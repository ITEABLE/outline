import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color, FontSize } from '@tiptap/extension-text-style';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Mention from '@tiptap/extension-mention';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import Suggestion from '@tiptap/suggestion';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { createLowlight } from 'lowlight';
import plaintext from 'highlight.js/lib/languages/plaintext';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import swift from 'highlight.js/lib/languages/swift';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import { marked } from 'marked';
import { detect } from './detect.js';
import { TerminalNode, termBridge, newSid } from './terminal.js';

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.append(t); t.select();
    document.execCommand('copy'); t.remove();
  }
}

/* ---------- code languages ---------- */
export const LANGS = [
  ['plaintext', 'text'], ['bash', 'bash'], ['json', 'json'], ['python', 'python'],
  ['javascript', 'javascript'], ['typescript', 'typescript'], ['sql', 'sql'], ['html', 'html'],
  ['css', 'css'], ['swift', 'swift'], ['markdown', 'markdown'], ['yaml', 'yaml'],
];
const ALIAS = {
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext', sh: 'bash', shell: 'bash', zsh: 'bash',
  console: 'bash', shellscript: 'bash', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', python3: 'python', yml: 'yaml', md: 'markdown',
  xml: 'html', htm: 'html', svg: 'html',
};
export const normLang = l => {
  const k = String(l || '').toLowerCase();
  const v = ALIAS[k] || k;
  return LANGS.some(([id]) => id === v) ? v : 'plaintext';
};
const lowlight = createLowlight({ plaintext, bash, json, python, javascript, typescript, sql, xml, css, swift, markdown, yaml });
lowlight.registerAlias({ xml: ['html'] });

function unwrapCodeAt(editor, pos) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const paras = node.textContent.split('\n').map(l => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] }));
  editor.chain().focus().insertContentAt({ from: pos, to: pos + node.nodeSize }, paras).run();
}

// ⌘↵: selection (or the current line) becomes a code block; inside a code block it goes back to text.
export function codeBlockFromSelection(editor) {
  const { state } = editor;
  const { from, to, empty, $from } = state.selection;
  if ($from.parent.type.name === 'codeBlock') { unwrapCodeAt(editor, $from.before()); return true; }
  let range = { from, to }, text;
  if (empty) { range = { from: $from.before(), to: $from.after() }; text = $from.parent.textContent; }
  else text = state.doc.textBetween(from, to, '\n');
  const node = { type: 'codeBlock', attrs: { language: detect(text), auto: true }, content: text ? [{ type: 'text', text }] : [] };
  editor.chain().focus().insertContentAt(range, node).run();
  return true;
}

const CodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      language: {
        default: 'plaintext',
        rendered: false,
        parseHTML: el => {
          const code = el.querySelector('code') || el;
          const cls = [...code.classList].find(c => /^lang(uage)?-/.test(c));
          const named = el.getAttribute('data-language') || cls?.replace(/^lang(uage)?-/, '');
          return named ? normLang(named) : detect(code.textContent);
        },
      },
      auto: {
        default: false,
        parseHTML: el => {
          if (el.getAttribute('data-auto')) return el.getAttribute('data-auto') === 'true';
          const code = el.querySelector('code') || el;
          return ![...code.classList].some(c => /^lang(uage)?-/.test(c)) && !el.getAttribute('data-language');
        },
        renderHTML: a => (a.auto ? { 'data-auto': 'true' } : { 'data-auto': 'false' }),
      },
    };
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'code';
      const head = document.createElement('div');
      head.className = 'code-head';
      head.contentEditable = 'false';
      head.innerHTML = `<label class="lang"><span class="lang-name"></span><span class="caret">▼</span><select title="Language">${LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label><span class="auto" title="Language detected automatically">auto</span><span class="sp"></span><button type="button" class="cb-btn" data-act="copy">copy</button><button type="button" class="cb-btn" data-act="unwrap" title="Back to plain text (⌘↵)">unwrap</button>`;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.append(code);
      dom.append(head, pre);
      const select = head.querySelector('select');
      const sync = () => {
        const l = current.attrs.language || 'plaintext';
        dom.dataset.lang = l;
        select.value = l;
        head.querySelector('.lang-name').textContent = LANGS.find(([v]) => v === l)?.[1] || l;
        dom.classList.toggle('is-auto', !!current.attrs.auto);
      };
      sync();
      select.addEventListener('change', () => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: select.value, auto: false }));
        editor.commands.focus();
      });
      head.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        if (b.dataset.act === 'copy') {
          copyText(current.textContent);
          b.textContent = 'copied';
          setTimeout(() => { b.textContent = 'copy'; }, 1000);
        } else {
          const pos = getPos();
          if (typeof pos === 'number') unwrapCodeAt(editor, pos);
        }
      });
      return {
        dom,
        contentDOM: code,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          sync();
          return true;
        },
        stopEvent: e => head.contains(e.target),
        ignoreMutation: m => head.contains(m.target),
      };
    };
  },
});

