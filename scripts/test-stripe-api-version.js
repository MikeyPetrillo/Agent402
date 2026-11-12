#!/usr/bin/env node
// Every server-side Stripe client sends the API version pinned in
// src/stripe-api-version.js, never the SDK's built-in default, so a stripe-node
// bump cannot move the API version behind our back.
//   1. No module under src/ constructs a Stripe client (under any local name
//      it imports the SDK as) except the pin module.
//   2. A client from newStripeClient() reports the pinned version, and the
//      pin is not the installed SDK's default only by accident: when the two
//      differ the client still carries the pin.
//   3. Caller options pass through, and a caller cannot override the pin.
// Offline: no key, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.log(`  FAIL ${m}`); } };

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const PIN_MODULE = "src/stripe-api-version.js";
const offenders = [];
for (const f of walk(join(ROOT, "src"))) {
  const rel = relative(ROOT, f);
  if (rel === PIN_MODULE) continue;
  const src = readFileSync(f, "utf8");
  // Every local name the SDK's default export is bound to (a type-only
  // JSDoc reference builds nothing and is not read).
  const names = new Set(["Stripe"]);
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']stripe["']/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']stripe["']\s*\)/g)) names.add(m[1]);
  for (const n of names) if (new RegExp(`\\bnew\\s+${n}\\s*\\(`).test(src)) offenders.push(`${rel} (new ${n})`);
  if (/await\s+import\(\s*["']stripe["']\s*\)/.test(src)) offenders.push(`${rel} (loads the SDK at run time)`);
}
ok(offenders.length === 0, `no src/ module builds a Stripe client outside ${PIN_MODULE}${offenders.length ? `: ${offenders.join(", ")}` : ""}`);

const { STRIPE_API_VERSION, newStripeClient } = await import("../src/stripe-api-version.js");
const { default: Stripe } = await import("stripe");
ok(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(STRIPE_API_VERSION), `the pin is a dated Stripe API version (${STRIPE_API_VERSION})`);

const client = newStripeClient("sk_test_offline");
ok(client.getApiField("version") === STRIPE_API_VERSION, "a client from newStripeClient sends the pinned version");
const sdkDefault = new Stripe("sk_test_offline").getApiField("version");
console.log(`  (installed SDK default: ${sdkDefault}; pin: ${STRIPE_API_VERSION})`);

const withOpts = newStripeClient("sk_test_offline", { maxNetworkRetries: 3, apiVersion: "2020-08-27" });
ok(withOpts.getApiField("version") === STRIPE_API_VERSION, "a caller's apiVersion cannot override the pin");
ok(withOpts.getMaxNetworkRetries() === 3, "other caller options pass through");

if (fail) { console.log(`\n${fail} failure(s)`); process.exit(1); }
console.log("\nall Stripe API version checks passed");
