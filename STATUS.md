# Outline: status and handoff

_Last updated: 2026-09-12_

Outline is a personal Mac notes app, built for the owner of this Mac to use instead of Apple Notes. They mostly keep prompts and Terminal commands in it. It's a native Mac app: a small Swift window that hosts a web-based rich-text editor (TipTap). It can send notes to Apple Notes, and from there to the iPhone through iCloud.

## Current state

- **Installed:** `/Applications/Outline.app`, the current version with Apple Notes, installed 2026-09-12.
- **Your notes:** `~/Library/Application Support/Outline/notes.json`. Never test against this file; see "Testing" below.
- **Features:** everything asked for in this conversation is done. Nothing is known to be broken. See "Known limits" for what the design deliberately doesn't do.

## Quick commands (run in the project folder)

```bash
npm install                 # once, on a new machine
./build.sh                  # builds dist/ (web) + build/Outline.app
./build.sh --install        # same, then replaces /Applications/Outline.app
npm test                    # editor + Apple Notes tests in Chrome (needs dist/ built)
node build.mjs              # web bundle only (DEV=1 node build.mjs → readable, unminified)
```

After installing, **quit Outline (⌘Q) and reopen it** to get the new version. The running copy saves its notes as it quits.

Requirements: macOS with the Xcode command-line tools (`swiftc`), Node, and Google Chrome (the tests drive it through `playwright-core`).

## Where things are

| Path | What it is |
|---|---|
| `src/app.js` | The app: sidebar tree, tabs and side-by-side panes, toolbar, saving, auto-removal of unused notes, Apple Notes menu |
| `src/editor.js` | The TipTap editor: extensions, code blocks (language picker, auto-detect, ⌘↵), `@` note links, `/` menu, Markdown and code paste, keyboard fixes |
| `src/applenotes.js` | Converts Outline ↔ Apple Notes HTML, plus change fingerprints |
| `src/migrate.js` | One-time conversion of v1 notes (plain text + code segments) to v2 |
| `src/detect.js` | Guesses a snippet's language (json/python/javascript/bash/sql/plaintext) |
| `src/styles.css`, `src/index.html` | Look and page shell (dark theme) |
| `mac/main.swift` | Native shell: window, WKWebView, saving to disk, Apple Notes bridge, confirm/alert boxes, external links, save-on-quit, test switches |
| `mac/notes.js` | JavaScript-for-Automation script that talks to Apple Notes (run through `osascript`) |
| `mac/Info.plist`, `mac/AppIcon.icns`, `mac/icon-source.html` | App metadata, icon, and the icon's source design |
| `build.mjs`, `build.sh` | Build scripts |
| `tests/editor.test.mjs`, `tests/applenotes.test.mjs` | End-to-end tests; screenshots go to `tests/.output/` |
| `dist/`, `build/`, `node_modules/` | Generated. Safe to delete; rebuilt by the commands above |

## Data and backups

All in `~/Library/Application Support/Outline/`:

- `notes.json`: the notes (format v2, described below).
- `notes.backup.json`: a copy of `notes.json` made the first time the app saves after each launch.
- `notes.before-v2.20260912-004645.json`: the owner's original notes, from before the big rewrite.
- `notes.before-import.<time>.json`: made before every "Bring back from Apple Notes".

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

**Other shortcuts:**
- Esc jumps between the sidebar and the editor
- ⌘↵ turns the selection (or the current line) into a code block, or back into text
- ⌘S saves immediately (saving is automatic anyway, about 0.4s after you stop)

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

## Testing

**`npm test`** runs two Chrome end-to-end suites against `dist/index.html`:

- **`tests/editor.test.mjs`** covers:
  - v1→v2 migration, run on the owner's real `notes.before-v2` backup if present (read-only; it never writes to it)
  - bullets on Enter; toolbar, `/` menu, paste, ⌘↵, `@` links and renames
  - tabs and panes, auto-removal, sidebar hide and resize, sub-notes
  - reload persistence, and no console errors
- **`tests/applenotes.test.mjs`** runs against a stand-in for the Mac bridge. It covers:
  - the send payload, and send / re-send
  - bring back: update, add, keep both, nothing-new, deleted-not-revived, backup
  - conversion of **real Apple Notes HTML** captured from the live test, the permission-error message, and no button in plain browsers

**Real Mac app, safely:** these environment variables make it use a scratch copy and no window.

```bash
mkdir -p /tmp/outline-test && cp ~/Library/Application\ Support/Outline/notes.json /tmp/outline-test/
OUTLINE_STORE_DIR=/tmp/outline-test OUTLINE_HIDDEN=1 OUTLINE_SELFTEST=/tmp/outline-test/result.txt \
  build/Outline.app/Contents/MacOS/Outline
cat /tmp/outline-test/result.txt   # "ok notes.before-import…json" = page ↔ app bridge works; app quits by itself
```

- `OUTLINE_STORE_DIR`: use another notes folder.
- `OUTLINE_HIDDEN`: no window and no Dock icon.
- `OUTLINE_SELFTEST=<file>`: after load, send one `backup` request through the Apple Notes bridge, write the reply to `<file>`, and quit.

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

## Known limits / ideas not done

- **Phone:** there's no Outline app on the phone. The phone sees notes through Apple Notes (edits come back with "Bring back"). Another option discussed but not built is a private web link, which would have its own separate notes.
- **Apple Notes losses:** highlights, link targets, heading 3, quotes and code languages don't survive a round trip through Apple Notes (see the table). Real Notes checklists can't be created from scripts.
- **Deleting:** deleting a note in Outline leaves its Apple Notes copy.
- **Not built yet:**
  - dragging tabs between panes, or dragging notes in the sidebar (use Tab / ⇧Tab)
  - search across notes
  - images
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

## Test results at handoff

- **`npm test`:** all 66 checks pass (editor suite and Apple Notes suite both report ALL PASSED).
- **Real app self-test on a copy of the owner's notes:** the bridge replied `ok`, and the notes were saved as v2 on quit.
- **Live Apple Notes test** (`mac/notes.js` via `osascript`, in a throwaway folder that was then deleted): send, update of the same note and fetch all worked in the iCloud account.
- **Installed:** `/Applications/Outline.app`, with a valid code signature.
- **Not yet run end to end:** a first "Send to Apple Notes" from inside the installed app. Each piece is tested (page ↔ bridge, bridge wiring, the Notes script), but that first send will show macOS's permission prompt for Outline, and only the owner can answer it.
- **Test flake (fixed):** the editor test once failed Bold under load, because the selection registered a frame late. It now waits for the selection before clicking.