// Code blocks flagged "auto" keep re-guessing their language as you type.
function autoLang(editor) {
  if (editor.isDestroyed) return;
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return;
    if (node.attrs.auto) {
      const lang = detect(node.textContent);
      if (lang !== node.attrs.language) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: lang }); changed = true; }
    }
    return false;
  });
  if (changed) { tr.setMeta('addToHistory', false); editor.view.dispatch(tr); }
}

/* ---------- pictures ---------- */
// In the Mac app pictures are saved as files beside the notes (mac/images.swift); in a browser they stay inline.
const imagesBridge = window.webkit?.messageHandlers?.images || null;
const isImage = f => f && /^image\//.test(f.type);

const readDataUrl = file => new Promise((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.onerror = () => no(r.error);
  r.readAsDataURL(file);
});
const naturalWidth = src => new Promise(ok => {
  const img = new window.Image();
  img.onload = () => ok(img.naturalWidth);
  img.onerror = () => ok(0);
  img.src = src;
});

async function storeImage(file) {
  const dataUrl = await readDataUrl(file);
  const w = await naturalWidth(dataUrl);
  const src = imagesBridge
    ? await imagesBridge.postMessage({ op: 'save', type: file.type, b64: dataUrl.slice(dataUrl.indexOf(',') + 1) })
    : dataUrl;
  // a Retina screenshot has twice the pixels it showed on screen; start it at its on-screen size
  return { src, width: w ? Math.round(w / (window.devicePixelRatio || 1)) : null };
}

// Adds pictures at the caret (or at `pos`, where they were dropped).
export async function insertImages(editor, files, pos) {
  const list = [...files].filter(isImage);
  if (!list.length) return false;
  let nodes;
  try { nodes = (await Promise.all(list.map(storeImage))).map(attrs => ({ type: 'image', attrs })); }
  catch (e) { alert(e.message || String(e)); return true; }
  if (editor.isDestroyed) return true;
  if (typeof pos === 'number') return editor.chain().focus().insertContentAt(pos, nodes).run();
  leaveEmptyListItem(editor);
  const { $from } = editor.state.selection;
  const empty = $from.parent.type.name === 'paragraph' && !$from.parent.content.size && $from.depth === 1;
  if (!empty) return editor.chain().focus().insertContent(nodes).run();
  // pictures are one position each, so the line after them starts right past the last one
  const at = $from.before();
  editor.chain().focus().insertContentAt({ from: at, to: $from.after() }, nodes).run();
  if (editor.state.doc.nodeAt(at + nodes.length)?.type.name !== 'paragraph') editor.commands.insertContentAt(at + nodes.length, { type: 'paragraph' });
  return editor.chain().setTextSelection(at + nodes.length + 1).focus().run();
}

// Opens the file picker for pictures.
export function pickImages(editor) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.hidden = true;
  document.body.append(input); // a detached input may never report its files
  input.onchange = () => { if (input.files.length) insertImages(editor, input.files); input.remove(); };
  input.addEventListener('cancel', () => input.remove());
  input.click();
  return true;
}

// Not draggable as a whole: in the Mac app a drag on the picture grabbed the mouse before its resize handles could.
const Picture = Image.extend({ draggable: false }).configure({
  inline: false,
  allowBase64: true,
  resize: { enabled: true, directions: ['left', 'right', 'bottomLeft', 'bottomRight'], minWidth: 60, minHeight: 30, alwaysPreserveAspectRatio: true },
});

