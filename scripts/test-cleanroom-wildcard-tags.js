// Behavior test written from cleanroom spec 47: every 402 listing's tags pass
// the x402 v2 ResourceInfo schema (at most five), lead with the category, and
// the non-catalog wildcard routes carry their own sanitized tag list.
// Boots the paid-mode server against a local /supported stub (port 0 for both).
import "./lib/offline-stores.js";
import { createServer } from "node:http";
import { bootServer } from "./lib/boot-server.js";
import { ResourceInfoSchema } from "@x402/core/schemas";

const stub = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url === "/supported") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }));
    } else { res.writeHead(404); res.end(); }
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

const srv = await bootServer({
  stores: "cleanroom-wildcard-tags",
  env: {
    FREE_MODE: "", NODE_ENV: "test",
    NETWORK: "base", PAYMENT_NETWORKS: "base",
    WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    FACILITATOR_URL: `http://127.0.0.1:${stubPort}`,
    CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
    FREE_ALERTS: "off", FOLLOWUPS: "off", STATS_ALLOW_EPHEMERAL: "true",
  },
});

let passed = 0, failed = 0;
const check = (cond, label) => { if (cond) passed++; else { failed++; console.error(`FAIL - ${label}`); } };
const base = srv.url;
const challenge = async (method, path) => {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify({ value: 1 }) : undefined });
  await res.text();
  const header = res.headers.get("payment-required") || "";
  return { status: res.status, pr: header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null };
};

try {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error("server did not boot");

  for (const [method, path] of [["GET", "/api/convert/miles-to-kilometers?value=1"], ["POST", "/api/convert-miles-to-kilometers"]]) {
    const { status, pr } = await challenge(method, path);
    check(status === 402 && pr, `${method} ${path}: answers 402 with a challenge (got ${status})`);
    const tags = pr?.resource?.tags;
    check(JSON.stringify(tags) === JSON.stringify(["convert", "agents", "x402", "tools"]), `${method} ${path}: wildcard tags are category then agents, x402, tools (got ${JSON.stringify(tags)})`);
    check(ResourceInfoSchema.safeParse(pr?.resource).success, `${method} ${path}: resource passes ResourceInfoSchema`);
  }

  const pricing = await (await fetch(`${base}/api/pricing`)).json();
  const hash = (pricing.endpoints || []).find((e) => e.path === "/api/hash");
  const { status, pr } = await challenge(String(hash?.method || "GET").toUpperCase(), "/api/hash?text=a");
  const tags = pr?.resource?.tags || [];
  check(status === 402, `/api/hash answers 402 (got ${status})`);
  check(tags.length >= 1 && tags.length <= 5 && tags[0] === hash?.category, `/api/hash tags: 1..5 led by its category (got ${JSON.stringify(tags)})`);
  check(tags.every((t) => typeof t === "string" && t.length <= 32 && /^[\x20-\x7e]+$/.test(t)), "/api/hash tags are printable ASCII of at most 32 characters");
  check(new Set(tags.map((t) => t.toLowerCase())).size === tags.length, "/api/hash tags are unique ignoring case");
  check(ResourceInfoSchema.safeParse(pr?.resource).success, "/api/hash resource passes ResourceInfoSchema");
} catch (e) {
  failed++; console.error(`FAIL - ${e?.message || e}`);
} finally {
  await srv.stop();
  await new Promise((r) => stub.close(r));
}
console.log(`${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
