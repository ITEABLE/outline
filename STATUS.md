# Outline: status and handoff

_Last updated: 2026-10-24_

Outline is a personal Mac notes app, built for the owner of this Mac to use instead of Apple Notes. They mostly keep prompts and Terminal commands in it. It's a native Mac app: a small Swift window that hosts a web-based rich-text editor (TipTap). It can send notes to Apple Notes, and from there to the iPhone through iCloud. Notes can also hold pictures (paste, drop, resize) and live terminals, with a one-click way to start the Claude CLI in them.

## Current state

- **Installed:** `/Applications/Outline.app`, the current version with pictures and terminals, installed 2026-10-24.
- **Your notes:** `~/Library/Application Support/Outline/notes.json`. Never test against this file; see "Testing" below.
- **Features:** everything asked for in this conversation is done. Nothing is known to be broken. See "Known limits" for what the design deliberately doesn't do.

## Quick commands (run in the project folder)

```bash
npm install                 # once, on a new machine
./build.sh                  # builds dist/ (web) + build/Outline.app
./build.sh --install        # same, then replaces /Applications/Outline.app
npm test                    # editor, Apple Notes, terminal and picture tests in Chrome (needs dist/ built)
node build.mjs              # web bundle only (DEV=1 node build.mjs → readable, unminified)
```

After installing, **quit Outline (⌘Q) and reopen it** to get the new version. The running copy saves its notes as it quits.

Requirements: macOS with the Xcode command-line tools (`swiftc`), Node, and Google Chrome (the tests drive it through `playwright-core`).

## Where things are

| Path | What it is |
|---|---|
| `src/app.js` | The app: sidebar tree, tabs and side-by-side panes, toolbar, saving, auto-removal of unused notes, Apple Notes menu |
| `src/editor.js` | The TipTap editor: extensions, code blocks (language picker, auto-detect, ⌘↵), `@` note links, `/` menu, Markdown and code paste, pictures (paste, drop, picker, resize), keyboard fixes, inserting terminals |
| `src/terminal.js`, `src/terminal.css` | Terminal views (xterm.js): the note block and the window share one `TermView`; tabs, folder menu, Claude button, the `terminal` node |
| `src/term-window.js`, `src/term.html` | The terminal window's page (one session, full size, tab shortcuts) |
| `src/applenotes.js` | Converts Outline ↔ Apple Notes HTML, plus change fingerprints |
| `src/migrate.js` | One-time conversion of v1 notes (plain text + code segments) to v2 |
| `src/detect.js` | Guesses a snippet's language (json/python/javascript/bash/sql/plaintext) |
| `src/styles.css`, `src/index.html` | Look and page shell (dark theme) |
| `mac/main.swift` | Native shell: window, WKWebView, saving to disk, Apple Notes bridge, confirm/alert boxes, external links, save-on-quit, test switches |
| `mac/images.swift` | Pictures: saves them as files in `images/` and serves them to the page as `outline-image://img/<hash>.<ext>` |
| `mac/terminal.swift` | Terminals: real shells on pseudo-terminals, tabs, terminal windows, folders, starting Claude, saving `terminals.json` |
| `mac/notes.js` | JavaScript-for-Automation script that talks to Apple Notes (run through `osascript`) |
| `mac/Info.plist`, `mac/AppIcon.icns`, `mac/icon-source.html` | App metadata, icon, and the icon's source design |
| `build.mjs`, `build.sh` | Build scripts |
| `tests/editor.test.mjs`, `tests/applenotes.test.mjs`, `tests/terminal.test.mjs`, `tests/images.test.mjs` | End-to-end tests; screenshots go to `tests/.output/` (not committed) |
| `dist/`, `build/`, `node_modules/` | Generated. Safe to delete; rebuilt by the commands above |

## Data and backups

All in `~/Library/Application Support/Outline/`:

- `notes.json`: the notes (format v2, described below).
- `notes.backup.json`: a copy of `notes.json` made the first time the app saves after each launch.
- `notes.before-v2.20260912-004645.json`: the owner's original notes, from before the big rewrite.
- `notes.before-import.<time>.json`: made before every "Bring back from Apple Notes".
- `notes.before-terminals.20261024-014128.json`: the notes just before the terminals version was installed.
- `notes.before-pictures.20261024-023814.json`: the notes just before the pictures version was installed.
- `images/`: every picture added to a note, named by a hash of its bytes (the same picture is stored once). Notes store `{ "type": "image", "attrs": { "src": "outline-image://img/….png", "width": 480, "height": … } }`. Nothing deletes these files, so pictures removed from notes stay on disk (and old backups keep working).
- `terminals.json`: each terminal's tabs (name, folder) and its last 64 KB of output, keyed by the block's session id, plus recently picked folders. Notes only store `{ "type": "terminal", "attrs": { "sid": "…" } }`.

