import './styles.css';
import { createEditor, htmlToDoc, docIsEmpty, relabelDoc, BLOCKS, setBlock, currentBlock, codeBlockFromSelection, esc } from './editor.js';
import { migrateV1 } from './migrate.js';
import { docToNotesHtml, notesHtmlToDoc, notesHash, hashText } from './applenotes.js';

const KEY = 'outline-notes.v2';
const OLD_KEY = 'outline-notes.v1';
// Inside the Mac app notes live in a file (via the native bridge); in a browser, in localStorage.
const native = window.__NATIVE__ && window.webkit?.messageHandlers?.store;
if (native) document.documentElement.classList.add('native');

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const $ = s => document.querySelector(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const svg = d => `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  x: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  dots: svg('<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>'),
  chev: svg('<path d="M6 4l4 4-4 4"/>'),
  split: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10"/>'),
  sidebar: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>'),
  code: svg('<path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5"/>'),
  marker: svg('<path d="M9.5 3l3.5 3.5L8 11.5H4.5V8z"/><path d="M3 13.5h5"/>'),
  link: svg('<path d="M6.8 9.2a3 3 0 004.2 0l2-2a3 3 0 00-4.2-4.2l-.9.9"/><path d="M9.2 6.8a3 3 0 00-4.2 0l-2 2a3 3 0 004.2 4.2l.9-.9"/>'),
  clear: svg('<path d="M3.5 3.5h7M7 3.5V12"/><path d="M10.5 9.5l3 3M13.5 9.5l-3 3"/>'),
  subnote: svg('<path d="M4 2.5h5l3 3v8H4z"/><path d="M8 7.5v4M6 9.5h4"/>'),
  width: svg('<path d="M2 8h12M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5"/>'),
};
const HIGHLIGHTS = [['None', ''], ['Yellow', 'rgba(240,198,116,.32)'], ['Green', 'rgba(158,206,106,.28)'], ['Blue', 'rgba(122,162,247,.32)'], ['Pink', 'rgba(247,118,142,.30)'], ['Purple', 'rgba(187,154,247,.30)']];
const COLORS = [['Default', ''], ['Grey', '#8b9099'], ['Red', '#f7768e'], ['Orange', '#ff9e64'], ['Yellow', '#e0af68'], ['Green', '#9ece6a'], ['Blue', '#7aa2f7'], ['Purple', '#bb9af7']];
const SIZES = [['', 'Normal'], ['13px', 'Small'], ['18px', 'Large'], ['23px', 'Huge']];

const emptyDoc = () => ({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] });
const newItem = (depth, title = '') => ({ id: uid(), depth, title, collapsed: false, doc: emptyDoc() });

/* ---------- load / save ---------- */
function starter() {
  const mk = (depth, title, html) => ({ id: uid(), depth, title, collapsed: false, doc: htmlToDoc(html) });
  const items = [
    mk(0, 'Start here', '<ul><li><p><strong>Enter</strong> makes a new bullet, <strong>Tab</strong> nests it.</p></li><li><p>Type <code>/</code> to pick a block type, <code>@</code> to link another note.</p></li><li><p>Select text and press <strong>⌘↵</strong> to turn it into a code block.</p></li><li><p>Paste Markdown, like a reply copied from Claude, and it keeps its formatting.</p></li><li><p><strong>⌘-click</strong> a note to open it in a new tab, <strong>⌥-click</strong> to open it side by side.</p></li></ul><pre><code class="language-bash">brew install jq</code></pre>'),
    mk(0, 'Side projects', '<ul><li><p>Rename screenshots by date</p></li><li><p>Menubar focus timer</p></li></ul>'),
    mk(1, 'Focus timer', '<p>Config sketch.</p><pre><code class="language-json">{\n  "minutes": 25,\n  "break": 5\n}</code></pre>'),
  ];
  return { v: 2, items, panes: [{ id: uid(), tabs: [items[0].id], active: items[0].id, flex: 1 }], focus: 0 };
}

function parse(raw) { try { return JSON.parse(raw); } catch { return null; } }
function stored() {
  if (native) return parse(window.__NATIVE__.raw);
  try { return parse(localStorage.getItem(KEY)) || parse(localStorage.getItem(OLD_KEY)); } catch { return null; }
}

function sanitize(d) {
  if (!d || !Array.isArray(d.items)) return null;
  const items = d.items.filter(x => x && typeof x === 'object').map(x => ({
    id: String(x.id || uid()),
    depth: Math.max(0, x.depth | 0),
    title: String(x.title ?? ''),
    collapsed: !!x.collapsed,
    doc: x.doc && x.doc.type === 'doc' ? x.doc : emptyDoc(),
    // link to the Apple Note it was sent to: its id, its last-seen change date,
    // our fingerprint at that point (hash) and Apple Notes' copy's fingerprint (remote)
    apple: typeof x.apple?.id === 'string'
      ? { id: x.apple.id, modified: String(x.apple.modified || ''), hash: String(x.apple.hash || ''), remote: String(x.apple.remote || '') }
      : undefined,
  }));
  if (!items.length) return null;
  items.forEach((it, i) => { it.depth = i ? Math.min(it.depth, items[i - 1].depth + 1) : 0; });
  const ids = new Set(items.map(i => i.id));
  let panes = (Array.isArray(d.panes) ? d.panes : []).map(p => {
    const tabs = [...new Set((p?.tabs || []).filter(t => ids.has(t)))];
    return { id: String(p?.id || uid()), tabs, active: tabs.includes(p?.active) ? p.active : tabs[0] ?? null, flex: +p?.flex || 1 };
  }).filter(p => p.tabs.length).slice(0, 3);
  if (!panes.length) panes = [{ id: uid(), tabs: [items[0].id], active: items[0].id, flex: 1 }];
  return {
    v: 2, items, panes,
    focus: clamp(d.focus | 0, 0, panes.length - 1),
    sidebar: { w: clamp(+d.sidebar?.w || 272, 180, 480), hidden: !!d.sidebar?.hidden },
    wide: !!d.wide,
    appleSentAt: typeof d.appleSentAt === 'string' ? d.appleSentAt : null,
    // Apple Notes ids of notes deleted here, so "Bring back" doesn't re-add their copies
    appleGone: Array.isArray(d.appleGone) ? d.appleGone.filter(x => typeof x === 'string').slice(-2000) : [],
  };
}

function load() {
  let d = stored();
  if (d && d.v !== 2 && Array.isArray(d.items)) d = migrateV1(d, uid);
  return sanitize(d) || sanitize(starter());
}

const state = load();

let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); };
function saveNow() {
  clearTimeout(saveTimer);
  const json = JSON.stringify(state);
  if (native) native.postMessage(json);
  else try { localStorage.setItem(KEY, json); } catch {}
  return json;
}
window.__flush = saveNow; // the Mac app calls this right before quitting
addEventListener('beforeunload', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

/* ---------- outline helpers ---------- */
const idx = id => state.items.findIndex(it => it.id === id);
const byId = id => state.items.find(it => it.id === id);
const titleOf = id => byId(id)?.title ?? '';
const subtreeEnd = i => {
  const d = state.items[i].depth;
  let j = i + 1;
  while (j < state.items.length && state.items[j].depth > d) j++;
  return j;
};
function ancestors(i) {
  const out = [];
  let d = state.items[i].depth;
  for (let j = i - 1; j >= 0 && d > 0; j--) {
    if (state.items[j].depth < d) { out.unshift(state.items[j]); d = state.items[j].depth; }
  }
  return out;
}
function childrenOf(i) {
  const d = state.items[i].depth, out = [];
  for (let j = i + 1; j < state.items.length && state.items[j].depth > d; j++) if (state.items[j].depth === d + 1) out.push(state.items[j]);
  return out;
}
// Unfolds every folded ancestor so the bullet is visible. Returns true if anything changed.
function reveal(i) {
  if (i < 0) return false;
  let changed = false;
  for (const a of ancestors(i)) if (a.collapsed) { a.collapsed = false; changed = true; }
  return changed;
}

/* ---------- panes, tabs, editors ---------- */
const panesEl = $('#panes');
const paneDom = new Map();   // pane id → { root, tabbar, toolbar, hosts, empty }
const editors = new Map();   // "paneId|noteId" → host record
const hostKey = (paneId, noteId) => `${paneId}|${noteId}`;
const paneById = id => state.panes.find(p => p.id === id);
const focusedPane = () => state.panes[state.focus] || state.panes[0];
const currentId = () => focusedPane()?.active ?? null;
const activeHost = pane => (pane?.active ? editors.get(hostKey(pane.id, pane.active)) : null);
// TipTap moves focus on the next frame; take it now so keys typed right after a jump aren't lost.
const focusNow = (ed, pos) => { ed.commands.focus(pos); ed.view.focus(); };

function dropHost(paneId, noteId) {
  const k = hostKey(paneId, noteId), h = editors.get(k);
  if (!h) return;
  h.ed.destroy();
  h.host.remove();
  editors.delete(k);
}

function dropPane(p) {
  const i = state.panes.indexOf(p);
  for (const id of p.tabs) dropHost(p.id, id);
  state.panes.splice(i, 1);
  if (i < state.focus) state.focus--; // keep focus on the same pane
}

function cleanPanes() {
  for (const p of [...state.panes]) if (!p.tabs.length && state.panes.length > 1) dropPane(p);
  state.focus = clamp(state.focus, 0, state.panes.length - 1);
}

// Removes a bullet (its sub-notes move up a level) and closes its tabs.
function removeAt(i) {
  const it = state.items[i], end = subtreeEnd(i);
  if (it.apple?.id) state.appleGone.push(it.apple.id);
  for (let j = i + 1; j < end; j++) state.items[j].depth--;
  state.items.splice(i, 1);
  for (const p of state.panes) {
    const k = p.tabs.indexOf(it.id);
    if (k < 0) continue;
    dropHost(p.id, it.id);
    p.tabs.splice(k, 1);
    if (p.active === it.id) p.active = p.tabs[Math.min(k, p.tabs.length - 1)] ?? null;
  }
  cleanPanes();
}

// A note that was created but never given a title or content disappears once you leave it.
function sweep({ atLoad = false } = {}) {
  const keep = new Set(atLoad ? [] : state.panes.map(p => p.active).filter(Boolean));
  const typing = document.activeElement?.closest?.('#tree .item')?.dataset.id;
  if (typing && !atLoad) keep.add(typing);
  let removed = false;
  for (let i = state.items.length - 1; i >= 0 && state.items.length > 1; i--) {
    const it = state.items[i];
    if (keep.has(it.id) || it.title.trim() || subtreeEnd(i) !== i + 1 || !docIsEmpty(it.doc)) continue;
    removeAt(i);
    removed = true;
  }
  return removed;
}

function sidePane(from) {
  const i = state.panes.indexOf(from);
  if (i < state.panes.length - 1) return state.panes[i + 1];
  if (state.panes.length < 3) {
    const p = { id: uid(), tabs: [], active: null, flex: 1 };
    state.panes.push(p);
    return p;
  }
  return state.panes[i - 1];
}

// mode: "here" replaces the current tab, "tab" opens a new tab, "side" opens in the next pane.
function openNote(id, mode = 'here', opts = {}) {
  if (!byId(id)) return;
  let pane = opts.pane || focusedPane();
  if (mode === 'side') pane = sidePane(pane);
  const prev = pane.active;
  if (pane.tabs.includes(id)) pane.active = id;
  else if (mode === 'here' && prev) {
    pane.tabs[pane.tabs.indexOf(prev)] = id;
    pane.active = id;
    dropHost(pane.id, prev);
  } else {
    pane.tabs.splice(prev ? pane.tabs.indexOf(prev) + 1 : pane.tabs.length, 0, id);
    pane.active = id;
  }
  state.focus = state.panes.indexOf(pane);
  const structural = reveal(idx(id)) | sweep();
  renderPanes();
  if (structural) renderTree(); else updateTreeOn();
  save();
  const h = activeHost(pane);
  if (opts.focus === 'title') h?.titleEl.focus();
  else if (opts.focus === 'editor' && h) focusNow(h.ed);
}

function activateTab(pane, id) {
  pane.active = id;
  state.focus = state.panes.indexOf(pane);
  const removed = sweep();
  renderPanes();
  if (removed) renderTree(); else updateTreeOn();
  save();
  const h = activeHost(pane);
  if (h) focusNow(h.ed);
}

function closeTab(pane, id) {
  const k = pane.tabs.indexOf(id);
  if (k < 0) return;
  pane.tabs.splice(k, 1);
  dropHost(pane.id, id);
  if (pane.active === id) pane.active = pane.tabs[Math.min(k, pane.tabs.length - 1)] ?? null;
  cleanPanes();
  const removed = sweep();
  renderPanes();
  if (removed) renderTree(); else updateTreeOn();
  save();
}

function closePane(pane) {
  dropPane(pane);
  cleanPanes();
  const removed = sweep();
  renderPanes();
  if (removed) renderTree(); else updateTreeOn();
  save();
}

function setFocus(paneId) {
  const i = state.panes.findIndex(p => p.id === paneId);
  if (i < 0 || i === state.focus) return;
  state.focus = i;
  for (const [pid, dom] of paneDom) dom.root.classList.toggle('focused', pid === paneId);
  updateTreeOn();
  save();
}

/* ---------- notes: create, title, delete ---------- */
function newNote(mode = 'here') {
  const n = newItem(0);
  state.items.push(n);
  renderTree();
  openNote(n.id, mode, { focus: 'title' });
}

function newChild(i) {
  const parent = state.items[i], n = newItem(parent.depth + 1);
  state.items.splice(subtreeEnd(i), 0, n);
  parent.collapsed = false;
  renderTree();
  openNote(n.id, 'here', { focus: 'title' });
}

// Used by @-links and the sub-note prompt: creates the note without leaving the current one.
function createChild(parentId, title) {
  const i = idx(parentId);
  const n = newItem(i < 0 ? 0 : state.items[i].depth + 1, title);
  if (i < 0) state.items.push(n);
  else { state.items.splice(subtreeEnd(i), 0, n); state.items[i].collapsed = false; }
  renderTree();
  renderChrome();
  save();
  return n;
}

function deleteNote(i) {
  const it = state.items[i], kids = subtreeEnd(i) - i - 1;
  const hasContent = it.title.trim() || !docIsEmpty(it.doc);
  const extra = (kids ? ' Its sub-notes move up a level.' : '') + (it.apple ? ' Its copy in Apple Notes stays there.' : '');
  if ((hasContent || kids) && !confirm(`Delete “${it.title || 'Untitled'}”?${extra}`)) return;
  removeAt(i);
  if (!state.items.length) state.items.push(newItem(0));
  if (!focusedPane().active) openNote(state.items[clamp(i - 1, 0, state.items.length - 1)].id, 'here');
  renderTree();
  renderPanes();
  save();
}

const relabelTimers = new Map();
function setTitle(id, value, from) {
  const it = byId(id);
  if (!it) return;
  it.title = value;
  const inp = titleInput(id);
  if (inp && inp !== from) inp.value = value;
  for (const h of editors.values()) if (h.noteId === id && h.titleEl !== from) h.titleEl.value = value;
  renderChrome();
  // keep @-links to this note showing its new name
  clearTimeout(relabelTimers.get(id));
  relabelTimers.set(id, setTimeout(() => {
    const open = new Set([...editors.values()].map(h => h.noteId));
    let changed = false;
    for (const n of state.items) if (!open.has(n.id) && relabelDoc(n.doc, id, value)) changed = true;
    for (const h of editors.values()) {
      const tr = h.ed.state.tr;
      let hit = false;
      h.ed.state.doc.descendants((node, pos) => {
        if (node.type.name === 'mention' && node.attrs.id === id && node.attrs.label !== value) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, label: value });
          hit = true;
        }
      });
      if (hit) { tr.setMeta('addToHistory', false); h.ed.view.dispatch(tr); } // saves via its update
    }
    if (changed) save();
  }, 500));
  save();
}

/* ---------- sidebar ---------- */
const tree = $('#tree');
const titleInput = id => tree.querySelector(`[data-id="${id}"] .title`);

function renderTree() {
  const cur = currentId();
  // redrawing replaces the inputs; keep the caret where it was if you were typing in one
  const a = document.activeElement;
  const typing = a?.classList?.contains('title') && tree.contains(a) ? { id: a.closest('.item').dataset.id, s: a.selectionStart, e: a.selectionEnd } : null;
  const frag = document.createDocumentFragment();
  let hideBelow = Infinity;
  state.items.forEach((it, i) => {
    if (it.depth > hideBelow) return;
    const next = state.items[i + 1], parent = !!next && next.depth > it.depth;
    hideBelow = parent && it.collapsed ? it.depth : Infinity;
    const li = document.createElement('li');
    li.className = 'item' + (it.id === cur ? ' on' : '') + (parent ? ' parent' : '') + (parent && it.collapsed ? ' folded' : '');
    li.style.setProperty('--d', it.depth);
    li.dataset.id = it.id;
    li.innerHTML = `<button class="twisty" tabindex="-1" title="Fold (⌘↑ / ⌘↓)">${ICON.chev}</button><span class="dot"></span><input class="title" placeholder="Untitled" spellcheck="false"><span class="row-acts"><button class="row-btn" data-act="child" tabindex="-1" title="New sub-note">${ICON.plus}</button><button class="row-btn" data-act="menu" tabindex="-1" title="More">${ICON.dots}</button></span>`;
    li.querySelector('.title').value = it.title;
    frag.append(li);
  });
  tree.replaceChildren(frag);
  const inp = typing && titleInput(typing.id);
  if (inp) { inp.focus(); inp.setSelectionRange(typing.s, typing.e); }
}

function updateTreeOn() {
  const cur = currentId();
  tree.querySelectorAll('.item').forEach(li => li.classList.toggle('on', li.dataset.id === cur));
}

function focusTitle(id, pos) {
  let inp = titleInput(id);
  if (!inp && reveal(idx(id))) { renderTree(); inp = titleInput(id); }
  if (!inp) return;
  inp.focus();
  const p = pos ?? inp.value.length;
  inp.setSelectionRange(p, p);
}

const focusEditor = () => { const h = activeHost(focusedPane()); if (h) focusNow(h.ed); };

function restructure(focusId) {
  const a = document.activeElement;
  const caret = a?.classList?.contains('title') ? a.selectionStart : undefined;
  renderTree();
  renderChrome();
  if (focusId) focusTitle(focusId, caret);
  save();
}

function indent(i, dir) {
  const items = state.items, it = items[i], end = subtreeEnd(i);
  if (dir > 0 && (i === 0 || it.depth > items[i - 1].depth)) return;
  if (dir < 0 && it.depth === 0) return;
  for (let j = i; j < end; j++) items[j].depth += dir;
  reveal(i);
  restructure(it.id);
}

function setFold(i, folded) {
  const it = state.items[i];
  if (subtreeEnd(i) === i + 1 || !!it.collapsed === folded) return;
  it.collapsed = folded;
  const typing = document.activeElement?.closest?.('#tree .item')?.dataset.id;
  const hidden = typing && idx(typing) > i && idx(typing) < subtreeEnd(i);
  restructure(hidden ? it.id : typing);
}

function addAfter(i) {
  const n = newItem(state.items[i].depth);
  state.items.splice(subtreeEnd(i), 0, n);
  renderTree();
  focusTitle(n.id, 0); // focusing it opens it
}

function showNoteMenu(id, x, y) {
  openMenu(x, y, `
    <button class="mi" data-a="tab">Open in new tab<kbd>⌘ click</kbd></button>
    <button class="mi" data-a="side">Open side by side<kbd>⌥ click</kbd></button>
    <div class="msep"></div>
    <button class="mi" data-a="child">New sub-note</button>
    <button class="mi" data-a="rename">Rename</button>
    ${appleBridge ? '<button class="mi" data-a="apple">Send to Apple Notes</button>' : ''}
    <div class="msep"></div>
    <button class="mi danger" data-a="delete">Delete</button>`, e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    closeMenu();
    if (a === 'tab' || a === 'side') openNote(id, a);
    else if (a === 'child') newChild(idx(id));
    else if (a === 'rename') { focusTitle(id); titleInput(id)?.select(); }
    else if (a === 'apple') sendToAppleNotes([id]);
    else if (a === 'delete') deleteNote(idx(id));
  });
}

tree.addEventListener('mousedown', e => {
  const li = e.target.closest('.item');
  if (!li || e.button !== 0) return;
  const id = li.dataset.id;
  if (e.target.closest('.twisty, .row-btn')) { e.preventDefault(); return; }
  if (e.metaKey || e.ctrlKey) { e.preventDefault(); openNote(id, 'tab'); return; }
  if (e.altKey) { e.preventDefault(); openNote(id, 'side'); return; }
  if (!e.target.classList.contains('title')) { e.preventDefault(); focusTitle(id); }
});
tree.addEventListener('click', e => {
  const b = e.target.closest('.twisty, .row-btn');
  if (!b) return;
  const li = b.closest('.item'), i = idx(li.dataset.id);
  if (b.classList.contains('twisty')) setFold(i, !state.items[i].collapsed);
  else if (b.dataset.act === 'child') newChild(i);
  else { const r = b.getBoundingClientRect(); showNoteMenu(li.dataset.id, r.left, r.bottom + 4); }
});
tree.addEventListener('contextmenu', e => {
  const li = e.target.closest('.item');
  if (!li) return;
  e.preventDefault();
  showNoteMenu(li.dataset.id, e.clientX, e.clientY);
});
tree.addEventListener('focusin', e => {
  const li = e.target.closest('.item');
  if (li && li.dataset.id !== currentId()) openNote(li.dataset.id, 'here');
});
tree.addEventListener('input', e => {
  const li = e.target.closest('.item');
  if (li) setTitle(li.dataset.id, e.target.value, e.target);
});
tree.addEventListener('keydown', e => {
  const inp = e.target;
  if (!inp.classList.contains('title') || e.isComposing) return;
  const li = inp.closest('.item'), id = li.dataset.id, i = idx(id);
  const mod = e.metaKey || e.ctrlKey;
  switch (e.key) {
    case 'Tab':
      e.preventDefault(); indent(i, e.shiftKey ? -1 : 1); break;
    case 'Enter':
      e.preventDefault(); if (mod) focusEditor(); else addAfter(i); break;
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault();
      if (mod) { setFold(i, e.key === 'ArrowUp'); break; }
      const to = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
      if (to) focusTitle(to.dataset.id);
      break;
    }
    case 'Escape':
      e.preventDefault(); focusEditor(); break;
    case 'Backspace': {
      const it = state.items[i];
      if (!it.title && docIsEmpty(it.doc) && state.items.length > 1 && subtreeEnd(i) === i + 1) {
        e.preventDefault();
        const target = li.previousElementSibling?.dataset.id || li.nextElementSibling?.dataset.id;
        removeAt(i);
        if (target) openNote(target, 'here');
        renderTree();
        renderPanes();
        if (target) focusTitle(target);
      }
      break;
    }
  }
});

$('#newNote').addEventListener('click', () => newNote('here'));
$('#hideSide').addEventListener('click', () => toggleSidebar(true));

/* ---------- Apple Notes ---------- */
// Only inside the Mac app, which runs Apple Notes' scripting for us (mac/notes.js).
const appleBridge = native ? window.webkit.messageHandlers.appleNotes : null;
const APPLE_FOLDER = 'Outline';
let appleBusy = false;

async function appleCall(action, payload = {}) {
  const reply = await appleBridge.postMessage({ action, payload: JSON.stringify(payload) });
  return typeof reply === 'string' && reply.startsWith('{') ? JSON.parse(reply) : reply;
}

let toastTimer;
function toast(text, kind = 'ok') {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (kind !== 'busy') toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 10000 : 4500);
}
$('#toast').addEventListener('click', () => { $('#toast').hidden = true; });

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `on ${new Date(iso).toLocaleDateString()}`;
}
const isBlank = it => !it.title.trim() && docIsEmpty(it.doc);
const pathOf = it => ancestors(idx(it.id)).map(a => a.title || 'Untitled').join(' › ');

async function sendToAppleNotes(ids) {
  if (appleBusy) return;
  const items = ids.map(byId).filter(it => it && !isBlank(it));
  if (!items.length) { toast('That note is empty, so there’s nothing to send.', 'error'); return; }
  appleBusy = true;
  toast(`Sending ${plural(items.length, 'note')} to Apple Notes…`, 'busy');
  try {
    const res = await appleCall('send', {
      folder: APPLE_FOLDER,
      notes: items.map(it => ({ id: it.id, appleId: it.apple?.id || null, html: docToNotesHtml(it.title, it.doc, pathOf(it)) })),
    });
    for (const r of res.notes) {
      const it = byId(r.id);
      if (it) it.apple = { id: r.appleId, modified: r.modified, hash: notesHash(it.title, it.doc), remote: hashText(r.html || '') };
    }
    state.appleSentAt = new Date().toISOString();
    save();
    toast(`Sent ${plural(res.notes.length, 'note')} to the “${APPLE_FOLDER}” folder in Apple Notes (${res.account}).`);
  } catch (e) {
    toast(e.message || String(e), 'error');
  } finally {
    appleBusy = false;
  }
}

function refreshOpen(it) {
  for (const h of editors.values()) if (h.noteId === it.id) h.ed.commands.setContent(it.doc, { emitUpdate: false });
}

// Notes edited in Apple Notes come back; notes added to its "Outline" folder come in as new notes.
// A note edited in both places is never overwritten: the Apple Notes version arrives as a copy beside it.
async function bringBackFromAppleNotes() {
  if (appleBusy) return;
  appleBusy = true;
  toast('Checking Apple Notes for changes…', 'busy');
  try {
    const res = await appleCall('fetch', { folder: APPLE_FOLDER });
    const linked = new Map(state.items.filter(it => it.apple?.id).map(it => [it.apple.id, it]));
    const gone = new Set(state.appleGone);
    const updates = [], copies = [], added = [];
    for (const r of res.notes) {
      const it = linked.get(r.appleId);
      if (!it) { if (!gone.has(r.appleId)) added.push(r); continue; }
      // edited in Apple Notes = its content differs from what it held after our last send or import
      // (dates alone aren't enough: they're to the second, and iCloud can touch a note without an edit)
      if (new Date(r.modified) < new Date(it.apple.modified)) continue;
      if (it.apple.remote ? hashText(r.html) === it.apple.remote : !(new Date(r.modified) > new Date(it.apple.modified))) continue;
      (notesHash(it.title, it.doc) === it.apple.hash ? updates : copies).push([it, r]);
    }
    const parts = [
      updates.length && `update ${plural(updates.length, 'note')} edited in Apple Notes`,
      added.length && `add ${plural(added.length, 'new note')}`,
      copies.length && `add ${plural(copies.length, 'copy', 'copies')} of notes edited in both places`,
    ].filter(Boolean);
    if (!parts.length) { toast('Nothing new in Apple Notes.'); return; }
    if (!confirm(`From Apple Notes: ${parts.join(', ')}?`)) { $('#toast').hidden = true; return; }
    await appleCall('backup').catch(() => {});

    for (const [it, r] of updates) {
      it.doc = notesHtmlToDoc(r.html);
      setTitle(it.id, r.name);
      it.apple = { id: r.appleId, modified: r.modified, hash: notesHash(it.title, it.doc), remote: hashText(r.html) };
      refreshOpen(it);
    }
    for (const [it, r] of copies) {
      const copy = { id: uid(), depth: it.depth, title: `${r.name} (from Apple Notes)`, collapsed: false, doc: notesHtmlToDoc(r.html) };
      state.items.splice(subtreeEnd(idx(it.id)), 0, copy);
      // don't offer the same copy again next time
      it.apple.modified = r.modified;
      it.apple.remote = hashText(r.html);
    }
    for (const r of added) {
      const n = { id: uid(), depth: 0, title: r.name, collapsed: false, doc: notesHtmlToDoc(r.html) };
      n.apple = { id: r.appleId, modified: r.modified, hash: notesHash(n.title, n.doc), remote: hashText(r.html) };
      state.items.push(n);
    }
    renderTree();
    renderChrome();
    save();
    toast(`Done: ${parts.join(', ')}.`);
  } catch (e) {
    toast(e.message || String(e), 'error');
  } finally {
    appleBusy = false;
  }
}

function showAppleMenu() {
  const r = $('#appleNotes').getBoundingClientRect();
  const cur = byId(currentId());
  openMenu(r.left, r.bottom + 6, `
    <button class="mi" data-a="all">Send all notes to Apple Notes</button>
    ${cur && !isBlank(cur) ? `<button class="mi" data-a="one"><span class="mi-text">Send “${esc(cur.title || 'Untitled')}” only</span></button>` : ''}
    <button class="mi" data-a="back">Bring back changes from Apple Notes</button>
    <div class="msep"></div>
    <div class="mnote">${state.appleSentAt ? `Last sent ${ago(state.appleSentAt)}.` : 'Nothing sent yet.'} Notes go to the “${APPLE_FOLDER}” folder in Apple Notes, which syncs to your iPhone through iCloud.</div>`, e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    closeMenu();
    if (a === 'all') sendToAppleNotes(state.items.map(it => it.id));
    else if (a === 'one') sendToAppleNotes([cur.id]);
    else bringBackFromAppleNotes();
  });
}
if (appleBridge) {
  $('#appleNotes').hidden = false;
  $('#appleNotes').addEventListener('click', showAppleMenu);
}

function applySidebar() {
  const app = $('#app');
  app.style.setProperty('--side-w', state.sidebar.w + 'px');
  app.classList.toggle('side-hidden', state.sidebar.hidden);
}
function toggleSidebar(hide = !state.sidebar.hidden) {
  state.sidebar.hidden = hide;
  applySidebar();
  renderPanes();
  save();
}
$('#sideResize').addEventListener('mousedown', e => {
  e.preventDefault();
  const x0 = e.clientX, w0 = state.sidebar.w;
  document.body.classList.add('resizing');
  const move = ev => { state.sidebar.w = clamp(w0 + ev.clientX - x0, 180, 480); applySidebar(); };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing');
    save();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});
$('#sideResize').addEventListener('dblclick', () => { state.sidebar.w = 272; applySidebar(); save(); });

/* ---------- popover menu (context menu, swatches, prompts) ---------- */
const menuEl = $('#menu');
let menuState = null;
function openMenu(x, y, html, onClick, { input = false, onCancel } = {}) {
  closeMenu();
  menuEl.innerHTML = html;
  menuEl.hidden = false;
  const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  menuEl.style.left = clamp(x, 8, innerWidth - w - 8) + 'px';
  menuEl.style.top = (y + h > innerHeight - 8 ? Math.max(8, y - h - 12) : y) + 'px';
  menuEl.onmousedown = e => { if (!input || e.target.tagName !== 'INPUT') e.preventDefault(); };
  menuEl.onclick = onClick;
  const outside = e => { if (!menuEl.contains(e.target)) cancel(); };
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
  const cancel = () => { closeMenu(); onCancel?.(); };
  // listen for outside clicks from the next tick (not the click that opened it) — unless it's already closed
  let open = true;
  setTimeout(() => { if (open) document.addEventListener('mousedown', outside, true); });
  document.addEventListener('keydown', key, true);
  menuState = () => {
    open = false;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', key, true);
  };
}
function closeMenu() {
  menuEl.hidden = true;
  menuEl.innerHTML = '';
  menuEl.onclick = null;
  menuState?.();
  menuState = null;
}
function askText(x, y, { placeholder, value = '', button = 'OK' }, onSubmit, onCancel) {
  openMenu(x, y, `<form class="ask"><input placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" spellcheck="false"><button type="submit" class="ask-go">${esc(button)}</button></form>`, null, { input: true, onCancel });
  const form = menuEl.querySelector('form'), input = form.querySelector('input');
  input.focus();
  input.select();
  form.onsubmit = e => { e.preventDefault(); const v = input.value.trim(); closeMenu(); onSubmit(v); };
}

