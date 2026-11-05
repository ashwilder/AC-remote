// Matter controller: pairs air conditioners into this app's own Matter fabric and controls them.
import { Environment, ServerNode, ControllerBehavior, Seconds, Logger } from "@matter/main";
import { EventEmitter } from "node:events";

const log = Logger.get("ACRemote");

// Matter Thermostat SystemMode values
export const MODES = { off: 0, auto: 1, cool: 3, heat: 4, fan: 7, dry: 8 };
const MODE_NAMES = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v, k]));

// Matter FanControl FanMode values and which ones each FanModeSequence offers
const FAN_NAMES = { 1: "low", 2: "medium", 3: "high", 4: "on", 5: "auto", 6: "smart" };
const FAN_VALUES = { low: 1, medium: 2, high: 3, on: 4, auto: 5, smart: 6 };
const FAN_SEQUENCES = {
    0: ["low", "medium", "high"],
    1: ["low", "high"],
    2: ["low", "medium", "high", "auto"],
    3: ["low", "high", "auto"],
    4: ["high", "auto"],
    5: ["high"],
};

const has = (ep, behavior) => ep && behavior in ep.behaviors.supported;
const safeState = (ep, behavior) => {
    try { return has(ep, behavior) ? ep.stateOf(behavior) : undefined; } catch { return undefined; }
};
const toC = v => (typeof v === "number" ? Math.round(v) / 100 : null);

export class AcController extends EventEmitter {
    #node;
    #bluetooth = false;
    #lastSnapshot = "";
    #poll;
    #pairing = false;
    #lastMode = new Map(); // remembers the last running mode for units without an On/Off cluster

    constructor({ storagePath, matterPort = 5541, bluetooth = true, logLevel = "notice" }) {
        super();
        this.storagePath = storagePath;
        this.matterPort = matterPort;
        this.wantBluetooth = bluetooth;
        Environment.default.vars.set("storage.path", storagePath);
        Environment.default.vars.set("log.level", logLevel);
        Environment.default.vars.set("runtime.signals", false); // the web server handles shutdown
    }

    get bluetoothAvailable() { return this.#bluetooth; }
    get pairing() { return this.#pairing; }

    async start() {
        if (this.wantBluetooth) {
            try {
                await import("@matter/nodejs-ble");
                Environment.default.vars.set("ble.enable", true);
                this.#bluetooth = true;
            } catch (e) {
                log.warn(`Bluetooth pairing unavailable on this PC: ${e.message}`);
            }
        }

        this.#node = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior), {
            id: "ac-remote-controller",
            network: { port: this.matterPort, ble: false },
            controller: { adminFabricLabel: "AC Remote (PC)", ble: this.#bluetooth },
            commissioning: { enabled: false },
            subscriptions: { persistenceEnabled: false },
        });
        await this.#node.start();
        log.notice(`Matter controller online; ${this.#node.peers.commissioned.length} paired device(s)`);

        // Push a fresh snapshot to listeners whenever any device state changes.
        this.#poll = setInterval(() => this.#checkForChanges(), 700);
    }

    async stop() {
        clearInterval(this.#poll);
        await this.#node?.close();
    }

    #checkForChanges() {
        let snap;
        try { snap = JSON.stringify(this.devices()); } catch (e) { return; }
        if (snap !== this.#lastSnapshot) {
            this.#lastSnapshot = snap;
            this.emit("change", JSON.parse(snap));
        }
    }

    #peer(id) {
        const peer = this.#node.peers.commissioned.find(p => p.id === id);
        if (!peer) throw httpError(404, "Device not found");
        return peer;
    }