/* ---------- block types (toolbar + slash menu) ---------- */
export const BLOCKS = [
  { id: 'paragraph', label: 'Text', icon: 'T', keys: 'text plain paragraph' },
  { id: 'h1', label: 'Heading 1', icon: 'H1', keys: 'heading title big' },
  { id: 'h2', label: 'Heading 2', icon: 'H2', keys: 'heading subtitle' },
  { id: 'h3', label: 'Heading 3', icon: 'H3', keys: 'heading small' },
  { id: 'bullet', label: 'Bullet list', icon: '•', keys: 'ul list unordered' },
  { id: 'ordered', label: 'Numbered list', icon: '1.', keys: 'ol number ordered' },
  { id: 'task', label: 'Checklist', icon: '☐', keys: 'todo task check' },
  { id: 'quote', label: 'Quote', icon: '❝', keys: 'blockquote' },
  { id: 'code', label: 'Code block', icon: '{}', keys: 'pre snippet' },
];

export function currentBlock(editor) {
  if (editor.isActive('codeBlock')) return 'code';
  for (const level of [1, 2, 3]) if (editor.isActive('heading', { level })) return 'h' + level;
  if (editor.isActive('taskList')) return 'task';
  if (editor.isActive('orderedList')) return 'ordered';
  if (editor.isActive('bulletList')) return 'bullet';
  if (editor.isActive('blockquote')) return 'quote';
  return 'paragraph';
}

export function setBlock(editor, id) {
  const list = ['bulletList', 'orderedList', 'taskList'].find(n => editor.isActive(n));
  const plain = () => {
    let ch = editor.chain().focus();
    if (editor.isActive('codeBlock')) ch = ch.setParagraph();
    if (list === 'bulletList') ch = ch.toggleBulletList();
    else if (list === 'orderedList') ch = ch.toggleOrderedList();
    else if (list === 'taskList') ch = ch.toggleTaskList();
    if (editor.isActive('blockquote')) ch = ch.unsetBlockquote();
    return ch;
  };
  const c = () => editor.chain().focus();
  switch (id) {
    case 'paragraph': return plain().setParagraph().run();
    case 'h1': case 'h2': case 'h3': return plain().setHeading({ level: +id[1] }).run();
    case 'bullet': return list === 'bulletList' || c().toggleBulletList().run();
    case 'ordered': return list === 'orderedList' || c().toggleOrderedList().run();
    case 'task': return list === 'taskList' || c().toggleTaskList().run();
    case 'quote': return editor.isActive('blockquote') || c().toggleBlockquote().run();
    case 'code': return editor.isActive('codeBlock') || codeBlockFromSelection(editor);
  }
  return false;
}

/* ---------- suggestion popups (@ and /) ---------- */
function popup(renderItem) {
  return () => {
    let el = null, items = [], index = 0, props = null;
    const draw = () => {
      el.innerHTML = items.length
        ? items.map((it, i) => `<button type="button" class="pop-item${i === index ? ' on' : ''}" data-i="${i}">${renderItem(it)}</button>`).join('')
        : '<div class="pop-empty">No matches</div>';
      el.querySelector('.pop-item.on')?.scrollIntoView({ block: 'nearest' });
    };
    const place = () => {
      const r = props?.clientRect?.();
      if (!r || !el) return;
      const h = el.offsetHeight, w = el.offsetWidth;
      const top = r.bottom + 6 + h > innerHeight - 8 ? r.top - h - 6 : r.bottom + 6;
      el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
      el.style.top = Math.max(8, top) + 'px';
    };
    const pick = i => { if (items[i]) props.command(items[i]); };
    return {
      onStart(p) {
        props = p; items = p.items; index = 0;
        el = document.createElement('div');
        el.className = 'popup';
        el.addEventListener('mousedown', e => {
          e.preventDefault();
          const b = e.target.closest('[data-i]');
          if (b) pick(+b.dataset.i);
        });
        document.body.append(el);
        draw(); place();
      },
      onUpdate(p) {
        props = p; items = p.items;
        index = Math.min(index, Math.max(0, items.length - 1));
        if (el) { el.hidden = false; draw(); place(); }
      },
      onKeyDown({ event }) {
        if (!el || el.hidden) return false;
        if (event.key === 'ArrowDown') { index = (index + 1) % Math.max(1, items.length); draw(); return true; }
        if (event.key === 'ArrowUp') { index = (index - 1 + items.length) % Math.max(1, items.length); draw(); return true; }
        if (event.key === 'Enter' || event.key === 'Tab') { if (!items.length) return false; pick(index); return true; }
        if (event.key === 'Escape') { el.hidden = true; return true; }
        return false;
      },
      onExit() { el?.remove(); el = null; },
    };
  };
}

