// End-to-end test of the editor in Chrome: node tests/editor.test.mjs (after `node build.mjs`).
// Drives dist/index.html; section 1 also runs the v1 → v2 migration on your real pre-v2 backup if one exists.
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';

const PAGE = new URL('../dist/index.html', import.meta.url).href;
const OUT = new URL('./.output/', import.meta.url).pathname;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SUPP = process.env.HOME + '/Library/Application Support/Outline/';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
let fails = 0;
const check = (n, ok, x = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  → ' + x : ''}`); };

async function open({ nativeRaw, viewport = { width: 1400, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  if (nativeRaw !== undefined) {
    await ctx.addInitScript(raw => {
      window.__NATIVE__ = { raw };
      window.__posted = [];
      window.webkit = { messageHandlers: { store: { postMessage: s => window.__posted.push(s) } } };
    }, nativeRaw);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('   !! ' + e.stack); });
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log('   !! ' + m.text()); } });
  page.on('dialog', d => d.accept());
  await page.goto(PAGE);
  await page.waitForSelector('.ProseMirror');
  return { ctx, page, errors };
}
const titles = page => page.$$eval('#tree .item .title', els => els.map(e => e.value));
const tabs = page => page.$$eval('.pane', ps => ps.map(p => [...p.querySelectorAll('.tab')].map(t => t.querySelector('.tab-title').textContent + (t.classList.contains('on') ? '*' : ''))));
const PM = '.pane.focused .host:not([hidden]) .ProseMirror';
const row = async (page, title) => page.locator('#tree .item').nth((await titles(page)).indexOf(title));
// click the empty space under the note → caret goes to its end
async function clickBelow(page) {
  const b = await page.locator('.pane.focused .host:not([hidden])').boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 30);
}
async function paste(page, text) {
  await page.evaluate(([sel, t]) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [PM, text]);
}
const codeLangs = page => page.$$eval(`${PM} .code`, c => c.map(x => x.dataset.lang));

/* ---------- 1. v1 notes migrate ---------- */
const backup = existsSync(SUPP) && readdirSync(SUPP).find(f => f.startsWith('notes.before-v2'));
if (backup) {
  const { ctx, page, errors } = await open({ nativeRaw: readFileSync(SUPP + backup, 'utf8') });
  const t = await titles(page);
  check('migrates v1 notes, blank one removed', t.length >= 6 && t[0] === 'Prompts' && !t.includes(''), JSON.stringify(t));
  const doc = await page.evaluate(() => JSON.parse(__posted.at(-1)));
  const prompts = doc.items.find(i => i.title === 'Prompts').doc.content.map(n => n.type + (n.attrs?.language ? ':' + n.attrs.language : ''));
  check('Prompts: 4 bullet labels + 4 code blocks', prompts.filter(x => x.startsWith('codeBlock')).length === 4 && prompts.filter(x => x === 'bulletList').length === 4, prompts.join(','));
  check('pmset block stays bash', prompts.includes('codeBlock:bash'));
  check('saved in new format', doc.v === 2);
  check('starts with the cursor in the sidebar', await page.evaluate(() => document.activeElement.classList.contains('title')));
  check('no errors (migration)', !errors.length, errors.join(' | '));
  await ctx.close();
} else console.log('SKIP  migration (no notes.before-v2 backup on this Mac)');

