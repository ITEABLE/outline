import Cocoa
import WebKit

// Invisible strip over the title bar so the window can still be dragged
// even though the web content runs underneath it.
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
    }
}

struct BridgeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// The page asks for Apple Notes work through `webkit.messageHandlers.appleNotes.postMessage`
// and gets a promise back. The Notes scripting itself lives in notes.js, run by osascript
// on a background thread so a big send never freezes the window.
@MainActor
final class AppleNotesBridge: NSObject, WKScriptMessageHandlerWithReply {
    let storeDir: URL
    init(storeDir: URL) { self.storeDir = storeDir }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else {
            return (nil, "Outline sent Apple Notes a request it didn't understand.")
        }
        if action == "backup" { return backup() }
        guard action == "send" || action == "fetch" else { return (nil, "Unknown Apple Notes action: \(action)") }
        do {
            return (try await Self.osascript(action: action, payload: body["payload"] as? String ?? "{}"), nil)
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    // Copies notes.json aside before changes from Apple Notes are applied.
    func backup() -> (Any?, String?) {
        let fm = FileManager.default
        let src = storeDir.appendingPathComponent("notes.json")
        guard fm.fileExists(atPath: src.path) else { return ("none", nil) }
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let dst = storeDir.appendingPathComponent("notes.before-import.\(stamp).json")
        do {
            try fm.copyItem(at: src, to: dst)
            return (dst.lastPathComponent, nil)
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    nonisolated static func osascript(action: String, payload: String) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                do { cont.resume(returning: try runScript(action: action, payload: payload)) }
                catch { cont.resume(throwing: error) }
            }
        }
    }

