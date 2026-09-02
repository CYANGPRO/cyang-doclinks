import Capacitor
import CryptoKit
import DeviceCheck
import EventKit
import Foundation
import LocalAuthentication
import UIKit
import UniformTypeIdentifiers
import VisionKit
import WebKit

@objc(Local801NativePlugin)
public final class Local801NativePlugin: CAPPlugin, CAPBridgedPlugin, VNDocumentCameraViewControllerDelegate, DataScannerViewControllerDelegate {
    public let identifier = "Local801NativePlugin"
    public let jsName = "Local801Native"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanDocument", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanCode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queueBackgroundUpload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addCalendarReminder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateSafeSummary", returnType: CAPPluginReturnPromise)
    ]

    private var scannerCall: CAPPluginCall?
    private var codeCall: CAPPluginCall?
    private let maxUploadBytes = 8 * 1024 * 1024

    @objc func getCapabilities(_ call: CAPPluginCall) {
        let codeScanner: Bool
        if #available(iOS 16.0, *) {
            codeScanner = DataScannerViewController.isSupported
        } else {
            codeScanner = false
        }
        call.resolve(["platform": "ios", "biometric": true, "attestation": DCAppAttestService.shared.isSupported,
            "documentScanner": VNDocumentCameraViewController.isSupported, "codeScanner": codeScanner,
            "backgroundUpload": true, "calendar": true, "safeSummary": true])
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        let context = LAContext(); var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { call.reject("Biometric or device-credential authentication is unavailable."); return }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: call.getString("reason") ?? "Authenticate to continue") { success, _ in
            DispatchQueue.main.async { success ? call.resolve(["authenticated": true]) : call.reject("Authentication did not complete.") }
        }
    }

    @objc func attest(_ call: CAPPluginCall) {
        guard let challenge = call.getString("challenge"), challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let challengeData = Data(base64Encoded: challenge.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=") else {
            call.reject("The device challenge is invalid."); return
        }
        let service = DCAppAttestService.shared
        guard service.isSupported else { call.reject("Apple App Attest is unavailable on this device."); return }
        let hash = Data(SHA256.hash(data: challengeData)); let defaults = UserDefaults.standard
        if let keyId = defaults.string(forKey: "local801.appAttestKey") {
            service.generateAssertion(keyId, clientDataHash: hash) { assertion, _ in
                guard let assertion else { call.reject("Apple App Attest could not verify this installation."); return }
                call.resolve(["platform": "ios", "evidence": assertion.base64EncodedString(), "evidenceKind": "app_assertion", "keyId": keyId])
            }
            return
        }
        service.generateKey { keyId, _ in
            guard let keyId else { call.reject("Apple App Attest could not create a device key."); return }
            service.attestKey(keyId, clientDataHash: hash) { attestation, _ in
                guard let attestation else { call.reject("Apple App Attest could not verify this installation."); return }
                defaults.set(keyId, forKey: "local801.appAttestKey")
                call.resolve(["platform": "ios", "evidence": attestation.base64EncodedString(), "evidenceKind": "app_attest", "keyId": keyId])
            }
        }
    }

    @objc func scanDocument(_ call: CAPPluginCall) {
        guard VNDocumentCameraViewController.isSupported else { call.reject("Document scanning is unavailable."); return }
        scannerCall = call; DispatchQueue.main.async {
            let controller = VNDocumentCameraViewController(); controller.delegate = self
            self.bridge?.viewController?.present(controller, animated: true)
        }
    }

    public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        scannerCall?.reject("Document scanning was cancelled."); scannerCall = nil; controller.dismiss(animated: true)
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        scannerCall?.reject("Document scanning is unavailable."); scannerCall = nil; controller.dismiss(animated: true)
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        let format = UIGraphicsPDFRendererFormat(); let page = CGRect(x: 0, y: 0, width: 612, height: 792)
        let pdf = UIGraphicsPDFRenderer(bounds: page, format: format).pdfData { context in
            for index in 0..<scan.pageCount { context.beginPage(); scan.imageOfPage(at: index).draw(in: page) }
        }
        if pdf.isEmpty || pdf.count > maxUploadBytes { scannerCall?.reject("The scanned PDF exceeds the secure upload limit.") }
        else { scannerCall?.resolve(["name": "Scanned document.pdf", "mediaType": "application/pdf", "base64Data": pdf.base64EncodedString()]) }
        scannerCall = nil; controller.dismiss(animated: true)
    }

    @objc func scanCode(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *), DataScannerViewController.isSupported, DataScannerViewController.isAvailable else { call.reject("QR scanning is unavailable."); return }
        codeCall = call; DispatchQueue.main.async {
            let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true,
                isGuidanceEnabled: true, isHighlightingEnabled: true); controller.delegate = self
            controller.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(self.cancelCodeScan))
            let navigation = UINavigationController(rootViewController: controller)
            self.bridge?.viewController?.present(navigation, animated: true) { try? controller.startScanning() }
        }
    }

    @objc private func cancelCodeScan() {
        if #available(iOS 16.0, *), let controller = (bridge?.viewController?.presentedViewController as? UINavigationController)?.topViewController as? DataScannerViewController {
            controller.stopScanning()
        }
        bridge?.viewController?.dismiss(animated: true); codeCall?.reject("QR scanning was cancelled."); codeCall = nil
    }

    @available(iOS 16.0, *)
    public func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        guard let first = addedItems.first, case let .barcode(code) = first, let value = code.payloadStringValue, value.count <= 2048 else { return }
        dataScanner.stopScanning(); dataScanner.navigationController?.dismiss(animated: true); codeCall?.resolve(["value": value]); codeCall = nil
    }

    @objc func getPendingShare(_ call: CAPPluginCall) {
        guard let shared = Local801BridgeViewController.consumeSharedPdf() else { call.resolve(["source": "none"]); return }
        call.resolve(["source": "share", "name": shared.name, "mediaType": "application/pdf", "base64Data": shared.data.base64EncodedString()])
    }

    @objc func queueBackgroundUpload(_ call: CAPPluginCall) {
        guard let encoded = call.getString("base64Data"), let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= maxUploadBytes,
              let name = safe(call.getString("name"), 255), name.range(of: "^[A-Za-z0-9][A-Za-z0-9 ._()\\-]{0,250}\\.pdf$", options: [.regularExpression, .caseInsensitive]) != nil,
              let title = safe(call.getString("title"), 255), let category = safe(call.getString("category"), 100),
              let visibility = safe(call.getString("visibility"), 64) else { call.reject("The secure upload details are invalid."); return }
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            let cookie = HTTPCookie.requestHeaderFields(with: cookies)["Cookie"] ?? ""
            guard !cookie.isEmpty else { call.reject("Sign in again before queuing a background upload."); return }
            do {
                let boundary = "Local801-\(UUID().uuidString)"; var body = Data()
                func append(_ value: String) { body.append(value.data(using: .utf8)!) }
                for (field, value) in [("title", title), ("category", category), ("visibility", visibility)] {
                    append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"\r\n\r\n\(value)\r\n")
                }
                append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: application/pdf\r\n\r\n")
                body.append(data); append("\r\n--\(boundary)--\r\n")
                let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PendingUploads", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
                let file = directory.appendingPathComponent(UUID().uuidString + ".multipart"); try body.write(to: file, options: [.atomic, .completeFileProtection])
                var values = URLResourceValues(); values.isExcludedFromBackup = true; var mutableFile = file; try mutableFile.setResourceValues(values)
                var request = URLRequest(url: URL(string: "https://cat.cyang.io/api/documents/upload")!); request.httpMethod = "POST"
                request.setValue("https://cat.cyang.io", forHTTPHeaderField: "Origin"); request.setValue(cookie, forHTTPHeaderField: "Cookie")
                request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
                Local801BackgroundUpload.shared.enqueue(request: request, file: file)
                call.resolve(["queued": true])
            } catch { call.reject("The secure background upload could not be queued.") }
        }
    }

    private func safe(_ value: String?, _ maximum: Int) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty, trimmed.count <= maximum,
              trimmed.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }; return trimmed
    }

    @objc func addCalendarReminder(_ call: CAPPluginCall) {
        guard let title = safe(call.getString("title"), 100), let starts = call.getString("startsAt"), let start = ISO8601DateFormatter().date(from: starts),
              let route = call.getString("route"), route.range(of: "^/[A-Za-z0-9?&=_/-]{1,200}$", options: .regularExpression) != nil else { call.reject("The calendar reminder is invalid."); return }
        let store = EKEventStore()
        let save: () -> Void = {
            guard let calendar = store.defaultCalendarForNewEvents else { call.reject("No writable calendar is available."); return }
            let event = EKEvent(eventStore: store); event.title = title; event.startDate = start; event.endDate = start.addingTimeInterval(1800); event.calendar = calendar
            event.url = URL(string: "https://cat.cyang.io" + route)
            do { try store.save(event, span: .thisEvent); call.resolve(["opened": true]) } catch { call.reject("The calendar reminder could not be saved.") }
        }
        if #available(iOS 17.0, *) { store.requestFullAccessToEvents { granted, _ in granted ? save() : call.reject("Calendar access was not granted.") } }
        else { store.requestAccess(to: .event) { granted, _ in granted ? save() : call.reject("Calendar access was not granted.") } }
    }

    @objc func updateSafeSummary(_ call: CAPPluginCall) {
        let urgent = max(0, min(999, call.getInt("urgentCount") ?? 0)); let total = max(0, min(999, call.getInt("totalCount") ?? 0))
        UserDefaults.standard.set(["urgent": urgent, "total": total], forKey: "local801.safeSummary")
        UIApplication.shared.shortcutItems = [
            UIApplicationShortcutItem(type: "io.cyang.local801.work", localizedTitle: "Work inbox", localizedSubtitle: nil, icon: UIApplicationShortcutIcon(systemImageName: "tray.full"), userInfo: nil),
            UIApplicationShortcutItem(type: "io.cyang.local801.documents", localizedTitle: "Scan document", localizedSubtitle: nil, icon: UIApplicationShortcutIcon(systemImageName: "doc.viewfinder"), userInfo: nil)
        ]; call.resolve(["updated": true])
    }
}

