// End-to-end test of terminal blocks and the terminal window in Chrome: node tests/terminal.test.mjs (after `node build.mjs`).
// The Mac side (mac/terminal.swift) is replaced by a stand-in that records requests and answers like the app.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const DIST = new URL('../dist/', import.meta.url).href;
const OUT = fileURLToPath(new URL('./.output/', import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
let fails = 0;
const check = (n, ok, x = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  → ' + x : ''}`); };

// A fake of the app's `term` handler: one session per sid, tabs, output events.
function fakeMac(raw) {
  window.__NATIVE__ = { raw };
  window.__posted = [];
  window.__calls = [];
  const sessions = {};
  const info = sid => ({ type: 'info', sid, ...sessions[sid].pub() });
  const fire = ev => setTimeout(() => window.__termEvent?.(ev));
  const mk = () => {
    let n = 0;
    const s = { tabs: [{ id: 'a', title: 'Claude outline', running: false, cwd: '/Users/me/Desktop/Claude outline' }], active: 'a', window: false, logs: { a: '' } };
    s.pub = () => ({ tabs: s.tabs.map(t => ({ ...t })), active: s.active, window: s.window });
    s.add = () => { const id = 'n' + ++n; s.tabs.push({ id, title: 'proj', running: false, cwd: '/p' }); s.logs[id] = ''; s.active = id; };
    return s;
  };
  // logs are kept as byte strings, like the app's UTF-8 output
  const utf8 = t => String.fromCharCode(...new TextEncoder().encode(t));
  window.__out = (sid, tab, text) => {
    const s = sessions[sid], at = s.logs[tab].length, b = utf8(text);
    s.logs[tab] += b;
    fire({ type: 'data', sid, tab, at, b64: btoa(b) });
  };
  window.__setWindow = (sid, open) => { sessions[sid].window = open; fire(info(sid)); };
  const term = {
    async postMessage(m) {
      window.__calls.push(m);
      const s = sessions[m.sid];
      switch (m.op) {
        case 'attach': sessions[m.sid] ??= mk(); (window.__attachedOnce ??= {})[m.sid] = true; return { ...sessions[m.sid].pub(), sid: m.sid };
        case 'start': {
          const t = s.tabs.find(x => x.id === m.tab) || s.tabs[0];
          if (!t.running) { t.running = true; s.logs[t.id] += `hello from ${t.id}\r\n$ `; }
          return { log: btoa(s.logs[t.id]), end: s.logs[t.id].length, tab: t.id };
        }
        case 'newTab': s.add(); fire(info(m.sid)); return s.active;
        case 'select': s.active = m.tab; fire(info(m.sid)); return null;
        case 'closeTab': s.tabs = s.tabs.filter(t => t.id !== m.tab); s.active = s.tabs[0].id; fire(info(m.sid)); return null;
        case 'rename': s.tabs.find(t => t.id === m.tab).title = m.name; fire(info(m.sid)); return null;
        case 'sessions': {
          const all = {
            claude: [
              { kind: 'claude', id: 'e3e0d38a-bf27-4f99-9f70-e96ca5ce8500', cwd: '/Users/me/Desktop/Claude Projects/RRG', title: 'read status.md and then push', time: Date.now() - 120000 },
              { kind: 'claude', id: '6990bc66-315f-4656-8546-99a2429969c6', cwd: '/Users/me/Desktop/Claude outline', title: 'make a hello world script', time: Date.now() - 7200000 },
            ],
            tmux: [{ kind: 'tmux', socket: 'outline', app: 'vscode', id: 'vscode-k3p9', program: 'claude', cwd: '/Users/me/code/web', time: Date.now() - 30000, attached: 1 }],
            tmuxInstalled: true,
          };
          const q = (m.query || '').toLowerCase();
          const hit = x => !q || x.id.toLowerCase().includes(q) || (x.title || '').toLowerCase().includes(q) || x.cwd.toLowerCase().includes(q);
          return { claude: all.claude.filter(hit), tmux: all.tmux.filter(hit), tmuxInstalled: true, mirror: !!window.__mirror };
        }
        case 'mirror': window.__mirror = m.on; return m.on;
        case 'preview': {
          await new Promise(r => setTimeout(r, 30));
          return m.kind === 'claude' ? '› make a hello world script\n\n✻ Done: hello.py prints Hello, world.' : 'web on main ❯ claude\n✻ Welcome back!\n> fix the login bug';
        }
        case 'openSession': {
          sessions[m.sid] ??= mk();
          const t = sessions[m.sid];
          const id = 'o' + t.tabs.length;
          if (!window.__attachedOnce?.[m.sid]) t.tabs = []; // a brand-new block holds only the session's tab
          t.tabs.push({ id, title: m.name, named: true, running: false, cwd: m.cwd });
          t.logs[id] = '';
          t.active = id;
          fire(info(m.sid));
          return id;
        }
        case 'folders': return { default: '/Users/me/Desktop/Claude outline', home: '/Users/me', recent: ['/Users/me/code/web', '/Users/me'] };
        case 'cd': case 'chooseFolder': {
          const path = m.op === 'cd' ? m.path : '/Users/me/picked';
          const t = s.tabs.find(x => x.id === m.tab);
          t.cwd = path; t.title = path.split('/').pop();
          fire(info(m.sid));
          return path;
        }
        default: return null;
      }
    },
  };
  window.webkit = { messageHandlers: { store: { postMessage: s => window.__posted.push(s) }, appleNotes: { postMessage: async () => ({}) }, term } };
}

async function open(path, { native = true, raw = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 860 } });
  if (native) await ctx.addInitScript(fakeMac, raw);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('   !! ' + e.stack); });
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log('   !! ' + m.text()); } });
  page.on('dialog', d => d.accept());
  await page.goto(DIST + path);
  return { ctx, page, errors };
}
const PM = '.pane.focused .host:not([hidden]) .ProseMirror';
const calls = (page, op) => page.evaluate(op => __calls.filter(c => c.op === op), op);
const screenText = (page, sel = '.term') => page.$eval(`${sel} .xterm-rows`, el => el.textContent);
const lastDoc = page => page.evaluate(() => JSON.parse(__posted.at(-1)));

