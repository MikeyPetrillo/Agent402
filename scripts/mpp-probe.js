#!/usr/bin/env node
// Synthetic MPP probe - buys a few of our cheapest pure-CPU tools over MPP's
// native tempo/charge method and GRADES each purchase, every 30 minutes.
//
// Why this exists beside the other Tempo jobs: the daily paid canary proves
// the rail once a day, and tempo-volume.js is graded only on a success RATE
// over ~17 buys of one route. Neither notices, within the hour, that one
// route stopped returning its answer, that receipts stopped being mirrored, or
// that settlement got slow enough to race the credential's own expiry (mppx
// signs with validBefore = now + ~25 s). This probe asserts, per purchase:
//   402 carries a tempo/charge challenge -> credential -> 200
//   + a Payment-Receipt header with a reference
//   + the tool's own answer is present AND correct (deterministic inputs, the
//     expected output computed here)
//   + the paid round trip finished under MPP_PROBE_MAX_MS.
//
// Payment code is NOT new: the same mppx client and burner the volume runner
// uses (tempo.charge from BURNER_KEY, autoSwap). Every request carries the
// signed heartbeat token, so the stats and the sales ledger file the buys as
// INTERNAL, never as outside revenue; the $0.001 per buy lands in our own
// payTo. Spend is bounded: at most MPP_PROBE_MAX_BUYS (default 4, hard cap 5)
// routes per run, one retry each, and the run refuses to start below
// MPP_PROBE_MIN_BALANCE_USD on the burner (default $1) - the funding sweep in
// the paid canary pages for a top-up before this ever grinds the wallet down.
//
// Exit 0 = every probed route passed; 1 = at least one failed after its retry;
// 2 = refused to start (no key, balance under the floor or unreadable, or no
// tempo challenge on the live 402).
import { createHash, createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const MAX_BUYS = Math.max(1, Math.min(5, Number(process.env.MPP_PROBE_MAX_BUYS) || 4));
const MAX_MS = Number(process.env.MPP_PROBE_MAX_MS) || 30_000;
const MIN_BALANCE_USD = Number(process.env.MPP_PROBE_MIN_BALANCE_USD ?? 1);
const MAX_PRICE_BASE_UNITS = 1000n; // $0.001 in 6-decimal units: a challenge above it is refused, never paid
const TEMPO_RPC = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
const USDCE = "0x20C000000000000000000000b9537d11c60E8b50";
const PATHUSD = "0x20c0000000000000000000000000000000000000";

// Deterministic inputs, expected outputs computed here: a 200 with a wrong or
// empty answer is a failure, not a pass.
const PROBE_TEXT = "mpp-probe";
export const PROBES = [
  { slug: "uuid", method: "GET", path: "/api/uuid", check: (b) => Array.isArray(b?.uuids) && b.uuids.length > 0 && typeof b.uuids[0] === "string" },
  { slug: "hash", method: "POST", path: "/api/hash", body: { text: PROBE_TEXT, algo: "sha256" }, check: (b) => b?.hex === createHash("sha256").update(PROBE_TEXT).digest("hex") },
  { slug: "base64", method: "POST", path: "/api/base64", body: { text: PROBE_TEXT, mode: "encode" }, check: (b) => b?.result === Buffer.from(PROBE_TEXT).toString("base64") },
  { slug: "slugify", method: "POST", path: "/api/slugify", body: { text: "MPP Probe 42" }, check: (b) => b?.slug === "mpp-probe-42" },
  { slug: "random", method: "GET", path: "/api/random?min=1&max=100&count=3", check: (b) => b && typeof b === "object" && Object.keys(b).length > 0 && !b.error },
];

async function main() {
  const key = (process.env.BURNER_KEY || "").trim();
  if (!key) { console.error("REFUSING to run: no BURNER_KEY"); process.exit(2); }
  const secret = (process.env.POW_SECRET || "").trim();
  if (!secret) console.warn("WARN no POW_SECRET: buys will NOT carry the heartbeat token and would be booked as outside revenue - refusing");
  if (!secret) process.exit(2);
  const heartbeatHeaders = () => {
    const minute = Math.floor(Date.now() / 60_000);
    return { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32) };
  };
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);

  async function erc20(token) {
    try {
      const data = "0x70a08231" + account.address.slice(2).toLowerCase().padStart(64, "0");
      const r = await fetch(TEMPO_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }), signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      return Number(BigInt(j.result || "0x0")) / 1e6;
    } catch { return null; }
  }
  // Public log: bucketed balance only (same rule as the volume runner).
  const usdce = await erc20(USDCE), pathusd = await erc20(PATHUSD);
  if (usdce === null && pathusd === null) { console.error("REFUSING to run: Tempo balance unreadable (RPC) - cannot apply the balance floor"); process.exit(2); }
  const spendable = (usdce ?? 0) + (pathusd ?? 0);
  console.log(`mpp-probe: ${MAX_BUYS} route(s) over tempo/charge | burner ${spendable >= 10 ? ">=$10" : spendable >= MIN_BALANCE_USD ? `>=$${MIN_BALANCE_USD}` : `<$${MIN_BALANCE_USD}`}`);
  if (spendable < MIN_BALANCE_USD) { console.error(`REFUSING to run: burner under MPP_PROBE_MIN_BALANCE_USD $${MIN_BALANCE_USD} on Tempo - top up before the next run`); process.exit(2); }

  const [{ Mppx, tempo }, { Challenge, Receipt }] = await Promise.all([import("mppx/client"), import("mppx")]);
  const client = Mppx.create({ methods: [tempo.charge({ account, autoSwap: true })], polyfill: false });

  const once = async (p) => {
    const url = `${TARGET}${p.path}`;
    const init = (extra = {}) => ({
      method: p.method,
      headers: { ...heartbeatHeaders(), ...(p.body ? { "content-type": "application/json" } : {}), ...extra },
      ...(p.body ? { body: JSON.stringify(p.body) } : {}),
    });
    const bare = await fetch(url, { ...init(), signal: AbortSignal.timeout(15_000) });
    const www = bare.headers.get("www-authenticate") || "";
    await bare.arrayBuffer().catch(() => {});
    const ch = www ? Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": www })).find((c) => c.method === "tempo" && c.intent === "charge") : null;
    if (!ch) return { fatal: bare.status === 402 || bare.status === 200, error: `no tempo/charge challenge (HTTP ${bare.status})` };
    let amount = null;
    try { amount = BigInt(String(ch.request?.amount ?? "")); } catch { amount = null; }
    if (amount === null || amount > MAX_PRICE_BASE_UNITS) return { error: `challenge amount ${ch.request?.amount ?? "?"} is above the $0.001 probe cap - not paid` };
    const credential = await client.createCredential(new Response(null, { status: 402, headers: { "WWW-Authenticate": Challenge.serialize(ch) } }));
    const t0 = Date.now();
    const paid = await fetch(url, { ...init({ Authorization: credential }), signal: AbortSignal.timeout(MAX_MS + 30_000) });
    const ms = Date.now() - t0;
    const body = await paid.json().catch(() => null);
    const receipt = paid.headers.get("payment-receipt");
    let ref = null;
    try { ref = receipt ? Receipt.deserialize(receipt)?.reference || null : null; } catch { ref = null; }
    if (paid.status !== 200) {
      const problem = body && typeof body === "object" && body.type ? `${String(body.type).split("/").pop()}: ${String(body.detail || "").slice(0, 120)}` : "";
      return { error: `HTTP ${paid.status} ${problem}`.trim(), ms };
    }
    if (!receipt || !ref) return { error: "200 without a Payment-Receipt reference (receipt mirroring broken)", ms, ref };
    if (!p.check(body)) return { error: `200 + receipt, but the answer is empty or wrong (${JSON.stringify(body).slice(0, 100)})`, ms, ref };
    if (ms > MAX_MS) return { error: `settled and correct but slow: ${ms}ms > ${MAX_MS}ms`, ms, ref };
    return { ok: true, ms, ref };
  };

  let failed = 0;
  for (const [i, p] of PROBES.slice(0, MAX_BUYS).entries()) {
    let r;
    try { r = await once(p); } catch (e) { r = { error: (e?.message || String(e)).slice(0, 160) }; }
    if (r.fatal && i === 0) { console.error(`REFUSING to run: ${r.error} on ${p.path} - TEMPO_API_KEY unset on prod, or the route is not paid`); process.exit(2); }
    if (!r.ok) {
      // One retry with a FRESH credential (credentials are single-use; a
      // >= 400 cancels settlement, so a retry costs nothing unless it succeeds).
      console.warn(`WARN  ${p.slug}: ${r.error} - retrying once`);
      await new Promise((res) => setTimeout(res, 3000));
      try { r = await once(p); } catch (e) { r = { error: (e?.message || String(e)).slice(0, 160) }; }
    }
    if (r.ok) console.log(`OK    ${p.slug.padEnd(8)} ${p.method} ${p.path.split("?")[0]} -> 200 + receipt in ${r.ms}ms${r.ref ? ` (tx https://explore.tempo.xyz/tx/${r.ref})` : ""}`);
    else { failed++; console.error(`FAIL  ${p.slug.padEnd(8)} ${p.method} ${p.path.split("?")[0]} -> ${r.error}${r.ref ? ` (tx ${r.ref})` : ""}`); }
  }
  console.log(`mpp-probe: ${MAX_BUYS - failed}/${MAX_BUYS} passed`);
  process.exit(failed ? 1 : 0);
}

// Resolved through realpath: a bare `file://${argv[1]}` comparison is false
// through a symlink or a path with a space, and the script would exit 0 having
// probed nothing.
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) main().catch((e) => { console.error(`mpp-probe crashed: ${(e?.message || String(e)).slice(0, 200)}`); process.exit(1); });
