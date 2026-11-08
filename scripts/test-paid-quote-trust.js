#!/usr/bin/env node
// Paid-quote trust (src/paid-quote-trust.js): a client address that completed
// a settled paid call is not held to the unpaid-quote limiters for
// PAID_QUOTE_TRUST_MINUTES after its last such call.
//
// A stock x402 client fetches an unpaid quote before every paid call, so the
// metered quote limiter (METERED_UNPAID_QUOTES_PER_MIN a minute per address)
// capped a paying buyer near that many paid calls a minute. Pinned here:
//
//   pure half: the window (trusted inside it, expired after it, slid by each
//   new mark), the key cap, the shared store read on a miss (and its answer
//   held), a store that fails or throws reads as not trusted, the counts are
//   bucketed and carry no key, paidAndSettled reads only a settled final 200
//   (not a 4xx, a refused settle, a replay, an allowance grant), and the
//   unpaid price-check budget skips a trusted address while still counting
//   an untrusted one and one whose store read fails;
//
//   booted half, on a real paid server with a stub facilitator: an address
//   that paid gets its 61st (and 70th) metered quote in a minute answered,
//   not 429; an address that only made a free proof-of-work call, or whose
//   paid call ended in a 4xx, is still refused at the 61st; a payment header
//   that does not verify still counts against its own budget from a trusted
//   address; the operator read carries bucketed counts only.
//
// The cross-replica half (a mark on one process read on another through
// Redis) is in scripts/test-shared-limits-crossprocess.js.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePorts } from "./lib/free-port.js";
import { ownStoreEnv } from "./lib/own-stores.js";

const POW_SECRET = "test-paid-quote-trust-secret";
process.env.POW_SECRET = POW_SECRET;

const {
  PAID_QUOTE_TRUST_MINUTES, PAID_QUOTE_TRUST_MS, PAID_QUOTE_TRUST_NEGATIVE_MS, createPaidQuoteTrust, paidAndSettled, trustBucket,
} = await import("../src/paid-quote-trust.js");
const { createUnpaidQuoteBudget, METERED_UNPAID_QUOTES_PER_MIN, METERED_UNPAID_QUOTES_PER_HOUR, PAID_CLIENT_QUOTE_MULTIPLIER, PAID_CLIENT_METERED_QUOTES_PER_MIN, PAID_CLIENT_METERED_QUOTES_PER_HOUR, quoteKeyDigest } = await import("../src/unpaid-quote-budget.js");
const { ALLOWANCE_STATE } = await import("../src/allowance-state.js");

