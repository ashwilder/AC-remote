// AC Remote for Windows: runs the AC Remote server in the background and shows it in an app window.
// The server keeps running in the system tray when the window is closed, so presets, timers and
// your phone keep working.
const { app, BrowserWindow, Tray, Menu, utilityProcess, shell, nativeImage, dialog, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ACRemote");
const LOG = path.join(DATA, "ac-remote.log");
const HIDDEN = process.argv.includes("--hidden");

let win, tray, server, quitting = false, restarts = 0;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => showWindow());
app.setAppUserModelId("com.vpn.acremote");

function port() {
    try { return Number(JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8")).port) || 8080; } catch { return 8080; }
}
const url = () => `http://127.0.0.1:${port()}`;

function log(line) {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG, line.endsWith("\n") ? line : `${line}\n`); } catch { /* ignore */ }
}

// Is an AC Remote server already answering (for example the older script-based install)?
function ping() {
    return new Promise(resolve => {
        const req = http.get(`${url()}/api/status`, { timeout: 1500 }, res => {
            let body = "";
            res.on("data", c => (body += c));
            res.on("end", () => { try { resolve(JSON.parse(body).app === "ac-remote"); } catch { resolve(false); } });
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
    });
}

function startServer() {
    log(`[${new Date().toISOString()}] starting AC Remote ${app.getVersion()}`);
    server = utilityProcess.fork(path.join(ROOT, "src", "server.mjs"), [], {
        cwd: ROOT, stdio: "pipe", serviceName: "AC Remote server",
        env: { ...process.env, AC_REMOTE_DESKTOP: "1" },
    });
    server.stdout?.on("data", d => log(d.toString()));
    server.stderr?.on("data", d => log(d.toString()));
    server.on("exit", code => {
        log(`[${new Date().toISOString()}] server stopped (code ${code})`);
        server = null;
        if (quitting) return;
        restarts++;
        setTimeout(startServer, Math.min(30000, 2000 * restarts));
    });
}

async function waitForServer(timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await ping()) { restarts = 0; return true; }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

function createWindow() {
    win = new BrowserWindow({
        width: 1180, height: 860, minWidth: 380, minHeight: 600, show: false,
        title: "AC Remote", icon: path.join(__dirname, "icon.png"), backgroundColor: "#F2F3F5", autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, sandbox: true },
    });
    win.loadFile(path.join(__dirname, "loading.html"));
    // Links to other sites open in the normal browser.
    win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e, u) => { if (!u.startsWith(url())) { e.preventDefault(); shell.openExternal(u); } });
    win.on("close", e => {
        if (quitting) return;
        e.preventDefault();
        win.hide();
        if (!app.__toldAboutTray) {
            app.__toldAboutTray = true;
            tray?.displayBalloon?.({ title: "AC Remote is still running", content: "It stays in the tray so presets, timers and your phone keep working. Right-click the icon to quit.", iconType: "info" });
        }
    });
    win.once("ready-to-show", () => { if (!HIDDEN) win.show(); });
}

function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function lanUrls() {
    return Object.values(os.networkInterfaces()).flat()
        .filter(i => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
        .map(i => `http://${i.address}:${port()}`);
}

function phoneHelp() {
    let remote = "";
    try { remote = fs.readFileSync(path.join(DATA, "remote-url.txt"), "utf8").trim(); } catch { /* not set up */ }
    const lan = lanUrls();
    const lines = [
        "Install the AC Remote app on your phone and it finds this PC by itself on your home Wi-Fi.",
        "",
        "Or type one of these addresses into the app (or a browser) on the same Wi-Fi:",
        ...lan.map(u => `   ${u}`),
        "",
        remote ? `Away from home (with Tailscale on in the phone):\n   ${remote}` : "For control away from home, choose \"Set up remote access\" in the tray menu.",
    ];
    const r = dialog.showMessageBoxSync({
        type: "info", title: "Use AC Remote on your phone", message: "Use AC Remote on your phone", detail: lines.join("\n"),
        buttons: ["Copy address", "Close"], defaultId: 1, cancelId: 1,
    });
    if (r === 0 && (lan[0] || remote)) clipboard.writeText(lan[0] || remote);
}

// Opens the Tailscale setup script in a console window (it installs Tailscale and publishes AC Remote privately).
function setupRemote() {
    const script = path.join(ROOT, "scripts", "remote-access.ps1");
    require("node:child_process").spawn("cmd.exe", ["/c", "start", "\"AC Remote remote access\"", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { detached: true, stdio: "ignore", windowsHide: false }).unref();
}

function buildTray() {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "tray.png")));
    tray.setToolTip("AC Remote");
    const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Open AC Remote", click: showWindow },
        { label: "Use on your phone…", click: phoneHelp },
        { label: "Set up remote access…", click: setupRemote },
        { type: "separator" },
        { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
          click: item => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }); refresh(); } },
        { label: "Open log", click: () => shell.openPath(LOG) },
        { type: "separator" },
        { label: "Quit AC Remote", click: () => { quitting = true; app.quit(); } },
    ]));
    refresh();
    tray.on("click", showWindow);
}

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Start with Windows by default; the tray menu can turn it off.
    const marker = path.join(DATA, ".desktop-first-run");
    if (!fs.existsSync(marker)) {
        app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
        try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }
    }
    buildTray();
    createWindow();
    if (!(await ping())) startServer();
    if (await waitForServer()) {
        win.loadURL(url());
    } else {
        win.loadFile(path.join(__dirname, "loading.html"), { query: { error: "1", log: LOG } });
        showWindow();
    }
});

app.on("window-all-closed", e => e.preventDefault?.());
app.on("before-quit", () => {
    quitting = true;
    if (server) server.kill();
});
