#!/usr/bin/env node
// POST /__operator/index/seed: the operator bulk path into the seller index
// (scripts/x402scan-seed.js is its caller). Proves, on a free-mode boot with
// no network beyond loopback: it is invisible without the operator token;
// the body is bounded; every origin faces the same validation a /sell
// submission does; a dry run registers nothing; a commit answers per origin
// and an origin with no x402 surface is reported, not listed.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3447;
const TOKEN = "test-operator-token-for-seed-route-0123456789";
let pass = 0, fail = 0, proc = null;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const stop = () => { try { proc?.kill("SIGKILL"); } catch { /* gone */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT, stdio: "ignore",
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", AGENT402_OPERATOR_TOKEN: TOKEN, BASE_URL: `http://127.0.0.1:${PORT}` },
});
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { /* booting */ } if (!up) await sleep(500); }
if (!up) { console.log("FAIL - server did not boot"); stop(); process.exit(1); }

const post = (body, auth = true) => fetch(`${base}/__operator/index/seed`, {
  method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(body),
});

let r = await post({ origins: ["https://seller.example"] }, false);
ok(r.status === 404, `without the operator token the route does not exist (${r.status})`);
r = await post({ origins: [] });
ok(r.status === 400, `an empty list is a 400 (${r.status})`);
r = await post({ origins: Array.from({ length: 26 }, (_, i) => `https://s${i}.example`) });
ok(r.status === 400 && /at most 25/.test((await r.json()).error || ""), `more than 25 origins in one call is a 400`);

r = await post({ origins: ["http://plain.example", "https://seller.example/", "https://seller.example", `http://127.0.0.1:${PORT}`, "not a url"] });
let j = await r.json();
ok(r.status === 200 && j.dryRun === true, `a call without commit is a dry run (${r.status}, dryRun ${j.dryRun})`);
ok(j.valid === 1 && j.rows.filter((x) => x.dryRun).length === 1, `one valid origin after validation and dedupe (valid ${j.valid}; a duplicate with a trailing slash collapses)`);
ok(j.rows.some((x) => x.origin === "http://plain.example" && /https/.test(x.error)), "a plain-http origin is refused by name");
ok(j.rows.some((x) => /not a url/.test(x.origin) && /valid URL/.test(x.error)), "a non-URL is refused by name");
const regs = async () => (await (await fetch(`${base}/__operator/seller-registrations.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json());
const beforeDry = await regs();
await post({ origins: ["https://dry-run-only.example"] });
const afterDry = await regs();
ok(beforeDry.total === afterDry.total && beforeDry.slots.submitted === afterDry.slots.submitted, `a dry run registers nothing (registrations ${beforeDry.total} -> ${afterDry.total}, submitted ${beforeDry.slots.submitted} -> ${afterDry.slots.submitted})`);

r = await post({ origins: ["https://origin.invalid"], commit: true });
j = await r.json();
ok(r.status === 200 && j.dryRun === false && j.listed === 0, `a commit answers 200 with per-origin rows (listed ${j.listed})`);
ok(j.rows.length === 1 && j.rows[0].listed === false && typeof j.rows[0].error === "string" && j.rows[0].error.length > 0, `an origin with no x402 surface is reported, not listed (${j.rows[0]?.error})`);

stop();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