let pass = 0;
const procs = [];
const dirs = [];
let facilitator = null;
const cleanup = () => {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  try { facilitator?.close(); } catch { /* closed */ }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
};
const fail = (m) => { console.error("FAIL:", m); for (const p of procs) if (p.__log) console.error(p.__log.slice(-2000)); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure half ---------------------------------------------------------------
ok(PAID_QUOTE_TRUST_MINUTES === 10 && PAID_QUOTE_TRUST_MS === 600_000, "the trust window is ten minutes");

// A fake shared store: a flag map with expiry, and switches to make it fail.
function fakeStore() {
  const flags = new Map();
  const s = {
    mode: "redis", down: false, throws: false, reads: 0,
    async flagSet(name, key, until) { if (s.down) return { ok: false, error: "down" }; if (s.throws) throw new Error("boom"); flags.set(`${name}:${key}`, until); return { ok: true }; },
    async flagGet(name, key, { now } = {}) {
      s.reads++;
      if (s.throws) throw new Error("boom");
      if (s.down) return { ok: false, error: "down" };
      const u = flags.get(`${name}:${key}`) || 0;
      return { ok: true, until: u > now ? u : 0 };
    },
    keys: () => [...flags.keys()],
  };
  return s;
}
{
  let t = 1_000_000;
  const store = fakeStore();
  const q = createPaidQuoteTrust({ store, now: () => t });
  ok(!q.trustedLocal("203.0.113.1") && !(await q.trusted("203.0.113.1")), "an address that never paid is not trusted");
  q.mark("203.0.113.1");
  ok(q.trustedLocal("203.0.113.1") && (await q.trusted("203.0.113.1")), "a paid address is trusted at once");
  t += PAID_QUOTE_TRUST_MS - 1;
  ok(q.trustedLocal("203.0.113.1"), "still trusted one millisecond before the window ends");
  t += 1;
  ok(!q.trustedLocal("203.0.113.1"), "the trust expires when the window ends");
  // Sliding: a new paid call restarts the window.
  q.mark("203.0.113.2");
  t += 9 * 60_000;
  q.mark("203.0.113.2");
  t += 9 * 60_000;
  ok(q.trustedLocal("203.0.113.2"), "each paid call slides the window (18 minutes after the first, 9 after the last)");
  t += 60_000;
  ok(!q.trustedLocal("203.0.113.2"), "and it ends ten minutes after the last paid call");
  ok(store.keys().every((k) => !k.includes("203.0.113")), "the shared store is keyed by a digest, never the address");
  // The digest is a keyed HMAC: a plain sha256 of an IPv4 address is
  // reversed by walking the 2^32 space.
  const plain = createHash("sha256").update("203.0.113.1").digest("hex").slice(0, 32);
  ok(store.keys().every((k) => !k.includes(plain)), "the shared store key is not a plain hash of the address");
  ok(store.keys().some((k) => k.endsWith(`:${quoteKeyDigest("203.0.113.1")}`)), "it is the keyed digest (quoteKeyDigest)");
  ok(quoteKeyDigest("203.0.113.1", { POW_SECRET: "one" }) !== quoteKeyDigest("203.0.113.1", { POW_SECRET: "two" }) && quoteKeyDigest("203.0.113.1", { POW_SECRET: "one" }) === quoteKeyDigest("203.0.113.1", { POW_SECRET: "one" }), "the digest depends on the server's secret and is stable under it (every replica reads the same key)");
  ok(quoteKeyDigest("203.0.113.1", { HANGUP_FORGIVE_SALT: "s", POW_SECRET: "one" }) === quoteKeyDigest("203.0.113.1", { HANGUP_FORGIVE_SALT: "s", POW_SECRET: "two" }), "the secret follows the hang-up digest's order (HANGUP_FORGIVE_SALT first)");
}
// Another replica: no local record, the shared flag is read on a miss; a
// negative answer is held so a refused flood is not a flood of store reads.
{
  let t = 2_000_000;
  const store = fakeStore();
  const a = createPaidQuoteTrust({ store, now: () => t });
  const b = createPaidQuoteTrust({ store, now: () => t });
  a.mark("198.51.100.7");
  await sleep(0);
  ok(!b.trustedLocal("198.51.100.7"), "a mark on one replica is not in another's local record");
  ok(await b.trusted("198.51.100.7"), "but the other replica reads it from the shared store");
  ok(b.trustedLocal("198.51.100.7"), "and keeps the answer locally");
  const before = store.reads;
  ok(!(await b.trusted("198.51.100.8")) && !(await b.trusted("198.51.100.8")) && store.reads === before + 1, `a not-trusted answer is held for a moment (store reads ${store.reads - before} for two lookups)`);
  t += PAID_QUOTE_TRUST_NEGATIVE_MS + 1;
  a.mark("198.51.100.8");
  await sleep(0);
  ok(await b.trusted("198.51.100.8"), "after the hold the store is read again");
  t += PAID_QUOTE_TRUST_MS + 1;
  ok(!(await b.trusted("198.51.100.7")), "the shared flag expires with the window too");
}
// The store down: not trusted, never a throw.
{
  let t = 3_000_000;
  const down = fakeStore(); down.down = true;
  const a = createPaidQuoteTrust({ store: down, now: () => t });
  const b = createPaidQuoteTrust({ store: down, now: () => t });
  a.mark("192.0.2.9");
  ok(!(await b.trusted("192.0.2.9")), "with the shared store down, another replica reads not trusted (limits normally)");
  const throws = fakeStore(); throws.throws = true;
  const c = createPaidQuoteTrust({ store: throws, now: () => t });
  let threw = false;
  try { c.mark("192.0.2.10"); ok(!(await createPaidQuoteTrust({ store: throws, now: () => t }).trusted("192.0.2.10")), "a store that throws reads as not trusted"); } catch { threw = true; }
  ok(!threw, "a store that throws never throws to the caller");
  const none = createPaidQuoteTrust({ store: null, now: () => t });
  ok(!(await none.trusted("192.0.2.11")), "with no store at all an unmarked address is not trusted");
}
// Bounded: the cap holds, oldest marked dropped first.
{
  let t = 4_000_000;
  const q = createPaidQuoteTrust({ store: null, keyCap: 3, now: () => t });
  for (let i = 1; i <= 5; i++) q.mark(`10.0.0.${i}`);
  ok(q._size() === 3 && !q.trustedLocal("10.0.0.1") && q.trustedLocal("10.0.0.5"), `the local record holds at most keyCap addresses, oldest dropped (${q._size()})`);
}
// Counts only, bucketed.
{
  ok(trustBucket(0) === "0" && trustBucket(3) === "1-9" && trustBucket(42) === "10-99" && trustBucket(500) === "100-999" && trustBucket(12345) === "1000+", "counts are reported in buckets");
  let t = 5_000_000;
  const q = createPaidQuoteTrust({ store: fakeStore(), now: () => t });
  for (let i = 0; i < 12; i++) q.mark(`172.16.0.${i}`);
  const s = q.stats();
  ok(s.trustedAddressesThisReplica === "10-99" && s.windowMinutes === 10, `the stats bucket the trusted count (${JSON.stringify(s)})`);
  ok(!/172\.16/.test(JSON.stringify(s)), "and carry no address");
}
// paidAndSettled: only a settled (or debited) final 200.
{
  const receipt = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const res = (status, headers = {}) => ({ statusCode: status, getHeader: (k) => headers[String(k).toLowerCase()] });
  ok(paidAndSettled({}, res(200, { "payment-response": receipt({ success: true, transaction: "0x1" }) })), "a 200 with a successful x402 receipt is paid");
  ok(paidAndSettled({}, res(200, { "payment-receipt": "mpp-receipt" })), "a 200 with an MPP or Tempo receipt is paid");
  ok(paidAndSettled({ creditsSettled: true }, res(200)), "a 200 debited from credits is paid");
  ok(paidAndSettled({ tempoSettled: true }, res(200)) && paidAndSettled({ stripeSettled: true }, res(200)), "a 200 settled on Tempo or a card is paid");
  ok(!paidAndSettled({}, res(200)), "a 200 with no settle evidence (a free call) is not paid");
  ok(!paidAndSettled({}, res(402, { "payment-response": receipt({ success: false }) })), "a refused settle is not paid");
  ok(!paidAndSettled({}, res(200, { "payment-response": receipt({ success: false }) })), "a receipt reporting failure is not paid");
  ok(!paidAndSettled({}, res(400, { "payment-response": receipt({ success: true }) })) && !paidAndSettled({ creditsSettled: true }, res(500)), "a 4xx or 5xx is never paid");
  ok(!paidAndSettled({}, res(200, { "payment-response": receipt({ success: true }), "x-replayed-answer": "1" })), "a replayed answer (no second settle) is not paid");
  ok(!paidAndSettled({ [ALLOWANCE_STATE]: { state: "served" } }, res(200, { "payment-response": receipt({ success: true }) })), "a first-call allowance grant is not paid");
}
// The unpaid price-check budget reads the trust.
{
  const req = (ip) => ({ method: "GET", path: "/api/uuid", ip, headers: { "user-agent": "buyer/1" }, socket: { remoteAddress: ip } });
  const mkRes = () => ({ headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, once() { return this; } });
  const drive = async (b, ip) => { const res = mkRes(); let nexted = false; await b.middleware(req(ip), res, () => { nexted = true; }); return { nexted, code: res.code }; };
  const store = fakeStore();
  const trust = createPaidQuoteTrust({ store });
  const b = createUnpaidQuoteBudget({ budget: 2, isPriced: () => true, replicas: 1, paidTrust: trust, log: () => {} });
  for (let i = 0; i < 2; i++) await drive(b, "203.0.113.50");
  ok((await drive(b, "203.0.113.50")).code === 429, "control: an untrusted address is refused past the budget");
  trust.mark("203.0.113.51");
  const got = [];
  const raised = 2 * PAID_CLIENT_QUOTE_MULTIPLIER;
  for (let i = 0; i < raised; i++) got.push((await drive(b, "203.0.113.51")).nexted);
  ok(PAID_CLIENT_QUOTE_MULTIPLIER === 10 && got.every(Boolean), `a trusted address is served past the price-check budget, up to ${PAID_CLIENT_QUOTE_MULTIPLIER} times it (${got.filter(Boolean).length} of ${raised})`);
  const over = await drive(b, "203.0.113.51");
  ok(over.code === 429 && !over.nexted, `and is refused past the raised ceiling: trust raises the cap, never lifts it (got ${over.code})`);
  // Trusted on another replica: read on the refusal path.
  const other = createPaidQuoteTrust({ store });
  other.mark("203.0.113.52");
  await sleep(0);
  const b2 = createUnpaidQuoteBudget({ budget: 1, isPriced: () => true, replicas: 1, paidTrust: createPaidQuoteTrust({ store }), log: () => {} });
  await drive(b2, "203.0.113.52");
  ok((await drive(b2, "203.0.113.52")).nexted, "an address trusted on another replica passes where it would be refused");
  const seen2 = [];
  for (let i = 0; i < PAID_CLIENT_QUOTE_MULTIPLIER + 2; i++) seen2.push((await drive(b2, "203.0.113.52")).code ?? 200);
  ok(seen2.includes(429), `and it too reads against the raised ceiling (statuses ${[...new Set(seen2)].join(",")})`);
  const downStore = fakeStore(); downStore.down = true;
  const b3 = createUnpaidQuoteBudget({ budget: 1, isPriced: () => true, replicas: 1, paidTrust: createPaidQuoteTrust({ store: downStore }), log: () => {} });
  createPaidQuoteTrust({ store: downStore }).mark("203.0.113.53");
  await drive(b3, "203.0.113.53");
  ok((await drive(b3, "203.0.113.53")).code === 429, "with the store down the budget limits normally");
}

// The buying-at-volume guide and its wiki page quote the window the code enforces.
{
  const { guidePage } = await import("../src/guides.js");
  const { readFileSync } = await import("node:fs");
  const html = String(guidePage("https://x.test", "buying-at-volume") || "").replace(/\s+/g, " ");
  const phrase = `${PAID_QUOTE_TRUST_MINUTES} minutes after each paid call`;
  const ceiling = `${PAID_CLIENT_METERED_QUOTES_PER_MIN} a minute and ${PAID_CLIENT_METERED_QUOTES_PER_HOUR.toLocaleString("en-US")} an hour for ${phrase}`;
  ok(html.includes(ceiling), `the guide quotes the raised ceiling: ${ceiling}`);
  ok(!html.includes("not limited for") && !html.includes("not counted for"), "and never says a paid address is not limited");
  const wiki = readFileSync(new URL("../wiki/Buying-at-Volume.md", import.meta.url), "utf8");
  const wikiCeiling = `${PAID_CLIENT_METERED_QUOTES_PER_MIN} a minute and ${PAID_CLIENT_METERED_QUOTES_PER_HOUR.toLocaleString("en-US")} an hour for ${phrase}`;
  ok(wiki.includes(wikiCeiling) && wiki.includes("PAID_QUOTE_TRUST_MINUTES") && wiki.includes("PAID_CLIENT_QUOTE_MULTIPLIER"), "the wiki page quotes the same ceiling and window and names their constants");
  ok(!/not limited for|not counted for/.test(wiki), "and never says a paid address is not limited");
  // The changelog entries (both files, which test-changelog-parity keeps equal) and the home monitor line.
  const changelogMd = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const changelogJs = readFileSync(new URL("../src/changelog.js", import.meta.url), "utf8");
  ok(!/not limited for|not counted for/.test(changelogMd) && !/not limited for|not counted for/.test(changelogJs), "the changelog (CHANGELOG.md and src/changelog.js) never says a paid address is not limited");
  const homeSrc = readFileSync(new URL("../src/ledger-home.js", import.meta.url), "utf8");
  ok(/emails up to \$\{MAX_FULL_PER_SUB_30D\} fresh reports in any 30 days/.test(homeSrc), "the home monitor line reads MAX_FULL_PER_SUB_30D, not a typed count");
  ok(PAID_CLIENT_METERED_QUOTES_PER_MIN === METERED_UNPAID_QUOTES_PER_MIN * 10 && PAID_CLIENT_METERED_QUOTES_PER_HOUR === METERED_UNPAID_QUOTES_PER_HOUR * 10, "the raised metered ceiling is ten times each plain figure");

  // The limits that get no paid-address raise are quoted from their own code.
  const { COMPOSITE_GUARD_LIMITS: g } = await import("../src/composite-spend-guard.js");
  const { failShareWords } = await import("../src/guides.js");
  const guardRow = `blocked for ${Math.round(g.BLOCK_MS / 60_000)} minutes at ${g.MAX_FAILS} in ${Math.round(g.WINDOW_MS / 60_000)} minutes while they are more than ${failShareWords(g.MIN_FAIL_SHARE)} of the buyer's outcomes there, or at ${g.HARD_MAX_FAILS} whatever it settled`;
  ok(g.MIN_FAIL_SHARE === 0.5 && guardRow.includes("more than half"), "the guard's share reads 'more than half' from MIN_FAIL_SHARE");
  ok(Object.isFrozen(g), "COMPOSITE_GUARD_LIMITS is frozen");
  ok(html.replace(/&#39;/g, "'").includes(guardRow), `the guide quotes the report guard: ${guardRow}`);
  ok(wiki.includes(`blocked for ${Math.round(g.BLOCK_MS / 60_000)} minutes`) && wiki.includes(`at ${g.MAX_FAILS} in ${Math.round(g.WINDOW_MS / 60_000)} minutes`) && wiki.includes(`or at ${g.HARD_MAX_FAILS} whatever it settled`), "the wiki page quotes the same report guard");
  // The large-body unpaid limiter and the guide both read UNPAID_LIMITS (no drift check needed).
  const { UNPAID_LIMITS } = await import("../src/large-body-gate.js");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/perMin:\s*LARGE_BODY_UNPAID_LIMITS\.PER_MIN,\s*perHour:\s*LARGE_BODY_UNPAID_LIMITS\.PER_HOUR/.test(server), "server.js builds the large-body unpaid limiter from UNPAID_LIMITS");
  const lbRow = `${UNPAID_LIMITS.PER_MIN} a minute and ${UNPAID_LIMITS.PER_HOUR.toLocaleString("en-US")} an hour per client address, the same once that address has paid`;
  ok(html.includes(lbRow), `the guide quotes the large-body limit with no paid raise: ${lbRow}`);
  ok(wiki.includes(`${UNPAID_LIMITS.PER_MIN} a minute, ${UNPAID_LIMITS.PER_HOUR.toLocaleString("en-US")} an hour`) && wiki.includes("no raise once the address has paid"), "the wiki page quotes the same large-body limit");
  ok(!/each one sets `Retry-After`|names its wait in <code>Retry-After/.test(html + wiki), "neither page says every limit sets Retry-After (the report guard does not)");

  // The content pipeline's job column is read from the route's async profile.
  const pipeline = String(guidePage("https://x.test", "content-pipeline") || "").replace(/\s+/g, " ");
  ok(/<td>Research report<\/td>.*?<td>yes, required<\/td>/.test(pipeline), "the research row reads 'yes, required' from the slow-sync window");
  ok(!pipeline.includes("{{jobs:"), "no jobs token is left unresolved");
}

// ---- booted half ---------------------------------------------------------------
const [PORT, FAC] = await getFreePorts(2);
let settles = 0;
const settledNonces = new Set();
facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let auth = null; try { auth = JSON.parse(body)?.paymentPayload?.payload?.authorization || null; } catch { /* ignore */ }
    const payer = auth?.from || "0x0000000000000000000000000000000000000000";
    const wellFormed = !!auth && /^0x[0-9a-f]{64}$/i.test(String(auth.nonce || "")) && /^0x[0-9a-fA-F]{40}$/.test(String(auth.from || ""));
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, wellFormed ? { isValid: true, payer } : { isValid: false, invalidReason: "malformed authorization" });
    if (req.url === "/settle") {
      settles++;
      const nonce = String(auth?.nonce || "").toLowerCase();
      if (!wellFormed || settledNonces.has(nonce)) return reply(200, { success: false, errorReason: "refused", transaction: "", network: "eip155:8453", payer });
      settledNonces.add(nonce);
      return reply(200, { success: true, transaction: "0x" + createHash("sha256").update(nonce).digest("hex"), network: "eip155:8453", payer });
    }
    if (req.url === "/rpc") return reply(200, { jsonrpc: "2.0", id: 1, result: "0x0" });
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC, "127.0.0.1", r));

