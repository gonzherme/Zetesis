// Zetesis's own Mac app: a window showing Zetesis's page in WebKit, with Zetesis's menus instead of a
// browser's. Everything Zetesis does happens in the page; this gives it a home on the Mac, and does the
// few things a browser would: saving a note before leaving, downloads, choosing and opening files, and
// finding text.

import AppKit
import WebKit

let address = URL(string: Bundle.main.object(forInfoDictionaryKey: "ZetesisURL") as? String ?? "http://127.0.0.1:8000/")!

func isZetesis(_ url: URL) -> Bool {
    url.scheme == address.scheme && url.host == address.host && url.port == address.port
}

// Links to anything but Zetesis open in the browser, and files opened from a note in their own apps.
@MainActor var openOutside: (URL) -> Void = { _ = NSWorkspace.shared.open($0) }
// Where downloads such as Export backup are saved.
@MainActor var downloadsFolder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]

// The page's background, so the title bar, and the window before the page appears, match it.
let paper = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        ? NSColor(srgbRed: 0x16 / 255, green: 0x18 / 255, blue: 0x16 / 255, alpha: 1)
        : NSColor(srgbRed: 0xf6 / 255, green: 0xf5 / 255, blue: 0xf1 / 255, alpha: 1)
}

// A file name not yet taken in the folder: "backup.zip", then "backup 2.zip", as the Finder does.
func unusedName(_ name: String, in folder: URL) -> URL {
    let base = (name as NSString).deletingPathExtension
    let suffix = (name as NSString).pathExtension.isEmpty ? "" : ".\((name as NSString).pathExtension)"
    var candidate = folder.appending(path: name)
    var number = 2
    while FileManager.default.fileExists(atPath: candidate.path) {
        candidate = folder.appending(path: "\(base) \(number)\(suffix)")
        number += 1
    }
    return candidate
}

// Right-click keeps what a Mac app offers, such as spelling, Look Up and Copy, without a browser's
// Reload or Open in New Window.
final class PageView: WKWebView {
    static let browserItems: Set<String> = [
        "WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
        "WKMenuItemIdentifierOpenLinkInNewWindow", "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierOpenImageInNewWindow", "WKMenuItemIdentifierDownloadImage",
        "WKMenuItemIdentifierOpenFrameInNewWindow", "WKMenuItemIdentifierOpenMediaInNewWindow",
        "WKMenuItemIdentifierDownloadMedia", "WKMenuItemIdentifierInspectElement",
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        var kept: [NSMenuItem] = []
        for item in menu.items where !Self.browserItems.contains(item.identifier?.rawValue ?? "") {
            // No separator first, last, or twice in a row.
            if item.isSeparatorItem && kept.last?.isSeparatorItem ?? true { continue }
            kept.append(item)
        }
        if kept.last?.isSeparatorItem == true { kept.removeLast() }
        menu.items = kept
        // With nothing left, as on the sidebar's background, no menu at all.
        if kept.isEmpty { menu.cancelTrackingWithoutAnimation() }
    }
}

