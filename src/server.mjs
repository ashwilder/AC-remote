// AC Remote: web server, Matter controller, optional MirAIe link and presets. Run with `node src/server.mjs`.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AcController, httpError } from "./ac.mjs";
import { MiraieCloud } from "./miraie.mjs";
import { DeviceHub } from "./hub.mjs";
import { Presets } from "./presets.mjs";
import { loadConfig, saveConfig, dataDir } from "./config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const config = loadConfig();
const matter = new AcController({
    storagePath: path.join(dataDir, "matter"),
    matterPort: config.matterPort,
    bluetooth: config.bluetooth,
    logLevel: process.env.AC_REMOTE_LOG ?? "notice",
});
const miraie = new MiraieCloud({ dataDir });
const ac = new DeviceHub({ matter, miraie, dataDir });
const presets = new Presets({ hub: ac, dataDir });

// ---------- auth ----------
const COOKIE = "acr_session";
const SESSION_DAYS = 180;
const failures = new Map(); // ip -> { count, until }

function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
    return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString("hex") };
}
function pinMatches(pin) {
    if (!config.pinHash) return false;
    const { hash } = hashPin(pin, config.pinSalt);
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(config.pinHash, "hex"));
}
function makeToken() {
    const exp = Date.now() + SESSION_DAYS * 864e5;
    const sig = crypto.createHmac("sha256", config.secret).update(String(exp)).digest("base64url");
    return `${exp}.${sig}`;
}
function tokenValid(token) {
    const [exp, sig] = String(token ?? "").split(".");
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const good = crypto.createHmac("sha256", config.secret).update(exp).digest("base64url");
    return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function cookies(req) {
    return Object.fromEntries((req.headers.cookie ?? "").split(";").map(c => c.trim().split("=")).filter(p => p[0]).map(([k, ...v]) => [k, v.join("=")]));
}
const isAuthed = req => tokenValid(cookies(req)[COOKIE]);
// Requests proxied by Tailscale (or anything else) carry X-Forwarded-For and are never treated as local.
const isLocal = req => !req.headers["x-forwarded-for"] && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const clientIp = req => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",")[0].trim();

function setSession(req, res) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function checkRateLimit(req) {
    const f = failures.get(clientIp(req));
    if (f && f.until > Date.now() && f.count >= 5) throw httpError(429, "Too many wrong PINs. Try again in 10 minutes.");
}
function recordFailure(req) {
    const ip = clientIp(req);
    const f = failures.get(ip);
    const fresh = !f || f.until < Date.now();
    failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 10 * 60e3 });
}
const validPin = pin => /^\d{4,8}$/.test(String(pin ?? ""));

// ---------- live updates (Server-Sent Events) ----------
const streams = new Set();
function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(msg);
}
ac.on("change", devices => broadcast("devices", devices));
ac.on("pairing", p => broadcast("pairing", p));
presets.on("change", p => broadcast("presets", p));
setInterval(() => { for (const res of streams) res.write(": ping\n\n"); }, 25e3);

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}
async function readJson(req) {
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) throw httpError(415, "Expected JSON");
    let size = 0;
    const chunks = [];
    for await (const c of req) {
        size += c.length;
        if (size > 16_384) throw httpError(413, "Request too large");
        chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw httpError(400, "Bad JSON"); }
}
function serveStatic(req, res) {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel === "/") rel = "/index.html";
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found");
    }
    res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": rel === "/sw.js" || rel === "/index.html" ? "no-cache" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
    });
    fs.createReadStream(file).pipe(res);
}

