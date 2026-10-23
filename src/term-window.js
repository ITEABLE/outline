// The terminal window: one terminal block's session, full size, with its tabs.
import './styles.css';
import { TermView } from './terminal.js';

const sid = new URLSearchParams(location.search).get('sid');
document.documentElement.classList.add('term-window');
const view = new TermView(document.getElementById('term'), { sid, compact: false });
view.attach().then(() => view.focus());

document.addEventListener('keydown', e => {
  if (!e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 't' && !e.shiftKey) { e.preventDefault(); view.newTab(); }
  else if (k === 'w' && !e.shiftKey) {
    e.preventDefault();
    if ((view.info?.tabs.length || 0) > 1) view.closeTab(view.info.active);
    else window.webkit.messageHandlers.term.postMessage({ op: 'closeWindow', sid });
  } else if (e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
    e.preventDefault();
    view.step(e.code === 'BracketRight' ? 1 : -1);
  } else if (/^[1-9]$/.test(e.key)) {
    const t = view.info?.tabs[+e.key - 1];
    if (t) { e.preventDefault(); view.select(t.id); }
  }
}, true);