    nonisolated static func runScript(action: String, payload: String) throws -> String {
        guard let script = Bundle.main.url(forResource: "notes", withExtension: "js") else {
            throw BridgeError("The Apple Notes helper is missing from Outline. Reinstall the app with ./build.sh --install.")
        }
        let tmp = FileManager.default.temporaryDirectory
        let input = tmp.appendingPathComponent("outline-in-\(UUID().uuidString).json")
        let output = tmp.appendingPathComponent("outline-out-\(UUID().uuidString).json")
        defer {
            try? FileManager.default.removeItem(at: input)
            try? FileManager.default.removeItem(at: output)
        }
        try payload.write(to: input, atomically: true, encoding: .utf8)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-l", "JavaScript", script.path, action, input.path, output.path]
        let errors = Pipe()
        process.standardError = errors
        process.standardOutput = FileHandle.nullDevice
        try process.run()
        let errorData = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        if process.terminationStatus != 0 {
            let text = String(data: errorData, encoding: .utf8) ?? ""
            if text.contains("-1743") || text.localizedCaseInsensitiveContains("not authorized") {
                throw BridgeError("Outline isn't allowed to use Apple Notes. Open System Settings › Privacy & Security › Automation, find Outline, and turn on Notes.")
            }
            throw BridgeError("Apple Notes didn't respond: \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
        return try String(contentsOf: output, encoding: .utf8)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var pending: String?
    var backedUp = false
    var terminals: TerminalManager!

    // OUTLINE_STORE_DIR / OUTLINE_HIDDEN let a test run use a scratch copy of the notes without a window.
    let env = ProcessInfo.processInfo.environment
    lazy var hidden = env["OUTLINE_HIDDEN"] != nil
    lazy var storeDir: URL = env["OUTLINE_STORE_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Outline", isDirectory: true)
    var storeURL: URL { storeDir.appendingPathComponent("notes.json") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        try? FileManager.default.createDirectory(at: storeDir, withIntermediateDirectories: true)

        terminals = TerminalManager(storeDir: storeDir)
        terminals.app = self
        let controller = WKUserContentController()
        controller.add(self, name: "store")
        controller.addScriptMessageHandler(AppleNotesBridge(storeDir: storeDir), contentWorld: .page, name: "appleNotes")
        controller.addScriptMessageHandler(terminals, contentWorld: .page, name: "term")
        let images = ImageStore(storeDir: storeDir)
        controller.addScriptMessageHandler(images, contentWorld: .page, name: "images")
        controller.addUserScript(bootScript(try? String(contentsOf: storeURL, encoding: .utf8)))
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(images, forURLScheme: ImageStore.scheme)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground") // no white flash before the page paints
        webView.uiDelegate = self
        webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        win.title = "Outline"
        win.titleVisibility = .hidden
        win.titlebarAppearsTransparent = true
        win.appearance = NSAppearance(named: .darkAqua)
        win.backgroundColor = NSColor(srgbRed: 0x13 / 255, green: 0x14 / 255, blue: 0x17 / 255, alpha: 1)
        win.minSize = NSSize(width: 680, height: 440)
        win.isReleasedWhenClosed = false
        win.delegate = self

        let content = NSView()
        win.contentView = content
        let strip = DragStrip()
        for v in [webView!, strip] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(v)
        }
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            strip.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            strip.topAnchor.constraint(equalTo: content.topAnchor),
            strip.heightAnchor.constraint(equalToConstant: 28),
        ])

        win.center()
        window = win

        let res = Bundle.main.resourceURL!
        webView.loadFileURL(res.appendingPathComponent("index.html"), allowingReadAccessTo: res)
        if hidden { return }
        win.setFrameAutosaveName("OutlineMain")
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Hands the saved notes to the page before it runs, as a JS string literal.
    func bootScript(_ saved: String?) -> WKUserScript {
        var literal = "null"
        if let saved, let data = try? JSONSerialization.data(withJSONObject: [saved]),
           let array = String(data: data, encoding: .utf8) {
            literal = "\(array)[0]"
        }
        return WKUserScript(source: "window.__NATIVE__ = { raw: \(literal) };",
                            injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    // The page posts the full notes JSON when it saves; disk writes are batched.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let json = message.body as? String else { return }
        pending = json
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(flush), object: nil)
        perform(#selector(flush), with: nil, afterDelay: 0.3)
    }

    @objc func flush() {
        guard let json = pending else { return }
        pending = nil
        let fm = FileManager.default
        if !backedUp, fm.fileExists(atPath: storeURL.path) {
            // keep a copy of whatever was on disk at launch
            let backup = storeDir.appendingPathComponent("notes.backup.json")
            try? fm.removeItem(at: backup)
            try? fm.copyItem(at: storeURL, to: backup)
        }
        backedUp = true
        try? json.write(to: storeURL, atomically: true, encoding: .utf8)
        // keep the boot data current so a reload never resurrects stale notes
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(bootScript(json))
    }

    // MARK: page dialogs — WKWebView shows nothing for confirm()/alert() unless the app does

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    // OUTLINE_SELFTEST=<file>: once the page has loaded, send one request through the Apple Notes
    // bridge (the backup action, which doesn't touch Notes), run a command in a real terminal, open
    // its window, save and show a picture, write the results to <file>, and quit. OUTLINE_SELFTEST_CLAUDE also starts the Claude CLI in it.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let out = env["OUTLINE_SELFTEST"], webView === self.webView else { return }
        let js = """
        try {
          const backup = await window.webkit.messageHandlers.appleNotes.postMessage({ action: 'backup' });
          // every request gets a deadline, so a request that never answers fails the test instead of hanging it
          const term = window.webkit.messageHandlers.term, sid = 'selftest', done = [];
          const t = { postMessage: m => Promise.race([
            term.postMessage(m).then(v => { done.push(m.op); return v; }),
            new Promise((_, no) => setTimeout(() => no(new Error(`no reply to ${m.op} (after ${done.join(', ')})`)), 6000)),
          ]) };
          await t.postMessage({ op: 'attach', sid });
          const s = await t.postMessage({ op: 'start', sid, cols: 80, rows: 24 });
          await t.postMessage({ op: 'input', sid, tab: s.tab, data: 'echo outline-$((40+2))\\r' });
          let text = '';
          for (let i = 0; i < 50 && !/^outline-42/m.test(text); i++) {
            await new Promise(r => setTimeout(r, 200));
            text = await t.postMessage({ op: 'text', sid, tab: s.tab });
          }
          const info = await t.postMessage({ op: 'attach', sid });
          let claude = '';
          if (\(env["OUTLINE_SELFTEST_CLAUDE"] != nil)) {
            await t.postMessage({ op: 'claude', sid, tab: s.tab });
            let title = '';
            for (let i = 0; i < 50 && title !== 'claude'; i++) {
              await new Promise(r => setTimeout(r, 200));
              title = (await t.postMessage({ op: 'attach', sid })).tabs[0].title;
            }
            claude = ' claude=' + (title === 'claude' ? 'ok' : 'fail:' + title);
          }
          await t.postMessage({ op: 'expand', sid, title: 'Self-test' });
          let viewers = 0; // the block's page + the window's page
          for (let i = 0; i < 40 && viewers < 2; i++) { await new Promise(r => setTimeout(r, 200)); viewers = await t.postMessage({ op: 'viewers', sid }); }
          await t.postMessage({ op: 'closeWindow', sid });
          await t.postMessage({ op: 'gc', keep: [] });
          // a picture saved to a file and shown back through outline-image://
          const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
          const src = await window.webkit.messageHandlers.images.postMessage({ op: 'save', type: 'image/png', b64: png });
          const shown = await new Promise(ok => { const i = new Image(); i.onload = () => ok(i.naturalWidth === 1); i.onerror = () => ok(false); i.src = src; });
          return backup + ' term=' + (/^outline-42/m.test(text) ? 'ok' : 'fail:' + JSON.stringify(text.slice(-300)))
            + ' window=' + (viewers >= 2 ? 'ok' : 'fail') + ' folder=' + info.tabs[0].cwd + claude
            + ' image=' + (shown ? 'ok' : 'fail:' + src);
        } catch (e) { return 'failed: ' + e.message; }
        """
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            let text: String
            switch result {
            case .success(let value): text = "ok \(value)"
            case .failure(let error): text = "error \(error.localizedDescription)"
            }
            try? text.write(toFile: out, atomically: true, encoding: .utf8)
            NSApp.terminate(nil)
        }
    }