/* ---------- 2. editing, blocks, paste, links, tabs ---------- */
{
  const { ctx, page, errors } = await open();
  check('starter notes load', (await titles(page)).length === 3);

  await page.click('#newNote');
  await page.keyboard.type('Groceries');
  await page.keyboard.press('Enter');
  await page.keyboard.type('milk');
  await page.keyboard.press('Enter');
  await page.keyboard.type('eggs');
  const lis = await page.$$eval(`${PM} > ul > li`, l => l.map(x => x.textContent));
  check('Enter makes new bullets (typing right away)', JSON.stringify(lis) === '["milk","eggs"]', JSON.stringify(lis));
  await page.keyboard.press('Tab');
  check('Tab nests a bullet', (await page.$$eval(`${PM} ul ul > li`, l => l.length)) === 1);

  await page.keyboard.press('Shift+Meta+ArrowLeft');
  await page.waitForFunction(() => getSelection().toString() === 'eggs'); // under load the selection can lag a frame
  await page.click('.pane.focused .toolbar [data-cmd=bold]');
  const bolded = await page.$$eval(`${PM} strong`, s => s.map(x => x.textContent).join());
  check('toolbar bold', bolded === 'eggs', JSON.stringify(bolded));
  await page.click('.pane.focused .toolbar [data-cmd=highlight]');
  await page.click('.menu .sw[title=Yellow]');
  const marked = await page.$$eval(`${PM} mark`, m => m.map(x => x.textContent));
  check('highlight colour', marked.length === 1 && marked[0] === 'eggs', JSON.stringify(marked));

  // Enter over a selection spanning nested bullets used to throw inside ProseMirror
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+z');

  await page.keyboard.press('Meta+ArrowRight');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('/h2');
  await page.waitForSelector('.popup .pop-item');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Plan');
  check('slash menu → heading', (await page.$$eval(`${PM} h2`, h => h.map(x => x.textContent).join())) === 'Plan');
  await page.waitForTimeout(50); // toolbar refreshes on the next frame
  check('toolbar shows Heading 2', (await page.$eval('.pane.focused .toolbar [data-cmd=block]', s => s.value)) === 'h2');
  await page.selectOption('.pane.focused .toolbar [data-cmd=block]', 'quote');
  check('toolbar style menu → quote', (await page.$$eval(`${PM} blockquote`, b => b.length)) === 1);
  await page.selectOption('.pane.focused .toolbar [data-cmd=block]', 'h2');

  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.press('Enter');
  await paste(page, '### Steps\n\n1. **Buy** things\n2. Cook\n\n```py\nprint("hi")\n```\n');
  const md = await page.evaluate(sel => {
    const r = document.querySelector(sel);
    return { h3: r.querySelector('h3')?.textContent, ol: r.querySelectorAll('ol li').length, bold: r.querySelector('ol strong')?.textContent };
  }, PM);
  check('Markdown paste keeps formatting', md.h3 === 'Steps' && md.ol === 2 && md.bold === 'Buy' && (await codeLangs(page)).includes('python'), JSON.stringify(md));

  await clickBelow(page);
  await paste(page, 'const x = [1, 2].map(n => n * 2);\nconsole.log(x);');
  check('plain code paste → code block', (await codeLangs(page)).includes('javascript'), JSON.stringify(await codeLangs(page)));

  await clickBelow(page);
  await page.keyboard.type('SELECT id FROM orders WHERE total > 100;');
  await page.keyboard.press('Meta+Enter');
  check('⌘↵ turns the line into a code block', (await codeLangs(page)).includes('sql'), JSON.stringify(await codeLangs(page)));
  await page.keyboard.press('Meta+Enter');
  check('⌘↵ again turns it back', !(await codeLangs(page)).includes('sql'));

  await clickBelow(page);
  await page.keyboard.type('see @Side');
  await page.waitForSelector('.popup .pop-item');
  await page.keyboard.press('Enter');
  check('@ inserts a note link', (await page.$$eval(`${PM} .mention`, m => m.map(x => x.textContent))).includes('@Side projects'));

  await (await row(page, 'Side projects')).locator('.title').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 2026');
  await page.waitForTimeout(700);
  await (await row(page, 'Groceries')).locator('.title').click();
  await page.waitForTimeout(100);
  check('renaming a note updates its links', (await page.$$eval(`${PM} .mention`, m => m.map(x => x.textContent))).includes('@Side projects 2026'));

  await page.click(`${PM} .mention`);
  check('clicking a link opens the note', (await page.inputValue('.pane.focused .host:not([hidden]) .doc-title')) === 'Side projects 2026');

  await (await row(page, 'Focus timer')).click({ modifiers: ['Meta'] });
  let tb = await tabs(page);
  check('⌘-click opens a new tab', tb[0].length === 2 && tb[0][1] === 'Focus timer*', JSON.stringify(tb));
  await (await row(page, 'Start here')).click({ modifiers: ['Alt'] });
  tb = await tabs(page);
  check('⌥-click opens side by side', tb.length === 2 && tb[1][0] === 'Start here*', JSON.stringify(tb));
  await page.screenshot({ path: OUT + 'split.png' });
  await page.click('.pane:nth-child(1) .tab.on');
  await page.click('.pane:nth-child(2) [data-act=closepane]');
  tb = await tabs(page);
  check('closing the other pane keeps this one', tb.length === 1 && tb[0].includes('Focus timer*'), JSON.stringify(tb));
  await page.keyboard.press('Meta+w');
  check('⌘W closes the tab', (await tabs(page))[0].length === 1, JSON.stringify(await tabs(page)));

  const before = (await titles(page)).length;
  await page.click('#newNote');
  check('new note appears', (await titles(page)).length === before + 1);
  await (await row(page, 'Start here')).locator('.title').click();
  check('unused new note is removed when you leave it', (await titles(page)).length === before, JSON.stringify(await titles(page)));

  // keyboard walk through the sidebar keeps focus when a blank note disappears
  await page.click('#newNote');
  await (await row(page, 'Start here')).locator('.title').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  check('sidebar arrows keep working', await page.evaluate(() => document.activeElement.value) === 'Focus timer', await page.evaluate(() => document.activeElement.value));

  await page.keyboard.press('Meta+\\');
  check('⌘\\ hides the sidebar', await page.$eval('#sidebar', a => getComputedStyle(a).display === 'none'));
  await page.click('[data-act=showside]');
  check('sidebar comes back', await page.$eval('#sidebar', a => getComputedStyle(a).display !== 'none'));
  const h = await page.locator('#sideResize').boundingBox();
  await page.mouse.move(h.x + 3, h.y + 300);
  await page.mouse.down();
  await page.mouse.move(h.x + 83, h.y + 300, { steps: 4 });
  await page.mouse.up();
  const w = await page.$eval('#sidebar', a => a.offsetWidth);
  check('sidebar drag-resizes', w > 330, String(w));

  await (await row(page, 'Groceries')).locator('.title').click();
  await page.click('.pane.focused .host:not([hidden]) [data-act=addchild]');
  await page.keyboard.type('Child idea');
  const t2 = await titles(page);
  check('+ Sub-note creates a nested note', t2.indexOf('Child idea') === t2.indexOf('Groceries') + 1, JSON.stringify(t2));

  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('.ProseMirror');
  const t3 = await titles(page);
  check('notes survive a reload', t3.includes('Groceries') && t3.includes('Child idea') && t3.includes('Side projects 2026'), JSON.stringify(t3));
  await (await row(page, 'Groceries')).locator('.title').click();
  check('formatting survives a reload', (await page.$$eval(`${PM} strong`, s => s.length)) >= 1 && (await codeLangs(page)).length >= 2, JSON.stringify(await codeLangs(page)));
  await page.screenshot({ path: OUT + 'editor.png' });
  check('no errors (editing)', !errors.length, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
