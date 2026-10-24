import Cocoa
import WebKit
import Darwin

// Terminals: each terminal block in a note is a "session" with one or more tabs, and each tab is a
// real shell on a pseudo-terminal. Swift owns them (so a block and its window show the same shells)
// and keeps their tabs, folders and recent output in terminals.json, so they come back after a relaunch.
// Pages talk to it through `webkit.messageHandlers.term`; output goes back as `window.__termEvent(...)`.

private let TIOCSWINSZ: UInt = 0x8008_7467 // _IOW('t', 103, struct winsize); the macro doesn't import
private let logLimit = 256 * 1024          // output kept in memory per tab, for redrawing a view
private let savedLogLimit = 64 * 1024      // output kept on disk per tab
// New terminals start in this folder (the owner's choice; home if it's gone).
private let defaultFolder = NSString(string: "~/Desktop/Claude outline").expandingTildeInPath

final class TermTab {
    let id: String
    var name: String     // set by the user; empty = show the folder or running program
    var cwd: String
    var title = ""
    var log = Data()
    var total = 0        // bytes ever written to this tab; lets a view skip output it already has
    var pid: pid_t = 0
    var fd: Int32 = -1
    var source: DispatchSourceRead?
    let writeQueue = DispatchQueue(label: "outline.term.write")
    var restored = false // log came from disk; a new shell gets a divider under it
    var command = ""     // typed into every new shell of this tab (resuming a Claude session, attaching to tmux)
    var mirror = ""      // name of the mirrored (tmux) session this tab shows, for its title, folder and prompt
    var running: Bool { pid > 0 }

    init(id: String, name: String = "", cwd: String) {
        self.id = id; self.name = name; self.cwd = cwd
    }
}

final class TermSession {
    var tabs: [TermTab]
    var active: String
    var window: NSWindow?
    init(tabs: [TermTab], active: String) { self.tabs = tabs; self.active = active }
    func tab(_ id: String?) -> TermTab? { tabs.first { $0.id == id } }
}

private struct Viewer { weak var web: WKWebView?; var sids: Set<String> }

@MainActor
final class TerminalManager: NSObject, WKScriptMessageHandlerWithReply, NSWindowDelegate {
    let storeDir: URL
    weak var app: AppDelegate?
    var sessions: [String: TermSession] = [:]
    private var viewers: [ObjectIdentifier: Viewer] = [:]
    private var pendingOut: [String: (sid: String, at: Int, data: Data)] = [:]
    private var flushScheduled = false
    private var titleTimer: Timer?
    private let ioQueue = DispatchQueue(label: "outline.term.io")
    private var recent: [String] = [] // folders picked lately, newest first
    private var panes: [String: (command: String, path: String)] = [:] // mirrored sessions' active panes, refreshed each second
    private var panesLoading = false

    var fileURL: URL { storeDir.appendingPathComponent("terminals.json") }

    init(storeDir: URL) {
        self.storeDir = storeDir
        super.init()
        load()
        installMirrorFiles()
        // selector timers and main-queue blocks (not MainActor.assumeIsolated, which crashed here)
        titleTimer = Timer.scheduledTimer(timeInterval: 1, target: self, selector: #selector(refreshTitles), userInfo: nil, repeats: true)
    }

    nonisolated static let home = FileManager.default.homeDirectoryForCurrentUser.path
    nonisolated static var startFolder: String { isFolder(defaultFolder) ? defaultFolder : home }
    nonisolated static func isFolder(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }
    static let uid = { () -> String in String(UUID().uuidString.prefix(8)).lowercased() }

    // MARK: messages from pages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return (nil, "Outline sent the terminal a request it didn't understand.")
        }
        let sid = body["sid"] as? String ?? ""
        let web = message.webView
        let int = { (k: String) in (body[k] as? NSNumber)?.intValue ?? 0 }