/* ---------- 1. a terminal block in a note ---------- */
let savedRaw;
{
  const { ctx, page, errors } = await open('index.html');
  await page.waitForSelector('.ProseMirror');
  check('toolbar has a Terminal button in the Mac app', await page.isVisible('.pane.focused .toolbar [data-cmd=terminal]'));

  await page.click('#newNote');
  await page.keyboard.type('Server');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/term');
  const items = await page.$$eval('.popup .pop-item', b => b.map(x => x.textContent));
  check('/ menu offers Terminal', items.some(t => t.includes('Terminal')), JSON.stringify(items));
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sess .sess-row');
  await page.waitForFunction(() => document.querySelectorAll('.sess .sess-row').length === 4);
  const rows = await page.$$eval('.sess .sess-row', b => b.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  check('picker offers a new terminal first, then terminals and Claude sessions', rows[0].includes('New terminal') && rows[1].includes('vscode-k3p9') && rows[2].includes('read status.md') && rows[2].includes('e3e0d38a'), JSON.stringify(rows));
  check('a mirrored terminal shows its app, program and folder', rows[1].includes('VS Code') && rows[1].includes('claude · web'), rows[1]);
  const help = await page.$$eval('.sess .sess-cmd', r => r.map(x => x.textContent));
  check('picker shows the commands for finding session IDs', help.length === 2 && help[0].includes('echo $OUTLINE_SESSION') && help[1].includes('~/.claude/projects'), JSON.stringify(help));
  check('each command has a Copy button', (await page.$$('.sess .sess-cmd .sess-copy')).length === 2);

  // hover preview
  await page.hover('.sess .sess-row[data-i="1"]');
  await page.waitForSelector('.sess-preview:not([hidden])');
  check('hovering a terminal previews its screen', (await page.textContent('.sess-preview pre')).includes('fix the login bug') && (await page.textContent('.sess-preview-head')).includes('VS Code'));
  await page.hover('.sess .sess-row[data-i="2"]');
  await page.waitForFunction(() => document.querySelector('.sess-preview-head').textContent.startsWith('Claude'));
  check('hovering a Claude session previews its last messages', (await page.textContent('.sess-preview pre')).includes('hello.py'));
  await page.hover('.sess .sess-row[data-i="0"]');
  await page.waitForSelector('.sess-preview', { state: 'hidden' });
  check('no preview for “New terminal”', true);

  // mirror switch
  check('mirror switch starts off', (await page.getAttribute('.sess-toggle', 'aria-checked')) === 'false');
  await page.click('.sess-toggle');
  await page.waitForFunction(() => document.querySelector('.sess-toggle').getAttribute('aria-checked') === 'true');
  check('switch turns mirroring on', (await calls(page, 'mirror'))[0]?.on === true && (await page.textContent('.sess-mirror-note')).includes('every new terminal'));
  await page.click('.sess-toggle');
  await page.waitForFunction(() => document.querySelector('.sess-toggle').getAttribute('aria-checked') === 'false');
  check('and off again', (await calls(page, 'mirror'))[1]?.on === false);
  await page.click('.sess input');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${PM} .term .xterm-rows`);
  await page.waitForFunction(() => document.querySelector('.term .xterm-rows')?.textContent.includes('hello from a'));
  check('block shows the shell’s output', (await screenText(page)).includes('hello from a'));
  const start = (await calls(page, 'start'))[0];
  check('starts the shell sized to the box', start && start.cols > 20 && start.rows >= 8, JSON.stringify(start));
  check('block replaced the empty bullet, not nested in it', await page.$eval(PM, el => el.firstElementChild.classList.contains('term-block')));

  await page.click('.term .xterm-screen');
  await page.keyboard.type('ls');
  await page.keyboard.press('Enter');
  const typed = (await calls(page, 'input')).map(c => c.data).join('');
  check('keys go to the shell', typed === 'ls\r', JSON.stringify(typed));
  check('keys don’t leak into the note', !(await page.$eval(PM, el => el.textContent)).includes('ls'));

  const sid = await page.evaluate(() => __calls.find(c => c.op === 'attach').sid);
  await page.evaluate(sid => __out(sid, 'a', 'file-one  file-two\r\n'), sid);
  await page.waitForFunction(() => document.querySelector('.term .xterm-rows').textContent.includes('file-two'));
  check('live output appears', true);

  // starts in the default folder; the folder menu
  check('folder button shows the default folder', (await page.textContent('.term .term-folder')).includes('Claude outline'));
  await page.click('.term [data-act=folder]');
  const menu = await page.$$eval('.term .term-menu .term-mi', b => b.map(x => x.textContent));
  check('folder menu: default, Home, recent, Choose…', menu[0].includes('Claude outline') && menu[0].includes('default') && menu[1].includes('Home') && menu.some(t => t.includes('web')) && menu.at(-1).includes('Choose folder'), JSON.stringify(menu));
  check('recent list skips folders already listed', menu.filter(t => t.startsWith('Home')).length === 1);
  await page.click('.term .term-mi[data-path="/Users/me/code/web"]');
  const cd = (await calls(page, 'cd'))[0];
  check('picking a folder moves the terminal there', cd?.path === '/Users/me/code/web' && cd.tab === 'a', JSON.stringify(cd));
  await page.waitForFunction(() => document.querySelector('.term .term-folder').textContent.includes('web'));
  check('menu closes and the button shows the new folder', await page.isHidden('.term .term-menu'));
  await page.click('.term [data-act=folder]');
  await page.click('.term [data-act=choose]');
  check('Choose folder… opens the folder picker', (await calls(page, 'chooseFolder')).length === 1);
  await page.click('.term [data-act=folder]');
  await page.mouse.click(5, 400);
  check('clicking elsewhere closes the menu', await page.isHidden('.term .term-menu'));

  // Claude
  await page.click('.term [data-act=claude]');
  const cl = (await calls(page, 'claude'))[0];
  check('Claude button starts Claude in this tab', cl?.tab === 'a', JSON.stringify(cl));
  await page.click('.term .xterm-screen');
  await page.keyboard.press('Meta+j');
  check('⌘J in the terminal starts Claude too', (await calls(page, 'claude')).length === 2);
  await page.screenshot({ path: OUT + 'terminal-block.png' });

  // tabs
  await page.click('.term [data-act=new]');
  await page.waitForFunction(() => document.querySelectorAll('.term .term-tab').length === 2);
  await page.waitForFunction(() => document.querySelector('.term .xterm-rows').textContent.includes('hello from n1'));
  check('new tab shows its own shell', !(await screenText(page)).includes('file-two'));
  await page.click('.term .term-tab[data-id=a] .term-tab-title');
  await page.waitForFunction(() => document.querySelector('.term .xterm-rows').textContent.includes('file-two'));
  check('switching back shows the first tab’s history', true);
  await page.dblclick('.term .term-tab[data-id=a] .term-tab-title');
  await page.keyboard.type('api server');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.term .term-tab[data-id=a]').textContent.includes('api server'));
  check('double-click renames a tab', true);

  // opening a Claude session in this block from the header's search
  const opensBefore = (await calls(page, 'openSession')).length;
  await page.click('.term [data-act=sessions]');
  await page.waitForSelector('.sess .sess-row');
  await page.keyboard.type('6990bc66');
  await page.waitForFunction(() => document.querySelectorAll('.sess .sess-row').length === 1);
  check('searching by ID finds the session', (await page.textContent('.sess .sess-row')).includes('hello world'));
  await page.keyboard.press('Enter');
  const op = (await calls(page, 'openSession'))[opensBefore];
  check('opens it as a tab of this terminal', op?.sid === sid && op.kind === 'claude' && op.id === '6990bc66-315f-4656-8546-99a2429969c6' && op.cwd === '/Users/me/Desktop/Claude outline', JSON.stringify(op));
  await page.waitForFunction(() => [...document.querySelectorAll('.term .term-tab')].some(t => t.textContent.includes('hello world')));
  check('the tab is named after the session', true);
  await page.click('.term .term-tab[data-id=a] .term-tab-title');

  // its own window
  await page.click('.term [data-act=expand]');
  const exp = (await calls(page, 'expand'))[0];
  check('expand asks for a window, with the note’s title', exp?.title === 'Server', JSON.stringify(exp));
  await page.evaluate(sid => __setWindow(sid, true), sid);
  await page.waitForSelector('.term .term-away:not([hidden])');
  check('block says it’s open in a window', true);
  const inputsBefore = (await calls(page, 'input')).length;
  await page.evaluate(sid => __setWindow(sid, false), sid);
  await page.waitForSelector('.term .term-away', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.term .xterm-rows').textContent.includes('file-two'));
  check('closing the window brings the block back', (await calls(page, 'input')).length === inputsBefore);

  await page.evaluate(() => window.__flush());
  const doc = await lastDoc(page);
  const node = doc.items.find(i => i.title === 'Server').doc.content.find(n => n.type === 'terminal');
  check('note stores the terminal block with its session id', node?.attrs.sid === sid, JSON.stringify(node));
  savedRaw = JSON.stringify(doc);
  check('no errors (block)', !errors.length, errors.join(' | '));
  await ctx.close();
}

/* ---------- 1b. a new block opened straight on a session ---------- */
{
  const { ctx, page, errors } = await open('index.html');
  await page.waitForSelector('.ProseMirror');
  await page.click('#newNote');
  await page.keyboard.type('Live');
  await page.keyboard.press('Enter');
  await page.click('.pane.focused .toolbar [data-cmd=terminal]');
  await page.waitForFunction(() => document.querySelectorAll('.sess .sess-row').length === 4);
  await page.keyboard.type('k3p9');
  await page.waitForFunction(() => document.querySelectorAll('.sess .sess-row').length === 1);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${PM} .term .term-tab`);
  const op = (await calls(page, 'openSession'))[0];
  check('toolbar → picker → mirrored terminal opens before the block is added', op?.kind === 'tmux' && op.id === 'vscode-k3p9' && op.socket === 'outline' && op.name === 'vscode-k3p9', JSON.stringify(op));
  const node = (await lastDoc(page).catch(() => null)) && JSON.parse(await page.evaluate(() => window.__flush())).items.find(i => i.title === 'Live').doc.content.find(n => n.type === 'terminal');
  check('the block shows that session', node?.attrs.sid === op.sid, JSON.stringify(node));
  check('its only tab is the session', (await page.$$eval(`${PM} .term .term-tab`, t => t.map(x => x.textContent.trim()))).join() === 'vscode-k3p9');
  await page.click('.pane.focused .toolbar [data-cmd=terminal]');
  await page.waitForSelector('.sess');
  await page.keyboard.press('Escape');
  check('Esc closes the picker without adding anything', !(await page.$('.sess')) && (await page.$$(`${PM} .term`)).length === 1);
  check('no errors (sessions)', !errors.length, errors.join(' | '));
  await ctx.close();
}

