// Terminal views: a live shell shown in a note block (compact) or in its own window.
// The shells run in the Mac app (mac/terminal.swift); this file only draws them and passes keys through.
import { Node } from '@tiptap/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

export const termBridge = window.webkit?.messageHandlers?.term || null;
const call = (op, args = {}) => termBridge.postMessage({ op, ...args });
export const newSid = () => 't' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const folderName = p => (p || '').split('/').filter(Boolean).pop() || '/';
const parentName = p => (p || '').split('/').filter(Boolean).slice(-2, -1)[0] || '';
const bytes = b64 => Uint8Array.from(atob(b64 || ''), c => c.charCodeAt(0));

const views = new Set();
if (termBridge) window.__termEvent = ev => { for (const v of views) if (v.sid === ev.sid) v.event(ev); };

const THEME = {
  background: '#15171b', foreground: '#d9dade', cursor: '#8ab4f8', cursorAccent: '#15171b',
  selectionBackground: 'rgba(138, 180, 248, .3)',
  black: '#1c1f24', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c9ccd3',
  brightBlack: '#5f6570', brightRed: '#ff8ea1', brightGreen: '#b5e38a', brightYellow: '#f0c674', brightBlue: '#8ab4f8', brightMagenta: '#c9aaff', brightCyan: '#9de0ff', brightWhite: '#ffffff',
};
const I = {
  plus: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  x: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  expand: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"/></svg>',
  search: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.25 3.25"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1z"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
};

