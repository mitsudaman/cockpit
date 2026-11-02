// 案件ボードのメニューバーアプリ。サーバー（launchd エージェント）の起動・停止とボードを開くだけを担う
import Cocoa

let serverLabel = "local.case-board"
let menuLabel = "local.case-board.menubar"
let domain = "gui/\(getuid())"
let agentsDir = NSHomeDirectory() + "/Library/LaunchAgents"
let logPath = NSHomeDirectory() + "/Library/Logs/case-board.log"
let boardURL = URL(string: "http://localhost:4747/")!

@discardableResult
func run(_ path: String, _ args: [String]) -> (status: Int32, out: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return (-1, "") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

@discardableResult
func launchctl(_ args: String...) -> (status: Int32, out: String) { run("/bin/launchctl", args) }

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private var up = false
    private var mine = 0
    private var active = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        updateIcon()
        refresh()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    // サーバーが応答するかと案件数を取り、アイコンに反映する
    private func refresh() {
        var req = URLRequest(url: boardURL.appendingPathComponent("api/cases"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, res, _ in
            let ok = (res as? HTTPURLResponse)?.statusCode == 200
            var mine = 0, active = 0
            if ok, let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let cases = json["cases"] as? [[String: Any]] {
                let open = cases.filter { ($0["status"] as? String) != "done" }
                active = open.count
                mine = open.filter { ($0["ball"] as? String) == "me" }.count
            }
            DispatchQueue.main.async {
                self.up = ok
                self.mine = mine
                self.active = active
                self.updateIcon()
            }
        }.resume()
    }

    private func refreshSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.refresh() }
    }

    private func updateIcon() {
        guard let button = item.button else { return }
        let image = NSImage(systemSymbolName: up ? "square.grid.2x2.fill" : "square.grid.2x2", accessibilityDescription: "コックピット")
        image?.isTemplate = true
        button.image = image
        button.appearsDisabled = !up
        button.toolTip = up ? "コックピット: 起動中" : "コックピット: 停止中"
    }

    private var managed: Bool { launchctl("print", "\(domain)/\(serverLabel)").status == 0 }

    private var menuAtLogin: Bool {
        let out = launchctl("print-disabled", domain).out
        return !out.contains("\"\(menuLabel)\" => disabled") && !out.contains("\"\(menuLabel)\" => true")
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        info(menu, up ? "● 起動中　localhost:4747" : "○ 停止中")
        if up { info(menu, "自分のボール \(mine)件 ／ 進行中 \(active)件") }
        menu.addItem(.separator())
        add(menu, "コックピットを開く", #selector(openBoard), "o", enabled: up)
        add(menu, up ? "サーバーを停止" : "サーバーを起動", #selector(toggle), "s")
        add(menu, "サーバーを再起動", #selector(restart), "r", enabled: up)
        menu.addItem(.separator())
        add(menu, "ログイン時にこのメニューを出す", #selector(toggleLogin), "").state = menuAtLogin ? .on : .off
        add(menu, "ログを開く", #selector(openLog), "l")
        menu.addItem(.separator())
        add(menu, "メニューを閉じる（サーバーは止めない）", #selector(quit), "q")
    }

    private func info(_ menu: NSMenu, _ title: String) {
        let mi = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        mi.isEnabled = false
        menu.addItem(mi)
    }

    @discardableResult
    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String, enabled: Bool = true) -> NSMenuItem {
        let mi = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
        mi.target = self
        menu.addItem(mi)
        return mi
    }

    @objc private func openBoard() { NSWorkspace.shared.open(boardURL) }

    @objc private func toggle() {
        up ? stop() : start()
        refreshSoon()
    }

    @objc private func restart() {
        if managed {
            launchctl("kickstart", "-k", "\(domain)/\(serverLabel)")
        } else {
            stop()
            start()
        }
        refreshSoon()
    }

    // 止めた状態がログインし直しても保たれるよう、enable / disable もあわせて切り替える
    private func start() {
        launchctl("enable", "\(domain)/\(serverLabel)")
        if !managed { launchctl("bootstrap", domain, "\(agentsDir)/\(serverLabel).plist") }
        launchctl("kickstart", "\(domain)/\(serverLabel)")
    }

    private func stop() {
        launchctl("disable", "\(domain)/\(serverLabel)")
        if managed { launchctl("bootout", "\(domain)/\(serverLabel)") }
        // ターミナルなど launchd 以外から起動されたサーバーも止める（4747 を掴んでいる node だけ）
        let pids = run("/usr/sbin/lsof", ["-a", "-c", "node", "-tiTCP:4747", "-sTCP:LISTEN"]).out
        for pid in pids.split(separator: "\n").compactMap({ Int32($0) }) { kill(pid, SIGTERM) }
    }

    @objc private func toggleLogin() {
        launchctl(menuAtLogin ? "disable" : "enable", "\(domain)/\(menuLabel)")
    }

    @objc private func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }

    @objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