const SLASH = [
  ...BLOCKS,
  { id: 'divider', label: 'Divider', icon: '—', keys: 'hr line separator' },
  { id: 'image', label: 'Picture', icon: '▣', keys: 'image photo screenshot attach png jpg', hint: 'from a file' },
  { id: 'terminal', label: 'Terminal', icon: '›_', keys: 'shell console command zsh claude', hint: 'a live shell' },
  { id: 'subnote', label: 'Sub-note', icon: '+', keys: 'page child note inside', hint: 'a note inside this one' },
  { id: 'mention', label: 'Link to a note', icon: '@', keys: 'mention reference' },
];

function slashCommands(ctx) {
  return Extension.create({
    name: 'slashCommands',
    addProseMirrorPlugins() {
      return [Suggestion({
        editor: this.editor,
        char: '/',
        pluginKey: new PluginKey('slashCommands'),
        shouldShow: ({ editor }) => !editor.isActive('codeBlock'),
        items: ({ query }) => {
          const q = query.toLowerCase();
          return SLASH.filter(s => (s.id !== 'terminal' || termBridge) && (!q || s.id.startsWith(q) || s.label.toLowerCase().includes(q) || s.keys?.includes(q)));
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run();
          if (props.id === 'divider') editor.chain().focus().setHorizontalRule().run();
          else if (props.id === 'terminal') insertTerminal(editor);
          else if (props.id === 'image') pickImages(editor);
          else if (props.id === 'subnote') ctx.promptSubnote?.(editor);
          else if (props.id === 'mention') editor.chain().focus().insertContent('@').run();
          else setBlock(editor, props.id);
        },
        render: popup(s => `<span class="pi-ico">${esc(s.icon)}</span><span>${esc(s.label)}</span>${s.hint ? `<span class="pi-hint">${esc(s.hint)}</span>` : ''}`),
      })];
    },
  });
}

function noteLinks(ctx) {
  return Mention.configure({
    HTMLAttributes: { class: 'mention' },
    renderText: ({ node }) => `@${ctx.titleOf?.(node.attrs.id) ?? node.attrs.label ?? ''}`,
    renderHTML: ({ options, node }) => [
      'span',
      { ...options.HTMLAttributes, class: 'mention' + (ctx.exists && !ctx.exists(node.attrs.id) ? ' missing' : '') },
      `@${ctx.titleOf?.(node.attrs.id) || node.attrs.label || 'Untitled'}`,
    ],
    suggestion: {
      char: '@',
      pluginKey: new PluginKey('noteLinks'),
      shouldShow: ({ editor }) => !editor.isActive('codeBlock'),
      items: ({ query }) => ctx.searchNotes?.(query) ?? [],
      command: ({ editor, range, props }) => {
        let attrs = props;
        if (props.create) {
          const n = ctx.createChild(props.title);
          attrs = { id: n.id, label: n.title };
        }
        editor.chain().focus().insertContentAt(range, [
          { type: 'mention', attrs: { id: attrs.id, label: attrs.label } },
          { type: 'text', text: ' ' },
        ]).run();
      },
      render: popup(it => it.create
        ? `<span class="pi-ico">+</span><span>Create sub-note <b>${esc(it.title)}</b></span>`
        : `<span class="pi-ico">@</span><span>${esc(it.label)}</span>${it.path ? `<span class="pi-hint">${esc(it.path)}</span>` : ''}`),
    },
  });
}