export class TermView {
  constructor(root, { sid, compact = false, title = () => '', onRemove } = {}) {
    this.sid = sid;
    this.compact = compact;
    this.titleOf = title;
    this.onRemove = onRemove;
    this.info = null;
    this.tab = null;
    this.pos = -1;       // output position already drawn; -1 while (re)loading a tab
    this.queue = [];
    this.gen = 0;
    this.away = false;   // a compact view whose session is open in its own window

    root.classList.add('term');
    root.classList.toggle('compact', compact);
    root.innerHTML = `
      <div class="term-head">
        <span class="term-ico" aria-hidden="true">›_</span>
        <div class="term-tabs"></div>
        <button type="button" class="term-btn" data-act="new" title="New terminal tab${compact ? '' : ' (⌘T)'}">${I.plus}</button>
        <button type="button" class="term-btn" data-act="sessions" title="Open a Claude or tmux session in a new tab">${I.search}</button>
        <span class="term-sp"></span>
        <button type="button" class="term-btn term-folder" data-act="folder" title="Change folder">${I.folder}<span class="lbl"></span></button>
        <button type="button" class="term-btn term-claude" data-act="claude" title="Start Claude in this terminal (⌘J)"><span class="spark">✻</span><span class="lbl">Claude</span></button>
        ${compact ? `<button type="button" class="term-btn" data-act="expand" title="Open in its own window">${I.expand}</button>
        <button type="button" class="term-btn" data-act="remove" title="Remove this terminal">${I.trash}</button>` : ''}
      </div>
      <div class="term-body">
        <div class="term-screen"></div>
        <div class="term-away" hidden><span>This terminal is open in its own window.</span><button type="button" class="term-pill" data-act="expand">Show window</button></div>
      </div>
      <div class="term-menu" hidden></div>`;
    this.root = root;
    this.el = sel => root.querySelector(sel);
    this.screen = this.el('.term-screen');

    this.term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: compact ? 12.5 : 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowTransparency: false,
      macOptionClickForcesSelection: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.screen);
    this.term.onData(d => { if (this.tab && !this.away) call('input', { sid, tab: this.tab, data: d }); });
    this.term.onResize(({ cols, rows }) => { if (this.tab && !this.away && this.pos >= 0) call('resize', { sid, tab: this.tab, cols, rows }); });
    this.term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && e.metaKey && e.key.toLowerCase() === 'j') { e.preventDefault(); this.claude(); return false; }
      return true;
    });
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.screen);

    root.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      const chip = e.target.closest('.term-tab');
      if (b?.dataset.act === 'close' && chip) { e.stopPropagation(); this.closeTab(chip.dataset.id); return; }
      if (chip && !chip.querySelector('input')) { this.select(chip.dataset.id); return; }
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'new') this.newTab();
      else if (a === 'sessions') {
        const r = b.getBoundingClientRect();
        pickSession({ x: r.left, y: r.bottom + 6 }).then(pick => {
          if (pick?.kind === 'new') this.newTab();
          else if (pick) openSession(sid, pick).then(() => this.focus(), e => alert(e.message || e));
          else this.focus();
        });
      }
      else if (a === 'claude') this.claude();
      else if (a === 'folder') this.menuEl.hidden ? this.folderMenu(b) : this.closeMenu();
      else if (a === 'cd') { this.closeMenu(); call('cd', { sid, tab: this.tab, path: b.dataset.path }).then(() => this.focus(), () => {}); }
      else if (a === 'choose') { this.closeMenu(); call('chooseFolder', { sid, tab: this.tab }).finally(() => this.focus()); }
      else if (a === 'expand') call('expand', { sid, title: this.titleOf() });
      else if (a === 'remove') this.onRemove?.();
    });
    root.addEventListener('dblclick', e => { const chip = e.target.closest('.term-tab'); if (chip) this.rename(chip.dataset.id); });

    this.menuEl = this.el('.term-menu');
    this.outside = e => { if (!this.menuEl.contains(e.target) && !e.target.closest('[data-act=folder]')) this.closeMenu(); };
    views.add(this);
  }

  async attach() {
    if (!termBridge) return;
    this.apply(await call('attach', { sid: this.sid }));
  }

  refit() {
    if (!this.screen.offsetWidth || !this.screen.offsetHeight) return;
    try { this.fit.fit(); } catch {}
  }

  focus() { if (!this.away) this.term.focus(); }

  event(ev) {
    if (ev.type === 'info') this.apply(ev);
    else if (ev.type === 'data' && ev.tab === this.tab && !this.away) {
      if (this.pos < 0) this.queue.push(ev);
      else this.write(ev.at, bytes(ev.b64));
    }
  }

  write(at, data) {
    const end = at + data.length;
    if (end <= this.pos) return;
    this.term.write(at < this.pos ? data.subarray(this.pos - at) : data);
    this.pos = end;
  }

  apply(info) {
    this.info = info;
    this.renderTabs();
    const away = this.compact && info.window;
    const wasAway = this.away;
    this.away = away;
    this.el('.term-away').hidden = !away;
    this.screen.style.visibility = away ? 'hidden' : '';
    this.root.classList.toggle('away', away);
    if (away) { this.pos = -1; this.tab = info.active; return; }
    if (wasAway || this.tab !== info.active || this.pos < 0 && !this.loading) this.load(info.active);
  }

  async load(tab) {
    const my = ++this.gen;
    this.tab = tab;
    this.pos = -1;
    this.queue = [];
    this.loading = true;
    this.term.reset();
    // size the shell to the box: the block may only just have been added to the page
    await new Promise(requestAnimationFrame);
    this.refit();
    try {
      const r = await call('start', { sid: this.sid, tab, cols: this.term.cols, rows: this.term.rows });
      if (my !== this.gen) return;
      this.tab = r.tab;
      this.term.write(bytes(r.log));
      this.pos = r.end;
      for (const ev of this.queue.splice(0)) if (ev.tab === this.tab) this.write(ev.at, bytes(ev.b64));
    } catch (e) {
      if (my === this.gen) this.term.write(`\r\n[${e.message || e}]\r\n`);
    } finally {
      if (my === this.gen) this.loading = false;
    }
  }

  renderTabs() {
    const { tabs = [], active } = this.info || {};
    const cur = tabs.find(t => t.id === active);
    const label = this.el('.term-folder .lbl');
    label.textContent = cur ? folderName(cur.cwd) : '';
    label.parentElement.title = `${cur?.cwd || ''} — change folder`;
    this.el('.term-tabs').innerHTML = tabs.map(t => `
      <div class="term-tab${t.id === active ? ' on' : ''}" data-id="${esc(t.id)}" title="${esc(t.cwd || '')}${t.named ? '' : ' — double-click to rename'}">
        <span class="term-tab-title">${esc(t.title || 'shell')}</span>${tabs.length > 1 ? `<button type="button" class="term-tab-x" data-act="close" aria-label="Close tab">${I.x}</button>` : ''}
      </div>`).join('');
  }

  select(id) { if (id !== this.info?.active) call('select', { sid: this.sid, tab: id }); this.focus(); }
  async newTab() { await call('newTab', { sid: this.sid }); this.focus(); }
  closeTab(id) { return call('closeTab', { sid: this.sid, tab: id }); }
  step(dir) {
    const tabs = this.info?.tabs || [];
    if (tabs.length < 2) return;
    const i = tabs.findIndex(t => t.id === this.info.active);
    this.select(tabs[(i + dir + tabs.length) % tabs.length].id);
  }

  rename(id) {
    const chip = this.el(`.term-tab[data-id="${CSS.escape(id)}"]`);
    const t = this.info?.tabs.find(x => x.id === id);
    if (!chip || !t) return;
    const input = document.createElement('input');
    input.className = 'term-tab-name';
    input.value = t.named ? t.title : '';
    input.placeholder = t.title;
    chip.querySelector('.term-tab-title').replaceWith(input);
    input.focus();
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      if (save) call('rename', { sid: this.sid, tab: id, name: input.value });
      else this.renderTabs();
      this.focus();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Starts the Claude CLI in this tab, as if you'd typed `claude` (a new tab if something else is running).
  claude() { call('claude', { sid: this.sid, tab: this.tab }).finally(() => this.focus()); }

  async folderMenu(btn) {
    const f = await call('folders');
    const cwd = this.info?.tabs.find(t => t.id === this.info.active)?.cwd;
    const item = (path, label, hint = '') => `<button type="button" class="term-mi${path === cwd ? ' on' : ''}" data-act="cd" data-path="${esc(path)}" title="${esc(path)}"><span>${esc(label)}</span>${hint ? `<span class="term-mi-hint">${esc(hint)}</span>` : ''}</button>`;
    const recent = f.recent.filter(p => p !== f.default && p !== f.home).slice(0, 5);
    this.menuEl.innerHTML = item(f.default, folderName(f.default), 'default') + item(f.home, 'Home', '~')
      + (recent.length ? `<div class="term-msep"></div><div class="term-mlabel">Recent</div>${recent.map(p => item(p, folderName(p), parentName(p))).join('')}` : '')
      + `<div class="term-msep"></div><button type="button" class="term-mi" data-act="choose"><span>Choose folder…</span></button>`;
    const r = btn.getBoundingClientRect(), box = this.root.getBoundingClientRect();
    this.menuEl.hidden = false;
    this.menuEl.style.top = (r.bottom - box.top + 4) + 'px';
    this.menuEl.style.right = Math.max(6, box.right - r.right) + 'px';
    document.addEventListener('mousedown', this.outside, true);
  }

  closeMenu() {
    this.menuEl.hidden = true;
    document.removeEventListener('mousedown', this.outside, true);
  }

  dispose() {
    this.closeMenu();
    views.delete(this);
    this.ro.disconnect();
    if (termBridge) call('detach', { sid: this.sid });
    this.term.dispose();
  }
}

