// End-to-end test of pictures in notes, in Chrome: node tests/images.test.mjs (after `node build.mjs`).
// Covers paste, drop, the file picker, resizing and saving, in a plain browser and against a stand-in for the Mac app.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAGE = new URL('../dist/index.html', import.meta.url).href;
const OUT = fileURLToPath(new URL('./.output/', import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
let fails = 0;
const check = (n, ok, x = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  → ' + x : ''}`); };

async function open({ native = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  if (native) {
    await ctx.addInitScript(() => {
      window.__NATIVE__ = { raw: null };
      window.__posted = [];
      window.__saved = [];
      // the app stores the file and hands back its address; here the address is the picture itself so it still shows
      window.webkit = { messageHandlers: {
        store: { postMessage: s => window.__posted.push(s) },
        images: { postMessage: async m => { window.__saved.push(m); return `data:${m.type};base64,${m.b64}`; } },
      } };
    });
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
const PM = '.pane.focused .host:not([hidden]) .ProseMirror';
const IMG = `${PM} [data-resize-wrapper] img`;
const savedDoc = async page => {
  const json = await page.evaluate(() => window.__flush());
  return JSON.parse(json);
};
const imagesIn = (doc, title) => {
  const out = [];
  (function walk(n) { if (!n) return; if (n.type === 'image') out.push(n.attrs); n.content?.forEach(walk); })(doc.items.find(i => i.title === title).doc);
  return out;
};
// a w×h PNG made in the page, delivered as a pasted file
async function pasteImage(page, w, h, color = '#7aa2f7') {
  await page.evaluate(async ([sel, w, h, color]) => {
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'Screenshot.png', { type: 'image/png' }));
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [PM, w, h, color]);
}

/* ---------- 1. plain browser: paste, resize, drop, picker ---------- */
{
  const { ctx, page, errors } = await open();
  await page.click('#newNote');
  await page.keyboard.type('Pics');
  await page.keyboard.press('Enter');
  await pasteImage(page, 480, 240);
  await page.waitForSelector(IMG);
  check('pasting a screenshot adds the picture', (await page.$$(IMG)).length === 1);
  check('picture isn’t draggable as a whole (it would steal the resize drag)', await page.$eval(`${PM} [data-resize-container]`, el => el.getAttribute('draggable') !== 'true'));
  check('picture replaced the empty bullet, not nested in it', await page.$eval(PM, el => el.firstElementChild.matches('[data-resize-container]')));
  let pics = imagesIn(await savedDoc(page), 'Pics');
  check('starts at its on-screen size', pics[0]?.width === 480, JSON.stringify(pics[0]?.width));
  check('in a browser it is stored inline', pics[0]?.src.startsWith('data:image/png'));
  await page.keyboard.type('caption under it');
  check('caret lands under the picture to keep typing', (await page.$eval(PM, el => el.lastElementChild.textContent)) === 'caption under it');

  // resize: hover, then drag the right edge 160px in
  const box = await page.locator(IMG).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const handle = await page.locator(`${PM} [data-resize-handle="right"]`).boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 160, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await page.locator(IMG).boundingBox();
  check('dragging the edge resizes it', Math.abs(after.width - 320) < 12, `${box.width} → ${after.width}`);
  check('keeps its shape', Math.abs(after.width / after.height - 2) < 0.05, `${after.width}×${after.height}`);
  pics = imagesIn(await savedDoc(page), 'Pics');
  check('new size is saved', Math.abs(pics[0].width - 320) < 12, JSON.stringify(pics[0]));

  // corners: TipTap's own corner handles never changed the width; dragging straight down or left must work
  const corner = async (name, dx, dy) => {
    const b = await page.locator(IMG).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    const c = await page.locator(`${PM} [data-resize-handle="${name}"]`).boundingBox();
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 + dx, c.y + c.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
    return page.locator(IMG).boundingBox();
  };
  let c1 = await corner('bottomRight', 0, 40);
  check('dragging the bottom-right corner down grows it', Math.abs(c1.width - 400) < 12, `${c1.width}`);
  c1 = await corner('bottomLeft', 80, 0);
  check('dragging the bottom-left corner inwards shrinks it', Math.abs(c1.width - 320) < 12, `${c1.width}`);
  check('corners keep its shape', Math.abs(c1.width / c1.height - 2) < 0.05, `${c1.width}×${c1.height}`);

  // drop a file onto the note
  await page.evaluate(async sel => {
    const c = Object.assign(document.createElement('canvas'), { width: 100, height: 100 });
    c.getContext('2d').fillRect(0, 0, 100, 100);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'drop.png', { type: 'image/png' }));
    const r = document.querySelector(sel).lastElementChild.getBoundingClientRect();
    const at = { clientX: r.left + 20, clientY: r.top + r.height / 2, dataTransfer: dt, bubbles: true, cancelable: true };
    document.querySelector(sel).dispatchEvent(new DragEvent('dragover', at));
    document.querySelector(sel).dispatchEvent(new DragEvent('drop', at));
  }, PM);
  await page.waitForFunction(sel => document.querySelectorAll(sel).length === 2, IMG);
  check('dropping a picture file adds it', true);

  // toolbar button → file picker
  const file = OUT + 'pick.png';
  writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.pane.focused .toolbar [data-cmd=image]')]);
  check('Picture button opens a picture picker', chooser.isMultiple());
  await chooser.setFiles(file);
  await page.waitForFunction(sel => document.querySelectorAll(sel).length === 3, IMG);
  check('picked file is added', true);

  await page.keyboard.press('Enter');
  await page.keyboard.type('/pict');
  check('/ menu offers Picture', (await page.$$eval('.popup .pop-item', b => b.map(x => x.textContent))).some(t => t.includes('Picture')));
  await page.keyboard.press('Escape');
  await page.screenshot({ path: OUT + 'pictures.png' });

  // relaunch
  await page.evaluate(() => window.__flush());
  await page.reload();
  await page.waitForSelector('.ProseMirror');
  const row = (await page.$$eval('#tree .item .title', e => e.map(x => x.value))).indexOf('Pics');
  await page.locator('#tree .item').nth(row).click();
  await page.waitForSelector(IMG);
  const w = await page.locator(IMG).first().boundingBox();
  check('pictures and their size survive a reload', (await page.$$(IMG)).length === 3 && Math.abs(w.width - 320) < 12, `${w.width}`);
  check('no errors (browser)', !errors.length, errors.join(' | '));
  await ctx.close();
}

/* ---------- 2. in the Mac app: pictures go to files, not into notes.json ---------- */
{
  const { ctx, page, errors } = await open({ native: true });
  check('Picture button is there in the Mac app', await page.isVisible('.pane.focused .toolbar [data-cmd=image]'));
  await page.click('#newNote');
  await page.keyboard.type('Shot');
  await page.keyboard.press('Enter');
  await pasteImage(page, 300, 150);
  await page.waitForSelector(IMG);
  const saved = await page.evaluate(() => window.__saved);
  check('picture is handed to the app to save', saved.length === 1 && saved[0].op === 'save' && saved[0].type === 'image/png' && saved[0].b64.length > 20, JSON.stringify(saved.map(s => s.type)));
  const pics = imagesIn(await savedDoc(page), 'Shot');
  check('note stores the address the app gave back', pics[0]?.src === `data:image/png;base64,${saved[0].b64}`);
  check('no errors (Mac app)', !errors.length, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
