// One list of ACs for the app, whichever way each one is connected:
//  - Matter (local, preferred for everyday controls)
//  - MirAIe cloud (Panasonic extras, energy, and a fallback when Matter isn't paired or is offline)
// It also runs the "turn off after" timers so they work for every AC.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { httpError } from "./ac.mjs";
import { CONVERTI } from "./miraie.mjs";

const BASIC = ["power", "mode", "targetTemp", "fan", "swing", "name"];
const EXTRA = ["powerful", "eco", "clean", "display", "converti", "swingV", "swingH", "nanoe"];

export class DeviceHub extends EventEmitter {
    #timers = new Map();
    #timerFile;
    #last = "";

    constructor({ matter, miraie, dataDir }) {
        super();
        this.matter = matter;
        this.miraie = miraie;
        this.#timerFile = path.join(dataDir, "timers.json");
        const changed = () => this.#changed();
        matter.on("change", changed);
        miraie.on("change", changed);
        matter.on("pairing", p => this.emit("pairing", p));
    }

    async start() {
        await this.matter.start();
        this.miraie.start(); // connects in the background; it is optional
        this.#restoreTimers();
        // Energy figures come from MirAIe occasionally; refresh them in the background.
        setInterval(() => { for (const m of this.miraie.list()) this.miraie.refreshEnergy(m.miraieId); }, 15 * 60e3).unref();
        setTimeout(() => { for (const m of this.miraie.list()) this.miraie.refreshEnergy(m.miraieId); }, 5000).unref();
    }

    async stop() {
        for (const t of this.#timers.values()) clearTimeout(t.handle);
        this.miraie.stop();
        await this.matter.stop();
    }

    #changed() {
        const snap = JSON.stringify(this.devices());
        if (snap !== this.#last) { this.#last = snap; this.emit("change", JSON.parse(snap)); }
    }

    // Which MirAIe AC is the same unit as a Matter AC. Explicit links win; with exactly one of each, they're assumed to match.
    #pairs() {
        const matterIds = this.matter.devices().map(d => d.id);
        const mir = this.miraie.list();
        const links = this.miraie.links;
        const map = new Map(); // matterId -> miraieId
        for (const m of mir) {
            const target = links[m.miraieId];
            if (target && matterIds.includes(target)) map.set(target, m.miraieId);
        }
        const explicit = new Set(Object.keys(links));
        if (matterIds.length === 1 && mir.length === 1 && !explicit.has(mir[0].miraieId)) map.set(matterIds[0], mir[0].miraieId);
        return map;
    }

    devices() {
        const pairs = this.#pairs();
        const used = new Set(pairs.values());
        const out = this.matter.devices().map(m => {
            const mir = pairs.has(m.id) ? this.miraie.get(pairs.get(m.id)) : undefined;
            const useCloud = !m.online && mir?.online; // fall back to MirAIe while Matter is unreachable
            const base = useCloud ? { ...m, ...pick(mir, ["power", "mode", "targetTemp", "fan"]), online: true } : m;
            return {
                ...base,
                roomTemp: m.roomTemp ?? mir?.roomTemp ?? null,
                swing: m.swing ?? (mir?.extras.swingV != null ? mir.extras.swingV === 0 : null),
                via: mir ? ["matter", "miraie"] : ["matter"],
                miraieId: mir?.miraieId ?? null,
                extras: mir?.online ? mir.extras : null,
                offAt: this.#timers.get(m.id)?.offAt ?? null,
            };
        });
        for (const mir of this.miraie.list()) {
            if (used.has(mir.miraieId)) continue;
            const id = `miraie:${mir.miraieId}`;
            out.push({
                id, name: mir.name, vendor: mir.vendor, product: mir.product, online: mir.online,
                power: mir.power, mode: mir.mode, modes: mir.modes, targetTemp: mir.targetTemp, minTemp: mir.minTemp, maxTemp: mir.maxTemp,
                roomTemp: mir.roomTemp, humidity: null, fan: mir.fan, fans: mir.fans,
                swing: mir.extras.swingV === null ? null : mir.extras.swingV === 0,
                via: ["miraie"], miraieId: mir.miraieId, extras: mir.online ? mir.extras : null,
                offAt: this.#timers.get(id)?.offAt ?? null,
            });
        }
        return out;
    }