/* ---------- sessions: pick a new terminal, a Claude Code session or a tmux session ---------- */

// Commands shown in the picker for finding the ID of the session you want to mirror.
const CLAUDE_ID = `basename "$(ls -t ~/.claude/projects/"$(pwd | sed 's/[^A-Za-z0-9]/-/g')"/*.jsonl | head -1)" .jsonl`;
export const SESSION_COMMANDS = [
  { label: 'Any terminal', where: 'run in it (VS Code, Terminal, iTerm…)', cmd: 'echo $OUTLINE_SESSION' },
  { label: 'Claude Code session', where: 'type in that Claude session', cmd: `! ${CLAUDE_ID}` },
];
// Where a mirrored terminal lives, by the app that opened it.
const APPS = {
  vscode: ['VS Code', 'VS'], terminal: ['Terminal', '›_'], iterm: ['iTerm', 'i'], outline: ['Outline', 'O'],
  warp: ['Warp', 'W'], ghostty: ['Ghostty', 'g'], shell: ['Terminal', '$'], tmux: ['tmux', 't'],
};
const appOf = it => APPS[it.app] || APPS.shell;

const ago = ms => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
};
const shortPath = p => (p || '').replace(/^\/Users\/[^/]+/, '~');

// Opens a picked session as a new tab of terminal `sid` (made if it doesn't exist yet). Resolves to the tab id.
export function openSession(sid, pick) {
  const name = pick.kind === 'claude' ? `✻ ${pick.title.slice(0, 28)}` : pick.id;
  return call('openSession', { sid, kind: pick.kind, id: pick.id, cwd: pick.cwd, socket: pick.socket, name });
}