final class Local801BackgroundUpload: NSObject, URLSessionTaskDelegate {
    private var completionHandler: (() -> Void)?
    static let shared = Local801BackgroundUpload(); private var session: URLSession!
    private override init() { super.init(); session = URLSession(configuration: URLSessionConfiguration.background(withIdentifier: "io.cyang.local801engage.secure-upload"), delegate: self, delegateQueue: nil) }
    func enqueue(request: URLRequest, file: URL) { let task = session.uploadTask(with: request, fromFile: file); task.taskDescription = "0|" + file.path; task.resume() }
    func setCompletionHandler(_ handler: @escaping () -> Void) { completionHandler = handler }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let parts = (task.taskDescription ?? "").split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2, let attempt = Int(parts[0]) else { return }; let path = parts[1]
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if (error == nil && (200..<300).contains(status)) || (400..<500).contains(status) { try? FileManager.default.removeItem(atPath: path); return }
        guard attempt < 4, FileManager.default.fileExists(atPath: path), let request = task.originalRequest else { try? FileManager.default.removeItem(atPath: path); return }
        let retry = session.uploadTask(with: request, fromFile: URL(fileURLWithPath: path)); retry.taskDescription = "\(attempt + 1)|\(path)"; retry.resume()
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) { DispatchQueue.main.async { self.completionHandler?(); self.completionHandler = nil } }
}