/* ---------- pasting Markdown ---------- */
const MD_SIGNS = [
  /^```/m, /^#{1,6}\s+\S/m, /\*\*[^*\n]+\*\*/, /^\s*[-*+]\s+\[[ xX]\]\s/m, /^\s*>\s+\S/m,
  /\[[^\]\n]+\]\([^)\s]+\)/, /^\|.+\|\s*$/m, /(^|\n)\s*(\d+\.|[-*+])\s+\S[^\n]*\n\s*(\d+\.|[-*+])\s+\S/, /`[^`\n]+`/,
];
const looksLikeMarkdown = t => MD_SIGNS.some(r => r.test(t));
// HTML that already carries structure (from a web page, Notes, Word) is better than our Markdown guess.
const richHtml = h => !!h && /<(h[1-6]|ul|ol|pre|strong|b|em|i|table|blockquote|code)[\s>]/i.test(h);

export function mdToHtml(md) {
  const html = marked.parse(md, { gfm: true, async: false });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('ul').forEach(ul => {
    const lis = [...ul.children];
    if (!lis.length || !lis.every(li => li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]'))) return;
    ul.setAttribute('data-type', 'taskList');
    for (const li of lis) {
      const cb = li.querySelector('input[type=checkbox]');
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', cb.checked ? 'true' : 'false');
      cb.remove();
    }
  });
  return doc.body.innerHTML;
}

// Pasting several lines onto an empty bullet (every new note starts as one) would put the
// whole paste — headings, code, lists — inside that bullet. Step out of the list first.
export function leaveEmptyListItem(editor) {
  const { empty, $from } = editor.state.selection;
  if (!empty || $from.parent.content.size) return;
  for (const type of ['listItem', 'taskItem']) {
    while (editor.can().liftListItem(type)) editor.commands.liftListItem(type);
  }
}

const SmartPaste = Extension.create({
  name: 'smartPaste',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: new PluginKey('smartPaste'),
      props: {
        handlePaste(view, event) {
          const dt = event.clipboardData;
          // a screenshot or copied picture comes as a file (a copied web image may also carry HTML; the file wins)
          const files = [...(dt?.files || [])].filter(isImage);
          if (files.length && !editor.isActive('codeBlock')) { insertImages(editor, files); return true; }
          const text = dt?.getData('text/plain');
          if (!text || editor.isActive('codeBlock')) return false;
          const html = dt.getData('text/html');
          if (text.trim().includes('\n') || richHtml(html)) leaveEmptyListItem(editor);
          if (richHtml(html)) return false;
          if (looksLikeMarkdown(text)) {
            editor.chain().focus().insertContent(mdToHtml(text)).run();
            return true;
          }
          const lang = text.includes('\n') ? detect(text) : 'plaintext';
          if (lang !== 'plaintext') {
            editor.chain().focus().insertContent({
              type: 'codeBlock', attrs: { language: lang, auto: true },
              content: [{ type: 'text', text: text.replace(/\n+$/, '') }],
            }).run();
            return true;
          }
          return false;
        },
        handleDrop(view, event, slice, moved) {
          if (moved) return false;
          const files = [...(event.dataTransfer?.files || [])].filter(isImage);
          if (!files.length) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          insertImages(editor, files, at ? at.pos : undefined);
          return true;
        },
      },
    })];
  },
});

// Adds a live terminal under the caret (stepping out of an empty bullet first), with a line after it to keep typing.
export function insertTerminal(editor) {
  leaveEmptyListItem(editor);
  const { $from } = editor.state.selection;
  const empty = $from.parent.type.name === 'paragraph' && !$from.parent.content.size && $from.depth === 1;
  const node = { type: 'terminal', attrs: { sid: newSid() } };
  if (empty) editor.chain().focus().insertContentAt({ from: $from.before(), to: $from.after() }, [node, { type: 'paragraph' }]).run();
  else editor.chain().focus().insertContent([node, { type: 'paragraph' }]).run();
  return true;
}

