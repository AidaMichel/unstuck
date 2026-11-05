// Preloaded with --require: records (and blocks) every outbound network attempt.
const fs = require("node:fs");
const out = process.env.NET_LOG;
const note = (what) => { if (out) fs.appendFileSync(out, what + "\n"); };
const block = (what) => { note(what); throw new Error(`network blocked in test: ${what}`); };
globalThis.fetch = async (u) => block(`fetch ${u}`);
for (const mod of ["http", "https"]) {
  const m = require(`node:${mod}`);
  m.request = (u) => block(`${mod}.request ${typeof u === "string" ? u : u?.host ?? u?.hostname}`);
  m.get = m.request;
}
const net = require("node:net");
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const o = typeof a[0] === "object" ? a[0] : { port: a[0], host: a[1] };
  if (o && o.path) return origConnect.apply(this, a); // local IPC sockets are fine
  block(`net.connect ${o?.host ?? "?"}:${o?.port ?? "?"}`);
};
