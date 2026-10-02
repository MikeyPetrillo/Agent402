#!/usr/bin/env node
// Selling prepaid credits creates a held balance - a third party's money kept
// against future redemption, which is the activity money transmitter statutes
// regulate. Closed-loop balances are exempt in many states, but that is a
// lawyer's call and we do not have one, so the product does not create the
// obligation at all: sales are OFF unless CREDITS_SALES is explicitly on.
//
// REDEMPTION IS NOT GATED, and that is the point of the test. Existing keys
// must keep spending their balance, or turning sales off would strand money
// that is already out there. This pins both halves.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { getFreePort } from "./lib/free-port.js";

const PORT = await getFreePort();
const B = `http://127.0.0.1:${PORT}`;
let pass = 0, proc = null;
const log = [];
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of log.slice(-20)) console.error("  server:", l); proc?.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { c ? (pass++, console.log("ok -", m)) : fail(m); };

const boot = (env) => new Promise(async (resolve) => {
  proc = spawn("node", ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT), FREE_MODE: "true", STRIPE_SECRET_KEY: "sk_test_x",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off",
      FREE_ALERTS: "off", FOLLOWUPS: "off", WALLET_DIGEST: "off", X402_SYNC_ON_START: "false", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => log.push(...String(d).split("\n").filter(Boolean)));
  proc.stderr.on("data", (d) => log.push(...String(d).split("\n").filter(Boolean)));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${B}/health`)).ok) return resolve(true); } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  resolve(false);
});

try {
  // --- default: a host that sets nothing is in the SAFE state, not the exposed one
  ok(await boot({}), "server booted with CREDITS_SALES unset");
  const off = await fetch(`${B}/api/credits/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "credits-20" }) });
  ok(off.status === 503, `selling is refused by default (got ${off.status})`);
  const body = await off.json().catch(() => ({}));
  ok(/not on sale/i.test(String(body.error || "")), "and the refusal says sales are off rather than reading as a misconfiguration");

  // redemption must survive: a 404 here would mean an existing key was stranded
  ok((await fetch(`${B}/api/credits/balance`)).status !== 404, "the balance route still exists, so an existing key can still be read");
  ok((await fetch(`${B}/api/credits/claim?session=x`)).status !== 404, "the claim route still exists");

  // The machine and page surfaces follow the same switch. /api/pricing used to
  // advertise packs and a checkout body that this server answers 503 to, and
  // /credits carried an InStock Offer and a "Buy $20" snippet while refusing.
  const pricingOff = await (await fetch(`${B}/api/pricing`)).json();
  ok(pricingOff.credits && pricingOff.credits.onSale === false, "/api/pricing says credits are not on sale");
  ok(!pricingOff.credits.checkout && !pricingOff.credits.packs && !pricingOff.credits.buy, "...and offers no packs, buy link or checkout body");
  ok(/already issued/.test(String(pricingOff.credits.how)) && /balance/.test(String(pricingOff.credits.balance)), "...and still tells an existing key holder how to spend and read it");
  const pageOff = await (await fetch(`${B}/credits`)).text();
  ok(!/InStock/.test(pageOff) && !/Buy \$20/.test(pageOff) && !/data-pack-buy/.test(pageOff), "/credits carries no Offer, buy snippet or buy button while sales are off");
  proc.kill("SIGKILL");

  // --- explicitly on: selling works again, so this is a switch and not a deletion
  ok(await boot({ CREDITS_SALES: "on" }), "server booted with CREDITS_SALES=on");
  const on = await fetch(`${B}/api/credits/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "credits-20" }) });
  ok(on.status !== 503, `selling is reachable when explicitly enabled (got ${on.status}, not the 503 refusal)`);
  const pricingOn = await (await fetch(`${B}/api/pricing`)).json();
  ok(pricingOn.credits?.onSale === true && pricingOn.credits.checkout?.method === "POST", "/api/pricing advertises the checkout when sales are on");

  // the gate must be read at call time, never latched at boot
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/if \(!creditsSalesEnabled\(\)\) return res\.status\(503\)/.test(src), "the check runs inside the handler, before Stripe is touched");

  console.log(`\n${pass} passed, 0 failed`);
} finally { proc?.kill("SIGKILL"); }