Format v2 (`notes.json`):

```json
{
  "v": 2,
  "items": [{ "id": "…", "depth": 0, "title": "…", "collapsed": false,
              "doc": { "type": "doc", "content": ["TipTap JSON"] },
              "apple": { "id": "x-coredata://…", "modified": "ISO date", "hash": "…", "remote": "…" } }],
  "panes": [{ "id": "…", "tabs": ["note ids"], "active": "note id", "flex": 1 }],
  "focus": 0, "sidebar": { "w": 272, "hidden": false }, "wide": false,
  "appleSentAt": "ISO date", "appleGone": ["Apple Notes ids of notes deleted in Outline"]
}
```

- **The outline:** a flat list where `depth` gives the nesting. A note's sub-notes are the items right after it with a greater depth.
- **Old formats:** v1 files (from localStorage key `outline-notes.v1`, or an old `notes.json`) are converted automatically on load.
- **Browser version:** opening `dist/index.html` in a browser also works. It stores notes in localStorage key `outline-notes.v2` and has no Apple Notes button.

## Features (what the owner asked for, all done)

1. **Unused notes disappear:** a note with no title and no content is removed once you leave it (switch note, switch tab, close tab, or relaunch).
2. **Sidebar:**
   - a highlighted **+ New note** (⌘N) button
   - on hover, **+** (new sub-note) and **⋯** (menu); right-click gives the same menu
   - fold arrows (⌘↑ / ⌘↓)
   - an "Inside this note" list plus a **+ Sub-note** button at the bottom of each note
   - **Sub-note** in the toolbar and the `/` menu creates a named sub-note and links to it
3. **Wider editor:** 980px wide, and a full-width button on the toolbar.
4. **Editor:**
   - Enter makes a new bullet (new notes start as a bullet); Tab / ⇧Tab nest and unnest
   - toolbar: text style (text, H1–H3, bullet, numbered, checklist, quote, code), size, B/I/U/S, inline code, highlight colours, text colours, link (⌘K), clear formatting
   - `/` opens a block menu; `@` links to another note (live title, click to open, ⌘-click for a new tab)
5. **Pasting:**
   - Markdown, such as a reply copied from Claude, keeps its headings, lists, code blocks and links
   - multi-line code pasted as plain text becomes a code block with its language guessed
   - pasting several lines onto an empty bullet steps out of the list first
6. **Tabs and side by side:**
   - ⌘-click a note to open it in a new tab; ⌥-click, or the split button, to open it side by side (up to 3 panes, drag the divider to resize)
   - ⌘T opens a new note in a new tab; ⌘W closes a tab; ⇧⌘[ and ⇧⌘] switch tabs
   - ⌘\ hides the sidebar; drag its edge to resize it (double-click the edge to reset)
7. **Apple Notes:** the sidebar's Apple Notes button (and right-click → Send to Apple Notes). See the next section.
8. **Terminals** (Mac app only): see "Terminals" below.
9. **Pictures:**
   - paste a screenshot or copied picture (⌘V), drop picture files onto a note, or use the toolbar's **Picture** button or `/picture` (Mac file picker, several at once)
   - a Retina screenshot starts at the size it was on screen; it never grows past the note's width
   - hover a picture to show its handles: drag the left/right edges or bottom corners to resize (the shape is kept); the size is saved
   - click a picture to select it; Backspace deletes it (pictures can't be dragged to move them: that drag stopped resizing from working in the Mac app)
   - in a plain browser, pictures are stored inside the note (data URLs)

**Other shortcuts:**
- Esc jumps between the sidebar and the editor
- ⌘↵ turns the selection (or the current line) into a code block, or back into text
- ⌘S saves immediately (saving is automatic anyway, about 0.4s after you stop)

## Terminals

**Adding one:** the toolbar's **Terminal** button, or `/terminal`. The block is a real login shell (your zsh, prompt and all), 12 rows tall, starting in **`~/Desktop/Claude outline`** (the owner's choice, `defaultFolder` in `mac/terminal.swift`; home if that folder is gone).

- **Folder:** the folder button in the header shows where the tab is. Its menu offers the default folder, Home, recently picked folders and **Choose folder…** (the Mac folder picker). Picking one types `cd -- '<folder>'` into the shell; if a program is running there, it opens a new tab in that folder instead.