final class Local801BridgeViewController: CAPBridgeViewController {
    private static var sharedPdf: (name: String, data: Data, receivedAt: Date)?
    private var lastUnlock = Date.distantPast
    private var unlocking = false
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(Local801NativePlugin())
        if Self.sharedPdf != nil, let url = URL(string: "https://cat.cyang.io/documents") { webView?.load(URLRequest(url: url)) }
    }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); guard Date().timeIntervalSince(lastUnlock) > 120 else { return }; lock() }
    func requireUnlock() { guard !unlocking, Date().timeIntervalSince(lastUnlock) > 120 else { return }; lock() }
    private func lock() {
        unlocking = true
        view.isHidden = true; let context = LAContext(); var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            unlocking = false
            let alert = UIAlertController(title: "Device lock required", message: "Configure Face ID, Touch ID, or a device passcode before using Engaging Local 801.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default)); present(alert, animated: true); return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Engaging Local 801") { success, _ in
            DispatchQueue.main.async { self.unlocking = false; if success { self.lastUnlock = Date(); self.view.isHidden = false } }
        }
    }
    static func receivePdf(url: URL) {
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard url.pathExtension.lowercased() == "pdf", let values = try? url.resourceValues(forKeys: [.fileSizeKey]), (values.fileSize ?? 0) <= 8 * 1024 * 1024,
              let data = try? Data(contentsOf: url, options: .mappedIfSafe), !data.isEmpty, data.count <= 8 * 1024 * 1024 else { return }
        sharedPdf = (String(url.lastPathComponent.prefix(255)), data, Date())
    }
    static func consumeSharedPdf() -> (name: String, data: Data)? {
        defer { sharedPdf = nil }; guard let value = sharedPdf, Date().timeIntervalSince(value.receivedAt) <= 300 else { return nil }
        return (value.name, value.data)
    }
}
