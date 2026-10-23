import { htmlToDoc, docIsEmpty, esc } from './editor.js';

/* ---------- Outline → Apple Notes ----------
   Apple Notes keeps a small slice of HTML: <h1>–<h3>, <div> lines, <b> <i> <u> <strike>,
   <tt> (monospace), <ul>/<ol>, links and inline colour. Everything else is flattened to that.
   Its first line becomes the note's name, so the title goes first as <h1>. */

const textOf = n => (n.type === 'text' ? n.text : (n.content || []).map(textOf).join(''));

// Trailing empty blocks come and go as you edit; leave them out so they don't count as changes.
function trimmed(doc) {
  const c = [...(doc?.content || [])];
  while (c.length && docIsEmpty({ content: [c[c.length - 1]] })) c.pop();
  return c;
}

function inline(nodes = []) {
  return nodes.map(n => {
    if (n.type === 'hardBreak') return '<br>';
    if (n.type === 'mention') return esc(`@${n.attrs?.label || 'note'}`);
    if (n.type !== 'text') return '';
    let s = esc(n.text);
    for (const m of n.marks || []) {
      if (m.type === 'bold') s = `<b>${s}</b>`;
      else if (m.type === 'italic') s = `<i>${s}</i>`;
      else if (m.type === 'underline') s = `<u>${s}</u>`;
      else if (m.type === 'strike') s = `<strike>${s}</strike>`;
      else if (m.type === 'code') s = `<tt>${s}</tt>`;
      // Apple Notes drops link targets (keeps only an underline) but turns written-out URLs into links
      else if (m.type === 'link' && m.attrs?.href) {
        const bare = m.attrs.href.replace(/^[a-z]+:\/\/(www\.)?/i, '').replace(/\/$/, '');
        if (!n.text.includes(bare)) s = `${s} (${esc(m.attrs.href)})`;
      }
      else if (m.type === 'highlight' && m.attrs?.color) s = `<span style="background-color: ${esc(m.attrs.color)}">${s}</span>`;
      else if (m.type === 'textStyle' && m.attrs?.color) s = `<span style="color: ${esc(m.attrs.color)}">${s}</span>`;
    }
    return s;
  }).join('');
}

const LISTS = new Set(['bulletList', 'orderedList']);

// Apple Notes merges a numbered list into a bullet list right before it (and vice versa);
// a blank line between them keeps them apart.
function blocks(nodes = []) {
  return nodes.map((n, i) => {
    const prev = nodes[i - 1];
    const gap = prev && LISTS.has(n.type) && LISTS.has(prev.type) && n.type !== prev.type ? '<div><br></div>' : '';
    return gap + block(n);
  }).join('');
}

function listItem(li) {
  const [first, ...rest] = li.content || [];
  const head = first?.type === 'paragraph' ? inline(first.content) : first ? block(first) : '';
  return `<li>${head || '<br>'}${blocks(rest)}</li>`;
}

function block(n) {
  const kids = () => blocks(n.content);
  switch (n.type) {
    case 'paragraph': return `<div>${inline(n.content) || '<br>'}</div>`;
    // Apple Notes keeps three heading looks: bold 20px, its own Heading (18px) and plain bold
    // (other sizes like 17px get flattened). The note title itself is its 24px Title.
    case 'heading': {
      const inner = inline(n.content);
      if (n.attrs?.level === 1) return `<div><b><span style="font-size: 20px">${inner}</span></b></div>`;
      if (n.attrs?.level === 2) return `<div><h2>${inner}</h2></div>`;
      return `<div><b>${inner}</b></div>`;
    }
    case 'bulletList': return `<ul>${(n.content || []).map(listItem).join('')}</ul>`;
    case 'orderedList': return `<ol>${(n.content || []).map(listItem).join('')}</ol>`;
    // Apple Notes can't receive real checklists from a script; ☐/☑ lines come back as checklists
    case 'taskList': return (n.content || []).map(t => {
      const [first, ...rest] = t.content || [];
      return `<div>${t.attrs?.checked ? '☑' : '☐'} ${first ? inline(first.content) : ''}</div>${rest.map(block).join('')}`;
    }).join('');
    case 'blockquote': return `<blockquote>${kids()}</blockquote>`;
    // Apple Notes collapses ordinary spaces, so indentation is sent as non-breaking spaces
    case 'codeBlock': return textOf(n).split('\n').map(l => `<div><tt>${esc(l.replace(/\t/g, '  ')).replace(/ /g, '&nbsp;') || '<br>'}</tt></div>`).join('');
    case 'horizontalRule': return '<div>———</div>';
    case 'terminal': return '<div><tt>[Terminal — open this note in Outline to use it]</tt></div>';
    default: return kids();
  }
}