const OP = "test-paid-quote-trust-operator";
const dir = mkdtempSync(join(tmpdir(), "a402-quote-trust-"));
dirs.push(dir);
const proc = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, ...ownStoreEnv("paid-quote-trust"),
    FREE_MODE: "", WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD", NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC}/rpc`, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", SOLANA_LEADERBOARD: "off",
    LEADERBOARD_FIRST_REFRESH_DELAY_MS: "3600000",
    // Only unpaid quotes reach the metered route: nothing is sent upstream.
    // The placeholder cost table prices the quote (no private rate here).
    OPENROUTER_API_KEY: "test-key-never-sent", UPSTREAM_COSTS_JSON: "", UPSTREAM_COSTS_OPTIONAL: "",
    UPSTREAM_COSTS_FILE: fileURLToPath(new URL("../docs/example-upstream-costs.json", import.meta.url)),
    SALES_LEDGER_DB: join(dir, "sales.db"), TRAFFIC_DIR: dir,
    RATE_LIMIT_REPLICAS: "1", TRUST_PROXY_HOPS: "1", POW_SECRET, POW_DIFFICULTY: "8",
    AGENT402_OPERATOR_TOKEN: OP, PORT: String(PORT),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.__log = "";
const keep = (b) => { proc.__log = (proc.__log + b.toString()).slice(-6000); };
proc.stdout.on("data", keep); proc.stderr.on("data", keep);
procs.push(proc);
const B = `http://127.0.0.1:${PORT}`;