@MainActor final class Shell: NSObject, NSApplicationDelegate, NSSearchFieldDelegate, WKNavigationDelegate, WKUIDelegate,
                              WKDownloadDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    let page: PageView = {
        let configuration = WKWebViewConfiguration()
        // Videos in notes can go full screen.
        configuration.preferences.isElementFullscreenEnabled = true
        return PageView(frame: .zero, configuration: configuration)
    }()
    let unreachable = NSTextField(labelWithString: "Can't reach Zetesis. Trying again…")
    // Finding text in an open note, as a browser's find bar does, above the page. WebKit's own find bar
    // stalls the app's other work while it slides in, so this one is the app's.
    let findBar = NSView()
    let findField = NSSearchField()
    private var titleWatch: NSKeyValueObservation?
    // Where each download goes, and which are files to open once downloaded rather than keep.
    private var destinations: [ObjectIdentifier: URL] = [:]
    private var opening: Set<ObjectIdentifier> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = menuBar(for: self)

        let content = NSView()
        window.contentView = content
        page.frame = content.bounds
        page.autoresizingMask = [.width, .height]
        content.addSubview(page)
        buildFindBar(in: content)
        unreachable.textColor = .secondaryLabelColor
        unreachable.isHidden = true
        unreachable.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(unreachable)
        NSLayoutConstraint.activate([
            unreachable.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            unreachable.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])

        window.title = "Zetesis"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = paper
        window.minSize = NSSize(width: 480, height: 420)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        if !window.setFrameUsingName("Zetesis") { window.center() }
        window.setFrameAutosaveName("Zetesis")

        page.navigationDelegate = self
        page.uiDelegate = self
        // Safari's Develop menu can inspect the page.
        page.isInspectable = true
        page.underPageBackgroundColor = paper
        page.pageZoom = ((UserDefaults.standard.object(forKey: "Zoom") as? Double).map { CGFloat($0) } ?? 1) * Self.actualZoom
        // Shown once loaded, so the window never flashes white.
        page.isHidden = true
        // The title stays hidden, but names the window in the Window menu and Mission Control.
        titleWatch = page.observe(\.title) { [weak self] page, _ in
            MainActor.assumeIsolated { self?.window.title = page.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Zetesis" }
        }
        page.load(URLRequest(url: address))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    // Closing the window keeps Zetesis open, as Notes does; the Dock icon brings it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showWindow(nil)
        return false
    }

    // Quitting saves the open note first, and asks if anything would still be lost. Then the page tells
    // the server it has gone, so the server can stop soon after.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        readyToLeave("Quit") { [weak self] quit in
            guard quit, let page = self?.page else { return NSApp.reply(toApplicationShouldTerminate: quit) }
            page.evaluateJavaScript("reportPresence(true); true") { _, _ in NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    @objc func showWindow(_ sender: Any?) {
        window.makeKeyAndOrderFront(sender)
    }

    // A command the page carries out, as its own key or button would; its answer says what is left to do.
    func run(_ name: String, then answer: @escaping @MainActor (Any?) -> Void = { _ in }) {
        page.callAsyncJavaScript("return menuCommand(name)", arguments: ["name": name], in: nil, in: .page) { result in
            answer(try? result.get())
        }
    }

    @objc func command(_ sender: NSMenuItem) {
        showWindow(nil)
        if let name = sender.representedObject as? String { run(name) }
    }

    // How large the page shows. Its actual size is a quarter larger than in a browser; View › Zoom In and
    // Zoom Out step from there, as in Safari, and the size it's left at is kept.
    static let actualZoom: CGFloat = 1.25
    static let zoomSteps: [CGFloat] = [0.75, 0.85, 1, 1.15, 1.25, 1.5, 1.75, 2]

    var zoom: CGFloat { page.pageZoom / Self.actualZoom }
    @objc func zoomIn(_ sender: Any?) { setZoom(Self.zoomSteps.first { $0 > zoom + 0.01 } ?? zoom) }
    @objc func zoomOut(_ sender: Any?) { setZoom(Self.zoomSteps.last { $0 < zoom - 0.01 } ?? zoom) }
    @objc func actualSize(_ sender: Any?) { setZoom(1) }

    func setZoom(_ zoom: CGFloat) {
        page.pageZoom = zoom * Self.actualZoom
        UserDefaults.standard.set(Double(zoom), forKey: "Zoom")
    }

    // Reloading picks up a change to Zetesis's page, saving the open note first, as quitting does.
    @objc func reload(_ sender: Any?) {
        readyToLeave("Reload") { [weak self] reload in
            guard reload, let page = self?.page else { return }
            page.load(URLRequest(url: page.url ?? address))
        }
    }

    // Whether to go ahead, once the page has saved the open note: yes when leaving would lose nothing, or
    // when you choose to leave anyway. A browser asks the same before closing a page with unsaved changes.
    func readyToLeave(_ verb: String, then leave: @escaping @MainActor (Bool) -> Void) {
        if page.isHidden { return leave(true) }
        page.callAsyncJavaScript("return await prepareToLeave()", in: nil, in: .page) { result in
            guard let loss = try? result.get() as? String, !loss.isEmpty else { return leave(true) }
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "\(verb) anyway?"
            alert.informativeText = loss
            alert.addButton(withTitle: "\(verb) Anyway")
            alert.addButton(withTitle: "Cancel")
            leave(alert.runModal() == .alertFirstButtonReturn)
        }
    }

    func buildFindBar(in content: NSView) {
        findField.placeholderString = "Find in Note"
        findField.delegate = self
        let steps = NSSegmentedControl(images: [NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Previous")!,
                                                NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "Next")!],
                                       trackingMode: .momentary, target: self, action: #selector(step(_:)))
        let done = NSButton(title: "Done", target: self, action: #selector(hideFindBar(_:)))
        let row = NSStackView(views: [findField, steps, done])
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        findBar.addSubview(row)
        findBar.addSubview(line)
        NSLayoutConstraint.activate([
            findField.widthAnchor.constraint(equalToConstant: 240),
            row.trailingAnchor.constraint(equalTo: findBar.trailingAnchor, constant: -12),
            row.centerYAnchor.constraint(equalTo: findBar.centerYAnchor),
            line.leadingAnchor.constraint(equalTo: findBar.leadingAnchor),
            line.trailingAnchor.constraint(equalTo: findBar.trailingAnchor),
            line.bottomAnchor.constraint(equalTo: findBar.bottomAnchor),
        ])
        findBar.isHidden = true
        findBar.autoresizingMask = [.width, .minYMargin]
        content.addSubview(findBar)
    }

    // The find bar takes a strip at the top, and the page the rest.
    func layOutFindBar() {
        let bounds = window.contentView!.bounds
        let height: CGFloat = findBar.isHidden ? 0 : 38
        findBar.frame = NSRect(x: 0, y: bounds.height - height, width: bounds.width, height: height)
        page.frame = NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height - height)
    }

    // ⌘F searches the folder on screen; in an open note, the page leaves it to the find bar, as it
    // leaves it to a browser's.
    @objc func find(_ sender: Any?) {
        run("find") { [weak self] answer in
            if answer as? String == "page" { self?.showFindBar() }
        }
    }

    func showFindBar() {
        findBar.isHidden = false
        layOutFindBar()
        window.makeFirstResponder(findField)
        findField.currentEditor()?.selectAll(nil)
    }

    @objc func hideFindBar(_ sender: Any?) {
        findBar.isHidden = true
        layOutFindBar()
        window.makeFirstResponder(page)
    }

    @objc func findNext(_ sender: Any?) { findAgain(backwards: false) }
    @objc func findPrevious(_ sender: Any?) { findAgain(backwards: true) }
    @objc func step(_ sender: NSSegmentedControl) { findAgain(backwards: sender.selectedSegment == 0) }

    @objc func useSelectionForFind(_ sender: Any?) {
        page.evaluateJavaScript("getSelection().toString()") { [weak self] selection, _ in
            if let text = selection as? String, !text.isEmpty { self?.findField.stringValue = text }
        }
    }

    func findAgain(backwards: Bool) {
        if findField.stringValue.isEmpty { return showFindBar() }
        let configuration = WKFindConfiguration()
        configuration.backwards = backwards
        configuration.wraps = true
        page.find(findField.stringValue, configuration: configuration) { [weak self] result in
            self?.findField.textColor = result.matchFound ? .labelColor : .systemRed
        }
    }

    // Typing searches from where the last match began, so a longer word still finds the same place.
    func controlTextDidChange(_ notification: Notification) {
        page.evaluateJavaScript("getSelection().rangeCount && getSelection().collapseToStart(); true") { [weak self] _, _ in
            self?.findAgain(backwards: false)
        }
    }

    // In the find field, Enter finds the next match (with Shift, the one before), and Esc closes the bar.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            findAgain(backwards: NSApp.currentEvent?.modifierFlags.contains(.shift) == true)
        } else if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            hideFindBar(nil)
        } else {
            return false
        }
        return true
    }

    // Zetesis's own pages open here, and any other link in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url, navigationAction.targetFrame?.isMainFrame == true,
              !isZetesis(url), url.scheme != "about" else {
            decisionHandler(.allow)
            return
        }
        openOutside(url)
        decisionHandler(.cancel)
    }

    // What the server sends as an attachment, such as a backup, is saved to Downloads.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let download = navigationResponse.isForMainFrame
            && (disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType)
        decisionHandler(download ? .download : .allow)
    }

    // What would open in a new window: a note's file opens in its own app, as from the Finder; a page
    // of Zetesis's opens here; anything else goes to the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if !isZetesis(url) {
            openOutside(url)
        } else if url.path.hasPrefix("/api/") {
            page.startDownload(using: URLRequest(url: url)) { [weak self] download in
                self?.opening.insert(ObjectIdentifier(download))
                download.delegate = self
            }
        } else {
            page.load(URLRequest(url: url))
        }
        return nil
    }

    // Choosing a file, as for "Start from a file…" or an image in a note, shows the Mac's Open panel, as
    // Safari does. WebKit leaves it to the app, and without this nothing happens.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // A file to open goes to a folder of its own among the temporary files; anything else to Downloads.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        let folder = opening.contains(ObjectIdentifier(download))
            ? FileManager.default.temporaryDirectory.appending(path: "Zetesis/\(UUID().uuidString)")
            : downloadsFolder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = unusedName(suggestedFilename, in: folder)
        destinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        let id = ObjectIdentifier(download)
        guard let file = destinations.removeValue(forKey: id) else { return }
        if opening.remove(id) != nil {
            openOutside(file)
        } else {
            // Bounces the Downloads stack in the Dock, as Safari does.
            DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: file.path)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
        let id = ObjectIdentifier(download)
        destinations.removeValue(forKey: id)
        opening.remove(id)
        NSAlert(error: error).beginSheetModal(for: window)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        unreachable.isHidden = true
        page.isHidden = false
    }

    // Without Zetesis's server there is nothing to show, so the window says so and keeps trying.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        let code = (error as NSError).code
        // A cancelled load, or one that turned into a download, is not a missing server.
        if code == NSURLErrorCancelled || code == 102 { return }
        page.isHidden = true
        unreachable.isHidden = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.page.load(URLRequest(url: address))
        }
    }

    // WebKit can stop a page that has been in the background a long time; it comes back where it was.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: webView.url ?? address))
    }
}