        switch op {
        case "attach":
            guard !sid.isEmpty else { return (nil, "missing session") }
            let s = session(sid)
            if let web { viewers[ObjectIdentifier(web), default: Viewer(web: web, sids: [])].sids.insert(sid) }
            return (info(sid, s), nil)
        case "detach":
            if let web { viewers[ObjectIdentifier(web)]?.sids.remove(sid) }
            return (nil, nil)
        case "start":
            guard let s = sessions[sid], let tab = s.tab(body["tab"] as? String) ?? s.tab(s.active) else { return (nil, "That terminal is gone.") }
            if !tab.running { spawn(tab, cols: int("cols"), rows: int("rows")) }
            else { resize(tab, cols: int("cols"), rows: int("rows")) }
            return (["log": tab.log.base64EncodedString(), "end": tab.total, "tab": tab.id], nil)
        case "input":
            guard let tab = sessions[sid]?.tab(body["tab"] as? String), let text = body["data"] as? String else { return (nil, nil) }
            if !tab.running {
                if text.contains("\r") { spawn(tab, cols: 0, rows: 0) }
                return (nil, nil)
            }
            send(tab, Data(text.utf8))
            return (nil, nil)
        case "resize":
            if let tab = sessions[sid]?.tab(body["tab"] as? String) { resize(tab, cols: int("cols"), rows: int("rows")) }
            return (nil, nil)
        case "select":
            guard let s = sessions[sid], let tab = s.tab(body["tab"] as? String) else { return (nil, nil) }
            s.active = tab.id
            changed(sid)
            return (nil, nil)
        case "newTab":
            guard let s = sessions[sid] else { return (nil, "That terminal is gone.") }
            let tab = TermTab(id: Self.uid(), cwd: s.tab(s.active)?.cwd ?? Self.startFolder)
            s.tabs.append(tab)
            s.active = tab.id
            changed(sid)
            return (tab.id, nil)
        case "closeTab":
            guard let s = sessions[sid], let i = s.tabs.firstIndex(where: { $0.id == body["tab"] as? String }) else { return (nil, nil) }
            let tab = s.tabs.remove(at: i)
            kill(tab)
            if s.tabs.isEmpty { s.tabs = [TermTab(id: Self.uid(), cwd: Self.startFolder)] }
            if s.active == tab.id { s.active = s.tabs[min(i, s.tabs.count - 1)].id }
            changed(sid)
            return (nil, nil)
        case "rename":
            guard let tab = sessions[sid]?.tab(body["tab"] as? String) else { return (nil, nil) }
            tab.name = (body["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            changed(sid)
            return (nil, nil)
        case "expand":
            openWindow(sid, title: body["title"] as? String ?? "")
            return (nil, nil)
        case "closeWindow":
            sessions[sid]?.window?.performClose(nil)
            return (nil, nil)
        case "claude":
            guard let s = sessions[sid], let tab = s.tab(body["tab"] as? String) ?? s.tab(s.active) else { return (nil, "That terminal is gone.") }
            run("claude", in: tab, sid: sid, unless: "claude")
            return (nil, nil)
        case "folders":
            return (["default": Self.startFolder, "home": Self.home, "recent": recent.filter(Self.isFolder)], nil)
        case "chooseFolder":
            guard let s = sessions[sid], let tab = s.tab(body["tab"] as? String) ?? s.tab(s.active) else { return (nil, nil) }
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.prompt = "Open Here"
            panel.message = "Pick a folder for this terminal"
            panel.directoryURL = URL(fileURLWithPath: tab.cwd)
            let win = s.window ?? app?.window
            let ok: NSApplication.ModalResponse
            if let win, win.isVisible { ok = await panel.beginSheetModal(for: win) } else { ok = panel.runModal() }
            guard ok == .OK, let url = panel.url else { return (nil, nil) }
            go(to: url.path, tab: tab, sid: sid)
            return (url.path, nil)
        case "sessions":
            // mirrored terminals, tmux and Claude Code sessions to open in a tab, newest first, filtered by `query`
            let query = (body["query"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            var res = await Self.findSessions(query)
            res["mirror"] = Self.mirrorInstalled()
            return (res, nil)
        case "preview":
            // what a session shows now: a terminal's screen, or a Claude conversation's last messages
            let id = body["id"] as? String ?? ""
            if body["kind"] as? String == "claude" { return (await Self.background { Self.claudeTail(id) }, nil) }
            let socket = body["socket"] as? String ?? "outline"
            return (await Self.background { Self.tmux(socket, ["capture-pane", "-p", "-J", "-t", "=\(id):"]) }, nil)
        case "mirror":
            // turns "mirror every terminal" on or off (a line at the top of ~/.zshrc)
            do { try Self.setMirror(body["on"] as? Bool ?? false); return (Self.mirrorInstalled(), nil) }
            catch { return (nil, "Outline couldn't change ~/.zshrc: \(error.localizedDescription)") }
        case "openSession":
            // opens a Claude Code session (resumed) or a tmux session (attached) as a new tab
            guard let kind = body["kind"] as? String, let id = body["id"] as? String, !sid.isEmpty else { return (nil, "Outline didn't get a session to open.") }
            let command: String
            if kind == "claude", id.range(of: "^[0-9a-fA-F-]{8,}$", options: .regularExpression) != nil { command = "claude --resume \(id)" }
            else if kind == "tmux" {
                let socket = body["socket"] as? String == "default" ? "" : "-L outline "
                command = "tmux \(socket)attach -t " + Self.quote("=" + id)
            }
            else { return (nil, "That isn't a session Outline can open.") }
            let cwd = (body["cwd"] as? String).flatMap { Self.isFolder($0) ? $0 : nil } ?? Self.startFolder
            let tab = TermTab(id: Self.uid(), name: body["name"] as? String ?? "", cwd: cwd)
            tab.command = command
            if kind == "tmux" && body["socket"] as? String != "default" { tab.mirror = id }
            if let s = sessions[sid] { s.tabs.append(tab); s.active = tab.id }
            else { sessions[sid] = TermSession(tabs: [tab], active: tab.id) }
            changed(sid)
            return (tab.id, nil)
        case "cd":
            guard let s = sessions[sid], let tab = s.tab(body["tab"] as? String) ?? s.tab(s.active),
                  let path = body["path"] as? String, Self.isFolder(path) else { return (nil, "That folder doesn't exist.") }
            go(to: path, tab: tab, sid: sid)
            return (nil, nil)
        case "text":
            // plain text of a tab's recent output (used by the self-test)
            guard let tab = sessions[sid]?.tab(body["tab"] as? String) ?? sessions[sid].flatMap({ $0.tab($0.active) }) else { return ("", nil) }
            return (Self.plain(tab.log), nil)
        case "viewers":
            // how many pages show this session (used by the self-test)
            return (viewers.values.filter { $0.web != nil && $0.sids.contains(sid) }.count, nil)
        case "gc":
            let keep = Set(body["keep"] as? [String] ?? [])
            for (id, s) in sessions where !keep.contains(id) {
                s.tabs.forEach { self.kill($0) }
                s.window?.close()
                sessions[id] = nil
            }
            scheduleSave()
            return (nil, nil)
        default:
            return (nil, "Unknown terminal request: \(op)")
        }
    }

    func session(_ sid: String) -> TermSession {
        if let s = sessions[sid] { return s }
        let tab = TermTab(id: Self.uid(), cwd: Self.startFolder)
        let s = TermSession(tabs: [tab], active: tab.id)
        sessions[sid] = s
        scheduleSave()
        return s
    }

    func info(_ sid: String, _ s: TermSession) -> [String: Any] {
        [
            "sid": sid,
            "tabs": s.tabs.map { ["id": $0.id, "title": $0.name.isEmpty ? ($0.title.isEmpty ? Self.folderName($0.cwd) : $0.title) : $0.name,
                                  "named": !$0.name.isEmpty, "running": $0.running, "cwd": $0.cwd] },
            "active": s.active,
            "window": s.window != nil,
        ]
    }

    // Tells every page showing this session about new tabs, titles or its window.
    func changed(_ sid: String) {
        if let s = sessions[sid] { emit(sid, ["type": "info"].merging(info(sid, s)) { a, _ in a }) }
        scheduleSave()
    }

    private func emit(_ sid: String, _ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event), let json = String(data: data, encoding: .utf8) else { return }
        for (key, v) in viewers {
            guard let web = v.web else { viewers[key] = nil; continue }
            if v.sids.contains(sid) { web.evaluateJavaScript("window.__termEvent && window.__termEvent(\(json))", completionHandler: nil) }
        }
    }

    // MARK: shells

    func spawn(_ tab: TermTab, cols: Int, rows: Int) {
        if tab.restored {
            output(tab, Data("\u{1b}[0m\u{1b}[?1049l\u{1b}[?25h\r\n\u{1b}[2m─── earlier output · new shell ───\u{1b}[0m\r\n".utf8), sid: sid(of: tab))
            tab.restored = false
        }
        var ws = winsize(ws_row: UInt16(clamping: rows > 0 ? rows : 24), ws_col: UInt16(clamping: cols > 0 ? cols : 80), ws_xpixel: 0, ws_ypixel: 0)
        let shell = Self.loginShell()
        let dir = Self.isFolder(tab.cwd) ? tab.cwd : Self.startFolder

        // Everything the child needs is prepared before fork: after it, only exec-safe calls.
        let argv: [UnsafeMutablePointer<CChar>?] = [strdup("-" + (shell as NSString).lastPathComponent), nil]
        var env = Self.shellEnv()
        if tab.command.isEmpty {
            // when mirroring is on, this tab's shell becomes the mirrored session "outline-<tab>"
            tab.mirror = "outline-" + tab.id.prefix(6)
            env["OUTLINE_MIRROR_ID"] = tab.mirror
        } else {
            env["OUTLINE_NO_MIRROR"] = "1" // it attaches to or resumes a session itself
        }
        let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        let cShell = strdup(shell), cDir = strdup(dir)
        defer { argv.forEach { free($0) }; envp.forEach { free($0) }; free(cShell); free(cDir) }

        var master: Int32 = -1
        let pid = forkpty(&master, nil, nil, &ws)
        if pid == 0 {
            chdir(cDir)
            execve(cShell, argv, envp)
            _exit(127)
        }
        guard pid > 0 else {
            output(tab, Data("\r\n[Outline couldn't start a shell]\r\n".utf8), sid: sid(of: tab))
            return
        }
        tab.pid = pid
        tab.fd = master
        tab.cwd = dir
        let src = DispatchSource.makeReadSource(fileDescriptor: master, queue: ioQueue)
        src.setEventHandler { [weak self, weak tab] in
            var buf = [UInt8](repeating: 0, count: 65536)
            let n = read(master, &buf, buf.count)
            if n <= 0 { src.cancel(); return }
            let data = Data(buf[0..<n])
            DispatchQueue.main.async { @MainActor in
                guard let self, let tab, tab.fd == master else { return }
                self.output(tab, data, sid: self.sid(of: tab))
            }
        }
        src.setCancelHandler { [weak self, weak tab] in
            close(master)
            // reap off the reading queue, so a shell slow to exit never holds up other tabs
            DispatchQueue.global().async {
                var status: Int32 = 0
                waitpid(pid, &status, 0)
                DispatchQueue.main.async { @MainActor in
                    guard let self, let tab, tab.pid == pid else { return }
                    tab.pid = 0; tab.fd = -1; tab.source = nil
                    let sid = self.sid(of: tab)
                    self.output(tab, Data("\r\n\u{1b}[2m[shell ended · press Return for a new one]\u{1b}[0m\r\n".utf8), sid: sid)
                    if let sid { self.changed(sid) }
                }
            }
        }
        tab.source = src
        src.resume()
        if !tab.command.isEmpty { send(tab, Data("\(tab.command)\r".utf8)) } // the shell reads it once its prompt is up
        if let sid = sid(of: tab) { changed(sid) }
    }

    func send(_ tab: TermTab, _ data: Data) {
        let fd = tab.fd
        guard fd >= 0 else { return }
        // a program that isn't reading would block the write; never let that freeze the window
        tab.writeQueue.async {
            data.withUnsafeBytes { raw in
                var off = 0
                while off < raw.count {
                    let n = write(fd, raw.baseAddress! + off, raw.count - off)
                    if n <= 0 { if errno == EINTR || errno == EAGAIN { continue }; return }
                    off += n
                }
            }
        }
    }

    func resize(_ tab: TermTab, cols: Int, rows: Int) {
        guard tab.fd >= 0, cols > 0, rows > 0 else { return }
        var ws = winsize(ws_row: UInt16(clamping: rows), ws_col: UInt16(clamping: cols), ws_xpixel: 0, ws_ypixel: 0)
        _ = withUnsafeMutablePointer(to: &ws) { ioctl(tab.fd, TIOCSWINSZ, $0) }
    }

    func kill(_ tab: TermTab) {
        guard tab.pid > 0 else { return }
        Darwin.kill(-tab.pid, SIGHUP) // the shell and everything it started
        Darwin.kill(tab.pid, SIGHUP)
        tab.source?.cancel()
        tab.pid = 0
    }

    func killAll() { sessions.values.forEach { $0.tabs.forEach { self.kill($0) } } }

    func sid(of tab: TermTab) -> String? { sessions.first { $0.value.tabs.contains { $0 === tab } }?.key }

    // Adds output to a tab's log and passes it to the pages, a frame's worth at a time.
    func output(_ tab: TermTab, _ data: Data, sid: String?) {
        let at = tab.total
        tab.total += data.count
        tab.log.append(data)
        if tab.log.count > logLimit { tab.log = Self.tail(tab.log, logLimit) }
        guard let sid else { return }
        if var p = pendingOut[tab.id] { p.data.append(data); pendingOut[tab.id] = p }
        else { pendingOut[tab.id] = (sid, at, data) }
        if !flushScheduled {
            flushScheduled = true
            perform(#selector(flushOutput), with: nil, afterDelay: 0.016)
        }
        scheduleSave(after: 3)
    }

    @objc private func flushOutput() {
        flushScheduled = false
        let out = pendingOut
        pendingOut = [:]
        for (tabId, p) in out { emit(p.sid, ["type": "data", "sid": p.sid, "tab": tabId, "at": p.at, "b64": p.data.base64EncodedString()]) }
    }

    // Keeps tab titles current: a running program's name (vim, node…) or the shell's folder.
    @objc func refreshTitles() {
        var mirrored = false
        for (sid, s) in sessions {
            var dirty = false
            for tab in s.tabs where tab.running {
                var dir = Self.cwd(of: tab.pid)
                var title = ""
                let fg = tcgetpgrp(tab.fd)
                if fg > 0 && fg != tab.pid { title = Self.processName(fg) }
                // inside a mirrored session the program in front is tmux; look through it
                if title == "tmux", let pane = panes[tab.mirror] {
                    title = Self.shells.contains(pane.command) ? "" : pane.command
                    dir = pane.path
                }
                if title == "tmux" { mirrored = true }
                if !tab.mirror.isEmpty { mirrored = true }
                if let dir, dir != tab.cwd { tab.cwd = dir; dirty = true }
                if title != tab.title { tab.title = title; dirty = true }
            }
            if dirty { changed(sid) }
        }
        guard mirrored, !panesLoading else { return }
        panesLoading = true
        Task {
            let out = await Self.background { Self.tmux("outline", ["list-sessions", "-F", "#{session_name}\t#{pane_current_command}\t#{pane_current_path}"]) }
            var map: [String: (command: String, path: String)] = [:]
            for line in out.split(separator: "\n") {
                let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
                if f.count >= 3 { map[f[0]] = (Self.programName(f[1]), f[2]) }
            }
            panes = map
            panesLoading = false
        }
    }

    nonisolated static let shells: Set<String> = ["zsh", "bash", "fish", "sh", "-zsh", "-bash"]

    // True when the tab's shell is waiting at its prompt (seen through a mirrored session if there is one).
    func atPrompt(_ tab: TermTab) -> Bool {
        guard tab.running else { return false }
        let fg = tcgetpgrp(tab.fd)
        if fg == tab.pid { return true }
        if Self.processName(fg) == "tmux", let pane = panes[tab.mirror] { return Self.shells.contains(pane.command) }
        return false
    }

    // The program in front in the tab, seen through a mirrored session.
    func frontProgram(_ tab: TermTab) -> String {
        let name = Self.processName(tcgetpgrp(tab.fd))
        if name == "tmux", let pane = panes[tab.mirror] { return pane.command }
        return name
    }

    // MARK: windows

    func openWindow(_ sid: String, title: String) {
        let s = session(sid)
        if let w = s.window { w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let controller = WKUserContentController()
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "term")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        let web = WKWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.uiDelegate = app
        web.navigationDelegate = app
        if #available(macOS 13.3, *) { web.isInspectable = true }

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 560),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        win.title = title.isEmpty ? "Terminal" : "Terminal — \(title)"
        win.appearance = NSAppearance(named: .darkAqua)
        win.backgroundColor = NSColor(srgbRed: 0x15 / 255, green: 0x17 / 255, blue: 0x1b / 255, alpha: 1)
        win.minSize = NSSize(width: 420, height: 260)
        win.isReleasedWhenClosed = false
        win.contentView = web
        win.delegate = self
        win.center()
        if let main = app?.window, main.isVisible {
            win.setFrameTopLeftPoint(NSPoint(x: main.frame.minX + 60, y: main.frame.maxY - 60))
        }
        s.window = win

        let res = Bundle.main.resourceURL!
        let query = sid.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        let page = URL(string: res.appendingPathComponent("term.html").absoluteString + "?sid=" + query)!
        web.loadFileURL(page, allowingReadAccessTo: res)
        changed(sid)
        if app?.hidden == true { return } // test runs: load the page without showing the window
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        guard let win = notification.object as? NSWindow,
              let (sid, s) = sessions.first(where: { $0.value.window === win }) else { return }
        if let web = win.contentView as? WKWebView {
            viewers[ObjectIdentifier(web)] = nil
            web.configuration.userContentController.removeScriptMessageHandler(forName: "term", contentWorld: .page)
        }
        s.window = nil
        changed(sid)
    }

    // MARK: running commands for the user

    // Types a command into the tab's shell, as if the user had. If the shell is busy with another
    // program, the command runs in a new tab instead; if `unless` is already running there, nothing happens.
    func run(_ command: String, in tab: TermTab, sid: String, unless program: String? = nil) {
        guard let s = sessions[sid] else { return }
        if tab.running {
            if atPrompt(tab) { send(tab, Data("\u{15}\(command)\r".utf8)); return } // Ctrl-U clears a half-typed line
            if let program, frontProgram(tab) == program { return }
            let fresh = TermTab(id: Self.uid(), cwd: tab.cwd)
            s.tabs.append(fresh)
            s.active = fresh.id
            spawn(fresh, cols: 0, rows: 0)
            send(fresh, Data("\(command)\r".utf8)) // the shell reads it once its prompt is up
        } else {
            spawn(tab, cols: 0, rows: 0)
            send(tab, Data("\(command)\r".utf8))
        }
        changed(sid)
    }

    // Moves a tab to a folder: `cd` in its shell (or a new tab there if a program is running).
    func go(to path: String, tab: TermTab, sid: String) {
        recent.removeAll { $0 == path }
        recent.insert(path, at: 0)
        recent = Array(recent.prefix(6))
        if !tab.running { tab.cwd = path }
        run("cd -- \(Self.quote(path))", in: tab, sid: sid)
        scheduleSave()
    }

    // MARK: finding sessions

    nonisolated static func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    nonisolated static func findSessions(_ query: String) async -> [String: Any] {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let (tmux, installed) = tmuxSessions(query)
                cont.resume(returning: ["claude": claudeSessions(query), "tmux": tmux, "tmuxInstalled": installed])
            }
        }
    }

