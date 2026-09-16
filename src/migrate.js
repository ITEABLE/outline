import { htmlToDoc, esc } from './editor.js';

// v1 notes were plain-text segments with code blocks in between. Lines starting with
// "- " or "1. " become real list items; code blocks keep their language.
export function segsToHtml(segs) {
  let html = '';
  for (const s of segs || []) {
    if (s?.t === 'code') {
      const lang = !s.lang || s.lang === 'text' ? 'plaintext' : s.lang;
      html += `<pre data-auto="${s.auto ? 'true' : 'false'}"><code class="language-${esc(lang)}">${esc(s.v)}</code></pre>`;
      continue;
    }
    let list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of String(s?.v ?? '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      let m;
      // dashes and bullet marks, incl. "⁃" which Apple apps insert for lists
      if ((m = line.match(/^\s*[-*•‐‑‒–—−⁃‣◦▪]\s*(\S.*)$/))) {
        if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
        html += `<li><p>${esc(m[1])}</p></li>`;
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
        html += `<li><p>${esc(m[1])}</p></li>`;
      } else {
        close();
        if (line.trim()) html += `<p>${esc(line.trim())}</p>`;
      }
    }
    close();
  }
  return html || '<p></p>';
}

export function migrateV1(d, uid) {
  const items = d.items.filter(x => x && typeof x === 'object').map(x => ({
    id: String(x.id || uid()),
    depth: Math.max(0, x.depth | 0),
    title: String(x.title ?? ''),
    collapsed: !!x.collapsed,
    doc: htmlToDoc(segsToHtml(x.segs)),
  }));
  const sel = items.some(i => i.id === d.sel) ? d.sel : items[0]?.id;
  return { v: 2, items, panes: sel ? [{ id: uid(), tabs: [sel], active: sel, flex: 1 }] : [], focus: 0 };
}
