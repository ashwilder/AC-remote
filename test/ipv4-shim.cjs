// TEST-ONLY shim: the build sandbox has no IPv6, but matter.js always opens IPv6 sockets.
// IPv6 UDP sockets become inert stand-ins (they "bind" without touching the network and drop
// everything sent to IPv6 addresses), so all real traffic flows over the IPv4 sockets.
// Never loaded by the real app; real Windows PCs have IPv6.
const dgram = require("node:dgram");
const orig = dgram.createSocket;
const isV6 = a => typeof a === "string" && a.includes(":");
dgram.createSocket = function (opts, cb) {
    const o = typeof opts === "string" ? { type: opts } : { ...opts };
    if (o.type !== "udp6") return orig.call(this, opts, cb);
    o.type = "udp4";
    delete o.ipv6Only;
    const s = orig.call(this, o, cb);
    let port = 0;
    s.bind = (...args) => {
        const cbk = args.find(a => typeof a === "function");
        const req = typeof args[0] === "object" && args[0] ? args[0].port : args[0];
        port = typeof req === "number" && req > 0 ? req : 40000 + Math.floor(Math.random() * 20000);
        process.nextTick(() => { s.emit("listening"); cbk?.(); });
        return s;
    };
    s.address = () => ({ address: "::", family: "IPv6", port });
    for (const m of ["addMembership", "dropMembership", "setMulticastInterface", "setBroadcast",
                     "setMulticastTTL", "setMulticastLoopback", "setTTL", "setRecvBufferSize", "setSendBufferSize"]) {
        s[m] = () => undefined;
    }
    s.send = (...a) => {
        const cbk = typeof a[a.length - 1] === "function" ? a[a.length - 1] : undefined;
        process.nextTick(() => cbk?.(null, 0));
    };
    const close = s.close.bind(s);
    s.close = cbk => { process.nextTick(() => { s.emit("close"); cbk?.(); }); };
    void close;
    return s;
};
