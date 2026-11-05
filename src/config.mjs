// Settings and data location. On Windows everything lives in %LOCALAPPDATA%\ACRemote.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const dataDir = process.env.AC_REMOTE_DATA
    ?? (process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ACRemote")
        : path.join(os.homedir(), ".ac-remote"));

const file = path.join(dataDir, "config.json");

const DEFAULTS = {
    port: 8080,          // web app port (phone + PC browser)
    matterPort: 5541,    // UDP port the Matter controller uses
    bluetooth: true,     // allow pairing a brand-new AC over this PC's Bluetooth
};

export function loadConfig() {
    fs.mkdirSync(dataDir, { recursive: true });
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }
    cfg = { ...DEFAULTS, ...cfg };
    if (process.env.AC_REMOTE_PORT) cfg.port = Number(process.env.AC_REMOTE_PORT);
    if (!cfg.secret) {
        cfg.secret = crypto.randomBytes(32).toString("hex");
        saveConfig(cfg);
    }
    return cfg;
}

export function saveConfig(cfg) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, file);
}
