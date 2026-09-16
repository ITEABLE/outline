// Apple Notes send / bring back, in Chrome with a stand-in for the Mac app's bridge:
//   node tests/applenotes.test.mjs   (after `node build.mjs`)
// The real Apple Notes side (mac/notes.js) was checked by hand with osascript; REAL_NOTES_HTML below
// is exactly what Apple Notes handed back for a note Outline sent, so the round trip is tested on it.
import { chromium } from 'playwright-core';

const PAGE = new URL('../dist/index.html', import.meta.url).href;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: CHROME });
let fails = 0;
const check = (n, ok, x = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  → ' + x : ''}`); };

const REAL_NOTES_HTML = [
  '<div><b><span style="font-size: 24px">Probe two</span></b></div>',
  '<div><b><span style="font-size: 20px">Twenty bold</span></b><br></div>',
  '<div><b>Seventeen bold</b><br></div>',
  '<div><b><span style="font-size: 18px">H2 tag</span></b></div>',
  '<div><br></div>',
  '<ol>', '<li>one</li>', '<li>two</li>', '</ol>',
  '<div><br></div>',
  '<div><font face="Courier"><tt>  indented  code</tt></font><span style="font-size: 13px"><tt><br></tt></span></div>',
  '<div><font face="Courier"><tt><br></tt></font></div>',
  '<div><font face="Courier"><tt>after blank</tt></font><span style="font-size: 13px"><tt><br></tt></span></div>',
  '<div>inline <font face="Menlo-Regular"><span style="font-size: 12px">menlo</span></font> and <font face="Courier"><span style="font-size: 12px">tt</span></font><br></div>',
  '<div>see link text (https://example.com) in <font color="#F7768E">red</font></div>',
  '<ul>', '<li>x</li>', '<ul>', '<li>y</li>', '</ul>', '</ul>',
].join('\n');

// Mac-app mode with a stand-in for Apple Notes
async function open({ sendFails = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await ctx.addInitScript(sendFails => {
    window.__NATIVE__ = { raw: null };
    window.__posted = [];
    window.__apple = { calls: [], remote: [] };
    window.webkit = { messageHandlers: {
      store: { postMessage: s => window.__posted.push(s) },
      appleNotes: { postMessage: async ({ action, payload }) => {
        const p = JSON.parse(payload || '{}');
        window.__apple.calls.push({ action, p });
        if (action === 'send') {
          if (sendFails) throw new Error("Outline isn't allowed to use Apple Notes. Open System Settings › Privacy & Security › Automation, find Outline, and turn on Notes.");
          return JSON.stringify({ account: 'iCloud', notes: p.notes.map(n => ({ id: n.id, appleId: n.appleId || 'x-coredata://note/' + n.id, name: 'x', html: 'stored:' + n.id, modified: '2026-09-12T10:00:00.000Z' })) });
        }
        if (action === 'fetch') return JSON.stringify({ account: 'iCloud', notes: window.__apple.remote });
        if (action === 'backup') return 'notes.before-import.json';
      } },
    } };
  }, sendFails);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('   !! ' + e.stack); });
  page.__dialogs = [];
  page.on('dialog', d => { page.__dialogs.push(d.message()); d.accept(); });
  await page.goto(PAGE);
  await page.waitForSelector('.ProseMirror');
  return { ctx, page, errors };
}
const titles = page => page.$$eval('#tree .item .title', els => els.map(e => e.value));
// the page batches saves (~0.4s after the last change); __flush() saves now and returns what it wrote
const saved = page => page.evaluate(() => JSON.parse(window.__flush()));
async function toastText(page) {
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('busy'));
  return page.textContent('#toast');
}
async function apple(page, action) {
  await page.click('#appleNotes');
  await page.click(`.menu [data-a=${action}]`);
  return toastText(page);
}
const PM = '.pane.focused .host:not([hidden]) .ProseMirror';

