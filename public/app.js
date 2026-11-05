const $ = s => document.querySelector(s);
const MODE = {
    cool: { label: "Cold", icon: "cool", color: "var(--cool)" },
    heat: { label: "Hot", icon: "heat", color: "var(--heat)" },
    dry: { label: "Dry Air", icon: "dry", color: "var(--dry)" },
    fan: { label: "Fan", icon: "fan", color: "var(--fan)" },
    auto: { label: "Auto", icon: "auto", color: "var(--auto)" },
};
const FAN = { quiet: "Quiet", low: "Low", medium: "Medium", high: "High", auto: "Auto", on: "On", smart: "Smart" };
const CONVERTI = [[0, "Off"], [40, "40%"], [50, "50%"], [55, "55%"], [60, "60%"], [70, "70%"], [80, "80%"], [90, "90%"], [100, "100%"], [110, "110%"]];
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let status = {};
let devices = [];
let presetData = { presets: [], active: {} };
let selected = load("acr.selected");
let pendingTemp = null;   // degrees being dialled in, not yet sent
let tempTimer;
let dragging = false;
let events;
let pairBusy = false;

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function store(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
const icon = name => `<svg><use href="#i-${name}"/></svg>`;
const fmtTemp = t => (t == null ? "--" : Number.isInteger(t) ? String(t) : t.toFixed(1));
const hhmm = ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function api(method, path, body) {
    const res = await fetch(path, {
        method, credentials: "same-origin",
        headers: { "x-acr": "1", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/login" && path !== "/api/pin") { showGate(); throw new Error(data.error ?? "Please sign in"); }
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
}

function toast(msg, bad = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = `toast show${bad ? " bad" : ""}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.className = "toast"), bad ? 5000 : 2200);
}

// ---------- boot & PIN ----------
async function boot() {
    try {
        status = await api("GET", "/api/status");
    } catch {
        $("#gate").hidden = false;
        $("#gate-title").textContent = "Can't reach your PC";
        $("#gate-help").textContent = "Make sure the PC is on and AC Remote is running, then reload this page.";
        $("#gate-form").hidden = true;
        return;
    }
    if (status.authed) return showApp();
    showGate();
}

function showGate() {
    events?.close();
    $("#app").hidden = true;
    $("#gate").hidden = false;
    const setup = status.setup;
    $("#gate-form").hidden = setup && !status.canSetup;
    $("#pin2").hidden = !setup;
    $("#pin2").required = setup;
    $("#pin").placeholder = setup ? "New PIN" : "PIN";
    $("#gate-title").textContent = setup ? "Choose a PIN" : "AC Remote";
    $("#gate-help").textContent = setup
        ? status.canSetup
            ? "You'll enter this 4 to 8 digit PIN on each phone or browser you use to control the AC."
            : "Finish setup on the PC first: open http://localhost:8080 there and choose a PIN."
        : "Enter your PIN to control the AC.";
    $("#gate-btn").textContent = setup ? "Save PIN" : "Unlock";
    $("#pin").focus();
}

$("#gate-form").addEventListener("submit", async e => {
    e.preventDefault();
    const pin = $("#pin").value.trim();
    $("#gate-error").textContent = "";
    if (status.setup && pin !== $("#pin2").value.trim()) { $("#gate-error").textContent = "The two PINs don't match."; return; }
    try {
        await api("POST", status.setup ? "/api/setup" : "/api/login", { pin });
        $("#pin").value = $("#pin2").value = "";
        status = await api("GET", "/api/status");
        showApp();
    } catch (err) {
        $("#gate-error").textContent = err.message;
        $("#pin").select();
    }
});

$("#change-pc").onclick = () => window.ACRemoteApp?.changePc();

function showApp() {
    // Inside the Android app: remember the private Tailscale address so the app works away from home.
    if (window.ACRemoteApp && status.remoteUrl) { try { window.ACRemoteApp.rememberRemote(status.remoteUrl); } catch { /* older app */ } }
    $("#gate").hidden = true;
    $("#app").hidden = false;
    connect();
}

// ---------- live updates ----------
function connect() {
    events?.close();
    let lostTimer;
    events = new EventSource("/api/events");
    events.addEventListener("devices", e => {
        clearTimeout(lostTimer);
        if ($("#banner").dataset.kind === "conn") $("#banner").hidden = true;
        devices = JSON.parse(e.data);
        render();
    });
    events.addEventListener("presets", e => { presetData = JSON.parse(e.data); renderPresets(); });
    events.addEventListener("pairing", e => { pairBusy = JSON.parse(e.data).active; });
    events.onerror = async () => {
        clearTimeout(lostTimer);
        lostTimer = setTimeout(() => {
            $("#banner").dataset.kind = "conn";
            $("#banner").textContent = "Can't reach your PC. Trying again…";
            $("#banner").hidden = false;
        }, 4000);
        const s = await fetch("/api/status").then(r => r.json()).catch(() => null);
        if (s && !s.authed) { status = s; showGate(); }
    };
}

// ---------- rendering ----------
const current = () => devices.find(d => d.id === selected) ?? devices[0];

function render() {
    const d = current();
    const app = $("#app");
    app.classList.toggle("empty-state", !d);
    $("#empty").hidden = !!d;
    $("#dial-wrap").hidden = !d;
    $("#side").hidden = !d;
    $("#set-device").hidden = !d;
    $("#status").hidden = !d;

    const sel = $("#device");
    sel.replaceChildren(...(d ? devices : [{ id: "", name: "AC Remote" }]).map(x => new Option(x.name, x.id, false, x.id === d?.id)));
    sel.disabled = devices.length < 2;
    $("#device-chev").style.display = devices.length < 2 ? "none" : "";
    if (!d) return;
    selected = d.id;

    app.classList.toggle("offline", !d.online);
    app.dataset.power = d.power ? "on" : "off";
    const st = $("#status");
    st.textContent = d.online ? (d.via.includes("matter") ? "Online" : "Online via MirAIe") : "Offline";
    st.className = `status ${d.online ? "online" : "offline"}`;

    const banner = $("#banner");
    if (!d.online) {
        banner.dataset.kind = "device";
        banner.textContent = `${d.name} isn't responding. Check that it's plugged in and connected to Wi-Fi; the controls will work again as soon as it's back.`;
        banner.hidden = false;
    } else if (banner.dataset.kind === "device") banner.hidden = true;

    // Dial
    const mode = d.power ? MODE[d.mode] ?? MODE.cool : null;
    document.documentElement.style.setProperty("--accent", mode ? mode.color : "var(--off)");
    const chip = $("#mode-chip");
    chip.innerHTML = `${icon(mode ? mode.icon : "power")}<span>${mode ? mode.label : "Off"}</span>`;
    const t = pendingTemp ?? d.targetTemp;
    $("#target").innerHTML = `${fmtTemp(t)}<sup>°</sup>`;
    $("#dial-caption").textContent = d.mode === "fan" && d.power ? "Fan only" : "Temperature";
    $("#minus").disabled = !d.online || t == null || t <= d.minTemp;
    $("#plus").disabled = !d.online || t == null || t >= d.maxTemp;
    const dial = $("#dial");
    dial.setAttribute("aria-valuemin", d.minTemp);
    dial.setAttribute("aria-valuemax", d.maxTemp);
    dial.setAttribute("aria-valuenow", t ?? "");
    dial.setAttribute("aria-valuetext", t == null ? "unknown" : `${fmtTemp(t)} degrees`);
    drawArc(d, t);

    // Stats
    const stats = [];
    if (d.roomTemp != null) stats.push(["temp", `${fmtTemp(d.roomTemp)}<small>°c</small>`, "Room temperature"]);
    if (d.extras?.energyMonthKwh != null) stats.push(["bolt", `${d.extras.energyMonthKwh}<small>kWh</small>`, "Energy used this month"]);
    else if (d.humidity != null) stats.push(["drop", `${d.humidity}<small>%</small>`, "Humidity"]);
    else stats.push(["wifi", `<small>${d.online ? "Connected" : "Offline"}</small>`, "Connection"]);
    $("#stats").innerHTML = stats.map(([i, v, label]) => `<div class="stat" title="${label}"><span class="ico">${icon(i)}</span><span>${v}</span><span class="sr-only">${label}</span></div>`).join("");

    // AC card
    $("#model").textContent = [d.vendor, d.product].filter(Boolean).join(" ") || d.name;
    const pw = $("#power");
    pw.setAttribute("aria-pressed", String(!!d.power));
    pw.setAttribute("aria-label", d.power ? "Turn off" : "Turn on");
    pw.disabled = !d.online;
    $("#timer-dot").hidden = !d.offAt;
    $("#timer-note").hidden = !d.offAt;
    if (d.offAt) $("#timer-note").textContent = `Turns off at ${hhmm(d.offAt)}`;

    renderFan(d);

    renderRound($("#modes"), d.modes.map(m => ({ v: m, label: MODE[m]?.label ?? m, icon: MODE[m]?.icon ?? "auto", color: MODE[m]?.color })),
        d.power ? d.mode : null, v => send({ mode: v }, { mode: v, power: true }), !d.online, "radio");

    renderExtras(d);
    $("#swing-card").hidden = d.swing === null || !!d.extras;
    $("#swing").checked = !!d.swing;
    $("#swing").disabled = !d.online;

    $("#rename").placeholder = d.name;
    $("#device-info").textContent = [d.vendor, d.product, d.via.includes("miraie") && d.via.includes("matter") ? "(Matter and MirAIe)" : d.via.includes("miraie") ? "(via MirAIe)" : ""].filter(Boolean).join(" ");
    renderPresets();
}

// The arc: a 200° sweep from the lowest to the highest setting.
const CX = 170, CY = 168, R = 124, A0 = 190, SWEEP = 200;
const rad = a => (a * Math.PI) / 180;
const pt = (r, a) => [CX + r * Math.cos(rad(a)), CY - r * Math.sin(rad(a))];
function arcPath(r, a1, a2) {
    const [x1, y1] = pt(r, a1), [x2, y2] = pt(r, a2);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${a1 - a2 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
const angleOf = (d, t) => A0 - SWEEP * Math.min(1, Math.max(0, (t - d.minTemp) / (d.maxTemp - d.minTemp)));

function drawArc(d, t) {
    const parts = [];
    parts.push(`<path class="ring" d="${arcPath(R + 32, A0, A0 - SWEEP)}" stroke-width="1.2"/>`);
    if (d.roomTemp != null && t != null) {
        // Orange stretch on the outer ring: from the room temperature to the target.
        const a = angleOf(d, d.roomTemp), b = angleOf(d, t);
        if (Math.abs(a - b) > 0.5) parts.push(`<path class="room" d="${arcPath(R + 32, Math.max(a, b), Math.min(a, b))}" stroke-width="2" stroke-linecap="round"/>`);
    }
    parts.push(`<path class="track" d="${arcPath(R, A0, A0 - SWEEP)}" stroke-width="18" stroke-linecap="round"/>`);
    for (let v = Math.ceil(d.minTemp); v <= d.maxTemp; v++) {
        const a = angleOf(d, v);
        const [x1, y1] = pt(R - 28, a), [x2, y2] = pt(R - (v % 2 ? 23 : 20), a);
        parts.push(`<line class="tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
    }
    if (t != null) {
        const a = angleOf(d, t);
        parts.push(`<path class="prog" d="${arcPath(R, A0, Math.min(A0 - 0.01, a))}" stroke-width="18" stroke-linecap="round"/>`);
        const [tx, ty] = pt(R + 18, a);
        parts.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${fmtTemp(t)}°c</text>`);
    }
    const [lx, ly] = pt(R + 14, A0 + 2), [rx, ry] = pt(R + 14, A0 - SWEEP - 2);
    parts.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" transform="rotate(-90 ${lx.toFixed(1)} ${ly.toFixed(1)})">${d.minTemp}°c</text>`);
    parts.push(`<text x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" text-anchor="middle" transform="rotate(90 ${rx.toFixed(1)} ${ry.toFixed(1)})">${d.maxTemp}°c</text>`);
    parts.push(`<path class="hit" d="${arcPath(R, A0, A0 - SWEEP)}" stroke-width="56"/>`);
    $("#arc").innerHTML = parts.join("");
}

function renderFan(d) {
    const bar = $("#fanbar");
    const speeds = d.fans.filter(f => f !== "auto" && f !== "off");
    const hasAuto = d.fans.includes("auto");
    bar.hidden = !d.fans.length;
    bar.dataset.hasauto = String(hasAuto);
    const isAuto = d.fan === "auto";
    bar.classList.toggle("auto", isAuto);
    const range = $("#fan-range");
    range.max = Math.max(0, speeds.length - 1);
    const idx = Math.max(0, speeds.indexOf(d.fan));
    if (document.activeElement !== range) range.value = idx;
    range.disabled = !d.online;
    range.setAttribute("aria-valuetext", FAN[d.fan] ?? d.fan ?? "");
    const f = speeds.length ? (idx + 1) / speeds.length : 0;
    $("#fan-fill").style.width = isAuto ? "" : `calc(48px + (100% - ${hasAuto ? 196 : 118}px) * ${f})`;
    $("#fan-label").textContent = FAN[d.fan] ?? (d.fan ?? "");
    $("#fan-auto").setAttribute("aria-pressed", String(isAuto));
    $("#fan-auto").disabled = !d.online;
}

function renderRound(el, items, active, onPick, disabled, kind = "radio", pressed = new Set()) {
    el.replaceChildren(...items.map(it => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "mode";
        b.dataset.v = it.v;
        if (kind === "radio") { b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(it.v === active)); }
        else b.setAttribute("aria-pressed", String(pressed.has(it.v)));
        if (it.color) b.style.setProperty("--mc", it.color);
        b.innerHTML = `<span class="disc">${icon(it.icon)}</span><span>${it.label}</span>`;
        b.disabled = disabled;
        b.onclick = () => onPick(it.v);
        return b;
    }));
}

function renderExtras(d) {
    const x = d.extras;
    $("#extras").hidden = !x;
    if (!x) return;
    const items = [
        { v: "powerful", label: "Powerful", icon: "powerful", color: "var(--red)" },
        { v: "eco", label: "Eco Mode", icon: "eco", color: "var(--dry)" },
        { v: "clean", label: "Clean", icon: "clean", color: "var(--cool)" },
    ];
    if (x.display !== null) items.push({ v: "display", label: "AC Display", icon: "display", color: "var(--cool)" });
    if (x.nanoe !== null) items.push({ v: "nanoe", label: "nanoe", icon: "nanoe", color: "var(--auto)" });
    const on = new Set(items.filter(i => x[i.v]).map(i => i.v));
    renderRound($("#extra-buttons"), items, null, v => send({ [v]: !x[v] }, { extras: { ...x, [v]: !x[v] } }), !d.online, "toggle", on);
    $("#filter-alert").hidden = !x.filterAlert;
    $("#converti-row").hidden = !x.convertiSupported;
    const cv = $("#converti");
    if (!cv.options.length) cv.replaceChildren(...CONVERTI.map(([v, l]) => new Option(l, v)));
    cv.value = String(x.converti ?? 0);
    cv.disabled = !d.online;
    $("#swingv-row").hidden = x.swingV === null;
    $("#swingv").value = String(x.swingV ?? 0);
    $("#swingv").disabled = !d.online;
}

// ---------- presets ----------
function describeDays(p) {
    if (p.once) return "once";
    const days = p.days ?? [];
    if (!days.length || days.length === 7) return "every day";
    if (days.join() === "1,2,3,4,5") return "weekdays";
    if (days.join() === "0,6") return "weekends";
    return days.map(i => DAY_NAMES[i]).join(", ");
}
function describeTimes(p) {
    if (p.start && p.end) return `${p.start} to ${p.end}`;
    if (p.start) return `from ${p.start}`;
    if (p.end) return `until ${p.end}`;
    return "";
}

function renderPresets() {
    const d = current();
    const box = $("#presets");
    if (!d) { box.replaceChildren(); return; }
    const list = presetData.presets.filter(p => p.deviceId === d.id);
    const active = presetData.active[d.id];
    const cards = list.map(p => {
        const running = active?.presetId === p.id;
        const m = MODE[p.mode] ?? MODE.cool;
        const el = document.createElement("article");
        el.className = `preset${running ? " running" : ""}`;
        el.style.setProperty("--pc", m.color);
        const bits = [m.label, p.fan ? `${FAN[p.fan] ?? p.fan} fan` : null, p.special === "powerful" ? "Powerful" : p.special === "eco" ? "Eco" : null].filter(Boolean).join(", ");
        const when = running
            ? (active.until ? `Running until ${hhmm(active.until)}` : "Running")
            : [describeTimes(p), p.start ? describeDays(p) : null].filter(Boolean).join(", ") || "Start it whenever you like";
        el.innerHTML = `
            <button class="preset-top" data-edit aria-label="Edit ${escapeHtml(p.name)}"><span class="pi">${icon(m.icon)}</span><strong>${escapeHtml(p.name)}</strong></button>
            <div class="big">${p.mode === "fan" ? "Fan" : `${fmtTemp(p.targetTemp)}°`}</div>
            <div class="meta">${escapeHtml(bits)}<br>${escapeHtml(when)}</div>
            <div class="preset-foot">
              ${p.start ? `<label class="auto"><input type="checkbox" class="switch" data-sched ${p.scheduled ? "checked" : ""}> Auto</label>` : `<span></span>`}
              <button class="go${running ? " stop" : ""}" data-go>${icon(running ? "stop" : "play")}${running ? "Stop" : "Start"}</button>
            </div>`;
        el.querySelector("[data-edit]").onclick = () => openPreset(p);
        el.querySelector("[data-go]").onclick = async e => {
            e.currentTarget.disabled = true;
            try {
                presetData = await api("POST", `/api/presets/${p.id}/${running ? "stop" : "start"}`);
                toast(running ? `${p.name} stopped` : `${p.name} started`);
            } catch (err) { toast(err.message, true); }
            renderPresets();
        };
        el.querySelector("[data-sched]")?.addEventListener("change", async e => {
            try {
                await api("PUT", `/api/presets/${p.id}`, { scheduled: e.target.checked });
                toast(e.target.checked ? `${p.name} will start at ${p.start}` : `${p.name} won't start by itself`);
            } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
        });
        return el;
    });
    const add = document.createElement("button");
    add.className = "preset new";
    add.innerHTML = `<span class="disc">${icon("plus")}</span><span>New preset</span>`;
    add.onclick = () => openPreset();
    box.replaceChildren(...cards, add);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

// Preset editor
let editing = null; // the preset being edited (or a fresh draft)
function openPreset(p) {
    const d = current();
    editing = p ? { ...p } : {
        deviceId: d.id, name: "", mode: d.modes.includes("cool") ? "cool" : d.modes[0], targetTemp: 24,
        fan: d.fans.includes("auto") ? "auto" : d.fans[0] ?? null, swing: null, special: null,
        start: "", end: "", days: [], once: false, scheduled: false,
    };
    $("#preset-title").textContent = p ? "Edit preset" : "New preset";
    $("#p-name").value = editing.name;
    $("#p-device-row").hidden = devices.length < 2;
    $("#p-device").replaceChildren(...devices.map(x => new Option(x.name, x.id, false, x.id === editing.deviceId)));
    $("#p-start").value = editing.start ?? "";
    $("#p-end").value = editing.end ?? "";
    $("#p-once").checked = !!editing.once;
    $("#p-scheduled").checked = !!editing.scheduled;
    $("#p-swing").checked = !!editing.swing;
    $("#p-delete").hidden = !p;
    $("#p-error").textContent = "";
    renderEditor();
    $("#preset").showModal();
}

function renderEditor() {
    const d = devices.find(x => x.id === editing.deviceId) ?? current();
    renderRound($("#p-modes"), d.modes.map(m => ({ v: m, label: MODE[m]?.label ?? m, icon: MODE[m]?.icon, color: MODE[m]?.color })),
        editing.mode, v => { editing.mode = v; renderEditor(); }, false);
    $("#p-temp-row").hidden = editing.mode === "fan";
    $("#p-temp").textContent = `${fmtTemp(editing.targetTemp)}°`;
    chips($("#p-fans"), d.fans.filter(f => f !== "off").map(f => [f, FAN[f] ?? f]), editing.fan, v => { editing.fan = v; renderEditor(); });
    $("#p-special-row").hidden = !d.extras;
    chips($("#p-special"), [[null, "None"], ["powerful", "Powerful"], ["eco", "Eco"]], editing.special, v => { editing.special = v; renderEditor(); });
    chips($("#p-days"), DAYS.map((l, i) => [i, l]), null, v => {
        const s = new Set(editing.days); s.has(v) ? s.delete(v) : s.add(v); editing.days = [...s]; renderEditor();
    }, new Set(editing.days), DAY_NAMES);
}

function chips(el, items, active, onPick, pressed, labels) {
    el.replaceChildren(...items.map(([v, l], i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = l;
        if (labels) b.setAttribute("aria-label", labels[i]);
        b.setAttribute("aria-pressed", String(pressed ? pressed.has(v) : v === active));
        b.onclick = () => onPick(v);
        return b;
    }));
}

$("#p-minus").onclick = () => { editing.targetTemp = Math.max(16, (editing.targetTemp ?? 24) - 1); renderEditor(); };
$("#p-plus").onclick = () => { editing.targetTemp = Math.min(30, (editing.targetTemp ?? 24) + 1); renderEditor(); };
$("#p-device").onchange = e => { editing.deviceId = e.target.value; renderEditor(); };
$("#preset-form").addEventListener("submit", async e => {
    e.preventDefault();
    const body = {
        ...editing,
        name: $("#p-name").value.trim(),
        start: $("#p-start").value || null,
        end: $("#p-end").value || null,
        once: $("#p-once").checked,
        scheduled: $("#p-scheduled").checked,
        swing: $("#p-swing").checked,
    };
    delete body.id;
    $("#p-error").textContent = "";
    try {
        if (editing.id) await api("PUT", `/api/presets/${editing.id}`, body);
        else await api("POST", "/api/presets", body);
        $("#preset").close();
        toast(editing.id ? "Preset saved" : "Preset created");
    } catch (err) { $("#p-error").textContent = err.message; }
});
$("#p-delete").onclick = async () => {
    if (!editing?.id || !confirm(`Delete the preset "${editing.name}"?`)) return;
    try { await api("DELETE", `/api/presets/${editing.id}`); $("#preset").close(); toast("Preset deleted"); }
    catch (err) { $("#p-error").textContent = err.message; }
};
$("#new-preset").onclick = () => openPreset();

// ---------- controls ----------
async function send(cmd, optimistic = cmd) {
    const d = current();
    if (!d) return;
    Object.assign(d, optimistic);
    render();
    try {
        Object.assign(d, await api("POST", `/api/devices/${encodeURIComponent(d.id)}/control`, cmd));
    } catch (e) {
        toast(e.message, true);
        devices = await api("GET", "/api/devices").catch(() => devices);
    }
    render();
}

$("#device").addEventListener("change", e => { selected = e.target.value; store("acr.selected", selected); pendingTemp = null; render(); });
$("#power").addEventListener("click", () => send({ power: !current().power }, { power: !current().power }));
$("#swing").addEventListener("change", e => send({ swing: e.target.checked }));
$("#converti").addEventListener("change", e => send({ converti: Number(e.target.value) }));
$("#swingv").addEventListener("change", e => send({ swingV: Number(e.target.value) }));
$("#fan-auto").addEventListener("click", () => send({ fan: "auto" }));
$("#fan-range").addEventListener("input", e => {
    const d = current();
    const speeds = d.fans.filter(f => f !== "auto" && f !== "off");
    const v = speeds[Number(e.target.value)];
    d.fan = v; renderFan(d);
});
$("#fan-range").addEventListener("change", e => {
    const d = current();
    const v = d.fans.filter(f => f !== "auto" && f !== "off")[Number(e.target.value)];
    if (v) send({ fan: v });
});

function setPending(t) {
    const d = current();
    if (!d || d.targetTemp == null) return;
    pendingTemp = Math.min(d.maxTemp, Math.max(d.minTemp, Math.round(t)));
    render();
}
function commitTemp(delay = 600) {
    clearTimeout(tempTimer);
    tempTimer = setTimeout(async () => {
        const value = pendingTemp;
        if (value == null) return;
        await send({ targetTemp: value }, { targetTemp: value });
        if (pendingTemp === value) pendingTemp = null;
        render();
    }, delay);
}
function nudge(delta) { const d = current(); if (!d) return; setPending((pendingTemp ?? d.targetTemp) + delta); commitTemp(); }
$("#minus").addEventListener("click", () => nudge(-1));
$("#plus").addEventListener("click", () => nudge(1));
$("#dial").addEventListener("keydown", e => {
    if (["ArrowUp", "ArrowRight"].includes(e.key)) { e.preventDefault(); nudge(1); }
    if (["ArrowDown", "ArrowLeft"].includes(e.key)) { e.preventDefault(); nudge(-1); }
});

// Drag along the arc to set the temperature.
function tempFromPointer(e) {
    const d = current();
    const svg = $("#arc");
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const dist = Math.hypot(p.x - CX, p.y - CY);
    let a = (Math.atan2(CY - p.y, p.x - CX) * 180) / Math.PI;
    if (a < -90) a += 360;
    a = Math.min(A0, Math.max(A0 - SWEEP, a));
    return { dist, temp: d.minTemp + ((A0 - a) / SWEEP) * (d.maxTemp - d.minTemp) };
}
$("#dial").addEventListener("pointerdown", e => {
    const d = current();
    if (!d?.online || d.targetTemp == null) return;
    const { dist, temp } = tempFromPointer(e);
    if (dist < R - 45 || dist > R + 45) return; // only grab near the arc
    dragging = true;
    $("#dial").setPointerCapture(e.pointerId);
    clearTimeout(tempTimer);
    setPending(temp);
});
$("#dial").addEventListener("pointermove", e => { if (dragging) setPending(tempFromPointer(e).temp); });
const endDrag = () => { if (dragging) { dragging = false; commitTemp(150); } };
$("#dial").addEventListener("pointerup", endDrag);
$("#dial").addEventListener("pointercancel", endDrag);

// ---------- off timer ----------
$("#timer-btn").onclick = () => {
    const d = current();
    $("#timer-state").textContent = d.offAt ? `${d.name} turns off at ${hhmm(d.offAt)}.` : `Pick when ${d.name} should switch itself off.`;
    $("#timer-cancel").hidden = !d.offAt;
    $("#timer").showModal();
};
$("#timer-options").addEventListener("click", async e => {
    const min = Number(e.target.closest("[data-min]")?.dataset.min);
    if (!min) return;
    await send({ offTimer: min }, {});
    $("#timer").close();
    toast(`Turns off at ${hhmm(Date.now() + min * 60e3)}`);
});
$("#timer-at").addEventListener("submit", async e => {
    e.preventDefault();
    const [h, m] = $("#timer-time").value.split(":").map(Number);
    const end = new Date(); end.setHours(h, m, 0, 0);
    if (end <= new Date()) end.setDate(end.getDate() + 1);
    const min = Math.max(1, Math.round((end - Date.now()) / 60e3));
    await send({ offTimer: min }, {});
    $("#timer").close();
    toast(`Turns off at ${hhmm(end)}`);
});
$("#timer-cancel").onclick = async () => { await send({ offTimer: 0 }, {}); $("#timer").close(); toast("Timer cancelled"); };

// ---------- sheets ----------
document.addEventListener("click", e => {
    const id = e.target.closest("[data-open]")?.dataset.open;
    if (!id) return;
    document.querySelectorAll("dialog[open]").forEach(dl => dl.close());
    openSheet(id);
});
$("#open-settings").addEventListener("click", () => openSheet("settings"));

function openSheet(id) {
    if (id === "pair") {
        $("#pair-error").textContent = "";
        $("#tab-ble").hidden = !status.bluetooth;
        if (!status.bluetooth) selectTab("share");
    }
    if (id === "settings") {
        $("#lan").replaceChildren(...(status.lanUrls ?? []).map(u => {
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = u; a.textContent = u;
            li.append(a);
            return li;
        }));
        $("#remote-help").textContent = status.remoteUrl
            ? `Anywhere (with Tailscale on in your phone): ${status.remoteUrl}`
            : 'Away from home: run "Set up remote access" on the PC, then use the address it gives you.';
        $("#version").textContent = `AC Remote ${status.version ?? ""}${window.ACRemoteApp ? ` (app ${window.ACRemoteApp.version()})` : ""}`;
        $("#set-app").hidden = !window.ACRemoteApp;
        $("#pin-error").textContent = "";
        loadMiraie();
    }
    $(`#${id}`).showModal();
}

function selectTab(which) {
    const ble = which === "ble";
    $("#tab-share").setAttribute("aria-selected", String(!ble));
    $("#tab-ble").setAttribute("aria-selected", String(ble));
    $("#pane-share").hidden = ble;
    $("#pane-ble").hidden = !ble;
    $("#ssid").required = ble;
}
$("#tab-share").addEventListener("click", () => selectTab("share"));
$("#tab-ble").addEventListener("click", () => selectTab("ble"));

$("#pair-form").addEventListener("submit", async e => {
    e.preventDefault();
    if (pairBusy) return;
    const ble = !$("#pane-ble").hidden;
    const body = { code: $("#code").value };
    if (ble) { body.wifiSsid = $("#ssid").value.trim(); body.wifiPassword = $("#wifipass").value; }
    $("#pair-error").textContent = "";
    $("#pair-btn").disabled = true;
    $("#pair-progress").hidden = false;
    try {
        const d = await api("POST", "/api/devices/pair", body);
        selected = d.id;
        store("acr.selected", selected);
        $("#pair").close();
        $("#code").value = $("#wifipass").value = "";
        toast(`${d.name} paired`);
    } catch (err) {
        $("#pair-error").textContent = err.message;
    } finally {
        $("#pair-btn").disabled = false;
        $("#pair-progress").hidden = true;
    }
});

// MirAIe link
async function loadMiraie() {
    let m;
    try { m = await api("GET", "/api/miraie"); } catch { return; }
    $("#mir-off").hidden = m.linked;
    $("#mir-on").hidden = !m.linked;
    $("#mir-error").textContent = "";
    if (!m.linked) return;
    $("#mir-state").textContent = m.error
        ? `Linked as ${m.account}, but MirAIe isn't reachable right now: ${m.error}`
        : `Linked as ${m.account}. ${m.devices.length} AC${m.devices.length === 1 ? "" : "s"} found${m.connected ? "" : "; connecting…"}.`;
    $("#mir-links").replaceChildren(...m.devices.filter(() => m.matterDevices.length).map(md => {
        const l = document.createElement("label");
        l.textContent = `${md.name}${md.room ? ` (${md.room})` : ""} is the same AC as`;
        const s = document.createElement("select");
        s.append(new Option("Not paired with Matter", ""), ...m.matterDevices.map(x => new Option(x.name, x.id, false, x.id === md.linkedTo)));
        s.value = md.linkedTo ?? "";
        s.onchange = async () => { try { await api("POST", "/api/miraie/link", { miraieId: md.id, matterId: s.value || null }); toast("Saved"); } catch (err) { toast(err.message, true); } };
        l.append(s);
        return l;
    }));
}
$("#mir-form").addEventListener("submit", async e => {
    e.preventDefault();
    $("#mir-btn").disabled = true;
    $("#mir-error").textContent = "";
    try {
        await api("POST", "/api/miraie", { username: $("#mir-user").value, password: $("#mir-pass").value });
        $("#mir-pass").value = "";
        toast("MirAIe linked");
        loadMiraie();
    } catch (err) { $("#mir-error").textContent = err.message; }
    $("#mir-btn").disabled = false;
});
$("#mir-unlink").onclick = async () => {
    if (!confirm("Unlink MirAIe? The Panasonic features and energy use will disappear from AC Remote. Matter control keeps working.")) return;
    await api("DELETE", "/api/miraie").catch(err => toast(err.message, true));
    loadMiraie();
};

$("#rename-form").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#rename").value.trim();
    if (!name) return;
    await send({ name }, { name });
    $("#rename").value = "";
    toast("Renamed");
});

$("#remove").addEventListener("click", async () => {
    const d = current();
    if (!d || !confirm(`Remove ${d.name} from AC Remote? You'll need a new pairing code to add it back. It stays in any other app it's paired with.`)) return;
    try {
        await api("DELETE", `/api/devices/${encodeURIComponent(d.id)}`);
        $("#settings").close();
        toast(`${d.name} removed`);
    } catch (err) { toast(err.message, true); }
});

$("#pin-form").addEventListener("submit", async e => {
    e.preventDefault();
    $("#pin-error").textContent = "";
    try {
        await api("POST", "/api/pin", { current: $("#pin-cur").value, next: $("#pin-new").value, signOutOthers: $("#pin-out").checked });
        e.target.reset();
        toast("PIN changed");
    } catch (err) { $("#pin-error").textContent = err.message; }
});

$("#logout").addEventListener("click", async () => {
    await api("POST", "/api/logout").catch(() => {});
    $("#settings").close();
    status = await api("GET", "/api/status").catch(() => status);
    showGate();
});

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