- **Tabs:** **+** in the block's header adds a tab (it starts in the current tab's folder). Click a tab to switch, double-click to rename, **×** to close. Unnamed tabs show the running program (vim, node…) or the folder.
- **Its own window:** the expand button opens the session in a window with the same tabs. Every tab opened there belongs to that note's terminal. While the window is open, the block says so ("Show window"); close the window and the block shows the shell again. In the window: ⌘T new tab, ⌘W close tab (on the last tab, closes the window), ⇧⌘[ / ⇧⌘] switch, ⌘1–9 pick a tab.
- **Claude:** the ✻ Claude button (or ⌘J in the terminal) types `claude` into the shell, so it's the real Claude CLI, running in that tab's folder, exactly as if you'd typed it. If another program is running in the tab, Claude starts in a new tab; if Claude is already running there, nothing happens. (Until 2026-10-24 this was a short-answer question bar using `claude -p`; the owner asked for the real CLI instead.)
- **After a relaunch:** tabs, names, folders and recent output come back; a new shell starts under a "earlier output · new shell" line. Running programs don't survive quitting.
- **Removing:** the trash button (asks first). Terminals no note uses any more are closed and forgotten the next time Outline starts (`gc`), so undo works until then.

**How it works:** `webkit.messageHandlers.term.postMessage({ op, sid, … })` → `TerminalManager` (ops: attach, detach, start, input, resize, select, newTab, closeTab, rename, expand, closeWindow, claude, folders, chooseFolder, cd, text, viewers, gc). Output goes back as `window.__termEvent({ type: 'data', sid, tab, at, b64 })`, batched per frame; `at` is the byte position, so a view never draws output twice. Tab and window changes go out as `{ type: 'info', … }` to every page showing that session.

## Apple Notes sync

**How it works:** the page calls `webkit.messageHandlers.appleNotes.postMessage({action, payload})`. The Swift `AppleNotesBridge` runs `osascript -l JavaScript notes.js <send|fetch> in.json out.json` on a background thread and passes the result back as a promise. The `backup` action is handled in Swift directly.

- **Send:** each note becomes one Apple Note in the folder **"Outline"** of the default account (iCloud here, so it syncs to the phone). Sending again updates the same Apple Note; if it was deleted in Apple Notes, a new one is made. A sub-note gets an "In: Parent › …" line under its title. Notes deleted in Outline are **not** deleted from Apple Notes.
- **Bring back:**
  - notes edited in Apple Notes replace the Outline version
  - notes added to the "Outline" folder come in as new notes
  - a note edited in both places is never overwritten: the Apple Notes version arrives as "<title> (from Apple Notes)" next to it
  - notes deleted in Outline are not brought back (`appleGone`)
  - it always asks first and makes a backup
- **Spotting a real edit:** a note counts as edited in Apple Notes only if its stored HTML's fingerprint changed since the last send or import (`apple.remote`). Dates alone aren't used, because they only go to the second and iCloud can touch a note without anyone editing it. "Edited in Outline" compares `notesHash()` of the note with the fingerprint saved at send time (`apple.hash`).
- **Permission:** macOS asks once for "Outline wants to control Notes". Outline is ad-hoc signed, so **macOS may ask again after each reinstall**. If it was denied, the app says how to fix it (System Settings › Privacy & Security › Automation › Outline › Notes).

**What survives the round trip** (checked against real Apple Notes on 2026-09-12, using a throwaway "Outline test (delete me)" folder that was then deleted and now sits in Recently Deleted):