{
  const { ctx, page, errors } = await open();
  check('Apple Notes button shows in the Mac app', await page.isVisible('#appleNotes'));

  // a note with the tricky parts, made by pasting Markdown
  await page.click('#newNote');
  await page.keyboard.type('Tricky');
  await page.keyboard.press('Enter');
  await page.evaluate(sel => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '# Big\n\n## Medium\n\n```\n  indented\n```\n\n1. one\n2. two\n\n- bullet\n\nSee [the docs](https://example.com/docs) and https://claude.ai\n');
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PM);
  await apple(page, 'one');
  const tricky = await page.evaluate(() => __apple.calls.find(c => c.action === 'send').p.notes[0].html);
  check('title first, as the note name', tricky.startsWith('<div><h1>Tricky</h1></div>'), tricky.slice(0, 60));
  check('heading 1 → bold 20px (survives in Apple Notes)', tricky.includes('<div><b><span style="font-size: 20px">Big</span></b></div>'));
  check('heading 2 → Apple Notes heading', tricky.includes('<div><h2>Medium</h2></div>'));
  check('code indentation kept as non-breaking spaces', tricky.includes('<div><tt>&nbsp;&nbsp;indented</tt></div>'), tricky);
  check('blank line between numbered and bullet list', tricky.includes('</ol><div><br></div><ul>'));
  check('link target written out, bare URL left alone', tricky.includes('the docs (https://example.com/docs)') && !tricky.includes('claude.ai (https://claude.ai)'));

  const all = await apple(page, 'all');
  check('send all → confirmation', /^Sent 4 notes to the “Outline” folder in Apple Notes \(iCloud\)\.$/.test(all), all);
  const sent = await page.evaluate(() => __apple.calls.filter(c => c.action === 'send').at(-1).p);
  check('re-send reuses the Apple Note it made', sent.notes.find(n => n.html.includes('Tricky')).appleId === 'x-coredata://note/' + sent.notes.find(n => n.html.includes('Tricky')).id);
  check('sub-note says where it lives', sent.notes.find(n => n.html.includes('Focus timer')).html.includes('<i>In: Side projects</i>'));
  let d = await saved(page);
  check('each note remembers its Apple Note', d.items.every(i => i.apple?.id) && d.appleSentAt);
  const ids = Object.fromEntries(d.items.map(i => [i.title, i.apple.id]));
  const stored = Object.fromEntries(d.items.map(i => [i.title, 'stored:' + i.id]));

  // nothing edited anywhere → nothing to do, even if Apple Notes bumped the dates
  await page.evaluate(([ids, stored]) => {
    window.__apple.remote = Object.keys(ids).map(t => ({ appleId: ids[t], name: t, modified: '2026-09-12T11:00:00.000Z', html: stored[t] }));
  }, [ids, stored]);
  check('untouched notes aren’t "changed" just because the date moved', (await apple(page, 'back')) === 'Nothing new in Apple Notes.', await page.textContent('#toast'));

  // edit "Focus timer" here; in Apple Notes change it and "Side projects"; add a note on the phone
  const r = (await titles(page)).indexOf('Focus timer');
  await page.locator('#tree .item').nth(r).locator('.title').click();
  await page.click(`${PM} p`);
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.type(' (edited on the Mac)');
  await page.evaluate(([ids, stored, real]) => {
    const later = '2026-09-12T12:00:00.000Z';
    window.__apple.remote = [
      { appleId: ids['Side projects'], name: 'Side projects', modified: later, html: '<div><b><span style="font-size: 24px">Side projects</span></b></div><div>Edited on my <b>phone</b></div><ul><li>new idea</li></ul><div>☑ bought milk</div>' },
      { appleId: ids['Focus timer'], name: 'Focus timer', modified: later, html: '<div>Focus timer</div><div>phone version</div>' },
      { appleId: ids['Start here'], name: 'Start here', modified: later, html: stored['Start here'] },
      { appleId: 'x-coredata://phone-only', name: 'Probe two', modified: later, html: real },
    ];
  }, [ids, stored, REAL_NOTES_HTML]);
  const done = await apple(page, 'back');
  check('bring back asks first', page.__dialogs.at(-1) === 'From Apple Notes: update 1 note edited in Apple Notes, add 1 new note, add 1 copy of notes edited in both places?', page.__dialogs.at(-1));
  check('bring back reports what it did', done.startsWith('Done: update 1 note'), done);
  const t = await titles(page);
  check('phone-only note comes in', t.includes('Probe two'), JSON.stringify(t));
  check('edited in both places keeps both', t.indexOf('Focus timer (from Apple Notes)') === t.indexOf('Focus timer') + 1, JSON.stringify(t));
  d = await saved(page);
  check('Mac edit kept', JSON.stringify(d.items.find(i => i.title === 'Focus timer').doc).includes('edited on the Mac'));
  const side = d.items.find(i => i.title === 'Side projects');
  check('phone edit replaces the note', JSON.stringify(side.doc).includes('Edited on my') && side.doc.content.some(n => n.type === 'taskList'), side.doc.content.map(n => n.type).join());
  check('a backup is made before changes', await page.evaluate(() => __apple.calls.some(c => c.action === 'backup')));

  // real Apple Notes HTML → Outline
  const probe = d.items.find(i => i.title === 'Probe two').doc.content;
  const kinds = probe.map(n => n.type + (n.attrs?.level ? n.attrs.level : ''));
  const text = n => (n.text || '') + (n.content || []).map(text).join('');
  check('20px bold line → heading 1', probe.some(n => n.type === 'heading' && n.attrs.level === 1 && text(n) === 'Twenty bold'), kinds.join());
  check('18px bold line → heading 2', probe.some(n => n.type === 'heading' && n.attrs.level === 2 && text(n) === 'H2 tag'), kinds.join());
  check('numbered list kept', probe.some(n => n.type === 'orderedList' && n.content.length === 2));
  const code = probe.find(n => n.type === 'codeBlock');
  check('monospace lines → one code block, indentation and blank line kept', code && text(code) === '  indented  code\n\nafter blank', JSON.stringify(code && text(code)));
  check('inline monospace → inline code', JSON.stringify(probe).split('"type":"code"').length - 1 === 2);
  check('text colour kept', JSON.stringify(probe).includes('"color":"#F7768E"') || JSON.stringify(probe).includes('rgb(247, 118, 142)'));
  const ul = probe.find(n => n.type === 'bulletList');
  check('nested bullet stays nested', ul?.content.length === 1 && ul.content[0].content.some(c => c.type === 'bulletList'), JSON.stringify(ul));

  // deleting a sent note here must not bring it back
  const fr = (await titles(page)).indexOf('Focus timer (from Apple Notes)');
  await page.locator('#tree .item').nth(fr).click({ button: 'right' });
  await page.click('.menu [data-a=delete]');
  const sr = (await titles(page)).indexOf('Side projects');
  await page.locator('#tree .item').nth(sr).click({ button: 'right' });
  await page.click('.menu [data-a=delete]');
  check('delete warns the Apple Notes copy stays', page.__dialogs.at(-1).includes('Its copy in Apple Notes stays there.'), page.__dialogs.at(-1));
  await page.evaluate(ids => {
    window.__apple.remote = window.__apple.remote.map(r => r.appleId === ids['Side projects'] ? { ...r, modified: '2026-09-12T13:00:00.000Z', html: r.html + '<div>more</div>' } : r);
  }, ids);
  check('a deleted note isn’t brought back', (await apple(page, 'back')) === 'Nothing new in Apple Notes.', await page.textContent('#toast'));
  check('no errors (Apple Notes)', !errors.length, errors.join(' | '));
  await ctx.close();
}

{
  const { ctx, page } = await open({ sendFails: true });
  const t = await apple(page, 'all');
  check('permission problem explains the fix', t.includes('System Settings › Privacy & Security › Automation') && await page.$eval('#toast', e => e.classList.contains('error')), t);
  await ctx.close();
}

{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(PAGE);
  await page.waitForSelector('.ProseMirror');
  check('no Apple Notes button in a plain browser', !(await page.isVisible('#appleNotes')));
  await ctx.close();
}

await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