function promptLink(ed) {
  const { from, to } = ed.state.selection;
  const c = ed.view.coordsAtPos(from);
  askText(c.left, c.bottom + 8, { placeholder: 'Paste or type a link', value: ed.getAttributes('link').href || '', button: 'Link' }, href => {
    const chain = ed.chain().focus().extendMarkRange('link');
    if (!href) return chain.unsetLink().run();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) href = 'https://' + href;
    if (from === to && !ed.isActive('link')) chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    else chain.setLink({ href }).run();
  }, () => ed.commands.focus());
}

function promptSubnote(ed, parentId) {
  const c = ed.view.coordsAtPos(ed.state.selection.from);
  askText(c.left, c.bottom + 8, { placeholder: 'Name the sub-note', button: 'Create' }, title => {
    if (!title) return ed.commands.focus();
    const n = createChild(parentId, title);
    ed.chain().focus().insertContent([{ type: 'mention', attrs: { id: n.id, label: n.title } }, { type: 'text', text: ' ' }]).run();
  }, () => ed.commands.focus());
}

function showSwatches(btn, list, text, apply) {
  const r = btn.getBoundingClientRect();
  openMenu(r.left, r.bottom + 6, `<div class="swatches">${list.map(([name, c]) =>
    `<button class="sw${text ? ' text' : ''}${c ? '' : ' none'}" data-c="${c}" title="${name}" style="--c:${c || 'transparent'}">${text ? 'A' : ''}</button>`).join('')}</div>`, e => {
    const b = e.target.closest('.sw');
    if (!b) return;
    closeMenu();
    apply(b.dataset.c);
  });
}

