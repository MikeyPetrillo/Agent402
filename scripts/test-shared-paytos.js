#!/usr/bin/env node
// Operator-listed SHARED payTo wallets (2026-09-28, src/shared-paytos.js).
//
// A split or settlement contract forwards each payment to one of many sellers,
// so every seller behind it is honestly "paid at" it and the per-wallet binding
// cannot tell them apart. The operator lists such a wallet; a listed wallet
// credits NOBODY with its leaderboard or chain-join history, and an origin paid
// at it keeps only the Bazaar evidence measured on its own URLs.
//
// Three parts: the rule (pure), the store (a file under a temp dir standing in
// for /data: persisted, survives a new instance), and the operator lever on a
// booted server (applied from the next read with no redeploy, and still listed
// after a restart).
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildEvidenceBinding, baseLiveGate } from "../src/evidence-binding.js";
import { dispatchEligibility, DISPATCH_DETAILS, dispatchLegend } from "../src/dispatch-eligibility.js";
import { createSharedPayToStore, parseSharedPayTosEnv } from "../src/shared-paytos.js";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const FLOORS = { minSettled: 50, minPayers: 3 };
const S = "0x" + "5".repeat(40);   // the shared split contract
const T = "0x" + "7".repeat(40);   // a second shared wallet, listed by env
const A = "https://seller-a.example"; // thin on its own URLs
const B = "https://seller-b.example"; // busy on its own URLs
const listed = (...ws) => ({ has: (w) => ws.includes(String(w).toLowerCase()) });
const label = (b, livePayTo) => dispatchEligibility({ routable: true, networks: ["eip155:8453"], settled: b?.settled || 0, payers: b?.payers, spendChains: ["base"], ...FLOORS, evidence: b, livePayTo });

// --- 1. The rule -------------------------------------------------------------
{
  const row = { wallet: S, wallets: [S], origins: [A, B], homepage: A, callsSettled: 5000, uniqueBuyers: 40 };
  const bazaar = [[A, { calls30d: 20, payers30d: 2, payTos: [S] }], [B, { calls30d: 900, payers30d: 12, payTos: [S] }]];
  const chainProven = new Map([[A, { settled: 600, payers: 9, payTo: S }]]);

  const control = buildEvidenceBinding({ leaderboardRows: [row], bazaarQuality: bazaar, chainProven, ...FLOORS });
  ok(control.get(A).byWallet.get(S).settled === 5000 && label(control.get(A), S).eligible === true, "control: unlisted, the contract's whole history is credited to every seller naming it (seller-a reads eligible on it)");

  const b = buildEvidenceBinding({ leaderboardRows: [row], bazaarQuality: bazaar, chainProven, sharedWallets: listed(S), ...FLOORS });
  ok(b.get(A).byWallet.get(S).settled === 20 && b.get(A).byWallet.get(S).payers === 2, "listed: seller-a keeps only its own Bazaar figures at S (20 calls / 2 payers)");
  ok(b.get(A).withheld.byWallet.get(S).settled === 5000 && b.get(A).withheld.payTos.has(S), "...the leaderboard history at S is reported as withheld, not as absent");
  ok(b.get(A).ownSettled === 0 && b.get(A).ownPayers === undefined && b.get(A).withheld.byWallet.get(S).payers === 40, "...and the chain join at S is withheld too (not the origin's own evidence while S is listed)");
  const la = label(b.get(A), S);
  ok(la.eligible === false && la.reason === "settlement_required" && la.chains.base.detail === "evidence_payto_shared", "label: seller-a reads settlement_required, detail evidence_payto_shared");
  const forced = baseLiveGate({ networks: ["eip155:8453"], settled: 5000, payers: 40, priceUsd: 0.01, ...FLOORS, binding: b.get(A), livePayTo: S });
  ok(forced.ok === false && forced.detail === "evidence_payto_shared", "even handed the contract's figures, the gate refuses seller-a at S");
  const gb = baseLiveGate({ networks: ["eip155:8453"], settled: b.get(B).settled, payers: b.get(B).payers, priceUsd: 0.01, ...FLOORS, binding: b.get(B), livePayTo: S });
  ok(b.get(B).byWallet.get(S).settled === 900 && gb.ok === true && JSON.stringify(gb.evidenceWallets) === JSON.stringify([S]), "seller-b clears at S on its OWN Bazaar figures (900 / 12) and is paid there");
  ok(typeof DISPATCH_DETAILS.evidence_payto_shared === "string" && !/\b[a-z0-9-]+\.(example|com|io|xyz)\b/i.test(DISPATCH_DETAILS.evidence_payto_shared) && dispatchLegend().routerDispatchDetail.evidence_payto_shared === DISPATCH_DETAILS.evidence_payto_shared, "the detail is in the published legend and names no one");
  const other = buildEvidenceBinding({ leaderboardRows: [{ ...row, wallet: T, wallets: [T] }], sharedWallets: listed(S), ...FLOORS });
  ok(other.get(A).byWallet.get(T).settled === 5000, "a wallet that is not listed is untouched");
}