/* ---------- 2. after a relaunch ---------- */
{
  const { ctx, page, errors } = await open('index.html', { raw: savedRaw });
  await page.waitForSelector('.ProseMirror');
  const gc = (await calls(page, 'gc'))[0];
  const sid = JSON.parse(savedRaw).items.find(i => i.title === 'Server').doc.content.find(n => n.type === 'terminal').attrs.sid;
  check('tells the app which terminals still exist', gc?.keep.includes(sid) && gc.keep.length === 1, JSON.stringify(gc));
  const row = (await page.$$eval('#tree .item .title', e => e.map(x => x.value))).indexOf('Server');
  await page.locator('#tree .item').nth(row).click();
  await page.waitForSelector(`${PM} .term .xterm-rows`);
  check('terminal block comes back in the note', (await calls(page, 'attach')).some(c => c.sid === sid));

  // removing it
  await page.click(`${PM} .term [data-act=remove]`);
  await page.waitForFunction(() => !document.querySelector('.pane.focused .host:not([hidden]) .term'));
  check('remove takes the block out', (await calls(page, 'detach')).some(c => c.sid === sid));
  check('no errors (relaunch)', !errors.length, errors.join(' | '));
  await ctx.close();
}

/* ---------- 3. the terminal window ---------- */
{
  const { ctx, page, errors } = await open('term.html?sid=w1');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('hello from a'));
  check('window shows the session', true);
  await page.click('.xterm-screen');
  await page.keyboard.press('Meta+t');
  await page.waitForFunction(() => document.querySelectorAll('.term-tab').length === 2);
  check('⌘T opens a tab in the window', (await calls(page, 'newTab')).length === 1);
  await page.keyboard.press('Meta+Shift+BracketLeft');
  await page.waitForFunction(() => document.querySelector('.term-tab.on')?.dataset.id === 'a');
  check('⇧⌘[ switches tabs', true);
  await page.keyboard.press('Meta+w');
  await page.waitForFunction(() => document.querySelectorAll('.term-tab').length === 1);
  check('⌘W closes a tab', (await calls(page, 'closeTab')).length === 1);
  await page.keyboard.press('Meta+w');
  check('⌘W on the last tab closes the window', (await calls(page, 'closeWindow')).length === 1);
  await page.keyboard.press('Meta+j');
  check('⌘J starts Claude in the window', (await calls(page, 'claude')).length === 1);
  await page.screenshot({ path: OUT + 'terminal-window.png' });
  check('no errors (window)', !errors.length, errors.join(' | '));
  await ctx.close();
}

/* ---------- 4. in a plain browser ---------- */
{
  const doc = JSON.parse(savedRaw);
  const { ctx, page, errors } = await open('index.html', { native: false });
  await ctx.addInitScript(d => { localStorage.setItem('outline-notes.v2', d); }, JSON.stringify(doc));
  await page.reload();
  await page.waitForSelector('.ProseMirror');
  check('no Terminal button in a plain browser', !(await page.$('[data-cmd=terminal]')));
  const row = (await page.$$eval('#tree .item .title', e => e.map(x => x.value))).indexOf('Server');
  await page.locator('#tree .item').nth(row).click();
  await page.waitForSelector(`${PM} .term-off`);
  check('a saved terminal shows a placeholder there', (await page.textContent(`${PM} .term-off`)).includes('Mac app'));
  check('no errors (browser)', !errors.length, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