/* ---------- toolbar ---------- */
function toolbarHTML() {
  return `
    <select class="tb-select" data-cmd="block" title="Text style">${BLOCKS.map(b => `<option value="${b.id}">${b.label}</option>`).join('')}</select>
    <select class="tb-select" data-cmd="size" title="Text size">${SIZES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <span class="tb-sep"></span>
    <button class="tb-btn" data-cmd="bold" title="Bold (⌘B)"><b>B</b></button>
    <button class="tb-btn" data-cmd="italic" title="Italic (⌘I)"><i>I</i></button>
    <button class="tb-btn" data-cmd="underline" title="Underline (⌘U)"><u>U</u></button>
    <button class="tb-btn" data-cmd="strike" title="Strikethrough (⌘⇧S)"><s>S</s></button>
    <button class="tb-btn" data-cmd="code" title="Inline code (⌘E)">${ICON.code}</button>
    <button class="tb-btn has-swatch" data-cmd="highlight" title="Highlight">${ICON.marker}<span class="swatch"></span></button>
    <button class="tb-btn has-swatch" data-cmd="color" title="Text colour"><span class="glyph-a">A</span><span class="swatch"></span></button>
    <button class="tb-btn" data-cmd="link" title="Link (⌘K)">${ICON.link}</button>
    <button class="tb-btn" data-cmd="clear" title="Clear formatting">${ICON.clear}</button>
    <span class="tb-sep"></span>
    <button class="tb-btn labeled" data-cmd="codeblock" title="Selection → code block (⌘↵)"><span class="mono">{ }</span><span class="lbl">Code</span></button>
    <button class="tb-btn labeled" data-cmd="subnote" title="New sub-note inside this note">${ICON.subnote}<span class="lbl">Sub-note</span></button>
    <span class="tb-fill"></span>
    <button class="tb-btn" data-cmd="wide" title="Full width">${ICON.width}</button>`;
}