export function docToNotesHtml(title, doc, path = '') {
  let html = `<div><h1>${esc(title || 'Untitled')}</h1></div>`;
  if (path) html += `<div><i>In: ${esc(path)}</i></div>`;
  return html + blocks(trimmed(doc));
}

export function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Fingerprint of what Apple Notes would show — tells "edited here since it was sent" apart from no change.
export const notesHash = (title, doc) => hashText(docToNotesHtml(title, doc));

/* ---------- Apple Notes → Outline ---------- */

const MONO = 'tt, code, pre, [style*="monospace"], [style*="Menlo"], [style*="Courier"], font[face*="Menlo"], font[face*="Courier"], font[face*="mono"]';

// A line whose text is all monospace (Apple Notes' "Monostyled") belongs to a code block.
function isMonoLine(el) {
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let any = false;
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (!t.textContent) continue;
    any = true;
    if (!t.parentElement.closest(MONO)) return false;
  }
  return any || !!el.querySelector(MONO);
}

// Apple Notes headings arrive as bold lines with a font size: 20px+ → heading 1, 18px → heading 2.
function headingLevel(el) {
  if (el.tagName !== 'DIV' || !el.textContent.trim()) return 0;
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (t.textContent.trim() && !t.parentElement.closest('b, strong')) return 0;
  }
  const size = Math.max(0, ...[...el.querySelectorAll('[style*="font-size"]')].map(s => parseFloat(s.style.fontSize) || 0));
  return size >= 19 ? 1 : size >= 17.5 ? 2 : 0;
}

function rename(el, tag) {
  const n = el.ownerDocument.createElement(tag);
  while (el.firstChild) n.append(el.firstChild);
  el.replaceWith(n);
  return n;
}

export function notesHtmlToDoc(html) {
  const body = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html').body;
  // the first line is the title, which Outline keeps separately
  body.firstElementChild?.remove();
  const path = body.firstElementChild;
  if (path?.querySelector('i') && /^In: /.test(path.textContent.trim())) path.remove();
  // Apple Notes writes nested lists as <ul><li>b</li><ul>…</ul></ul>; put them inside their item
  body.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol').forEach(list => {
    const prev = list.previousElementSibling;
    if (prev?.tagName === 'LI') prev.append(list);
  });
  // a trailing <br> in a line that has text is just Apple Notes' line ending
  body.querySelectorAll('div > br:last-child').forEach(br => { if (br.parentElement.textContent.trim()) br.remove(); });

  const out = [];
  let code = null, tasks = null;
  const flushCode = () => { if (code) { out.push(`<pre data-auto="true"><code>${esc(code.join('\n').replace(/\n+$/, ''))}</code></pre>`); code = null; } };
  const flushTasks = () => { if (tasks) { out.push(`<ul data-type="taskList">${tasks.join('')}</ul>`); tasks = null; } };

  for (const el of [...body.childNodes]) {
    if (el.nodeType === 3) {
      if (el.textContent.trim()) { flushCode(); flushTasks(); out.push(`<p>${esc(el.textContent)}</p>`); }
      continue;
    }
    if (el.nodeType !== 1) continue;
    if (el.tagName === 'DIV' && isMonoLine(el)) { flushTasks(); (code ??= []).push(el.textContent.replace(/ /g, ' ')); continue; }
    const m = el.tagName === 'DIV' && el.textContent.match(/^\s*([☐☑✓✔])\s?([\s\S]*)$/);
    if (m) {
      flushCode();
      (tasks ??= []).push(`<li data-type="taskItem" data-checked="${m[1] !== '☐'}"><p>${esc(m[2].trim())}</p></li>`);
      continue;
    }
    flushCode(); flushTasks();
    const level = headingLevel(el);
    if (level) { out.push(`<h${level}>${esc(el.textContent.trim())}</h${level}>`); continue; }
    // inline monospace becomes code, <font color> a text colour, background colour a highlight
    el.querySelectorAll(MONO).forEach(t => rename(t, 'code'));
    el.querySelectorAll('code code').forEach(c => c.replaceWith(...c.childNodes));
    // Apple Notes stores text colour as <font color>
    el.querySelectorAll('font[color]').forEach(f => {
      const span = rename(f, 'span');
      span.style.color = f.getAttribute('color');
    });
    el.querySelectorAll('span[style*="background-color"]').forEach(s => {
      const mark = rename(s, 'mark');
      mark.setAttribute('data-color', s.style.backgroundColor);
    });
    out.push(el.outerHTML);
  }
  flushCode(); flushTasks();
  return htmlToDoc(out.join('') || '<p></p>');
}
