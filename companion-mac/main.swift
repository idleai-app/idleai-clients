// idleai companion — macOS menu-bar ticker + floating in-window pill.
// Native assistant apps (Claude Desktop, ChatGPT, Codex, Grok, Gemini) can't be
// injected safely (editing a signed app breaks its Gatekeeper signature), so the
// companion serves two honest surfaces instead — both timed to the same watched
// window, both paying only while an assistant is actually frontmost:
//   1. a menu-bar ticker (always available, no permissions);
//   2. a floating ✶ pill overlay pinned to the top strip of the assistant's own
//      window (our own borderless NSWindow, not injected code) — this needs
//      Accessibility permission to read the target window's bounds. Denied →
//      the pill anchors to the top of the screen instead.
// A terminal app also counts, but only while an agent CLI is actually working
// there (fresh writes under ~/.codex/sessions etc).
//
// Auth reuses the CLI's ~/.idleai.json (run: idleai login idl_xxx).
// Build: ./build.sh  (swiftc, no Xcode project needed)
import AppKit
import ApplicationServices

struct Config: Decodable {
    let token: String
    let baseUrl: String
    let paused: Bool? // shared flag written by `idleai pause` — honored by every local client
}

struct ServedAd: Decodable {
    let campaignId: String
    let text: String
    let url: String
    let takeover: Bool?
}
struct ServeResponse: Decodable {
    let ad: ServedAd?
    let reason: String?
}
struct EventResponse: Decodable {
    let ok: Bool?
    let customer_share_micros: Int?
}
struct StatsInner: Decodable { let today_micros: Int }
struct StatsResponse: Decodable { let stats: StatsInner }

func usd(_ micros: Int) -> String {
    let digits = (micros != 0 && micros < 10_000) ? 4 : 2
    return String(format: "$%.\(digits)f", Double(micros) / 1_000_000)
}

// $HOME first (matches os.homedir() in the JS clients and lets tests sandbox
// the config + agent-CLI signal dirs); NSHomeDirectory ignores the override.
var homeURL: URL {
    URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory())
}

// Read an AXUIElement's frame (top-left origin, global display space).
func axFrame(_ el: AXUIElement) -> CGRect? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success
    else { return nil }
    var pos = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(posRef as! AXValue, .cgPoint, &pos)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
    guard size.width > 1, size.height > 1 else { return nil }
    return CGRect(origin: pos, size: size)
}

// The frontmost assistant window as an AXUIElement (focused window, else first).
func focusedWindowElement(pid: pid_t) -> AXUIElement? {
    let appElement = AXUIElementCreateApplication(pid)
    var winRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &winRef) != .success {
        var windowsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef) == .success,
              let windows = windowsRef as? [AXUIElement], let first = windows.first else { return nil }
        winRef = first
    }
    guard let window = winRef, CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
    return (window as! AXUIElement)
}

// A borderless, always-on-top window that floats the ✶ ad line over the top
// strip of the watched assistant's window.
final class OverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class PillView: NSView {
    var onClick: (() -> Void)?
    let star = NSTextField(labelWithString: "✶")
    let text = NSTextField(labelWithString: "")
    let arrow = NSTextField(labelWithString: "↗")
    let earn = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(red: 0.043, green: 0.059, blue: 0.055, alpha: 0.96).cgColor
        layer?.cornerRadius = 14
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(red: 0.145, green: 0.204, blue: 0.188, alpha: 1).cgColor
        let mono = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
        star.font = mono; text.font = mono; arrow.font = mono; earn.font = mono
        star.textColor = NSColor(red: 0, green: 0.722, blue: 0.580, alpha: 1) // #00b894
        arrow.textColor = star.textColor
        text.textColor = NSColor(red: 0.910, green: 0.941, blue: 0.929, alpha: 1)
        earn.textColor = NSColor(red: 0.541, green: 0.639, blue: 0.612, alpha: 1)
        let stack = NSStackView(views: [star, text, arrow, earn])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    required init?(coder: NSCoder) { nil }
    override func mouseDown(with event: NSEvent) { onClick?() }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    // Matched against frontmost app name/bundle id, lowercased.
    let assistantNames = ["claude", "chatgpt", "codex", "grok", "gemini",
                          "perplexity", "deepseek", "mistral", "le chat",
                          "cursor", "windsurf"]
    // Terminals only count while the Codex CLI is working (see codexWorking()).
    let terminalNames = ["terminal", "iterm", "warp", "ghostty", "kitty",
                         "alacritty", "wezterm", "hyper", "tabby"]
    let viewSeconds: TimeInterval = 5 // a view pays only after this long on screen
    let rotateSeconds: TimeInterval = 12
    let codexActiveSeconds: TimeInterval = 15 // rollout writes can pause mid-turn
    // Floating-pill horizontal placement in the top strip: fraction of the
    // window/screen width right of center, plus a fixed px nudge. Applied in
    // both the AX (window-relative) and no-permission (screen) branches.
    let rightBiasFraction: CGFloat = 0.20
    let rightBiasPx: CGFloat = -60