function runCmd(pane, cmd, value, el) {
  const h = activeHost(pane);
  if (!h) return;
  const ed = h.ed, c = () => ed.chain().focus();
  switch (cmd) {
    case 'block': setBlock(ed, value); break;
    case 'size': (value ? c().setFontSize(value) : c().unsetFontSize()).run(); break;
    case 'bold': c().toggleBold().run(); break;
    case 'italic': c().toggleItalic().run(); break;
    case 'underline': c().toggleUnderline().run(); break;
    case 'strike': c().toggleStrike().run(); break;
    case 'code': c().toggleCode().run(); break;
    case 'highlight': showSwatches(el, HIGHLIGHTS, false, color => (color ? c().setHighlight({ color }) : c().unsetHighlight()).run()); break;
    case 'color': showSwatches(el, COLORS, true, color => (color ? c().setColor(color) : c().unsetColor()).run()); break;
    case 'link': promptLink(ed); break;
    case 'clear': c().unsetAllMarks().run(); break;
    case 'codeblock': codeBlockFromSelection(ed); break;
    case 'subnote': promptSubnote(ed, h.noteId); break;
    case 'wide': state.wide = !state.wide; applyWide(); save(); break;
  }
}

function syncToolbar(pane) {
  const dom = paneDom.get(pane.id);
  if (!dom) return;
  const tb = dom.toolbar, h = activeHost(pane);
  tb.classList.toggle('disabled', !h);
  tb.querySelector('[data-cmd=wide]').classList.toggle('on', state.wide);
  if (!h) return;
  const ed = h.ed;
  tb.querySelector('[data-cmd=block]').value = currentBlock(ed);
  tb.querySelector('[data-cmd=size]').value = ed.getAttributes('textStyle').fontSize || '';
  for (const m of ['bold', 'italic', 'underline', 'strike', 'code', 'link']) tb.querySelector(`[data-cmd=${m}]`).classList.toggle('on', ed.isActive(m));
  tb.querySelector('[data-cmd=highlight] .swatch').style.background = ed.getAttributes('highlight').color || 'transparent';
  tb.querySelector('[data-cmd=color] .swatch').style.background = ed.getAttributes('textStyle').color || 'transparent';
}

