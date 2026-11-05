// Presets: saved AC settings you can start with one tap, or let run on a schedule.
// A preset sets power, mode, temperature, fan and swing (plus Powerful/Eco when MirAIe is linked),
// and, if it has an end time, switches the AC off at that time.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { httpError } from "./ac.mjs";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MODES = ["cool", "heat", "dry", "fan", "auto"];
const FANS = ["quiet", "low", "medium", "high", "auto", "on", "smart"];
const SPECIAL = [null, "powerful", "eco"];

export class Presets extends EventEmitter {
    #file; #data; #tick;

    constructor({ hub, dataDir }) {
        super();
        this.hub = hub;
        this.#file = path.join(dataDir, "presets.json");
        try { this.#data = JSON.parse(fs.readFileSync(this.#file, "utf8")); } catch { this.#data = null; }
        this.#data = { presets: [], active: {}, lastRun: {}, ...(this.#data ?? {}) };
        // A preset stops being "running" once its AC is switched off by any means.
        hub.on("change", devices => {
            let dirty = false;
            for (const [deviceId, a] of Object.entries(this.#data.active)) {
                const d = devices.find(x => x.id === deviceId);
                if (!d || d.power === false || (a.until && a.until < Date.now())) { delete this.#data.active[deviceId]; dirty = true; }
            }
            if (dirty) this.#save();
        });
    }

    start() {
        this.#tick = setInterval(() => this.#runSchedules(), 15e3);
        this.#runSchedules();
    }
    stop() { clearInterval(this.#tick); }

    snapshot() {
        return { presets: this.#data.presets, active: this.#data.active };
    }

    #save() {
        const tmp = `${this.#file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
        fs.renameSync(tmp, this.#file);
        this.emit("change", this.snapshot());
    }

    #validate(input, existing = {}) {
        const p = { ...existing, ...input };
        const name = String(p.name ?? "").trim().slice(0, 40);
        if (!name) throw httpError(400, "Give the preset a name");
        this.hub.find(p.deviceId); // throws if the AC doesn't exist
        if (!MODES.includes(p.mode)) throw httpError(400, "Choose a mode");
        const t = Number(p.targetTemp);
        if (p.mode !== "fan" && (!Number.isFinite(t) || t < 16 || t > 32)) throw httpError(400, "Temperature must be between 16 and 32 °C");
        if (p.fan != null && !FANS.includes(p.fan)) throw httpError(400, "Unknown fan speed");
        if (!SPECIAL.includes(p.special ?? null)) throw httpError(400, "Unknown special mode");
        for (const k of ["start", "end"]) if (p[k] && !TIME.test(p[k])) throw httpError(400, "Times must look like 22:30");
        const days = Array.isArray(p.days) ? [...new Set(p.days.map(Number).filter(n => n >= 0 && n <= 6))].sort() : [];
        if (p.scheduled && !p.start) throw httpError(400, "Set a start time to run this preset on a schedule");
        return {
            id: existing.id ?? crypto.randomUUID(),
            deviceId: p.deviceId,
            name,
            mode: p.mode,
            targetTemp: Number.isFinite(t) ? Math.round(t * 2) / 2 : null,
            fan: p.fan ?? null,
            swing: typeof p.swing === "boolean" ? p.swing : null,
            special: p.special ?? null,
            start: p.start || null,
            end: p.end || null,
            days,
            once: !!p.once,
            scheduled: !!p.scheduled,
        };
    }

    create(input) {
        const p = this.#validate(input);
        this.#data.presets.push(p);
        this.#save();
        return p;
    }

    update(id, input) {
        const i = this.#data.presets.findIndex(p => p.id === id);
        if (i < 0) throw httpError(404, "Preset not found");
        const p = this.#validate(input, this.#data.presets[i]);
        this.#data.presets[i] = p;
        this.#save();
        return p;
    }

    remove(id) {
        this.#data.presets = this.#data.presets.filter(p => p.id !== id);
        for (const [k, a] of Object.entries(this.#data.active)) if (a.presetId === id) delete this.#data.active[k];
        delete this.#data.lastRun[id];
        this.#save();
    }

    #find(id) {
        const p = this.#data.presets.find(x => x.id === id);
        if (!p) throw httpError(404, "Preset not found");
        return p;
    }

    // Apply a preset now.
    async run(id) {
        const p = this.#find(id);
        const cmd = { power: true, mode: p.mode };
        if (p.targetTemp != null && p.mode !== "fan") cmd.targetTemp = p.targetTemp;
        if (p.fan) cmd.fan = p.fan;
        const target = this.hub.find(p.deviceId);
        if (p.swing !== null && (target.swing !== null || target.miraieId)) cmd.swing = p.swing;
        const minutes = p.end ? minutesUntil(p.end) : 0;
        cmd.offTimer = minutes; // 0 clears any earlier timer, so the preset's own end time is the one that counts
        await this.hub.control(p.deviceId, cmd);
        if (p.special && this.hub.find(p.deviceId).extras) {
            await this.hub.control(p.deviceId, { [p.special]: true }).catch(e => console.warn(`[preset] ${p.special}: ${e.message}`));
        }
        this.#data.active[p.deviceId] = { presetId: p.id, startedAt: Date.now(), until: minutes ? Date.now() + minutes * 60e3 : null };
        this.#save();
        return this.snapshot();
    }

    // Stop a running preset: switch the AC off.
    async halt(id) {
        const p = this.#find(id);
        await this.hub.control(p.deviceId, { power: false });
        delete this.#data.active[p.deviceId];
        this.#save();
        return this.snapshot();
    }

    async #runSchedules() {
        const now = new Date();
        const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        for (const p of this.#data.presets) {
            if (!p.scheduled || p.start !== hhmm || this.#data.lastRun[p.id] === today) continue;
            if (p.days.length && !p.days.includes(now.getDay())) continue;
            this.#data.lastRun[p.id] = today;
            if (p.once) p.scheduled = false;
            this.#save();
            try {
                await this.run(p.id);
                console.log(`[preset] started "${p.name}" on schedule`);
            } catch (e) {
                console.warn(`[preset] could not start "${p.name}": ${e.message}`);
            }
        }
    }
}

const pad = n => String(n).padStart(2, "0");

// Minutes from now until the next time the clock reads hh:mm (today, or tomorrow if it has passed).
export function minutesUntil(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const now = new Date();
    const end = new Date(now);
    end.setHours(h, m, 0, 0);
    if (end <= now) end.setDate(end.getDate() + 1);
    return Math.max(1, Math.round((end - now) / 60e3));
}