@MainActor func menuBar(for shell: Shell) -> NSMenu {
    func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let menu = NSMenu(title: title)
        items.forEach(menu.addItem)
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }
    func item(_ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command,
              target: AnyObject? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target
        return item
    }
    func command(_ title: String, _ name: String, _ key: String = "") -> NSMenuItem {
        let entry = item(title, #selector(Shell.command(_:)), key, target: shell)
        entry.representedObject = name
        return entry
    }

    let services = menu("Services", [])
    NSApp.servicesMenu = services.submenu
    let window = menu("Window", [
        item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
        item("Zoom", #selector(NSWindow.performZoom(_:))),
        .separator(),
        item("Zetesis", #selector(Shell.showWindow(_:)), "0", target: shell),
        .separator(),
        item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
    ])
    NSApp.windowsMenu = window.submenu
    let help = menu("Help", [command("Keyboard Shortcuts", "shortcuts")])
    NSApp.helpMenu = help.submenu

    let bar = NSMenu()
    [
        menu("Zetesis", [
            item("About Zetesis", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            services,
            .separator(),
            item("Hide Zetesis", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Zetesis", #selector(NSApplication.terminate(_:)), "q"),
        ]),
        menu("File", [
            command("New Note", "newNote", "n"),
            command("Save", "save", "s"),
            .separator(),
            command("Export Backup…", "backup"),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ]),
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Delete", #selector(NSText.delete(_:))),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            menu("Find", [
                item("Find…", #selector(Shell.find(_:)), "f", target: shell),
                item("Find Next", #selector(Shell.findNext(_:)), "g", target: shell),
                item("Find Previous", #selector(Shell.findPrevious(_:)), "g", [.command, .shift], target: shell),
                item("Use Selection for Find", #selector(Shell.useSelectionForFind(_:)), "e", target: shell),
            ]),
            menu("Spelling and Grammar", [
                item("Show Spelling and Grammar", #selector(NSText.showGuessPanel(_:)), ":"),
                item("Check Document Now", #selector(NSText.checkSpelling(_:)), ";"),
                .separator(),
                item("Check Spelling While Typing", #selector(NSTextView.toggleContinuousSpellChecking(_:))),
                item("Check Grammar With Spelling", #selector(NSTextView.toggleGrammarChecking(_:))),
                item("Correct Spelling Automatically", #selector(NSTextView.toggleAutomaticSpellingCorrection(_:))),
            ]),
            menu("Substitutions", [
                item("Show Substitutions", #selector(NSTextView.orderFrontSubstitutionsPanel(_:))),
                .separator(),
                item("Smart Copy/Paste", #selector(NSTextView.toggleSmartInsertDelete(_:))),
                item("Smart Quotes", #selector(NSTextView.toggleAutomaticQuoteSubstitution(_:))),
                item("Smart Dashes", #selector(NSTextView.toggleAutomaticDashSubstitution(_:))),
                item("Smart Links", #selector(NSTextView.toggleAutomaticLinkDetection(_:))),
                item("Text Replacement", #selector(NSTextView.toggleAutomaticTextReplacement(_:))),
            ]),
        ]),
        menu("View", [
            command("Search", "search", "l"),
            command("Explore", "explore"),
            command("Roadmap", "roadmap"),
            command("Following", "following"),
            .separator(),
            item("Actual Size", #selector(Shell.actualSize(_:)), target: shell),
            item("Zoom In", #selector(Shell.zoomIn(_:)), "+", target: shell),
            // ⌘= zooms in too, without Shift.
            { let entry = item("Zoom In", #selector(Shell.zoomIn(_:)), "=", target: shell); entry.isHidden = true; entry.allowsKeyEquivalentWhenHidden = true; return entry }(),
            item("Zoom Out", #selector(Shell.zoomOut(_:)), "-", target: shell),
            .separator(),
            item("Reload", #selector(Shell.reload(_:)), "r", target: shell),
        ]),
        window,
        help,
    ].forEach(bar.addItem)
    return bar
}

// Start

MainActor.assumeIsolated {
    let shell = Shell()
    NSApplication.shared.delegate = shell
    NSApplication.shared.run()
}