/* ---------- keys ---------- */
function keys(ctx) {
  return Extension.create({
    name: 'outlineKeys',
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        // Enter over a selection that spans blocks at different depths (e.g. across nested
        // bullets) makes ProseMirror's split throw. Delete the selection first, then let the
        // normal Enter handlers split the collapsed caret.
        Enter: () => {
          const { empty, $from, $to } = this.editor.state.selection;
          if (!empty && !$from.sameParent($to)) this.editor.commands.deleteSelection();
          return false;
        },
        'Mod-Enter': () => codeBlockFromSelection(this.editor),
        'Mod-k': () => { ctx.promptLink?.(this.editor); return true; },
      };
    },
  });
}
// Runs last: keeps Tab from leaving the editor and lets Esc jump to the sidebar.
function fallbackKeys(ctx) {
  return Extension.create({
    name: 'outlineFallbackKeys',
    priority: 1,
    addKeyboardShortcuts() {
      return {
        Tab: () => true,
        'Shift-Tab': () => true,
        Escape: () => { ctx.onEscape?.(); return true; },
      };
    },
  });
}

export function buildExtensions(ctx = {}) {
  return [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener noreferrer', target: null } },
      dropcursor: { color: '#8ab4f8', width: 2 },
    }),
    Picture,
    CodeBlock.configure({ lowlight, defaultLanguage: 'plaintext', enableTabIndentation: true, tabSize: 2, exitOnTripleEnter: true, exitOnArrowDown: true }),
    Highlight.configure({ multicolor: true }),
    TextStyle, Color, FontSize,
    TaskList, TaskItem.configure({ nested: true }),
    Placeholder.configure({
      includeChildren: true,
      placeholder: ({ node }) => node.type.name === 'heading' ? `Heading ${node.attrs.level}`
        : node.type.name === 'codeBlock' ? '' : 'Type / for blocks, @ to link a note',
    }),
    TerminalNode.configure({ noteTitle: () => ctx.noteTitle?.() ?? '' }),
    noteLinks(ctx),
    slashCommands(ctx),
    SmartPaste,
    keys(ctx),
    fallbackKeys(ctx),
  ];
}

export function createEditor({ element, content, ctx, onUpdate, onChange, onFocus }) {
  const editor = new Editor({
    element,
    content,
    extensions: buildExtensions(ctx),
    editorProps: { attributes: { class: 'prose', spellcheck: 'true' } },
    onUpdate: () => onUpdate?.(editor),
    onTransaction: () => onChange?.(editor),
    onFocus: () => onFocus?.(editor),
  });
  let t;
  editor.on('update', () => { clearTimeout(t); t = setTimeout(() => autoLang(editor), 400); });
  element.addEventListener('click', e => {
    const m = e.target.closest('.mention');
    if (m) { e.preventDefault(); ctx.openNote?.(m.getAttribute('data-id'), e); return; }
    const a = e.target.closest('a[href]');
    if (a && (e.metaKey || e.ctrlKey)) { e.preventDefault(); window.open(a.href, '_blank'); }
  });
  return editor;
}

// Converts HTML to the stored document format without showing an editor.
let headless;
export function htmlToDoc(html) {
  headless ??= new Editor({ element: null, extensions: buildExtensions({}), content: '' });
  headless.commands.setContent(html || '<p></p>', { emitUpdate: false });
  return headless.getJSON();
}

export function docIsEmpty(doc) {
  let empty = true;
  (function walk(n) {
    if (!empty || !n) return;
    if (n.type === 'text' && n.text?.trim()) { empty = false; return; }
    if (n.type === 'mention' || n.type === 'horizontalRule' || n.type === 'terminal' || n.type === 'image') { empty = false; return; }
    n.content?.forEach(walk);
  })(doc);
  return empty;
}

// Renames @-links to a note inside a stored document. Returns true if any changed.
export function relabelDoc(doc, id, label) {
  let changed = false;
  (function walk(n) {
    if (!n) return;
    if (n.type === 'mention' && n.attrs?.id === id && n.attrs.label !== label) { n.attrs.label = label; changed = true; }
    n.content?.forEach(walk);
  })(doc);
  return changed;
}