| In Outline | In Apple Notes | Comes back as |
|---|---|---|
| Title | the note's name (24px title line) | title |
| Heading 1 / 2 / 3 | bold 20px / Notes' "Heading" (18px) / bold line | heading 1 / heading 2 / bold text |
| Bold, italic, underline, strikethrough, text colour | kept | kept |
| Highlight colour | **lost** (Notes ignores it from scripts) | nothing |
| Link | written out as "text (url)"; Notes drops link targets | plain text with the URL |
| Bullets, nested bullets, numbered lists | kept (a blank line separates adjacent list types, or Notes merges them) | kept |
| Checklist | ☐ / ☑ lines (scripts can't make real Notes checklists) | checklist |
| Code block | monospace lines; indentation kept via non-breaking spaces | code block (language re-guessed) |
| Inline code | monospace | inline code |
| Quote, divider, `@` link | plain text | plain text |
| Picture | a "[Picture — open this note in Outline to see it]" line (scripts can't add attachments) | that line, as text (the picture is lost if the note is edited in Apple Notes) |
| Terminal | a "[Terminal — open this note in Outline to use it]" line | that line, as text (the terminal is lost if the note is edited in Apple Notes) |

## Testing

**`npm test`** runs four Chrome end-to-end suites against `dist/`:

- **`tests/editor.test.mjs`** covers:
  - v1→v2 migration, run on the owner's real `notes.before-v2` backup if present (read-only; it never writes to it)
  - bullets on Enter; toolbar, `/` menu, paste, ⌘↵, `@` links and renames
  - tabs and panes, auto-removal, sidebar hide and resize, sub-notes
  - reload persistence, and no console errors
- **`tests/applenotes.test.mjs`** runs against a stand-in for the Mac bridge. It covers:
  - the send payload, and send / re-send
  - bring back: update, add, keep both, nothing-new, deleted-not-revived, backup
  - conversion of **real Apple Notes HTML** captured from the live test, the permission-error message, and no button in plain browsers
- **`tests/terminal.test.mjs`** runs against a stand-in for `mac/terminal.swift`. It covers:
  - adding a block (toolbar, `/terminal`), output, keys going to the shell and not the note
  - the default folder, the folder menu (default, Home, recent, Choose…), the Claude button and ⌘J, tabs (new, switch, rename), the window hand-off
  - saving the block, `gc` after a relaunch, removing, the terminal window's shortcuts, the plain-browser placeholder
- **`tests/images.test.mjs`** covers pasting a screenshot (size, placement, caret after it), resizing by dragging an edge (shape kept, size saved), dropping a file, the Picture button's file picker, `/picture`, reload, and, against a stand-in for the Mac app, that pictures are handed to the app to save instead of stored in the note.

**Real Mac app, safely:** these environment variables make it use a scratch copy and no window.

```bash
mkdir -p /tmp/outline-test && cp ~/Library/Application\ Support/Outline/notes.json /tmp/outline-test/
OUTLINE_STORE_DIR=/tmp/outline-test OUTLINE_HIDDEN=1 OUTLINE_SELFTEST=/tmp/outline-test/result.txt \
  build/Outline.app/Contents/MacOS/Outline
cat /tmp/outline-test/result.txt   # "ok notes.before-import…json term=ok window=ok folder=…/Claude outline image=ok"; app quits by itself
```

- `OUTLINE_STORE_DIR`: use another notes folder.
- `OUTLINE_HIDDEN`: no window and no Dock icon.
- `OUTLINE_SELFTEST=<file>`: after load, send one `backup` request through the Apple Notes bridge, run `echo` in a real shell, open and close its window (not shown when hidden), save a picture and load it back through `outline-image://`, write the results to `<file>`, and quit.
- `OUTLINE_SELFTEST_CLAUDE=1`: the self-test also starts the Claude CLI in the terminal and checks the tab is titled "claude" (sends no message).

**The Apple Notes script by hand.** This creates real notes, so only use a throwaway folder name:

```bash
echo '{"folder":"Outline test (delete me)","notes":[{"id":"t","appleId":null,"html":"<div><h1>Test</h1></div><div>hi</div>"}]}' > /tmp/in.json
osascript -l JavaScript mac/notes.js send /tmp/in.json /tmp/out.json && cat /tmp/out.json
echo '{"folder":"Outline test (delete me)"}' > /tmp/f.json && osascript -l JavaScript mac/notes.js fetch /tmp/f.json /tmp/out.json && cat /tmp/out.json
osascript -l JavaScript -e "const N=Application('Notes'); N.delete(N.defaultAccount().folders.whose({name:'Outline test (delete me)'})()[0])"
```

**Test results at handoff:** _see the end of this file._

## Decisions and gotchas worth knowing

- **Focus timing:** TipTap focuses on the next frame, so the app uses `focusNow()` (`commands.focus` + `view.focus()`). Otherwise keys typed right after jumping from the title land in the title.
- **Enter over nested bullets:** Enter over a selection spanning nested bullets throws in ProseMirror's split. A high-priority Enter handler deletes the selection first.
- **WKWebView dialogs and links:** WKWebView shows nothing for `confirm()` / `alert()` unless the app implements `WKUIDelegate`; `main.swift` does, with native alerts. Links that aren't `file://` open in the default browser.
- **Title bar:** the page runs under a transparent title bar. A 28px invisible `DragStrip` keeps the window draggable, and the page adds a 28px band (`.native .panes { padding-top: 28px }`).
- **⌘W:** it belongs to the page (close tab); the window closes with ⇧⌘W.
- **Saving:** it is batched (~0.4s). On quit, Swift calls `window.__flush()` and writes what it returns.
- **Build target:** the web bundle targets Safari 15 (macOS 12), and the toolbar uses CSS container queries to wrap and shorten in narrow panes.
- **Apple Notes naming:** Apple Notes takes a note's name from its first line; Outline sends the title first and strips that line when bringing a note back.
- **Pictures and WKWebView:** `<input type=file>` shows nothing unless the app implements `runOpenPanelWith` (done in `main.swift`), and the input must be in the page or it may never report its files. A file dropped outside the editor would make WKWebView open it in place of the app, so the page swallows such drops and `decidePolicyFor` refuses file URLs outside the app bundle.
- **No `MainActor.assumeIsolated`:** it crashed the app from a timer on this macOS. `mac/terminal.swift` uses selector timers, `perform(_:afterDelay:)` and `DispatchQueue.main.async { @MainActor in … }`.
- **Errors in async message handlers vanish:** an Objective-C exception inside one (e.g. a bad URL passed to `loadFileURL`) never replies, and the page waits forever. The self-test gives every request a deadline for that reason.
- **Shells:** started with `forkpty` + `execve` (argv/env built before the fork). The env drops `CLAUDECODE*`/`OUTLINE_*` and adds `TERM=xterm-256color`, `LANG`, and `~/.local/bin` + Homebrew to `PATH`. Writes to a shell go through a per-tab queue so a program that stops reading can't freeze the window.
- **Claude's process name:** the CLI's executable is `~/.local/share/claude/versions/<version>`, so `processName()` checks the path to title such tabs "claude".
- **Reading terminal output:** Swift treats `\r\n` as one character, so `plain()` (used by the self-test) interprets the bytes itself: carriage returns, backspaces, cursor left/right and erase-line, as zsh uses when it redraws a line.

## Known limits / ideas not done

- **Phone:** there's no Outline app on the phone. The phone sees notes through Apple Notes (edits come back with "Bring back"). Another option discussed but not built is a private web link, which would have its own separate notes.
- **Apple Notes losses:** highlights, link targets, heading 3, quotes and code languages don't survive a round trip through Apple Notes (see the table). Real Notes checklists can't be created from scripts.
- **Deleting:** deleting a note in Outline leaves its Apple Notes copy.
- **Terminals:**
  - running programs stop when Outline quits (history, tabs and folders are kept)
  - a terminal opens in its own window, not as a tab in Outline's panes
  - copying a terminal block and pasting it gives a second view of the same session, not a new one
- **Not built yet:**
  - dragging tabs between panes, or dragging notes in the sidebar (use Tab / ⇧Tab)
  - search across notes
  - cropping or captions for pictures; unused picture files are never cleaned up
  - stable code signing, which would stop the permission prompt returning after reinstalls
- **Old test code:** the old single-file v1 `index.html` was removed; its logic lives on in `src/detect.js` and `src/migrate.js`.

## Working with the owner

- They want **short, plain-English answers**. When they ask a status question ("what's left?"), just answer it; don't start work.
- They test every build live on this Mac while it runs. Always back up `notes.json` before format changes, and test on copies, never the live file.
- **Don't send their real notes to Apple Notes** unless they ask. Use a throwaway folder for testing.
- Conversation so far, in order:
  1. A scratchpad web page (bullets + code blocks)
  2. Made into a Mac app
  3. Their six-point feedback: unused notes, sidebar and sub-notes, wider editor, rich editor with Enter bullets / formatting / `@`, Markdown paste, tabs and side by side
  4. Apple Notes send and bring back, a bug sweep, and this file
  5. Terminals in notes: tabs, their own window, and quick short answers from Claude (2026-10-24)
  6. Terminals start in `~/Desktop/Claude outline` with a folder menu; the Claude button starts the real CLI (2026-10-24)
  7. Pictures: paste, drop, pick and resize (2026-10-24)

## Test results at handoff

- **`npm test`:** all four suites report ALL PASSED (2026-10-24). The editor suite's "toolbar bold" check still fails now and then under load (the old selection-timing flake); it passed on rerun.
- **Real app self-test on a copy of the owner's notes:** `term=ok window=ok folder=/Users/apple/Desktop/Claude outline image=ok` (a picture saved to `images/` and shown back). The app quit cleanly, with no shells left running.
- **Installed:** `/Applications/Outline.app` on 2026-10-24, with a valid code signature. Notes were backed up first (`notes.before-pictures.20261024-023814.json`).
- **Not seen yet by a person:** pasting a real screenshot, the picture picker and the folder picker on screen, and the terminal window. The pieces are tested, but only in Chrome and in the hidden test mode.
- **Earlier (2026-09-12):** live Apple Notes send, update and fetch worked in a throwaway folder. The first "Send to Apple Notes" from the installed app will show macOS's permission prompt.