// Shows the session picker at `anchor` ({ x, y } in the page). Resolves to { kind: 'new' }, a session, or null.
export function pickSession(anchor) {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'sess';
    el.innerHTML = `
      <div class="sess-search">${I.search}<input placeholder="Search sessions, or paste a session ID" autocomplete="off" spellcheck="false"></div>
      <div class="sess-list" role="listbox"></div>
      <div class="sess-help">
        <div class="sess-mirror"><div class="sess-cmd-text"><span class="sess-cmd-label">Mirror every terminal</span><span class="sess-mirror-note"></span></div><button type="button" class="sess-toggle" role="switch" aria-checked="false" data-act="mirror"><span></span></button></div>
        <div class="sess-help-title">Find the ID of the session you want to mirror</div>
        ${SESSION_COMMANDS.map((c, i) => `<div class="sess-cmd"><div class="sess-cmd-text"><span class="sess-cmd-label">${esc(c.label)} <span>· ${esc(c.where)}</span></span><code>${esc(c.cmd)}</code></div><button type="button" class="sess-copy" data-cmd="${i}">Copy</button></div>`).join('')}
      </div>
      <div class="sess-preview" hidden><div class="sess-preview-head"></div><pre></pre></div>`;
    document.body.append(el);
    const input = el.querySelector('input'), list = el.querySelector('.sess-list');
    const preview = el.querySelector('.sess-preview'), toggle = el.querySelector('.sess-toggle');
    let items = [], index = 0, seq = 0, timer = 0, done = false, mirror = false, peekTimer = 0, peekSeq = 0;

    const place = () => {
      const w = el.offsetWidth, h = el.offsetHeight;
      el.style.left = Math.max(8, Math.min(anchor.x, innerWidth - w - 8)) + 'px';
      el.style.top = (anchor.y + h > innerHeight - 8 ? Math.max(8, anchor.y - h - 30) : anchor.y) + 'px';
    };
    const row = (it, i) => {
      const on = i === index ? ' on' : '';
      if (it.kind === 'new') return `<button type="button" class="sess-row${on}" data-i="${i}"><span class="sess-badge new">›_</span><span class="sess-main"><span class="sess-title">New terminal</span><span class="sess-meta">a fresh shell in your default folder</span></span></button>`;
      if (it.kind === 'tmux') {
        const [app, badge] = appOf(it);
        const folder = shortPath(it.cwd).split('/').pop() || '~';
        const title = it.program ? `${it.program} · ${folder}` : folder;
        return `<button type="button" class="sess-row${on}" data-i="${i}"><span class="sess-badge app-${esc(it.app)}">${esc(badge)}</span><span class="sess-main"><span class="sess-title">${esc(title)}</span><span class="sess-meta">${esc(app)} · <code>${esc(it.id)}</code> · ${it.attached ? 'open' : 'detached'} · ${ago(it.time)}${it.match === 'screen' ? ' · matched on screen' : ''}</span></span></button>`;
      }
      if (it.kind === 'claude') return `<button type="button" class="sess-row${on}" data-i="${i}" title="${esc(it.id)}"><span class="sess-badge claude">✻</span><span class="sess-main"><span class="sess-title">${esc(it.title)}</span><span class="sess-meta"><code>${esc(it.id.slice(0, 8))}</code> · ${esc(shortPath(it.cwd))} · ${ago(it.time)}</span></span></button>`;
      return '';
    };
    const draw = res => {
      const q = input.value.trim();
      items = [...(q ? [] : [{ kind: 'new' }]), ...(res?.tmux || []), ...(res?.claude || [])];
      index = Math.min(index, Math.max(0, items.length - 1));
      const lead = q ? 0 : 1, nT = res?.tmux?.length || 0;
      let html = '';
      items.forEach((it, i) => {
        if (i === lead && nT) html += '<div class="sess-label">Terminals</div>';
        if (i === lead + nT && res?.claude?.length) html += '<div class="sess-label">Claude Code sessions</div>';
        html += row(it, i);
      });
      if (res && !res.tmuxInstalled) html += '<div class="sess-note">Mirroring terminals needs tmux. Install it with <code>brew install tmux</code>.</div>';
      else if (res && !q && !nT) html += `<div class="sess-note">${mirror ? 'No mirrored terminals yet. Terminals you open from now on show up here.' : 'Turn on “Mirror every terminal” below to see the terminals you open in VS Code, Terminal and anywhere else.'}</div>`;
      if (q && !items.length && res) html += '<div class="sess-note">No session matches “' + esc(q) + '”.</div>';
      list.innerHTML = html;
      list.querySelector('.sess-row.on')?.scrollIntoView({ block: 'nearest' });
      place();
    };
    const showMirror = () => {
      toggle.setAttribute('aria-checked', String(mirror));
      toggle.classList.toggle('on', mirror);
      el.querySelector('.sess-mirror-note').textContent = mirror
        ? 'On: every new terminal you open (VS Code, Terminal, iTerm, Outline…) can be found here.'
        : 'Off: only terminals started in tmux show up.';
    };
    const load = async () => {
      const my = ++seq;
      const res = await call('sessions', { query: input.value.trim() }).catch(() => null);
      if (my !== seq || done) return;
      if (res) { mirror = !!res.mirror; showMirror(); }
      draw(res);
    };
    // hovering (or arrowing to) a session shows what's on its screen, or a Claude session's last messages
    const peek = it => {
      clearTimeout(peekTimer);
      if (!it || it.kind === 'new') { preview.hidden = true; return; }
      peekTimer = setTimeout(async () => {
        const my = ++peekSeq;
        const text = await call('preview', { kind: it.kind, id: it.id, socket: it.socket }).catch(() => '');
        if (my !== peekSeq || done) return;
        const lines = String(text || '').replace(/\s+$/, '').split('\n');
        preview.querySelector('pre').textContent = (it.kind === 'tmux' ? lines.slice(-24) : lines).join('\n') || '(nothing on screen yet)';
        preview.querySelector('.sess-preview-head').textContent = it.kind === 'claude' ? `Claude · ${it.id.slice(0, 8)} · ${shortPath(it.cwd)}` : `${appOf(it)[0]} · ${it.id} · ${shortPath(it.cwd)}`;
        preview.hidden = false;
        const r = el.getBoundingClientRect(), w = preview.offsetWidth;
        preview.classList.toggle('left', r.right + 8 + w > innerWidth - 8 && r.left - 8 - w > 8);
        preview.querySelector('pre').scrollTop = 1e6;
      }, 120);
    };
    list.addEventListener('mouseover', e => { const b = e.target.closest('[data-i]'); if (b) peek(items[+b.dataset.i]); });
    list.addEventListener('mouseleave', () => peek(items[index]));
    const finish = pick => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(peekTimer);
      document.removeEventListener('mousedown', outside, true);
      el.remove();
      resolve(pick);
    };
    const outside = e => { if (!el.contains(e.target)) finish(null); };

    input.addEventListener('input', () => { index = 0; clearTimeout(timer); timer = setTimeout(load, 150); });
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        list.querySelectorAll('.sess-row').forEach(b => b.classList.toggle('on', +b.dataset.i === index));
        list.querySelector('.sess-row.on')?.scrollIntoView({ block: 'nearest' });
        peek(items[index]);
      } else if (e.key === 'Enter') { e.preventDefault(); if (items[index]) finish(items[index]); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
    el.addEventListener('mousedown', e => { if (e.target !== input) e.preventDefault(); });
    list.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) finish(items[+b.dataset.i]); });
    el.querySelector('.sess-help').addEventListener('click', async e => {
      if (e.target.closest('[data-act=mirror]')) {
        try { mirror = await call('mirror', { on: !mirror }); } catch (err) { alert(err.message || err); }
        showMirror();
        load();
        input.focus();
        return;
      }
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      const text = SESSION_COMMANDS[+b.dataset.cmd].cmd;
      try { await navigator.clipboard.writeText(text); }
      catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1200);
      input.focus();
    });
    setTimeout(() => document.addEventListener('mousedown', outside, true));
    draw(null);
    input.focus();
    load();
  });
}