const tbPending = new Set();
let tbRaf = 0;
function scheduleToolbar(paneId) {
  tbPending.add(paneId);
  tbRaf ||= requestAnimationFrame(() => {
    tbRaf = 0;
    for (const id of tbPending) { const p = paneById(id); if (p) syncToolbar(p); }
    tbPending.clear();
  });
}

const applyWide = () => {
  document.documentElement.classList.toggle('wide', state.wide);
  for (const p of state.panes) syncToolbar(p);
};

/* ---------- pane rendering ---------- */
function buildPane(pane) {
  const pid = pane.id;
  const root = document.createElement('section');
  root.className = 'pane';
  root.dataset.pane = pid;
  root.innerHTML = `<div class="pane-resize"></div><div class="tabbar"></div><div class="toolbar">${toolbarHTML()}</div><div class="hosts"><div class="empty">No note open. Pick one on the left, or press ⌘N for a new one.</div></div>`;
  const dom = { root, tabbar: root.querySelector('.tabbar'), toolbar: root.querySelector('.toolbar'), hosts: root.querySelector('.hosts'), empty: root.querySelector('.empty') };
  paneDom.set(pid, dom);

  root.addEventListener('mousedown', () => setFocus(pid), true);
  root.addEventListener('focusin', () => setFocus(pid));

  dom.tabbar.addEventListener('mousedown', e => { if (e.target.closest('button, .tab')) e.preventDefault(); });
  dom.tabbar.addEventListener('click', e => {
    const p = paneById(pid);
    const act = e.target.closest('[data-act]')?.dataset.act;
    const tab = e.target.closest('.tab');
    if (act === 'close' && tab) return closeTab(p, tab.dataset.id);
    if (tab) return activateTab(p, tab.dataset.id);
    if (act === 'newtab') return newNote('tab');
    if (act === 'split' && p.active) return openNote(p.active, 'side', { pane: p });
    if (act === 'closepane') return closePane(p);
    if (act === 'showside') return toggleSidebar(false);
  });
  dom.tabbar.addEventListener('auxclick', e => {
    const tab = e.target.closest('.tab');
    if (tab && e.button === 1) closeTab(paneById(pid), tab.dataset.id);
  });

  dom.toolbar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  dom.toolbar.addEventListener('click', e => {
    const b = e.target.closest('button[data-cmd]');
    if (b) runCmd(paneById(pid), b.dataset.cmd, null, b);
  });
  dom.toolbar.addEventListener('change', e => {
    const s = e.target.closest('select[data-cmd]');
    if (s) runCmd(paneById(pid), s.dataset.cmd, s.value, s);
  });

  root.querySelector('.pane-resize').addEventListener('mousedown', e => {
    const i = state.panes.findIndex(p => p.id === pid);
    if (i < 1) return;
    e.preventDefault();
    const a = state.panes[i - 1], b = state.panes[i];
    const ra = paneDom.get(a.id).root;
    const wa = ra.offsetWidth, wb = root.offsetWidth, total = a.flex + b.flex, x0 = e.clientX;
    document.body.classList.add('resizing');
    const move = ev => {
      const na = clamp(wa + ev.clientX - x0, 280, wa + wb - 280);
      a.flex = total * na / (wa + wb);
      b.flex = total - a.flex;
      ra.style.flex = `${a.flex} 1 0`;
      root.style.flex = `${b.flex} 1 0`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      save();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  return dom;
}

function renderTabbar(pane, dom, i) {
  const showSide = state.sidebar.hidden && i === 0;
  dom.tabbar.innerHTML = `
    ${showSide ? `<button class="tb-btn" data-act="showside" title="Show sidebar (⌘\\)">${ICON.sidebar}</button>` : ''}
    <div class="tabs">${pane.tabs.map(id => `<div class="tab${id === pane.active ? ' on' : ''}" data-id="${id}" title="${esc(titleOf(id) || 'Untitled')}"><span class="tab-title">${esc(titleOf(id) || 'Untitled')}</span><button class="tab-x" data-act="close" tabindex="-1" aria-label="Close tab">${ICON.x}</button></div>`).join('')}
      <button class="tb-btn" data-act="newtab" title="New note in a new tab (⌘T)">${ICON.plus}</button>
    </div>
    <div class="tb-right">
      <button class="tb-btn" data-act="split" title="Open this note side by side">${ICON.split}</button>
      ${state.panes.length > 1 ? `<button class="tb-btn" data-act="closepane" title="Close this pane">${ICON.x}</button>` : ''}
    </div>`;
}

function renderPanes() {
  for (const [pid, dom] of paneDom) {
    if (state.panes.some(p => p.id === pid)) continue;
    dom.root.remove();
    paneDom.delete(pid);
  }
  state.panes.forEach((pane, i) => {
    const dom = paneDom.get(pane.id) || buildPane(pane);
    if (panesEl.children[i] !== dom.root) panesEl.insertBefore(dom.root, panesEl.children[i] || null);
    dom.root.style.flex = `${pane.flex} 1 0`;
    dom.root.classList.toggle('focused', i === state.focus);
    renderTabbar(pane, dom, i);
    for (const h of editors.values()) if (h.paneId === pane.id) h.host.hidden = h.noteId !== pane.active;
    dom.empty.hidden = !!pane.active;
    if (pane.active) ensureHost(pane, pane.active).host.hidden = false;
    syncToolbar(pane);
  });
}

// Tabs, breadcrumbs and sub-note lists all show titles and structure; redraw them together.
function renderChrome() {
  state.panes.forEach((pane, i) => { const dom = paneDom.get(pane.id); if (dom) renderTabbar(pane, dom, i); });
  for (const h of editors.values()) { renderCrumbs(h); renderChildren(h); }
}

function renderCrumbs(h) {
  const i = idx(h.noteId);
  if (i < 0) return;
  h.crumbs.innerHTML = ancestors(i).map(a => `<button data-open="${a.id}">${esc(a.title || 'Untitled')}</button>`).join('<span class="sep">/</span>');
}

function renderChildren(h) {
  const i = idx(h.noteId);
  if (i < 0) return;
  const kids = childrenOf(i);
  h.kids.innerHTML = (kids.length ? `<span class="kids-label">Inside this note</span>${kids.map(k =>
    `<button class="child-chip" data-open="${k.id}"><span class="dot"></span>${esc(k.title || 'Untitled')}</button>`).join('')}` : '')
    + `<button class="add-child" data-act="addchild">${ICON.plus}Sub-note</button>`;
}

function searchNotes(query, selfId) {
  const q = query.toLowerCase();
  const hits = state.items
    // blank notes are about to be removed, so don't offer them as link targets
    .filter(it => it.id !== selfId && (it.title.trim() || !docIsEmpty(it.doc)) && (!q || it.title.toLowerCase().includes(q)))
    .sort((a, b) => (b.title.toLowerCase().startsWith(q) ? 1 : 0) - (a.title.toLowerCase().startsWith(q) ? 1 : 0))
    .slice(0, 8)
    .map(it => {
      const a = ancestors(idx(it.id));
      return { id: it.id, label: it.title || 'Untitled', path: a.length ? a[a.length - 1].title : '' };
    });
  if (q && !state.items.some(it => it.title.toLowerCase() === q)) hits.push({ create: true, title: query });
  return hits;
}

function ensureHost(pane, noteId) {
  const k = hostKey(pane.id, noteId);
  if (editors.has(k)) return editors.get(k);
  const host = document.createElement('div');
  host.className = 'host';
  host.innerHTML = '<div class="doc"><nav class="crumbs"></nav><input class="doc-title" placeholder="Untitled" spellcheck="false"><div class="editor"></div><div class="kids"></div></div>';
  paneDom.get(pane.id).hosts.append(host);
  const h = { paneId: pane.id, noteId, host, titleEl: host.querySelector('.doc-title'), crumbs: host.querySelector('.crumbs'), kids: host.querySelector('.kids') };
  h.titleEl.value = titleOf(noteId);
  h.ed = createEditor({
    element: host.querySelector('.editor'),
    content: byId(noteId).doc,
    ctx: {
      titleOf: id => byId(id)?.title,
      exists: id => !!byId(id),
      searchNotes: q => searchNotes(q, noteId),
      createChild: title => createChild(noteId, title),
      openNote: (id, e) => { if (byId(id)) openNote(id, e?.metaKey || e?.ctrlKey ? 'tab' : e?.altKey ? 'side' : 'here', { pane: paneById(h.paneId) }); },
      promptLink,
      promptSubnote: ed => promptSubnote(ed, noteId),
      onEscape: () => focusTitle(noteId),
    },
    onUpdate: ed => {
      const it = byId(noteId);
      if (!it) return;
      it.doc = ed.getJSON();
      for (const o of editors.values()) if (o !== h && o.noteId === noteId && !o.ed.isFocused) o.ed.commands.setContent(it.doc, { emitUpdate: false });
      save();
    },
    onChange: () => scheduleToolbar(h.paneId),
    onFocus: () => setFocus(h.paneId),
  });

  h.titleEl.addEventListener('input', () => setTitle(noteId, h.titleEl.value, h.titleEl));
  h.titleEl.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'Tab') { e.preventDefault(); focusNow(h.ed, 'start'); }
    else if (e.key === 'Escape') { e.preventDefault(); focusTitle(noteId); }
  });
  host.addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) { openNote(open.dataset.open, e.metaKey || e.ctrlKey ? 'tab' : e.altKey ? 'side' : 'here', { pane: paneById(h.paneId) }); return; }
    if (e.target.closest('[data-act=addchild]')) newChild(idx(noteId));
  });
  // clicking the empty space under a note drops the caret at its end
  host.addEventListener('mousedown', e => {
    if (e.target === host || e.target.classList.contains('doc')) { e.preventDefault(); focusNow(h.ed, 'end'); }
  });

  editors.set(k, h);
  renderCrumbs(h);
  renderChildren(h);
  return h;
}

/* ---------- global keys ---------- */
document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  const pane = focusedPane();
  if (k === 's') { e.preventDefault(); saveNow(); }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); newNote('here'); }
  else if (k === 't' && !e.shiftKey) { e.preventDefault(); newNote('tab'); }
  else if (k === 'w' && !e.shiftKey) { e.preventDefault(); if (pane?.active) closeTab(pane, pane.active); }
  else if (e.key === '\\') { e.preventDefault(); toggleSidebar(); }
  else if (e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft') && pane?.tabs.length > 1) {
    e.preventDefault();
    const step = e.code === 'BracketRight' ? 1 : -1;
    const n = pane.tabs.length;
    activateTab(pane, pane.tabs[(pane.tabs.indexOf(pane.active) + step + n) % n]);
  }
});

/* ---------- boot ---------- */
sweep({ atLoad: true });
cleanPanes();
if (!focusedPane().active) {
  const p = focusedPane();
  p.tabs = [state.items[0].id];
  p.active = state.items[0].id;
}
applySidebar();
applyWide();
renderTree();
renderPanes();
if (native) saveNow();
focusTitle(currentId());
