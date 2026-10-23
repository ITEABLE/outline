import Cocoa
import WebKit
import CryptoKit

// Pictures in notes are saved as files in <store>/images/ (named by a hash of their bytes, so the same
// picture is stored once) and shown through the outline-image:// scheme. Keeping them out of notes.json
// keeps saving and launching fast however many screenshots a note holds.
@MainActor
final class ImageStore: NSObject, WKScriptMessageHandlerWithReply, WKURLSchemeHandler {
    static let scheme = "outline-image"
    let dir: URL

    init(storeDir: URL) {
        dir = storeDir.appendingPathComponent("images", isDirectory: true)
    }

    static let types = ["png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
                        "heic": "image/heic", "tiff": "image/tiff", "bmp": "image/bmp", "svg": "image/svg+xml"]

    // { op: "save", b64, type } → "outline-image://img/<hash>.<ext>"
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], body["op"] as? String == "save",
              let b64 = body["b64"] as? String, let data = Data(base64Encoded: b64), !data.isEmpty else {
            return (nil, "Outline couldn't read that picture.")
        }
        let mime = (body["type"] as? String ?? "").lowercased()
        let ext = Self.types.first { $0.value == mime }?.key ?? (mime == "image/jpg" ? "jpg" : "png")
        let name = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(32) + "." + ext
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent(String(name))
            if !FileManager.default.fileExists(atPath: file.path) { try data.write(to: file, options: .atomic) }
            return ("\(Self.scheme)://img/\(name)", nil)
        } catch {
            return (nil, "Outline couldn't save that picture: \(error.localizedDescription)")
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let name = task.request.url?.lastPathComponent ?? ""
        let ext = (name as NSString).pathExtension.lowercased()
        // only plain file names made here: no paths, nothing outside the images folder
        guard name.range(of: "^[0-9a-f]+\\.[a-z]+$", options: .regularExpression) != nil,
              let data = try? Data(contentsOf: dir.appendingPathComponent(name)), let url = task.request.url else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(URLResponse(url: url, mimeType: Self.types[ext] ?? "application/octet-stream", expectedContentLength: data.count, textEncodingName: nil))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
