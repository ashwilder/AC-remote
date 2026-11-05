// Optional link to Panasonic's MirAIe cloud, for the features Matter doesn't carry
// (Powerful, Eco, Clean, AC display, Converti7, swing positions) and for energy use.
// Based on the publicly documented MirAIe API used by the open-source miraie-ac projects.
// Unofficial: Panasonic can change it at any time, so everything here fails soft.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import mqtt from "mqtt";

const AUTH = process.env.MIRAIE_AUTH_URL ?? "https://auth.miraie.in";
const APP = process.env.MIRAIE_APP_URL ?? "https://app.miraie.in";
const MQTT_URL = process.env.MIRAIE_MQTT_URL ?? "mqtts://mqtt.miraie.in:8883";
const CLIENT_ID = "PBcMcfG19njNCL8AOgvRzIC8AjQa";
const SCOPE = "an_14214235325";

export const CONVERTI = [
    { value: 0, label: "Off" }, { value: 40, label: "40%" }, { value: 50, label: "50%" }, { value: 55, label: "55%" },
    { value: 60, label: "60%" }, { value: 70, label: "70%" }, { value: 80, label: "80%" }, { value: 90, label: "90%" },
    { value: 100, label: "100%" }, { value: 110, label: "110%" },
];
const FANS = ["quiet", "low", "medium", "high", "auto"];

const on = v => v === "on" || v === true || v === "true";
const num = v => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// Firmware 3.02+ packs a fraction into the room temperature ("prefix.temp"), see miraie-ac-in utils.
function roomTemp(value, firmware = "") {
    if (value === undefined || value === null || value === "") return null;
    const s = String(value);
    const [maj, min] = String(firmware).replace(/[^\d.]/g, "").split(".").map(Number);
    if (maj > 3 || (maj === 3 && min >= 2)) {
        const [prefix, t] = s.split(".");
        if (t !== undefined) { const whole = Number(t); return whole > 0 ? Math.round((whole + Number(prefix) / 256) * 10) / 10 : null; }
    }
    return num(s);
}

export class MiraieCloud extends EventEmitter {
    #file; #keyFile; #saved = {}; #token; #userId; #homeId; #devices = new Map(); #client; #relogin; #energy = new Map();
    error = null;

