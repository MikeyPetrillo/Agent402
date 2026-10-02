#!/usr/bin/env node
// scripts/erase-subject.js must remove an address from every file store that
// holds one, because /privacy promises erasure on request. Fixtures live in a
// scratch data root; the script runs as a child exactly as an operator runs it.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = process.env.ERASE_SUBJECT_SCRIPT || join(here, "erase-subject.js");
const root = mkdtempSync(join(tmpdir(), "erase-subject-"));
let failed = 0;
const ok = (c, m) => { if (c) console.log("  ok", m); else { failed++; console.error("  FAIL", m); } };
const W = (f, o) => writeFileSync(join(root, f), JSON.stringify(o));
const R = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));
const who = "Erase.Me@example.com";
const env = { ...process.env, DATABASE_URL: "" };

W("free-alerts.json", { alerts: { a1: { email: "erase.me@example.com", kind: "insider" }, a2: { email: "keep@example.com" } } });
W("followups.json", { seqs: { s1: { email: "erase.me@example.com" }, s2: { email: "keep@example.com" } } });
W("wallet-digest.json", { subs: { d1: { email: "erase.me@example.com", payer: "0xabc", kind: "wallet" }, d2: { email: "keep@example.com", payer: "0xdef" } } });
W("stripe-subscriptions.json", { sub_1: { email: "erase.me@example.com", status: "active" } });

const dry = spawnSync(process.execPath, [script, who, "--dry", "--data-root", root], { encoding: "utf8", env });
ok(dry.status === 0, "dry run exits 0");
ok(Boolean(R("wallet-digest.json").subs.d1), "dry run leaves the digest record in place");

const run = spawnSync(process.execPath, [script, who, "--data-root", root], { encoding: "utf8", env });
ok(run.status === 0, "erase exits 0");
const alerts = R("free-alerts.json").alerts, seqs = R("followups.json").seqs, subs = R("wallet-digest.json").subs;
ok(!alerts.a1 && Boolean(alerts.a2), "free alert for the address deleted, others kept");
ok(!seqs.s1 && Boolean(seqs.s2), "follow-up sequence deleted, others kept");
ok(!subs.d1 && Boolean(subs.d2), "weekly digest subscription deleted, others kept");
ok(R("stripe-subscriptions.json").sub_1.email === null, "subscription record keeps billing history without the address");
ok(/wallet-digest\.json: 1 subscription/.test(run.stdout), "report names the digest store");

rmSync(root, { recursive: true, force: true });
if (failed) { console.error(`test-erase-subject: ${failed} failed`); process.exit(1); }
console.log("test-erase-subject: all passed");
