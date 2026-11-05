// Preload for scripts/test-golden-trajectories.js: the booted paid server buys
// from a stub seller ecosystem on this host and nothing else.
//
//   node --import ./scripts/lib/golden-preload.js src/server.js
//
// - Every host under `.golden.test` is a stub seller: its name resolves to a
//   public-looking address (so the probe's address check reads it as public)
//   and every request to it is carried to GOLDEN_SELLER_PORT on loopback with
//   the host in `x-golden-host`. Any other outside host is refused (offline
//   preload) and counted.
// - The buyer's address guard is off for this process (its own test seam).
// - The trajectory seam in src/tools/route-execute.js is set, and a control
//   server on loopback (port written to GOLDEN_CTL_FILE) answers what the run
//   recorded: the steps for a task, the payer's held exposure, the unproven
//   lane's per-seller spend and the delivery memo.
import "../offline-egress-preload.js";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const SUFFIX = ".golden.test";
const PUBLIC_STAND_IN = "93.184.215.14";
const SELLER_PORT = Number(process.env.GOLDEN_SELLER_PORT);
if (!SELLER_PORT) throw new Error("golden preload: GOLDEN_SELLER_PORT is required");
const isGolden = (h) => String(h || "").toLowerCase().endsWith(SUFFIX);
const egress = [];

const require = createRequire(import.meta.url);
const dns = require("node:dns");
const dnsp = require("node:dns/promises");
const offP = dnsp.lookup, offCb = dns.lookup;
dnsp.lookup = (h, o) => (isGolden(h) ? Promise.resolve(o?.all ? [{ address: PUBLIC_STAND_IN, family: 4 }] : { address: PUBLIC_STAND_IN, family: 4 }) : offP(h, o));
dns.lookup = (h, o, cb) => {
  if (typeof o === "function") { cb = o; o = {}; }
  if (isGolden(h)) return process.nextTick(cb, null, o?.all ? [{ address: PUBLIC_STAND_IN, family: 4 }] : PUBLIC_STAND_IN, 4);
  return offCb(h, o, cb);
};
syncBuiltinESMExports();

const offlineFetch = globalThis.fetch;
globalThis.fetch = function goldenFetch(input, init = {}) {
  let url;
  try { url = new URL(typeof input === "string" ? input : input?.url || String(input)); } catch { return offlineFetch.call(this, input, init); }
  if (isGolden(url.hostname)) {
    const { dispatcher, ...rest } = init || {};
    const headers = new Headers(rest.headers || {});
    headers.set("x-golden-host", url.hostname.toLowerCase());
    return offlineFetch.call(this, `http://127.0.0.1:${SELLER_PORT}${url.pathname}${url.search}`, { ...rest, headers, redirect: "manual" });
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) egress.push(url.hostname);
  return offlineFetch.call(this, input, init);
};

const { __setBuyerAddressGuardForTest } = await import("../../src/x402-buyer.js");
__setBuyerAddressGuardForTest(false);

const steps = new Map(); // task id -> [{ step, ...data }]
const { setTrajectoryListenerForTest } = await import("../../src/tools/route-execute.js");
setTrajectoryListenerForTest((req, step, data) => {
  const id = String(req?.headers?.["x-golden-task"] || "");
  if (!id) return;
  if (!steps.has(id)) steps.set(id, []);
  steps.get(id).push({ step, ...JSON.parse(JSON.stringify(data)) });
});

const ctl = createServer(async (req, res) => {
  const u = new URL(req.url, "http://ctl");
  const send = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    if (u.pathname === "/steps") return send(steps.get(u.searchParams.get("task")) || []);
    if (u.pathname === "/egress") return send({ hosts: egress });
    if (u.pathname === "/state") {
      const { exposureSnapshot } = await import("../../src/external-spend-guard.js");
      const { unprovenSellerSpentUsd } = await import("../../src/base-unproven.js");
      const { sellerDeliveryMemoEntries } = await import("../../src/x402-buyer.js");
      const payer = String(u.searchParams.get("payer") || "").toLowerCase();
      const row = exposureSnapshot().find((r) => String(r.payer).toLowerCase() === payer);
      const unproven = {};
      for (const s of u.searchParams.getAll("seller")) {
        const [origin, payTo] = s.split("|");
        unproven[origin] = await unprovenSellerSpentUsd({ origin, payTo });
      }
      return send({ exposureUsd: row ? row.unsettledUsd : 0, unproven, delivery: sellerDeliveryMemoEntries().map((e) => ({ origin: e.origin, strikes: e.strikes, actionable: e.actionable })) });
    }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(String(e?.message || e)); }
});
ctl.listen(0, "127.0.0.1", () => {
  if (process.env.GOLDEN_CTL_FILE) writeFileSync(process.env.GOLDEN_CTL_FILE, String(ctl.address().port));
});
ctl.unref();
