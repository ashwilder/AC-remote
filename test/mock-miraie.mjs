// TEST-ONLY stand-in for Panasonic's MirAIe cloud: login, homes, status, energy and the MQTT channel.
// Usage: node test/mock-miraie.mjs   (HTTP on 8790, MQTT on 1884)
// Then start the app with MIRAIE_AUTH_URL=http://localhost:8790 MIRAIE_APP_URL=http://localhost:8790 MIRAIE_MQTT_URL=mqtt://localhost:1884
// Login: mobile 9876543210, password test1234
import http from "node:http";
import net from "node:net";
import { Aedes } from "aedes";

const TOKEN = "mock-token-1";
const HOME = "home-1";
const DEV = "dev-1";
const BASE = "u1/h1/dev1";
const state = {
    ty: "AC", onlineStatus: "true", ps: "on", acmd: "cool", actmp: "24.0", rmtmp: "28", acfs: "auto",
    acvs: 0, achs: 0, acdc: "on", acpm: "off", acem: "off", acec: "off", cnv: 0, acng: "off", acfc: "off", rssi: -55,
};

const broker = await Aedes.createBroker({
    authenticate: (client, username, password, done) => done(null, username === HOME && String(password) === TOKEN),
});
broker.on("publish", (packet, client) => {
    if (!client || packet.topic !== `${BASE}/control`) return;
    const msg = JSON.parse(packet.payload.toString());
    for (const k of ["ki", "cnt", "sid"]) delete msg[k];
    Object.assign(state, Object.fromEntries(Object.entries(msg).map(([k, v]) => [k, typeof v === "number" && k === "actmp" ? String(v) : v])));
    console.log("[mock-miraie] control", JSON.stringify(msg));
    setTimeout(() => broker.publish({ topic: `${BASE}/status`, payload: Buffer.from(JSON.stringify(msg)), qos: 0, retain: false }, () => {}), 150);
});
net.createServer(broker.handle).listen(1884, () => console.log("[mock-miraie] MQTT on 1884"));

http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/simplifi/v1/userManagement/login") {
        const b = JSON.parse(body || "{}");
        const ok = (b.mobile === "+919876543210" || b.mobile === "9876543210") && b.password === "test1234" && b.clientId;
        return ok ? json(200, { accessToken: TOKEN, refreshToken: "r", userId: "user-1", expiresIn: 86400 }) : json(401, { message: "Invalid credentials" });
    }
    if (!authed) return json(401, { message: "Unauthorized" });
    if (url.pathname === "/simplifi/v1/homeManagement/homes") {
        return json(200, [{ homeId: HOME, spaces: [{ spaceName: "Bedroom", devices: [{ deviceId: DEV, deviceName: "Ash AC", topic: [BASE] }] }] }]);
    }
    if (url.pathname.startsWith("/simplifi/v1/deviceManagement/devices/deviceId/")) {
        return json(200, [{ deviceId: DEV, modelName: "CS-NU18ZKY5W", brand: "Panasonic", firmwareVersion: "2.10" }]);
    }
    if (url.pathname === `/simplifi/v1/deviceManagement/devices/${DEV}/mobile/status`) return json(200, state);
    if (url.pathname === `/simplifi/v1/powerConsumption/devices/${DEV}`) {
        const m = url.searchParams.get("startDate");
        return json(200, [{ month: m, power: 64.2 }]);
    }
    json(404, { message: "not found" });
}).listen(8790, () => console.log("[mock-miraie] HTTP on 8790"));