    // MARK: file pickers — WKWebView shows nothing for <input type=file> unless the app does

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.image]
        guard let win = webView.window else { return panel.runModal() == .OK ? panel.urls : nil }
        return await panel.beginSheetModal(for: win) == .OK ? panel.urls : nil
    }

    // MARK: links — anything that isn't the app itself opens in the default browser

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .allow }
        // a file dropped outside the editor must never replace the app's page
        if url.isFileURL { return url.path.hasPrefix(Bundle.main.resourcePath ?? "/-") ? .allow : .cancel }
        if url.scheme == "about" { return .allow }
        NSWorkspace.shared.open(url)
        return .cancel
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: quitting

    // The page batches saves, so pull its latest notes before quitting.
    var quitReplied = false
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let webView = webView else { return .terminateNow }
        webView.evaluateJavaScript("window.__flush ? window.__flush() : null") { result, _ in
            if let json = result as? String { self.pending = json }
            self.finishQuit()
        }
        perform(#selector(finishQuit), with: nil, afterDelay: 1.5) // never hang on a stuck page
        return .terminateLater
    }

    @objc func finishQuit() {
        guard !quitReplied else { return }
        quitReplied = true
        flush()
        terminals?.save()
        terminals?.killAll()
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    func applicationWillTerminate(_ notification: Notification) { flush() }
    // closing the notes window quits, even if terminal windows are still open
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === window { NSApp.terminate(nil) }
    }

    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Outline", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Outline", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Outline", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // WKWebView only gets copy/paste/undo shortcuts through a real Edit menu
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
            .keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
            .keyEquivalentModifierMask = [.command, .control]

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        // ⌘W belongs to the page (closes a tab); the window closes with ⇧⌘W
        windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
            .keyEquivalentModifierMask = [.command, .shift]

        for menu in [appMenu, editMenu, viewMenu, windowMenu] {
            let item = NSMenuItem()
            item.submenu = menu
            main.addItem(item)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }
}

@main
@MainActor
enum Main {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(delegate.hidden ? .accessory : .regular)
        app.run()
    }
}