    find(id) {
        const d = this.devices().find(x => x.id === id);
        if (!d) throw httpError(404, "AC not found");
        return d;
    }

    async control(id, cmd) {
        const d = this.find(id);
        cmd = { ...cmd };
        if ("offTimer" in cmd) {
            const minutes = Number(cmd.offTimer);
            if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) throw httpError(400, "Timer must be between 0 and 24 hours");
            this.#setTimer(id, minutes ? Date.now() + minutes * 60e3 : null);
            delete cmd.offTimer;
        }
        if (cmd.power === false && this.#timers.has(id)) this.#setTimer(id, null);

        const basic = pick(cmd, BASIC);
        const extra = pick(cmd, EXTRA);
        // Swing: Matter only if the AC exposes it there; otherwise MirAIe's vertical swing.
        if ("swing" in basic && d.via.includes("matter") && this.matter.devices().find(m => m.id === id)?.swing === null) {
            if (d.miraieId) extra.swingV = basic.swing ? 0 : 3;
            delete basic.swing;
        }
        if (Object.keys(basic).length) {
            const matterId = d.via.includes("matter") ? id : null;
            if (matterId && this.matter.isOnline(matterId)) {
                await this.matter.control(matterId, basic);
            } else if (d.miraieId) {
                if ("name" in basic) throw httpError(409, "Renaming needs the Matter connection. Rename it in the MirAIe app instead.");
                await this.miraie.control(d.miraieId, basic);
            } else {
                throw httpError(409, "The AC is offline. Check that it is powered and on Wi-Fi.");
            }
        }
        if (Object.keys(extra).length) {
            if (!d.miraieId) throw httpError(409, "This feature needs your MirAIe account. Link it in Settings.");
            await this.miraie.control(d.miraieId, extra);
        }
        this.#changed();
        return this.find(id);
    }

    async remove(id) {
        this.#setTimer(id, null);
        if (id.startsWith("miraie:")) throw httpError(409, "This AC comes from your MirAIe account. Unlink MirAIe in Settings to remove it.");
        await this.matter.remove(id);
        this.#changed();
    }

    // ---------- off timers ----------
    #restoreTimers() {
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(this.#timerFile, "utf8")); } catch { return; }
        // Timers that ran out while the PC was off are dropped rather than firing late.
        for (const [id, offAt] of Object.entries(saved)) if (offAt > Date.now() + 1000) this.#setTimer(id, offAt, false);
        this.#saveTimers();
    }
    #saveTimers() {
        const data = Object.fromEntries([...this.#timers].map(([id, t]) => [id, t.offAt]));
        try { fs.writeFileSync(this.#timerFile, JSON.stringify(data)); } catch (e) { console.warn(`Could not save timers: ${e.message}`); }
    }
    #setTimer(id, offAt, save = true) {
        clearTimeout(this.#timers.get(id)?.handle);
        this.#timers.delete(id);
        if (offAt) {
            const handle = setTimeout(async () => {
                this.#timers.delete(id);
                this.#saveTimers();
                try { await this.control(id, { power: false }); console.log(`[timer] switched ${id} off`); }
                catch (e) { console.warn(`[timer] could not switch ${id} off: ${e.message}`); }
                this.#changed();
            }, Math.min(Math.max(0, offAt - Date.now()), 2 ** 31 - 1));
            this.#timers.set(id, { offAt, handle });
        }
        if (save) this.#saveTimers();
        this.#changed();
    }

    miraieStatus() {
        return {
            linked: this.miraie.linked, account: this.miraie.account, connected: this.miraie.connected, error: this.miraie.error,
            devices: this.miraie.list().map(m => ({ id: m.miraieId, name: m.name, room: m.room, linkedTo: this.#linkedTo(m.miraieId) })),
            matterDevices: this.matter.devices().map(m => ({ id: m.id, name: m.name })),
            converti: CONVERTI,
        };
    }
    #linkedTo(miraieId) {
        for (const [matterId, mid] of this.#pairs()) if (mid === miraieId) return matterId;
        return null;
    }
}

function pick(obj, keys) {
    return Object.fromEntries(keys.filter(k => obj && k in obj && obj[k] !== undefined).map(k => [k, obj[k]]));
}