try {
  let up = false;
  for (let i = 0; i < 180 && !up; i++) { try { up = (await fetch(`${B}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
  if (!up) fail("server never answered /health");

  const from = (ip, headers = {}) => ({ "x-forwarded-for": ip, "user-agent": "trust-test/1.0", ...headers });
  const QUOTE_BODY = JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 });
  const quote = (ip, headers = {}) => fetch(`${B}/v1/metered/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...from(ip, headers) }, body: QUOTE_BODY });
  const quotes = async (ip, n, headers) => { const got = []; for (let i = 0; i < n; i++) got.push((await quote(ip, headers)).status); return got; };
  const N = METERED_UNPAID_QUOTES_PER_MIN;

  // The paid call: an x402 exact payment against the stub facilitator.
  let nonceN = 0;
  const freshNonce = () => "0x" + (++nonceN).toString(16).padStart(64, "0");
  const acceptFor = async (ip, path) => {
    const r = await fetch(`${B}${path}`, { headers: from(ip) });
    ok(r.status === 402, `unpaid ${path} from ${ip} is a 402 (got ${r.status})`);
    const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
    return (req402.accepts || []).find((a) => a.network === "eip155:8453");
  };
  const credential = (accept, nonce, fromAddr = "0x00000000000000000000000000000000000000a1") => Buffer.from(JSON.stringify({
    x402Version: 2, resource: accept.resource, accepted: accept,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: fromAddr, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce } },
  })).toString("base64");

  // Control: an address that never paid is refused at the 61st quote.
  {
    const got = await quotes("203.0.113.10", N + 1);
    ok(got.slice(0, N).every((s) => s === 402) && got[N] === 429, `control: an address that never paid gets ${N} quotes, then a 429 (statuses ${[...new Set(got.slice(0, N))].join(",")} then ${got[N]})`);
  }
  // A paid 200, then past the limit.
  {
    const ip = "203.0.113.20";
    const accept = await acceptFor(ip, "/api/uuid");
    const s0 = settles;
    const paid = await fetch(`${B}/api/uuid`, { headers: from(ip, { "payment-signature": credential(accept, freshNonce()) }) });
    ok(paid.status === 200 && settles === s0 + 1, `the paid call settles and is served (status ${paid.status}, settles ${settles - s0})`);
    await sleep(50);
    const got = await quotes(ip, N + 10);
    ok(got.every((s) => s === 402), `after a paid 200 the address's ${N + 1}st and later quotes in a minute are answered, not 429 (statuses ${[...new Set(got)].join(",")})`);
    // Up to the raised ceiling, then a 429: trust raises the cap, never lifts it.
    const rest = await quotes(ip, PAID_CLIENT_METERED_QUOTES_PER_MIN - got.length + 1);
    const all = [...got, ...rest];
    const M = PAID_CLIENT_METERED_QUOTES_PER_MIN;
    ok(all.slice(0, M).every((s) => s === 402) && all[M] === 429, `a trusted address gets ${M} quotes in a minute (${PAID_CLIENT_QUOTE_MULTIPLIER} times ${N}), then a 429 (statuses ${[...new Set(all.slice(0, M))].join(",")} then ${all[M]})`);
    // A payment header that does not verify still counts against its own budget.
    const bad = (await acceptFor("203.0.113.21", "/api/uuid"));
    const junk = { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, resource: bad.resource, accepted: bad, payload: { signature: "0x11", authorization: { from: "nope", to: bad.payTo, value: bad.amount, validAfter: "0", validBefore: "9999999999", nonce: "0x01" } } })).toString("base64") };
    const refused = await quotes(ip, N + 1, junk);
    ok(refused.slice(0, N).every((s) => s === 402 || s === 401) && refused[N] === 429, `from a trusted address, a payment that does not verify is still refused after ${N} (statuses ${[...new Set(refused.slice(0, N))].join(",")} then ${refused[N]})`);
  }
  // A free (proof-of-work) call trusts nothing.
  {
    const ip = "203.0.113.30";
    const ch = await (await fetch(`${B}/api/pow/challenge?slug=uuid`, { headers: from(ip) })).json().catch(() => ({}));
    let solved = null;
    if (ch?.token && ch?.challenge) {
      const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
      let n = 0; while (lz(createHash("sha256").update(`${ch.challenge}:${n}`).digest()) < ch.difficulty) n++;
      solved = `${ch.token}:${n}`;
    }
    const free = solved ? await fetch(`${B}/api/uuid`, { headers: from(ip, { "x-pow-solution": solved }) }) : null;
    ok(free?.status === 200 && free.headers.get("x-pow-accepted") === "true", `a free proof-of-work call is served (status ${free?.status})`);
    const got = await quotes(ip, N + 1);
    ok(got[N] === 429, `an address that only made a free call is still refused at quote ${N + 1} (got ${got[N]})`);
  }
  // A paid call that ends in a 4xx is not charged and trusts nothing: one the
  // handler refuses (settlement canceled) and one whose settle is refused.
  {
    const ip = "203.0.113.40";
    const r0 = await fetch(`${B}/api/checksum`, { method: "POST", headers: { "content-type": "application/json", ...from(ip) }, body: "{}" });
    ok(r0.status === 402, `unpaid POST /api/checksum is a 402 (got ${r0.status})`);
    const accept = (JSON.parse(Buffer.from(r0.headers.get("payment-required"), "base64").toString("utf-8")).accepts || []).find((a) => a.network === "eip155:8453");
    const s0 = settles;
    const r = await fetch(`${B}/api/checksum`, { method: "POST", headers: { "content-type": "application/json", ...from(ip, { "payment-signature": credential(accept, freshNonce(), "0x00000000000000000000000000000000000000b2") }) }, body: "{}" });
    ok(r.status === 400 && settles === s0, `a paid call the handler refuses ends in a 400 and is not settled (status ${r.status}, settles ${settles - s0})`);
    const got = await quotes(ip, N + 1);
    ok(got[N] === 429, `an address whose paid call got a 400 is still refused at quote ${N + 1} (got ${got[N]})`);
  }
  {
    const ip = "203.0.113.41";
    const accept = await acceptFor(ip, "/api/uuid");
    // Nonce 1 is already settled: the stub refuses it at settle, as the chain would.
    const r = await fetch(`${B}/api/uuid`, { headers: from(ip, { "payment-signature": credential(accept, "0x" + "0".repeat(63) + "1", "0x00000000000000000000000000000000000000c3") }) });
    ok(r.status === 402, `a paid call whose settle is refused ends in a 402 (got ${r.status})`);
    const got = await quotes(ip, N + 1);
    ok(got[N] === 429, `an address whose settle was refused is still refused at quote ${N + 1} (got ${got[N]})`);
  }
  // The operator read: bucketed counts only.
  {
    const op = await (await fetch(`${B}/__operator/traffic.json?days=1`, { headers: { authorization: `Bearer ${OP}` } })).json();
    const t = op.paidQuoteTrust || {};
    ok(t.trustedAddressesThisReplica === "1-9" && t.windowMinutes === PAID_QUOTE_TRUST_MINUTES, `the operator read reports a bucketed trusted count (${JSON.stringify(t)})`);
    ok(!/203\.0\.113/.test(JSON.stringify(t)), "and no address");
  }
  console.log(`\nPASS - ${pass} checks (paid-quote trust)`);
  cleanup();
  process.exit(0);
} catch (e) {
  fail(e?.stack || String(e));
}