    var statusItem: NSStatusItem!
    var openItem: NSMenuItem!
    var todayItem: NSMenuItem!
    var pauseItem: NSMenuItem!

    // Floating in-window pill overlay.
    var overlay: OverlayWindow!
    var pill: PillView!
    var frontPid: pid_t = 0 // pid of the currently-watched assistant app

    var config: Config?
    var ad: ServedAd?
    var adShownAt: Date?
    var paidThisAd = false
    var serving = false
    var todayMicros = 0
    var paused = false
    var assistantFocused = false
    var terminalFocused = false
    var lastReason: String?
    let reasonLabels = [
        "vpn_detected": "VPN detected — disconnect to earn",
        "geo_mismatch": "country mismatch — fix your location",
        "busy_elsewhere": "another device is earning — this one stands by",
    ]

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildMenu()
        buildOverlay()
        loadConfig()
        observeFrontmost()
        updateFocus(NSWorkspace.shared.frontmostApplication)
        // Ask for Accessibility permission once, up front, so the overlay can
        // read the assistant window's bounds. Denied → overlay stays hidden.
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        refreshStats()
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.tick() }
        // Reposition the overlay more often than the 1s serve tick so it tracks
        // the window smoothly as it moves/resizes.
        let reposition = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.positionOverlay() }
        reposition.tolerance = 0.1 // let the system coalesce wakeups
        Timer.scheduledTimer(withTimeInterval: 60.0, repeats: true) { [weak self] _ in self?.refreshStats() }
        render()
    }

    func buildOverlay() {
        pill = PillView(frame: NSRect(x: 0, y: 0, width: 420, height: 30))
        pill.onClick = { [weak self] in self?.openAd() }
        overlay = OverlayWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 30),
            styleMask: .borderless, backing: .buffered, defer: false
        )
        overlay.isOpaque = false
        overlay.backgroundColor = .clear
        overlay.hasShadow = true
        overlay.level = .statusBar // floats above ordinary app windows
        overlay.ignoresMouseEvents = false
        overlay.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        overlay.contentView = pill
        overlay.orderOut(nil)
    }

    func loadConfig() {
        let path = homeURL.appendingPathComponent(".idleai.json")
        guard let data = try? Data(contentsOf: path),
              let cfg = try? JSONDecoder().decode(Config.self, from: data) else { return }
        config = cfg
    }

    func buildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        openItem = NSMenuItem(title: "Open ad ↗ (pays 50×)", action: #selector(openAd), keyEquivalent: "o")
        openItem.target = self
        openItem.isEnabled = false
        todayItem = NSMenuItem(title: "Today: $0.00", action: nil, keyEquivalent: "")
        todayItem.isEnabled = false
        pauseItem = NSMenuItem(title: "Pause", action: #selector(togglePause), keyEquivalent: "")
        pauseItem.target = self
        let quit = NSMenuItem(title: "Quit idleai", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(openItem)
        menu.addItem(todayItem)
        menu.addItem(.separator())
        menu.addItem(pauseItem)
        menu.addItem(quit)
        statusItem.menu = menu
    }

    func observeFrontmost() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            self?.updateFocus(app)
        }
    }

    func updateFocus(_ app: NSRunningApplication?) {
        let name = (app?.localizedName ?? "").lowercased()
        let bundle = (app?.bundleIdentifier ?? "").lowercased()
        assistantFocused = assistantNames.contains { name.contains($0) || bundle.contains($0) }
        terminalFocused = terminalNames.contains { name.contains($0) || bundle.contains($0) }
        // Only assistant *apps* get the floating pill (a terminal's window has no
        // chat area to hug). Remember the pid so the overlay can find its window.
        frontPid = assistantFocused ? (app?.processIdentifier ?? 0) : 0
        if !assistantFocused && !terminalFocused {
            ad = nil
            adShownAt = nil
        }
        render()
        positionOverlay()
    }

    // Placement: pin the pill to the TOP-CENTER of the assistant's window, just
    // below the title strip. This is deliberately anchored to the window's stable
    // top edge (not the composer) — the composer moves and resizes across Claude's
    // Chat/Cowork/Code tabs, but the title area is fixed and identical everywhere,
    // so the pill lands in one predictable, non-overlapping spot every time.
    func positionOverlay() {
        guard let overlay else { return }
        // Base visibility: an assistant app frontmost, an ad in hand, not paused.
        guard assistantFocused, ad != nil, !effectivePaused, frontPid != 0 else {
            if overlay.isVisible { overlay.orderOut(nil) }
            return
        }
        // Without Accessibility permission we can't read the window bounds — don't
        // vanish; anchor to the top-center of the screen the developer is working
        // on (mouse location — NSScreen.main is the primary display for a
        // menu-bar app, wrong on multi-monitor setups).
        guard let winEl = focusedWindowElement(pid: frontPid), let axWin = axFrame(winEl) else {
            // No AX permission → screen-anchored. Same right bias as the window
            // branch so the position knob works in either path.
            let mouse = NSEvent.mouseLocation
            let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
                ?? NSScreen.main ?? NSScreen.screens.first
            if let vf = screen?.visibleFrame {
                let w = max(220, min(pill.fittingSize.width + 28, vf.width - 40))
                var x = vf.midX - w / 2 + vf.width * rightBiasFraction + rightBiasPx
                x = max(vf.minX + 8, min(x, vf.maxX - w - 8))
                let frame = NSRect(x: x, y: vf.maxY - 44, width: w, height: 30)
                if overlay.frame != frame { overlay.setFrame(frame, display: true) }
                if !overlay.isVisible { overlay.orderFrontRegardless() }
            }
            return
        }
        let winRect = cocoaRect(fromAX: axWin)
        guard let screen = NSScreen.screens.first(where: { $0.frame.intersects(winRect) }) ?? NSScreen.main
        else { return }

        let h: CGFloat = 30
        let pillSize = pill.fittingSize
        let w = max(220, min(pillSize.width + 28, winRect.width - 24))
        // winRect.maxY is the window's TOP edge in Cocoa's flipped space; sit the
        // pill just below the title strip (~10px down from the top), biased toward
        // the right of center so it clears the conversation title on the left.
        let centerX = winRect.midX - w / 2
        let rightBias = winRect.width * rightBiasFraction + rightBiasPx
        var frame = NSRect(x: centerX + rightBias, y: winRect.maxY - h - 10, width: w, height: h)
        // Keep the pill under the menu bar and inside the window horizontally.
        frame.origin.y = min(frame.origin.y, screen.visibleFrame.maxY - h - 4)
        frame.origin.x = max(winRect.minX + 8, min(frame.origin.x, winRect.maxX - frame.width - 8))
        if overlay.frame != frame { overlay.setFrame(frame, display: true) }
        if !overlay.isVisible { overlay.orderFrontRegardless() }
    }

    // Convert an Accessibility (top-left origin, primary-display-relative) rect
    // to Cocoa's bottom-left-origin global coordinates.
    func cocoaRect(fromAX ax: CGRect) -> CGRect {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? ax.maxY
        return CGRect(x: ax.minX, y: primaryHeight - ax.maxY, width: ax.width, height: ax.height)
    }

    // Agent CLIs (Codex, Gemini, Grok) leave no frontmost-app signal of their
    // own — they live inside whatever terminal hosts them. Each writes session
    // artifacts under its home dir on every turn event, so a fresh mtime there
    // means that agent is working right now.
    func codexWorking() -> Bool {
        let fm = FileManager.default
        var dir = homeURL.appendingPathComponent(".codex/sessions")
        for _ in 0..<3 { // year / month / day, numeric names, padding not guaranteed
            guard let names = try? fm.contentsOfDirectory(atPath: dir.path),
                  let newest = names.compactMap({ n in Int(n).map { (n, $0) } })
                      .max(by: { $0.1 < $1.1 })?.0
            else { return false }
            dir = dir.appendingPathComponent(newest)
        }
        return dirHasFreshWrite(dir, depth: 0)
    }

    // Bounded scan: true as soon as any file under `dir` (limited depth, at
    // most `budget` stats) was modified within codexActiveSeconds. Subdirs are
    // visited newest-mtime-first so the active session's branch is reached
    // before months of stale ones exhaust the budget.
    func dirHasFreshWrite(_ dir: URL, depth: Int, budget: Int = 500) -> Bool {
        var remaining = budget
        func walk(_ d: URL, _ left: Int) -> Bool {
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: d, includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey]
            ) else { return false }
            var dirs: [(URL, Date)] = []
            for entry in entries {
                if remaining <= 0 { return false }
                let values = try? entry.resourceValues(forKeys: [.contentModificationDateKey, .isDirectoryKey])
                let mtime = values?.contentModificationDate ?? .distantPast
                if values?.isDirectory == true {
                    dirs.append((entry, mtime))
                    continue
                }
                remaining -= 1
                if Date().timeIntervalSince(mtime) < codexActiveSeconds { return true }
            }
            guard left > 0 else { return false }
            dirs.sort { $0.1 > $1.1 }
            for (sub, _) in dirs {
                if remaining <= 0 { return false }
                if walk(sub, left - 1) { return true }
            }
            return false
        }
        return walk(dir, depth)
    }

    // tick() and render() can both ask within the same second — cache the
    // three dir scans briefly so a focused terminal doesn't cost constant I/O.
    var agentCheckAt = Date.distantPast
    var agentCheckResult = false
    func agentCliWorking() -> Bool {
        if Date().timeIntervalSince(agentCheckAt) < 2 { return agentCheckResult }
        agentCheckAt = Date()
        let home = homeURL
        agentCheckResult = codexWorking()
            // Gemini CLI: per-session tracker/tasks/chats under ~/.gemini/tmp/…
            || dirHasFreshWrite(home.appendingPathComponent(".gemini/tmp"), depth: 5)
            // Grok CLI: state under ~/.grok
            || dirHasFreshWrite(home.appendingPathComponent(".grok"), depth: 4)
        return agentCheckResult
    }

    // The watched surface: an assistant app frontmost, or a terminal frontmost
    // while an agent CLI works in it. Honest views only — either way the
    // developer is looking at the screen the assistant is thinking on.
    var surfaceWatched: Bool {
        assistantFocused || (terminalFocused && agentCliWorking())
    }

    func api(_ path: String, method: String = "GET", body: [String: Any]? = nil,
             done: @escaping (Data?) -> Void) {
        guard let cfg = config, let url = URL(string: cfg.baseUrl + path) else {
            done(nil)
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(cfg.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body = body {
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok ? data : nil) }
        }.resume()
    }

    var effectivePaused: Bool { paused || config?.paused == true }

    func refreshStats() {
        loadConfig() // pick up `idleai pause` / token changes without a restart
        api("/api/customer/stats") { [weak self] data in
            guard let self, let d = data,
                  let res = try? JSONDecoder().decode(StatsResponse.self, from: d) else { return }
            self.todayMicros = res.stats.today_micros
            self.render()
        }
    }

    func serve() {
        guard !serving else { return }
        serving = true
        api("/api/serve") { [weak self] data in
            guard let self else { return }
            self.serving = false
            let decoded = data.flatMap { try? JSONDecoder().decode(ServeResponse.self, from: $0) }
            self.lastReason = decoded?.reason
            guard let newAd = decoded?.ad else {
                self.ad = nil
                self.adShownAt = nil
                self.render()
                return
            }
            self.ad = newAd
            self.adShownAt = Date()
            self.paidThisAd = false
            self.render()
        }
    }

    func tick() {
        guard config != nil, !effectivePaused, surfaceWatched else {
            // Codex going quiet in a focused terminal ends the window like a
            // focus change would — a stale ad must not sit there unpaid-for.
            if ad != nil, effectivePaused || !assistantFocused {
                ad = nil
                adShownAt = nil
                render()
            }
            return
        }
        guard let currentAd = ad, let shownAt = adShownAt else {
            serve()
            return
        }
        if !paidThisAd, Date().timeIntervalSince(shownAt) >= viewSeconds {
            paidThisAd = true
            api("/api/events", method: "POST",
                body: ["campaignId": currentAd.campaignId, "type": "impression"]) { [weak self] data in
                guard let self, let d = data,
                      let ev = try? JSONDecoder().decode(EventResponse.self, from: d),
                      ev.ok == true else { return }
                self.todayMicros += ev.customer_share_micros ?? 0
                self.render()
            }
        }
        if paidThisAd, Date().timeIntervalSince(shownAt) >= rotateSeconds {
            serve()
        }
    }

    @objc func openAd() {
        guard let currentAd = ad, let url = URL(string: currentAd.url) else { return }
        NSWorkspace.shared.open(url)
        api("/api/events", method: "POST",
            body: ["campaignId": currentAd.campaignId, "type": "click"]) { [weak self] data in
            guard let self, let d = data,
                  let ev = try? JSONDecoder().decode(EventResponse.self, from: d),
                  ev.ok == true else { return }
            self.todayMicros += ev.customer_share_micros ?? 0
            self.render()
        }
    }

    @objc func togglePause() {
        paused = !paused
        if paused {
            ad = nil
            adShownAt = nil
        }
        render()
    }

    func render() {
        guard let button = statusItem.button else { return }
        let watched = surfaceWatched
        if config == nil {
            button.title = "✶ idleai — run: idleai login"
        } else if effectivePaused {
            button.title = "✶ paused"
        } else if watched, let currentAd = ad {
            // Creatives may end with the brand ↗ — the ticker renders its own.
            var text = currentAd.text.trimmingCharacters(in: .whitespaces)
            if text.hasSuffix("↗") {
                text = String(text.dropLast()).trimmingCharacters(in: .whitespaces)
            }
            if text.count > 56 { text = String(text.prefix(55)) + "…" }
            let star = currentAd.takeover == true ? "✶⭐" : "✶"
            button.title = "\(star) \(text) ↗ \(usd(todayMicros))"
        } else if watched, let reason = lastReason, let label = reasonLabels[reason] {
            button.title = "✶ \(label)"
        } else {
            button.title = "✶ \(usd(todayMicros))"
        }
        openItem.isEnabled = ad != nil
        todayItem.title = "Today: \(usd(todayMicros))"
        pauseItem.title = paused ? "Resume" : "Pause"
        renderPill()
        positionOverlay()
    }

    // Fill the floating pill's text from the current ad (positionOverlay decides
    // whether it's actually on screen).
    func renderPill() {
        guard let currentAd = ad else { return }
        var text = currentAd.text.trimmingCharacters(in: .whitespaces)
        if text.hasSuffix("↗") {
            text = String(text.dropLast()).trimmingCharacters(in: .whitespaces)
        }
        pill.star.textColor = currentAd.takeover == true
            ? NSColor(red: 0.992, green: 0.878, blue: 0.278, alpha: 1) // #fde047
            : NSColor(red: 0, green: 0.722, blue: 0.580, alpha: 1)
        pill.text.stringValue = text
        pill.earn.stringValue = "· \(usd(todayMicros)) today"
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
