#!/usr/bin/env node
// scripts/erase-subject.js must remove an address from every file store that
// holds one, because /privacy promises erasure on request. Fixtures live in a
// scratch data root; the script runs as a child exactly as an operator runs it,
// with no state database (the file backend). The database backend is
// scripts/test-erase-subject-pg.js.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = process.env.ERASE_SUBJECT_SCRIPT || join(here, "erase-subject.js");
const root = mkdtempSync(join(tmpdir(), "erase-subject-"));
let failed = 0;
const ok = (c, m) => { if (c) console.log("  ok", m); else { failed++; console.error("  FAIL", m); } };
const W = (f, o) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), JSON.stringify(o)); };
const R = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));
const who = "Erase.Me@example.com";
const failKey = createHash("sha256").update("erase.me@example.com").digest("hex").slice(0, 24);
const otherKey = createHash("sha256").update("keep@example.com").digest("hex").slice(0, 24);
const env = { ...process.env, DATABASE_URL: "", STATE_DATABASE_URL: "" };

W("free-alerts.json", { alerts: { a1: { email: "erase.me@example.com", kind: "insider" }, a2: { email: "keep@example.com" } } });
W("followups.json", { seqs: { s1: { email: "erase.me@example.com" }, s2: { email: "keep@example.com" } } });
W("wallet-digest.json", { subs: { d1: { email: "erase.me@example.com", payer: "0xabc", kind: "wallet" }, d2: { email: "keep@example.com", payer: "0xdef" } } });
W("stripe-subscriptions.json", { sub_1: { email: "erase.me@example.com", status: "active" } });
W("mpp-subscriptions.json", { mpp_1: { subId: "mpp_1", email: "Erase.Me@example.com", status: "active", payer: "0xAbC" }, mpp_2: { subId: "mpp_2", email: "keep@example.com" }, "tempo:sub:1": { amount: "1", lookupKey: "k" } });
W("credits/k_aaa.json", { keyId: "k1", balanceMicro: 500, email: "erase.me@example.com" });
W("credits/k_bbb.json", { keyId: "k2", balanceMicro: 700, email: "keep@example.com" });
W("human-checkout/_failures.json", { [failKey]: [1], [otherKey]: [2] });

const dry = spawnSync(process.execPath, [script, who, "--dry", "--data-root", root], { encoding: "utf8", env });
ok(dry.status === 0, `dry run exits 0 (${dry.status}) ${dry.stderr.slice(0, 200)}`);
ok(Boolean(R("wallet-digest.json").subs.d1), "dry run leaves the digest record in place");
ok(R("mpp-subscriptions.json").mpp_1.email === "Erase.Me@example.com" && R("credits/k_aaa.json").email === "erase.me@example.com" && Boolean(R("human-checkout/_failures.json")[failKey]), "dry run leaves every new store unchanged");
ok(/mpp-subscriptions\.json: 1 record\(s\) would be/.test(dry.stdout) && /credits: 1 key record\(s\) would be/.test(dry.stdout) && /_failures: 1 failure counter\(s\) would be deleted/.test(dry.stdout), "dry run reports per store what would be removed");

const run = spawnSync(process.execPath, [script, who, "--data-root", root], { encoding: "utf8", env });
ok(run.status === 0, `erase exits 0 (${run.status}) ${run.stderr.slice(0, 200)}`);
const alerts = R("free-alerts.json").alerts, seqs = R("followups.json").seqs, subs = R("wallet-digest.json").subs;
ok(!alerts.a1 && Boolean(alerts.a2), "free alert for the address deleted, others kept");
ok(!seqs.s1 && Boolean(seqs.s2), "follow-up sequence deleted, others kept");
ok(!subs.d1 && Boolean(subs.d2), "weekly digest subscription deleted, others kept");
ok(R("stripe-subscriptions.json").sub_1.email === null && R("stripe-subscriptions.json").sub_1.status === "active", "subscription record keeps billing history without the address");
const mpp = R("mpp-subscriptions.json");
ok(mpp.mpp_1.email === null && mpp.mpp_1.status === "active" && mpp.mpp_1.payer === "0xAbC" && mpp.mpp_2.email === "keep@example.com" && mpp["tempo:sub:1"].lookupKey === "k", "MPP subscription keeps the record without the address; the wallet's case and other records are untouched");
ok(R("credits/k_aaa.json").email === null && R("credits/k_aaa.json").balanceMicro === 500 && R("credits/k_bbb.json").email === "keep@example.com", "credit key keeps its balance without the address; other keys untouched");
const fx = R("human-checkout/_failures.json");
ok(!fx[failKey] && Boolean(fx[otherKey]), "card-checkout failure counter for the address deleted, others kept");
ok(/wallet-digest\.json: 1 subscription/.test(run.stdout), "report names the digest store");

const again = spawnSync(process.execPath, [script, who, "--dry", "--data-root", root], { encoding: "utf8", env });
ok(again.status === 0 && !/: [1-9]\d* /.test(again.stdout), "a second dry run finds nothing left");

rmSync(root, { recursive: true, force: true });
if (failed) { console.error(`test-erase-subject: ${failed} failed`); process.exit(1); }
console.log("test-erase-subject: all passed");