async function route(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (!p.startsWith("/api/")) return serveStatic(req, res);

    // State-changing requests must come from our own page (blocks cross-site form posts).
    if (req.method !== "GET" && req.headers["x-acr"] !== "1") throw httpError(403, "Forbidden");

    if (p === "/api/status" && req.method === "GET") {
        const authed = isAuthed(req);
        return send(res, 200, {
            app: "ac-remote", setup: !config.pinHash, canSetup: !config.pinHash && isLocal(req), authed,
            bluetooth: matter.bluetoothAvailable, version: VERSION,
            lanUrls: authed ? lanUrls() : undefined,
            remoteUrl: authed ? remoteUrl() : undefined,
        });
    }
    if (p === "/api/setup" && req.method === "POST") {
        if (config.pinHash) throw httpError(409, "A PIN is already set");
        if (!isLocal(req)) throw httpError(403, "Set the PIN from the PC itself the first time (open http://localhost:" + config.port + ")");
        const { pin } = await readJson(req);
        if (!validPin(pin)) throw httpError(400, "PIN must be 4 to 8 digits");
        const { salt, hash } = hashPin(pin);
        Object.assign(config, { pinSalt: salt, pinHash: hash });
        saveConfig(config);
        setSession(req, res);
        return send(res, 200, { ok: true });
    }
    if (p === "/api/login" && req.method === "POST") {
        checkRateLimit(req);
        const { pin } = await readJson(req);
        if (!validPin(pin) || !pinMatches(pin)) { recordFailure(req); throw httpError(401, "Wrong PIN"); }
        failures.delete(clientIp(req));
        setSession(req, res);
        return send(res, 200, { ok: true });
    }
    if (p === "/api/logout" && req.method === "POST") {
        res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return send(res, 200, { ok: true });
    }

    if (!isAuthed(req)) throw httpError(401, "Please sign in");

    if (p === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write(`retry: 3000\nevent: devices\ndata: ${JSON.stringify(ac.devices())}\n\n`);
        res.write(`event: pairing\ndata: ${JSON.stringify({ active: matter.pairing })}\n\n`);
        res.write(`event: presets\ndata: ${JSON.stringify(presets.snapshot())}\n\n`);
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
    }
    if (p === "/api/devices" && req.method === "GET") return send(res, 200, ac.devices());
    if (p === "/api/devices/pair" && req.method === "POST") {
        const body = await readJson(req);
        const wifi = body.wifiSsid ? { ssid: String(body.wifiSsid), password: String(body.wifiPassword ?? "") } : undefined;
        return send(res, 200, await matter.pair({ code: body.code, wifi }));
    }
    const m = p.match(/^\/api\/devices\/([^/]+)(\/control)?$/);
    if (m && m[2] && req.method === "POST") return send(res, 200, await ac.control(decodeURIComponent(m[1]), await readJson(req)));
    if (m && !m[2] && req.method === "DELETE") { await ac.remove(decodeURIComponent(m[1])); return send(res, 200, { ok: true }); }

    // ----- presets -----
    if (p === "/api/presets" && req.method === "GET") return send(res, 200, presets.snapshot());
    if (p === "/api/presets" && req.method === "POST") return send(res, 200, presets.create(await readJson(req)));
    const pm = p.match(/^\/api\/presets\/([^/]+)(\/(start|stop))?$/);
    if (pm && pm[3] === "start" && req.method === "POST") return send(res, 200, await presets.run(pm[1]));
    if (pm && pm[3] === "stop" && req.method === "POST") return send(res, 200, await presets.halt(pm[1]));
    if (pm && !pm[2] && req.method === "PUT") return send(res, 200, presets.update(pm[1], await readJson(req)));
    if (pm && !pm[2] && req.method === "DELETE") { presets.remove(pm[1]); return send(res, 200, { ok: true }); }

    // ----- MirAIe link -----
    if (p === "/api/miraie" && req.method === "GET") return send(res, 200, ac.miraieStatus());
    if (p === "/api/miraie" && req.method === "POST") {
        const { username, password } = await readJson(req);
        await miraie.link(username, password);
        return send(res, 200, ac.miraieStatus());
    }
    if (p === "/api/miraie" && req.method === "DELETE") { await miraie.unlink(); return send(res, 200, ac.miraieStatus()); }
    if (p === "/api/miraie/link" && req.method === "POST") {
        const { miraieId, matterId } = await readJson(req);
        miraie.setLink(String(miraieId), matterId ? String(matterId) : null);
        return send(res, 200, ac.miraieStatus());
    }

    if (p === "/api/pin" && req.method === "POST") {
        checkRateLimit(req);
        const { current, next, signOutOthers } = await readJson(req);
        if (!pinMatches(current)) { recordFailure(req); throw httpError(401, "Current PIN is wrong"); }
        if (!validPin(next)) throw httpError(400, "New PIN must be 4 to 8 digits");
        const { salt, hash } = hashPin(next);
        Object.assign(config, { pinSalt: salt, pinHash: hash });
        if (signOutOthers) config.secret = crypto.randomBytes(32).toString("hex");
        saveConfig(config);
        setSession(req, res);
        return send(res, 200, { ok: true });
    }
    throw httpError(404, "Not found");
}

const server = http.createServer((req, res) => {
    route(req, res).catch(e => {
        if (!e.status) console.error(e);
        if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : "Something went wrong on the PC. Check the log." });
        else res.end();
    });
});

function remoteUrl() {
    try { return fs.readFileSync(path.join(dataDir, "remote-url.txt"), "utf8").trim() || undefined; } catch { return undefined; }
}

function lanUrls() {
    return Object.values(os.networkInterfaces()).flat()
        .filter(i => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
        .map(i => `http://${i.address}:${config.port}`);
}

await ac.start();
presets.start();
server.listen(config.port, "0.0.0.0", () => {
    const lan = lanUrls();
    console.log("");
    console.log("  AC Remote is running.");
    console.log(`  On this PC:     http://localhost:${config.port}`);
    for (const u of lan) console.log(`  On your phone:  ${u}   (same Wi-Fi)`);
    console.log(`  Data folder:    ${dataDir}`);
    console.log("");
});

async function shutdown() {
    server.close();
    for (const res of streams) res.end();
    presets.stop();
    await ac.stop().catch(() => {});
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