    #acEndpoint(peer) {
        const eps = [...peer.endpoints].filter(e => e.number !== 0);
        return eps.find(e => has(e, "thermostat")) ?? eps.find(e => has(e, "fanControl")) ?? eps.find(e => has(e, "onOff"));
    }

    isOnline(id) {
        return !!this.#node.peers.commissioned.find(p => p.id === id)?.lifecycle?.isOnline;
    }

    devices() {
        return this.#node.peers.commissioned.map(peer => this.#describe(peer));
    }

    #describe(peer) {
        const info = safeState(peer, "basicInformation") ?? {};
        const ep = this.#acEndpoint(peer);
        const t = safeState(ep, "thermostat");
        const fan = safeState(ep, "fanControl");
        const onOff = safeState(ep, "onOff");
        const tm = safeState(ep, "temperatureMeasurement");
        const hum = safeState(ep, "relativeHumidityMeasurement");
        const f = t?.featureMap ?? {};

        const systemMode = t?.systemMode;
        const modeName = MODE_NAMES[systemMode] ?? (systemMode === undefined ? null : `mode${systemMode}`);
        if (modeName && modeName !== "off") this.#lastMode.set(peer.id, systemMode);
        const power = onOff ? !!onOff.onOff && modeName !== "off" : modeName ? modeName !== "off" : null;

        const modes = [];
        if (f.cooling) modes.push("cool");
        if (f.heating) modes.push("heat");
        if (f.autoMode) modes.push("auto");
        if (t) modes.push("dry", "fan");

        // Which setpoint the temperature control adjusts depends on the mode.
        const useHeat = modeName === "heat" || (!f.cooling && f.heating);
        const target = useHeat ? t?.occupiedHeatingSetpoint : t?.occupiedCoolingSetpoint;
        const min = useHeat ? (t?.minHeatSetpointLimit ?? t?.absMinHeatSetpointLimit) : (t?.minCoolSetpointLimit ?? t?.absMinCoolSetpointLimit);
        const max = useHeat ? (t?.maxHeatSetpointLimit ?? t?.absMaxHeatSetpointLimit) : (t?.maxCoolSetpointLimit ?? t?.absMaxCoolSetpointLimit);

        const fanFeatures = fan?.featureMap ?? {};
        const rock = fanFeatures.rocking ? fan.rockSupport ?? {} : null;
        const rockSetting = fan?.rockSetting ?? {};

        return {
            id: peer.id,
            name: info.nodeLabel || info.productLabel || info.productName || "Air conditioner",
            vendor: info.vendorName ?? null,
            product: info.productName ?? null,
            online: !!peer.lifecycle?.isOnline,
            power,
            mode: modeName,
            modes,
            targetTemp: toC(target),
            minTemp: toC(min) ?? 16,
            maxTemp: toC(max) ?? 30,
            roomTemp: toC(t?.localTemperature ?? tm?.measuredValue),
            humidity: typeof hum?.measuredValue === "number" ? Math.round(hum.measuredValue / 100) : null,
            fan: fan ? FAN_NAMES[fan.fanMode] ?? (fan.fanMode === 0 ? "off" : null) : null,
            fans: fan ? FAN_SEQUENCES[fan.fanModeSequence] ?? ["low", "medium", "high", "auto"] : [],
            swing: rock ? !!(rockSetting.rockUpDown || rockSetting.rockLeftRight || rockSetting.rockRound) : null,
        };
    }

    async control(id, cmd) {
        const peer = this.#peer(id);
        if (!peer.lifecycle?.isOnline) throw httpError(409, "The AC is offline. Check that it is powered and on Wi-Fi.");
        const ep = this.#acEndpoint(peer);
        if (!ep) throw httpError(422, "This device has no air-conditioner controls");
        const state = this.#describe(peer);
        const wrap = async (fn, what) => {
            try { await fn(); } catch (e) {
                log.warn(`Command ${what} failed: ${e.message}`);
                throw httpError(502, `The AC rejected "${what}": ${e.message}`);
            }
        };

        if ("power" in cmd) {
            if (has(ep, "onOff")) {
                await wrap(() => ep.commandsOf("onOff")[cmd.power ? "on" : "off"](), "power");
                if (cmd.power && state.mode === "off") {
                    await wrap(() => ep.setStateOf("thermostat", { systemMode: this.#lastMode.get(id) ?? MODES.cool }), "mode");
                }
            } else {
                await wrap(() => ep.setStateOf("thermostat", { systemMode: cmd.power ? this.#lastMode.get(id) ?? MODES.cool : MODES.off }), "power");
            }
        }
        if ("mode" in cmd) {
            const value = MODES[cmd.mode];
            if (value === undefined || cmd.mode === "off") throw httpError(400, "Unknown mode");
            await wrap(() => ep.setStateOf("thermostat", { systemMode: value }), `mode ${cmd.mode}`);
            if (has(ep, "onOff") && !state.power) await wrap(() => ep.commandsOf("onOff").on(), "power");
        }
        if ("targetTemp" in cmd) {
            const c = Number(cmd.targetTemp);
            if (!Number.isFinite(c) || c < state.minTemp || c > state.maxTemp) {
                throw httpError(400, `Temperature must be between ${state.minTemp} and ${state.maxTemp} °C`);
            }
            const t = ep.stateOf("thermostat");
            const mode = cmd.mode ?? state.mode;
            const useHeat = mode === "heat" || (!t.featureMap.cooling && t.featureMap.heating);
            const attr = useHeat ? "occupiedHeatingSetpoint" : "occupiedCoolingSetpoint";
            await wrap(() => ep.setStateOf("thermostat", { [attr]: Math.round(c * 100) }), "temperature");
        }
        if ("fan" in cmd) {
            const value = FAN_VALUES[cmd.fan];
            if (value === undefined) throw httpError(400, "Unknown fan speed");
            await wrap(() => ep.setStateOf("fanControl", { fanMode: value }), `fan ${cmd.fan}`);
        }
        if ("swing" in cmd) {
            const sup = ep.stateOf("fanControl").rockSupport ?? {};
            const on = !!cmd.swing;
            const setting = { rockUpDown: on && !!sup.rockUpDown, rockLeftRight: on && !sup.rockUpDown && !!sup.rockLeftRight, rockRound: on && !sup.rockUpDown && !sup.rockLeftRight && !!sup.rockRound };
            await wrap(() => ep.setStateOf("fanControl", { rockSetting: setting }), "swing");
        }
        if ("name" in cmd) {
            const name = String(cmd.name).trim().slice(0, 32);
            if (!name) throw httpError(400, "Name cannot be empty");
            await wrap(() => peer.setStateOf("basicInformation", { nodeLabel: name }), "rename");
        }
        await new Promise(r => setTimeout(r, 300));
        this.#checkForChanges();
        return this.#describe(peer);
    }

    /**
     * Pair a device. `code` is the 11-digit manual pairing code or the "MT:..." QR text.
     * With `wifi` set, pairing happens over this PC's Bluetooth and the AC is given those Wi-Fi details.
     */
    async pair({ code, wifi }) {
        if (this.#pairing) throw httpError(409, "Already pairing a device. Please wait.");
        const clean = String(code ?? "").trim();
        const pairingCode = clean.toUpperCase().startsWith("MT:") ? clean.toUpperCase() : clean.replace(/[^0-9]/g, "");
        if (!pairingCode.startsWith("MT:") && pairingCode.length !== 11 && pairingCode.length !== 21) {
            throw httpError(400, "Enter the 11-digit pairing code (or the MT:... text from the QR code)");
        }
        if (wifi && !this.#bluetooth) {
            throw httpError(400, "Bluetooth pairing is not available on this PC. Pair the AC with a phone app first, then share it here.");
        }
        this.#pairing = true;
        this.emit("pairing", { active: true });
        try {
            const options = { pairingCode, timeout: Seconds(wifi ? 120 : 60) };
            if (wifi) options.wifiNetwork = { wifiSsid: wifi.ssid, wifiCredentials: wifi.password ?? "" };
            const peer = await this.#node.peers.commission(options);
            log.notice(`Paired new device ${peer.id}`);
            await new Promise(r => setTimeout(r, 1000));
            this.#checkForChanges();
            return this.#describe(peer);
        } catch (e) {
            log.warn(`Pairing failed: ${e.message}`);
            throw httpError(502, friendlyPairingError(e, !!wifi));
        } finally {
            this.#pairing = false;
            this.emit("pairing", { active: false });
        }
    }

    async remove(id) {
        const peer = this.#peer(id);
        try {
            await peer.decommission();
        } catch (e) {
            log.warn(`Device did not confirm removal (${e.message}); removing locally`);
            await peer.delete();
        }
        this.#checkForChanges();
    }
}

function friendlyPairingError(e, viaBluetooth) {
    const m = String(e?.message ?? e);
    if (/timeout|timed out|not found|no .*device|discover/i.test(m)) {
        return viaBluetooth
            ? "Couldn't find the AC over Bluetooth. Put the AC in pairing mode (press SMART on the remote until the Wi-Fi light blinks), keep the PC within a few metres, and try again."
            : "Couldn't find the AC on your network. Make sure the pairing code is fresh (they expire after a few minutes) and the PC is on the same Wi-Fi as the AC.";
    }
    if (/passcode|pase|spake/i.test(m)) return "The pairing code was rejected. Generate a new code and try again.";
    if (/wifi|network.*commission|connectNetwork/i.test(m)) return "The AC couldn't join your Wi-Fi. Check the Wi-Fi name and password (2.4 GHz network) and try again.";
    return `Pairing failed: ${m}`;
}

export function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}