// --- 2. The env floor ---------------------------------------------------------
{
  const logs = [];
  const env = parseSharedPayTosEnv(` ${T.toUpperCase().replace("0X", "0x")} , not-a-wallet,0x1234,`, { log: (m) => logs.push(m) });
  ok(env.wallets.size === 1 && env.wallets.has(T), "SOR_MULTI_TENANT_PAYTOS: a valid address is listed, lower-cased");
  ok(env.rejected.length === 2 && logs.length === 1 && /ignored 2 malformed/.test(logs[0]), "a malformed entry is dropped whole and logged, never applied in part");
}

// --- 3. The store ---------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "shared-paytos-"));
try {
  const file = join(dir, "sor-shared-paytos.json");
  const s1 = createSharedPayToStore({ file, envWallets: new Set([T]) });
  s1.load();
  ok(!s1.has(S) && s1.has(T) && s1.list()[0].source === "env", "a fresh store lists the env floor only");
  const v0 = s1.version;
  const added = await s1.add(S, { note: "split contract" });
  ok(added.changed === true && s1.has(S) && s1.version > v0, "add lists the wallet at once and bumps the version");
  ok((await s1.add(S)).changed === false, "adding it again changes nothing");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  ok(onDisk.wallets[S]?.note === "split contract" && !(T in onDisk.wallets), "persisted to the file (runtime entries only; the env floor is not copied)");
  ok(readdirSync(dir).every((f) => !f.endsWith(".tmp")), "written tmp + rename: no temp file is left behind");
  const s2 = createSharedPayToStore({ file, envWallets: new Set() });
  s2.load();
  ok(s2.has(S) && s2.list().find((x) => x.wallet === S)?.source === "operator", "RESTART: a new instance over the same file still lists it");
  let threw = null;
  try { await s1.remove(T); } catch (e) { threw = e; }
  ok(threw?.statusCode === 409, "an env-listed wallet cannot be removed at runtime (409)");
  threw = null;
  try { await s1.add("0x1234"); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400, "a malformed wallet is refused (400)");
  ok((await s1.remove(S)).changed === true && !s1.has(S), "remove unlists it");
  const s3 = createSharedPayToStore({ file });
  s3.load();
  ok(!s3.has(S), "...and the removal persists");
  writeFileSync(file, "{not json");
  const logs = [];
  const s4 = createSharedPayToStore({ file, envWallets: new Set([T]), log: (m) => logs.push(m) });
  s4.load();
  ok(s4.has(T) && logs.some((l) => /could not parse/.test(l)), "an unreadable file is reported loudly and the env floor still applies");
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// --- 4. The operator lever on a booted server ---------------------------------
{
  const dir2 = mkdtempSync(join(tmpdir(), "shared-paytos-boot-"));
  const lbFile = join(dir2, "leaderboard-snapshot.json");
  const storeFile = join(dir2, "sor-shared-paytos.json");
  // The leaderboard warm-starts from this file at boot: one seller, paid at S.
  writeFileSync(lbFile, JSON.stringify({
    spec: "x402-leaderboard/1", asOf: "2026-09-28T00:00:00.000Z", windowLabel: "7d",
    leaderboard: [{ rank: 1, homepage: A, origins: [A], wallet: S, wallets: [S], callsSettled: 5000, uniqueBuyers: 40 }],
    walletEvidence: { [S]: { callsSettled: 5000, uniqueBuyers: 40, origins: [A] } },
  }));
  const TOKEN = "shared-paytos-operator-token-for-tests";
  const H = { "x-operator-token": TOKEN, "content-type": "application/json" };
  let proc = null, port = null;
  const serverLog = [];
  const boot = async () => {
    port = await getFreePort();
    proc = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env, PORT: String(port), FREE_MODE: "true", AGENT402_OPERATOR_TOKEN: TOKEN,
        LEADERBOARD_SNAPSHOT_FILE: lbFile, SOR_SHARED_PAYTOS_FILE: storeFile, SOR_MULTI_TENANT_PAYTOS: `${T},not-a-wallet`,
        X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false",
        MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (c) => { for (const l of String(c).split("\n")) if (l.trim()) serverLog.push(l.slice(0, 300)); if (serverLog.length > 60) serverLog.splice(0, serverLog.length - 60); };
    proc.stdout.on("data", keep); proc.stderr.on("data", keep);
    for (let i = 0; i < 160; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 500)); }
    return false;
  };
  const stop = () => new Promise((r) => { if (!proc) return r(); proc.once("exit", () => r()); proc.kill("SIGKILL"); });
  const get = async (p, h = H) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = async (body, h = H) => { const r = await fetch(`http://127.0.0.1:${port}/__operator/shared-paytos`, { method: "POST", headers: h, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    ok(await boot(), "server booted (free mode, leaderboard warm-started from a fixture)");
    const before = await get(`/__operator/shared-paytos.json?wallet=${S}`);
    ok(before.status === 200 && before.body.listed === false && before.body.creditedTo.includes(A) && before.body.withheldFrom.length === 0, "before: the wallet's history is credited to the seller paid at it");
    ok((await get("/__operator/shared-paytos.json", { accept: "application/json" })).status === 404 && (await post({ action: "add", wallet: S }, { "content-type": "application/json" })).status === 404, "without the operator token both routes answer 404");
    const add = await post({ action: "add", wallet: S, note: "split contract" });
    ok(add.status === 200 && add.body.changed === true && add.body.source === "operator", "POST add lists the wallet");
    const after = await get(`/__operator/shared-paytos.json?wallet=${S}`);
    ok(after.body.listed === true && after.body.creditedTo.length === 0 && after.body.withheldFrom.includes(A), "applied from the next read, no redeploy: credited to nobody, withheld from the seller");
    const listing = await get("/__operator/shared-paytos");
    ok(listing.body.env === 1 && listing.body.operator === 1 && listing.body.wallets.some((x) => x.wallet === T && x.source === "env"), "the listing shows the env floor (the malformed env entry dropped) beside the runtime entry");
    ok((await post({ action: "remove", wallet: T })).status === 409, "an env-listed wallet cannot be removed at runtime");
    ok((await post({ action: "add", wallet: "0x12" })).status === 400 && (await post({ action: "nope", wallet: S })).status === 400, "a malformed wallet or action is refused 400");
    await stop();
    ok(await boot(), "RESTART: the server boots again over the same /data files");
    const restarted = await get(`/__operator/shared-paytos.json?wallet=${S}`);
    ok(restarted.body.listed === true && restarted.body.entry?.note === "split contract" && restarted.body.withheldFrom.includes(A) && restarted.body.creditedTo.length === 0, "the listing survived the restart and still credits nobody");
    const rm = await post({ action: "remove", wallet: S });
    const back = await get(`/__operator/shared-paytos.json?wallet=${S}`);
    ok(rm.body.changed === true && back.body.listed === false && back.body.creditedTo.includes(A), "POST remove restores the crediting at once");
  } catch (e) {
    ok(false, `booted leg threw: ${e?.stack || e}`);
    for (const l of serverLog.slice(-20)) console.error("  server:", l);
  } finally {
    await stop();
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