// The note block. It only stores which session it shows; the shells, tabs and history live in the Mac app.
export const TerminalNode = Node.create({
  name: 'terminal',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addOptions() { return { noteTitle: () => '' }; },
  addAttributes() {
    return {
      sid: {
        default: null,
        parseHTML: el => el.getAttribute('data-terminal') || null,
        renderHTML: a => ({ 'data-terminal': a.sid || '' }),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-terminal]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', HTMLAttributes, 'Terminal']; },
  addNodeView() {
    const options = this.options;
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'term-block';
      dom.contentEditable = 'false';
      const sid = node.attrs.sid;
      let view = null;
      if (!termBridge || !sid) {
        dom.innerHTML = '<div class="term-off"><span class="term-ico">›_</span>Terminal · opens in the Outline Mac app</div>';
      } else {
        view = new TermView(dom, {
          sid,
          compact: true,
          title: () => options.noteTitle(),
          onRemove: () => {
            if (!confirm('Remove this terminal? Its shells are closed and its tabs are forgotten when Outline next starts.')) return;
            const pos = getPos();
            if (typeof pos === 'number') editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
          },
        });
        view.attach();
      }
      return {
        dom,
        stopEvent: () => true,
        ignoreMutation: () => true,
        update: n => n.type === node.type && n.attrs.sid === sid,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        destroy: () => view?.dispose(),
      };
    };
  },
});
