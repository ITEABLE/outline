# Outline

A personal notes app for the Mac, made to replace Apple Notes for keeping prompts, Terminal commands and snippets. It's a small native Swift window around a rich-text editor ([TipTap](https://tiptap.dev)), with notes saved as a plain JSON file on your Mac.

## What it does

- **Notes in an outline.** Notes nest inside each other in the sidebar. Fold them, drag the sidebar wider, or hide it with ⌘\\. A note with no title and no content disappears once you leave it.
- **A rich editor.** Enter makes a new bullet and Tab nests it. There are headings, checklists, quotes, colours and highlights, `/` for a block menu, and `@` to link another note.
- **Code blocks.** Select text and press ⌘↵ to turn it into a code block. The language is detected automatically (bash, JSON, Python, JavaScript, SQL and more), with a copy button.
- **Smart paste.** Markdown, such as a reply copied from Claude, keeps its headings, lists, code and links. Multi-line code pasted as plain text becomes a code block.
- **Pictures.** Paste a screenshot (⌘V), drop image files onto a note, or use the **Picture** button. Drag a picture's edges or corners to resize it.
- **Terminals in notes.** The **Terminal** button adds a live shell to a note, with tabs. It can open in its own window, has a folder menu, and has a button that starts the Claude CLI right there.
- **Sessions.** When adding a terminal, pick an existing session instead of starting fresh. Turn on **Mirror every terminal** and every terminal you open (VS Code, Terminal, iTerm, Outline) shows up, ready to open in Outline as a live, shared view. Claude Code sessions are listed too and resume where they left off. Search by session ID, folder, program or on-screen text, and hover a session to preview it. `echo $OUTLINE_SESSION` prints any terminal's ID.
- **Tabs and side by side.** ⌘-click a note to open it in a new tab, or ⌥-click to open it next to the current one (up to three panes).
- **Apple Notes.** Send notes to an "Outline" folder in Apple Notes, which syncs to your iPhone through iCloud. Bring back edits made on the phone.

## Install

Requirements: macOS 12 or later on Apple silicon, the Xcode command-line tools (`xcode-select --install`), and [Node.js](https://nodejs.org). Optional: [tmux](https://github.com/tmux/tmux) (`brew install tmux`) for mirroring terminals (turning it on adds one line to the top of `~/.zshrc`; turning it off removes it), and [Claude Code](https://claude.com/claude-code) for the Claude features.

```bash
git clone https://github.com/ITEABLE/outline.git
cd outline
npm install
./build.sh --install   # builds Outline.app and copies it to /Applications
```

Then open **Outline** from Applications. After installing a new version, quit Outline (⌘Q) and reopen it.

The first time you send notes to Apple Notes, macOS asks whether Outline may control Notes. Because the app is signed only locally, it may ask again after a reinstall.

## Shortcuts

| Keys | Action |
|---|---|
| ⌘N / ⌘T | New note / new note in a new tab |
| ⌘W | Close the tab |
| ⇧⌘[ / ⇧⌘] | Previous / next tab |
| ⌘\\ | Show or hide the sidebar |
| Tab / ⇧Tab | Nest / un-nest (bullets and sidebar notes) |
| ⌘↑ / ⌘↓ | Fold / unfold a note in the sidebar |
| ⌘↵ | Selection ↔ code block |
| ⌘K | Add a link |
| `/` · `@` | Block menu · link to a note |
| Esc | Jump between sidebar and editor |
| ⌘J | Start Claude in a terminal (when a terminal has focus) |

In a terminal window, ⌘T opens a tab, ⌘W closes one, and ⌘1–9 pick one.

## Where your data lives

Everything stays on your Mac, in `~/Library/Application Support/Outline/`:

| File | What it is |
|---|---|
| `notes.json` | All notes, tabs and layout |
| `notes.backup.json` | A copy made at each launch |
| `images/` | Pictures added to notes |
| `terminals.json` | Terminal tabs, folders and recent output |

Opening `dist/index.html` in a browser also works, minus terminals and Apple Notes. Notes are then stored in the browser instead.

## Development

```bash
./build.sh                 # build dist/ and build/Outline.app
node build.mjs             # web bundle only (DEV=1 for readable output)
npm test                   # end-to-end tests in Google Chrome (build first)
```

| Path | What it is |
|---|---|
| `src/` | The web app: `app.js` (sidebar, tabs, panes, saving), `editor.js` (TipTap editor, paste, pictures), `terminal.js` (terminal views), `applenotes.js` (Apple Notes conversion) |
| `mac/` | The native side: `main.swift` (window, saving, dialogs), `terminal.swift` (shells), `images.swift` (picture files), `notes.js` (Apple Notes scripting) |
| `tests/` | Chrome end-to-end tests for the editor, Apple Notes, terminals and pictures |
| `dist/`, `build/` | Build output (committed; `./build.sh` regenerates both) |

The real app also has test switches for running safely against a copy of your notes. These are documented in [STATUS.md](STATUS.md), along with design decisions, known limits and the full feature history.
