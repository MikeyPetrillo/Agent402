#!/usr/bin/env node
// The free-alert ROUTES on a booted server (the engine has its own test).
// Found 2026-08-28 by the first live signup: the confirmation page 500'd on
// prod ("esc is not defined") while the record activated - the engine test
// could not see it and the route test only covered the bad-link 400. Boots a
// FREE_MODE server with a known secret, plants a pending record in the same
// store the server reads, and drives confirm / unsubscribe / stop end to end.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { createFreeAlerts, defaultStorePath } from "../src/free-alerts.js";

let pass = 0; let proc = null;
const fail = (m) => { console.error("FAIL:", m); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = "alerts-routes-test-secret";
const STORE = defaultStorePath();
ok(!existsSync("/data") || STORE.startsWith("/data"), `store path is the server's own (${STORE})`);

// Plant a pending record with the engine (same store, same secret => same links).
const mail = [];
const fa = createFreeAlerts({ storePath: STORE, probes: { insider: async () => ({ ids: ["x"] }) }, validators: { insider: (t) => String(t).toUpperCase() }, sendEmail: async (m) => { mail.push(m); return true; }, secret: SECRET, baseUrl: "http://x.test", log: () => {} });
const email = `routes-${Date.now().toString(36)}@example.com`;
await fa.signup({ email, kind: "insider", target: "TSTX", source: "test" });
const id = Object.keys(fa._store().alerts).find((k) => fa._store().alerts[k].email === email);
ok(id && mail.length === 1, "pending record planted, confirmation captured");
const confirmK = fa.sign(id, "confirm"), unsubK = fa.sign(id, "unsubscribe");

const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
proc = spawn("node", ["src/server.js"], { env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", POW_SECRET: SECRET, FREE_ALERTS_SECRET: "", MPP_SECRET_KEY: "", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", FREE_ALERTS: "off" }, stdio: "ignore" });
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await sleep(500); }
  ok((await fetch(`${B}/health`)).ok, "server booted with the test secret");
  const forged = await fetch(`${B}/alerts/confirm?id=${id}&k=forged`);
  ok(forged.status === 400, `forged confirmation -> 400 (got ${forged.status})`);
  const conf = await fetch(`${B}/alerts/confirm?id=${id}&k=${confirmK}`);
  const confHtml = await conf.text();
  ok(conf.status === 200 && /Alert confirmed/.test(confHtml) && /TSTX/.test(confHtml) && /monitors\?product=insider-monitor/.test(confHtml), `the signed confirmation link renders the confirmed page with the monitor offer (got ${conf.status})`);
  const rec = JSON.parse(readFileSync(STORE, "utf8")).alerts[id];
  ok(rec.status === "active", "the record is active after the click");
  const again = await fetch(`${B}/alerts/confirm?id=${id}&k=${confirmK}`);
  ok(again.status === 200, "confirming twice is a 200, not an error");
  const unsub = await fetch(`${B}/alerts/unsubscribe?id=${id}&k=${unsubK}`);
  const unsubHtml = await unsub.text();
  ok(unsub.status === 200 && /Unsubscribed/.test(unsubHtml) && /TSTX/.test(unsubHtml), `the signed unsubscribe link renders the unsubscribed page (got ${unsub.status})`);
  const rec2 = JSON.parse(readFileSync(STORE, "utf8")).alerts[id];
  ok(rec2.status === "unsubscribed" && rec2.email === null, "the record is unsubscribed and the address is dropped");
  const post = await fetch(`${B}/alerts/unsubscribe?id=${id}&k=${unsubK}`, { method: "POST" });
  ok(post.status === 200, "RFC 8058 one-click POST unsubscribe answers 200");
  const stopBad = await fetch(`${B}/followups/stop?id=cs_x&k=forged`);
  ok(stopBad.status === 400 && /did not work/.test(await stopBad.text()), "a forged follow-up stop link renders the 400 page (no 500)");
  const hostile = await fetch(`${B}/alerts/confirm?id=__proto__&k=${confirmK}`);
  ok(hostile.status === 400, "a prototype-name id is refused");
  console.log(`\nPASS - ${pass} checks (alert routes end to end on a booted server)`);
  proc.kill("SIGKILL"); process.exit(0);
} catch (e) { fail(e?.stack || String(e)); }