    constructor({ dataDir }) {
        super();
        this.#file = path.join(dataDir, "miraie.json");
        this.#keyFile = path.join(dataDir, "miraie.key");
        try { this.#saved = JSON.parse(fs.readFileSync(this.#file, "utf8")); } catch { this.#saved = {}; }
    }

    get linked() { return !!this.#saved.username; }
    get account() { return this.#saved.username ?? null; }
    get connected() { return !!this.#client?.connected; }
    get links() { return this.#saved.links ?? {}; }

    // ---------- credentials (kept on this PC only, encrypted with a key stored beside them) ----------
    #key() {
        try { return Buffer.from(fs.readFileSync(this.#keyFile, "utf8"), "hex"); } catch { /* new */ }
        const k = crypto.randomBytes(32);
        fs.writeFileSync(this.#keyFile, k.toString("hex"), { mode: 0o600 });
        return k;
    }
    #encrypt(text) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv("aes-256-gcm", this.#key(), iv);
        const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
        return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
    }
    #decrypt(blob) {
        const [iv, tag, enc] = blob.split(".").map(b => Buffer.from(b, "base64"));
        const d = crypto.createDecipheriv("aes-256-gcm", this.#key(), iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
    }
    #save() {
        fs.writeFileSync(this.#file, JSON.stringify(this.#saved, null, 2), { mode: 0o600 });
    }

    // ---------- lifecycle ----------
    async start() {
        if (!this.linked) return;
        try {
            await this.#connect(this.#saved.username, this.#decrypt(this.#saved.password));
        } catch (e) {
            this.error = e.message;
            console.warn(`[MirAIe] ${e.message}. Retrying in 5 minutes.`);
            this.emit("change");
            setTimeout(() => this.start(), 5 * 60e3).unref();
        }
    }

    async link(username, password) {
        username = String(username ?? "").trim();
        if (!username || !password) throw httpError(400, "Enter your MirAIe mobile number or email and password");
        await this.#connect(username, String(password));
        this.#saved = { ...this.#saved, username, password: this.#encrypt(String(password)), links: this.#saved.links ?? {} };
        this.#save();
    }

    async unlink() {
        this.#client?.end(true);
        this.#client = undefined;
        clearTimeout(this.#relogin);
        this.#devices.clear();
        this.#saved = {};
        try { fs.unlinkSync(this.#file); } catch { /* none */ }
        this.error = null;
        this.emit("change");
    }

    stop() { this.#client?.end(true); clearTimeout(this.#relogin); }

    setLink(miraieId, matterId) {
        this.#saved.links = { ...(this.#saved.links ?? {}), [miraieId]: matterId || null };
        this.#save();
        this.emit("change");
    }

    // ---------- HTTP ----------
    async #login(username, password) {
        // The mobile number is tried as typed, then with the +91 prefix, since accounts differ.
        const ids = username.includes("@") ? [{ email: username }] : [...new Set([username.replace(/\s/g, ""), normaliseMobile(username)])].map(m => ({ mobile: m }));
        let res;
        for (const id of ids) {
            res = await fetch(`${AUTH}/simplifi/v1/userManagement/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: CLIENT_ID, password, scope: SCOPE, ...id }) })
                .catch(() => { throw httpError(502, "Couldn't reach MirAIe. Check the PC's internet connection."); });
            if (res.ok) break;
        }
        if (res.status === 401 || res.status === 400 || res.status === 403 || res.status === 404) throw httpError(422, "MirAIe didn't accept that login. Use the same mobile number or email and password as the MirAIe app.");
        if (!res.ok) throw httpError(502, `MirAIe sign-in failed (${res.status})`);
        const j = await res.json();
        this.#token = j.accessToken;
        this.#userId = j.userId;
        clearTimeout(this.#relogin);
        const secs = Number(j.expiresIn);
        if (secs > 120) {
            this.#relogin = setTimeout(() => this.#refresh(), Math.min(secs * 800, 2 ** 31 - 1));
            this.#relogin.unref?.();
        }
    }

    async #refresh() {
        try {
            await this.#login(this.#saved.username, this.#decrypt(this.#saved.password));
            if (this.#client) { this.#client.options.password = this.#token; }
        } catch (e) { this.error = e.message; this.emit("change"); }
    }

    async #get(url) {
        let res = await fetch(url, { headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" } });
        if (res.status === 401 && this.linked) { await this.#refresh(); res = await fetch(url, { headers: { Authorization: `Bearer ${this.#token}` } }); }
        if (!res.ok) throw httpError(502, `MirAIe request failed (${res.status})`);
        return res.json();
    }

    async #connect(username, password) {
        await this.#login(username, password);
        const homes = await this.#get(`${APP}/simplifi/v1/homeManagement/homes`);
        const home = Array.isArray(homes) ? homes[0] : homes;
        if (!home) throw httpError(404, "No home found in this MirAIe account");
        this.#homeId = home.homeId;
        this.#devices.clear();
        for (const space of home.spaces ?? []) {
            for (const d of space.devices ?? []) {
                this.#devices.set(d.deviceId, { id: d.deviceId, name: d.deviceName, room: space.spaceName ?? null, base: String(d.topic?.[0] ?? ""), raw: {}, details: {} });
            }
        }
        const ids = [...this.#devices.keys()];
        if (ids.length) {
            try {
                const details = await this.#get(`${APP}/simplifi/v1/deviceManagement/devices/deviceId/${ids.join(",")}`);
                for (const dd of Array.isArray(details) ? details : []) {
                    const dev = this.#devices.get(dd.deviceId);
                    if (dev) dev.details = { model: dd.modelName || dd.modelNumber || null, brand: dd.brand || "Panasonic", firmware: dd.firmwareVersion || "" };
                }
            } catch { /* details are optional */ }
            await Promise.all(ids.map(async id => {
                try { Object.assign(this.#devices.get(id).raw, await this.#get(`${APP}/simplifi/v1/deviceManagement/devices/${id}/mobile/status`)); } catch { /* status arrives over MQTT too */ }
            }));
        }
        this.#startMqtt();
        this.error = null;
        this.emit("change");
        for (const id of this.#devices.keys()) this.refreshEnergy(id);
    }

    #startMqtt() {
        this.#client?.end(true);
        const client = mqtt.connect(MQTT_URL, {
            username: this.#homeId, password: this.#token, clientId: `ac-remote-${crypto.randomBytes(4).toString("hex")}`,
            reconnectPeriod: 5000, connectTimeout: 20000, rejectUnauthorized: !process.env.MIRAIE_MQTT_INSECURE,
        });
        this.#client = client;
        client.on("connect", () => {
            const topics = [...this.#devices.values()].flatMap(d => [`${d.base}/status`, `${d.base}/connectionStatus`]);
            if (topics.length) client.subscribe(topics);
            this.emit("change");
        });
        client.on("message", (topic, payload) => {
            let msg; try { msg = JSON.parse(payload.toString()); } catch { return; }
            const dev = [...this.#devices.values()].find(d => topic.startsWith(`${d.base}/`));
            if (!dev) return;
            Object.assign(dev.raw, msg);
            this.emit("change");
        });
        client.on("error", async e => {
            if (/not authori[sz]ed|bad user name|auth/i.test(e.message)) await this.#refresh();
        });
        client.on("close", () => this.emit("change"));
    }

    // ---------- devices ----------
    list() {
        return [...this.#devices.values()].map(d => this.#describe(d));
    }

    get(id) { const d = this.#devices.get(id); return d ? this.#describe(d) : undefined; }

    #describe(d) {
        const r = d.raw;
        const mode = r.acmd ?? null;
        const modes = ["cool", "dry", "fan", "auto"];
        if (mode === "heat") modes.splice(1, 0, "heat");
        return {
            miraieId: d.id,
            name: d.name,
            room: d.room,
            vendor: d.details.brand ?? "Panasonic",
            product: d.details.model ?? null,
            online: (r.onlineStatus === undefined ? true : on(r.onlineStatus)) && this.connected,
            power: r.ps === undefined ? null : on(r.ps),
            mode,
            modes,
            targetTemp: num(r.actmp),
            minTemp: 16,
            maxTemp: 30,
            roomTemp: roomTemp(r.rmtmp, d.details.firmware),
            fan: r.acfs ?? null,
            fans: FANS,
            extras: {
                powerful: on(r.acpm),
                eco: on(r.acem),
                clean: on(r.acec),
                display: r.acdc === undefined ? null : on(r.acdc),
                converti: num(r.cnv),
                convertiSupported: r.cnv !== undefined && Number(r.cnv) !== 1,
                swingV: num(r.acvs),
                swingH: num(r.achs),
                nanoe: r.acngs !== undefined || r.acng !== undefined ? on(r.acngs ?? r.acng) : null,
                filterAlert: on(r.acfc),
                energyMonthKwh: this.#energy.get(d.id)?.kwh ?? null,
            },
        };
    }

    // Translate app commands into MirAIe fields and publish them.
    async control(id, cmd) {
        const d = this.#devices.get(id);
        if (!d) throw httpError(404, "MirAIe AC not found");
        if (!this.connected) throw httpError(409, "Not connected to MirAIe right now. Check the PC's internet connection.");
        const p = {};
        if ("power" in cmd) p.ps = cmd.power ? "on" : "off";
        if ("mode" in cmd) p.acmd = String(cmd.mode);
        if ("targetTemp" in cmd) p.actmp = String(Number.isInteger(+cmd.targetTemp) ? +cmd.targetTemp : +cmd.targetTemp);
        if ("fan" in cmd) { if (!FANS.includes(cmd.fan)) throw httpError(400, "Unknown fan speed"); p.acfs = cmd.fan; }
        if ("swing" in cmd) p.acvs = cmd.swing ? 0 : 3;
        if ("swingV" in cmd) p.acvs = clampInt(cmd.swingV, 0, 5);
        if ("swingH" in cmd) p.achs = clampInt(cmd.swingH, 0, 5);
        if ("display" in cmd) p.acdc = cmd.display ? "on" : "off";
        if ("nanoe" in cmd) p.acng = cmd.nanoe ? "on" : "off";
        // Powerful, Eco and Clean are mutually exclusive and also cancel Converti7, as in the MirAIe app.
        if ("powerful" in cmd) Object.assign(p, { acpm: cmd.powerful ? "on" : "off", ...(cmd.powerful ? { acem: "off", acec: "off", cnv: 0 } : {}) });
        if ("eco" in cmd) Object.assign(p, { acem: cmd.eco ? "on" : "off", ...(cmd.eco ? { acpm: "off", acec: "off", cnv: 0 } : {}) });
        if ("clean" in cmd) Object.assign(p, { acec: cmd.clean ? "on" : "off", ...(cmd.clean ? { acpm: "off", acem: "off", cnv: 0 } : {}) });
        if ("converti" in cmd) {
            const v = Number(cmd.converti);
            if (!CONVERTI.some(c => c.value === v)) throw httpError(400, "Unknown Converti7 level");
            Object.assign(p, { cnv: v, acem: "off", acpm: "off" });
        }
        if (!Object.keys(p).length) return this.get(id);
        const payload = JSON.stringify({ ki: 1, cnt: "an", sid: "1", ...p });
        await new Promise((resolve, reject) => this.#client.publish(`${d.base}/control`, payload, { qos: 0 }, e => (e ? reject(httpError(502, `MirAIe didn't take the command: ${e.message}`)) : resolve())));
        Object.assign(d.raw, p); // show it straight away; the AC's status message confirms it
        this.emit("change");
        return this.get(id);
    }

    // This month's energy use in kWh, refreshed at most every 15 minutes.
    async refreshEnergy(id) {
        const cached = this.#energy.get(id);
        if (cached && Date.now() - cached.at < 15 * 60e3) return;
        this.#energy.set(id, { at: Date.now(), kwh: cached?.kwh ?? null });
        const now = new Date();
        const mm = `${String(now.getMonth() + 1).padStart(2, "0")}${now.getFullYear()}`;
        try {
            const res = await this.#get(`${APP}/simplifi/v1/powerConsumption/devices/${id}?grain=Monthly&startDate=${mm}&endDate=${mm}`);
            const row = Array.isArray(res) ? res.find(r => String(r.month) === mm) ?? res[0] : null;
            const kwh = row ? Number(row.power) : null;
            this.#energy.set(id, { at: Date.now(), kwh: Number.isFinite(kwh) ? Math.round(kwh * 10) / 10 : null });
            this.emit("change");
        } catch { /* energy is optional */ }
    }
}

function normaliseMobile(m) {
    const digits = m.replace(/[^\d+]/g, "");
    if (digits.startsWith("+")) return digits;
    if (digits.length === 10) return `+91${digits}`;
    return digits;
}
function clampInt(v, lo, hi) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw httpError(400, `Value must be between ${lo} and ${hi}`);
    return n;
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