    // Claude Code keeps each session as ~/.claude/projects/<folder>/<session id>.jsonl.
    nonisolated static func claudeSessions(_ query: String, limit: Int = 25) -> [[String: Any]] {
        let fm = FileManager.default
        let root = URL(fileURLWithPath: home).appendingPathComponent(".claude/projects")
        var files: [(URL, Date)] = []
        for dir in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
            for f in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] where f.pathExtension == "jsonl" {
                files.append((f, (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast))
            }
        }
        files.sort { $0.1 > $1.1 }
        var out: [[String: Any]] = []
        for (i, (file, date)) in files.enumerated() {
            let id = file.deletingPathExtension().lastPathComponent
            let idHit = !query.isEmpty && id.lowercased().contains(query)
            // read only the newest sessions closely; older ones are found by their ID
            if !idHit && i >= 300 { continue }
            guard let info = claudeInfo(file) else { continue }
            if !query.isEmpty && !idHit && !info.cwd.lowercased().contains(query) && !info.title.lowercased().contains(query) { continue }
            out.append(["kind": "claude", "id": id, "cwd": info.cwd, "title": info.title, "time": date.timeIntervalSince1970 * 1000])
            if out.count >= limit { break }
        }
        return out
    }

    // The session's folder and a title: Claude's own summary if it wrote one, else the first thing typed.
    nonisolated static func claudeInfo(_ file: URL) -> (cwd: String, title: String)? {
        guard let h = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? h.close() }
        let data = (try? h.read(upToCount: 256 * 1024)) ?? Data()
        var cwd = "", first = "", summary = ""
        for line in data.split(separator: 0x0a) {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
            if cwd.isEmpty, let c = obj["cwd"] as? String { cwd = c }
            if summary.isEmpty, obj["type"] as? String == "summary", let t = obj["summary"] as? String { summary = t }
            if first.isEmpty, obj["type"] as? String == "user", obj["isMeta"] as? Bool != true, obj["isSidechain"] as? Bool != true,
               let msg = obj["message"] as? [String: Any] {
                var text = msg["content"] as? String ?? ""
                if let parts = msg["content"] as? [[String: Any]] { text = parts.first { $0["type"] as? String == "text" }?["text"] as? String ?? "" }
                text = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty && !text.hasPrefix("<") { first = text }
            }
            if !cwd.isEmpty && !first.isEmpty && !summary.isEmpty { break }
        }
        guard !first.isEmpty || !summary.isEmpty else { return nil } // nothing was ever said in it
        let title = (summary.isEmpty ? first : summary).replacingOccurrences(of: "\n", with: " ")
        return (cwd, String(title.prefix(140)))
    }

    nonisolated static func tmuxPath() -> String? {
        ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    // Runs tmux on a socket ("outline" = mirrored terminals, "default" = tmux started by hand) and returns its output.
    nonisolated static func tmux(_ socket: String, _ args: [String]) -> String {
        guard let path = tmuxPath() else { return "" }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = (socket == "default" ? [] : ["-L", socket]) + args
        p.environment = shellEnv()
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return "" }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    nonisolated static func background<T>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { cont in DispatchQueue.global(qos: .userInitiated).async { cont.resume(returning: work()) } }
    }

    // The Claude CLI's process is named after its version (2.1.310); show it as "claude".
    nonisolated static func programName(_ name: String) -> String {
        name.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil ? "claude" : name
    }

    // Mirrored terminals (and any tmux sessions started by hand), newest first. A query matches the ID, app,
    // program, folder, or text on the session's screen.
    nonisolated static func tmuxSessions(_ query: String) -> ([[String: Any]], Bool) {
        guard tmuxPath() != nil else { return ([], false) }
        var rows: [[String: Any]] = []
        for socket in ["outline", "default"] {
            let out = tmux(socket, ["list-sessions", "-F", "#{session_name}\t#{session_activity}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}\t#{@app}"])
            for line in out.split(separator: "\n") {
                let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
                guard f.count >= 6 else { continue }
                let program = programName(f[3])
                var row: [String: Any] = ["kind": "tmux", "socket": socket, "id": f[0], "time": (Double(f[1]) ?? 0) * 1000,
                                          "attached": Int(f[2]) ?? 0, "program": shells.contains(program) ? "" : program,
                                          "cwd": f[4], "app": socket == "default" ? "tmux" : (f[5].isEmpty ? "shell" : f[5])]
                if !query.isEmpty {
                    let fields = [f[0], f[4], program, row["app"] as! String].map { $0.lowercased() }
                    if !fields.contains(where: { $0.contains(query) }) {
                        let screen = tmux(socket, ["capture-pane", "-p", "-J", "-t", "=\(f[0]):"]).lowercased()
                        guard screen.contains(query) else { continue }
                        row["match"] = "screen"
                    }
                }
                rows.append(row)
            }
        }
        return (rows.sorted { ($0["time"] as? Double ?? 0) > ($1["time"] as? Double ?? 0) }, true)
    }

    // The last few messages of a Claude Code session, for the picker's preview.
    nonisolated static func claudeTail(_ id: String) -> String {
        guard id.range(of: "^[0-9a-fA-F-]{8,}$", options: .regularExpression) != nil else { return "" }
        let root = URL(fileURLWithPath: home).appendingPathComponent(".claude/projects")
        let fm = FileManager.default
        guard let file = ((try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [])
            .map({ $0.appendingPathComponent(id + ".jsonl") }).first(where: { fm.fileExists(atPath: $0.path) }),
              let h = try? FileHandle(forReadingFrom: file) else { return "" }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        try? h.seek(toOffset: size > 262_144 ? size - 262_144 : 0)
        let data = (try? h.readToEnd()) ?? Data()
        var lines: [String] = []
        for raw in data.split(separator: 0x0a) {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(raw)) as? [String: Any],
                  obj["isSidechain"] as? Bool != true, obj["isMeta"] as? Bool != true,
                  let type = obj["type"] as? String, type == "user" || type == "assistant",
                  let msg = obj["message"] as? [String: Any] else { continue }
            var text = msg["content"] as? String ?? ""
            if let parts = msg["content"] as? [[String: Any]] {
                text = parts.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: " ")
            }
            text = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
            if text.isEmpty || text.hasPrefix("<") { continue }
            lines.append((type == "user" ? "› " : "✻ ") + String(text.prefix(280)))
        }
        return lines.suffix(6).joined(separator: "\n\n")
    }

    // MARK: mirroring every terminal

    nonisolated static var shellDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Outline/shell", isDirectory: true)
    }
    nonisolated static let zshrcMarker = "# Outline: mirror every terminal"
    nonisolated static var zshrc: URL { URL(fileURLWithPath: home).appendingPathComponent(".zshrc") }

    // Keeps the hook and its tmux settings current in Application Support, where ~/.zshrc points.
    func installMirrorFiles() {
        let fm = FileManager.default
        try? fm.createDirectory(at: Self.shellDir, withIntermediateDirectories: true)
        for name in ["mirror.zsh", "tmux.conf"] {
            guard let src = Bundle.main.url(forResource: (name as NSString).deletingPathExtension, withExtension: (name as NSString).pathExtension),
                  let data = try? Data(contentsOf: src) else { continue }
            let dst = Self.shellDir.appendingPathComponent(name)
            if (try? Data(contentsOf: dst)) != data { try? data.write(to: dst, options: .atomic) }
        }
    }

    nonisolated static func mirrorInstalled() -> Bool {
        ((try? String(contentsOf: zshrc, encoding: .utf8)) ?? "").contains(zshrcMarker)
    }

    // Adds (at the very top, so it runs before anything else) or removes the line that sources the hook.
    nonisolated static func setMirror(_ on: Bool) throws {
        let fm = FileManager.default
        let text = (try? String(contentsOf: zshrc, encoding: .utf8)) ?? ""
        if on == text.contains(zshrcMarker) { return }
        let backup = URL(fileURLWithPath: home).appendingPathComponent(".zshrc.before-outline")
        if !fm.fileExists(atPath: backup.path), fm.fileExists(atPath: zshrc.path) { try fm.copyItem(at: zshrc, to: backup) }
        let line = "[[ -r \"$HOME/Library/Application Support/Outline/shell/mirror.zsh\" ]] && source \"$HOME/Library/Application Support/Outline/shell/mirror.zsh\"  \(zshrcMarker)"
        let updated = on ? line + "\n" + text
                         : text.split(separator: "\n", omittingEmptySubsequences: false).filter { !$0.contains(zshrcMarker) }.joined(separator: "\n")
        try updated.write(to: zshrc, atomically: true, encoding: .utf8)
    }

    // MARK: saving

    private var saveScheduled = false
    func scheduleSave(after delay: Double = 0.5) {
        guard !saveScheduled else { return }
        saveScheduled = true
        perform(#selector(save), with: nil, afterDelay: delay)
    }

    @objc func save() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(save), object: nil)
        saveScheduled = false
        var out: [String: Any] = [:]
        for (sid, s) in sessions {
            out[sid] = [
                "active": s.active,
                "tabs": s.tabs.map { ["id": $0.id, "name": $0.name, "cwd": $0.cwd, "command": $0.command, "log": Self.trimmedForDisk($0.log).base64EncodedString()] },
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: ["v": 1, "sessions": out, "recent": recent]) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let saved = root["sessions"] as? [String: [String: Any]] else { return }
        recent = root["recent"] as? [String] ?? []
        for (sid, s) in saved {
            let tabs: [TermTab] = (s["tabs"] as? [[String: Any]] ?? []).compactMap { t in
                guard let id = t["id"] as? String else { return nil }
                let tab = TermTab(id: id, name: t["name"] as? String ?? "", cwd: t["cwd"] as? String ?? Self.startFolder)
                tab.command = t["command"] as? String ?? ""
                if let b64 = t["log"] as? String, let log = Data(base64Encoded: b64), !log.isEmpty {
                    tab.log = log; tab.total = log.count; tab.restored = true
                }
                return tab
            }
            guard !tabs.isEmpty else { continue }
            let active = s["active"] as? String
            sessions[sid] = TermSession(tabs: tabs, active: tabs.contains { $0.id == active } ? active! : tabs[0].id)
        }
    }

    // MARK: helpers

    nonisolated static func tail(_ data: Data, _ limit: Int) -> Data {
        data.count <= limit ? data : Data(data.suffix(limit))
    }

    // Starts the saved log at a line break so a replay never begins halfway through an escape code.
    nonisolated static func trimmedForDisk(_ log: Data) -> Data {
        guard log.count > savedLogLimit else { return log }
        let t = log.suffix(savedLogLimit)
        if let nl = t.firstIndex(of: 0x0a) { return Data(t[t.index(after: nl)...]) }
        return Data(t)
    }

    // Terminal output as the lines it left on screen, without colours or cursor codes (for the self-test).
    // Handles the in-line redraws shells do (carriage returns, backspaces, cursor left/right, erase line).
    nonisolated static func plain(_ data: Data) -> String {
        let chars = Array(String(decoding: data, as: UTF8.self).unicodeScalars)
        var lines: [String] = []
        var line: [Character] = []
        var col = 0
        func put(_ c: Character) {
            if col < line.count { line[col] = c } else { line += Array(repeating: " ", count: col - line.count); line.append(c) }
            col += 1
        }
        func newline() { lines.append(String(line).replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)); line = []; col = 0 }
        var i = 0
        while i < chars.count {
            let c = chars[i]
            switch c.value {
            case 0x1b:
                guard i + 1 < chars.count else { i += 1; continue }
                let next = chars[i + 1]
                if next == "[" { // CSI: params, then a final byte
                    var j = i + 2, params = ""
                    while j < chars.count, (0x20...0x3f).contains(chars[j].value) { params.unicodeScalars.append(chars[j]); j += 1 }
                    let final = j < chars.count ? chars[j] : "m"
                    let n = max(1, Int(params.filter(\.isNumber)) ?? 1)
                    switch final {
                    case "D": col = max(0, col - n)
                    case "C": col += n
                    case "G": col = n - 1
                    case "K": if params.isEmpty || params == "0" { if col < line.count { line.removeSubrange(col...) } } else if params == "2" { line = [] }
                    case "J": if col < line.count { line.removeSubrange(col...) }
                    default: break
                    }
                    i = j + 1
                } else if next == "]" { // OSC: up to BEL or ESC \
                    var j = i + 2
                    while j < chars.count, chars[j].value != 0x07, !(chars[j].value == 0x1b) { j += 1 }
                    i = j < chars.count && chars[j].value == 0x1b ? j + 2 : j + 1
                } else if next == "(" || next == ")" {
                    i += 3
                } else {
                    i += 2
                }
                continue
            case 0x0a: newline()
            case 0x0d: col = 0
            case 0x08: col = max(0, col - 1)
            case 0x09: repeat { put(" ") } while col % 8 != 0
            case 0..<0x20, 0x7f: break
            default: put(Character(c))
            }
            i += 1
        }
        if !line.isEmpty { newline() }
        return lines.joined(separator: "\n")
    }

    nonisolated static func loginShell() -> String {
        if let pw = getpwuid(getuid()), let sh = pw.pointee.pw_shell, let shell = String(validatingUTF8: sh),
           FileManager.default.isExecutableFile(atPath: shell) { return shell }
        return "/bin/zsh"
    }

    nonisolated static func shellEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        for k in env.keys where k.hasPrefix("OUTLINE_") || k.hasPrefix("CLAUDECODE") || k.hasPrefix("CLAUDE_CODE_") || k == "__CFBundleIdentifier" || k == "TERM_SESSION_ID" {
            env[k] = nil
        }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Outline"
        if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
        env["HOME"] = env["HOME"] ?? home
        env["SHELL"] = loginShell()
        let extra = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        let path = (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        env["PATH"] = (extra.filter { !path.contains($0) } + path).joined(separator: ":")
        return env
    }

    nonisolated static func cwd(of pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        let path = withUnsafeBytes(of: &info.pvi_cdir.vip_path) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
        return path.isEmpty ? nil : path
    }

    nonisolated static func processName(_ pid: pid_t) -> String {
        // the Claude CLI's executable is named after its version (…/claude/versions/2.1.310)
        var path = [CChar](repeating: 0, count: 4096)
        if proc_pidpath(pid, &path, UInt32(path.count)) > 0, String(cString: path).contains("/claude/versions/") { return "claude" }
        var buf = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buf, UInt32(buf.count)) > 0 else { return "" }
        return String(cString: buf)
    }

    nonisolated static func folderName(_ path: String) -> String {
        if path == home { return "~" }
        return (path as NSString).lastPathComponent
    }
}
