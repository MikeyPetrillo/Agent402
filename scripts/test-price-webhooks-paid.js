#!/usr/bin/env node
// Price webhooks on a PAID server (src/price-webhooks.js,
// src/tools/price-webhook-kit.js): a registration is kept only when its call
// settles, and the registrant is the payer.
//
// Booted PAID server (scripts/lib/paid-wires-rig.js: local stubs that verify
// a payment and then settle it or refuse it for funds; nothing leaves this
// machine), POST /api/price-webhook, on wires that settle after the handler
// (x402 on Base, a Tempo pull credential, x402 on Solana):
//   - a funded wallet's registration answers 200 and is stored, confirmed
//     (control);
//   - a wallet whose payment verifies and is then refused at settlement
//     answers 402: while the settle is under way the registration is stored
//     as pending (control: the handler ran), and once the response has ended
//     nothing is stored for it;
//   - a payer's own registrations past its cap are refused 409 with nothing
//     settled, another payer registers an endpoint on the same host, and the
//     same URL again from the same payer renews the subscription in place
//     (and a renewal whose settlement is refused changes nothing).
// Deliveries are switched off and the server may contact no host that is not
// loopback (the rig fails the run if it tries), so nothing is ever sent.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPaidWires, sleep } from "./lib/paid-wires-rig.js";
import { PENDING_MS } from "../src/price-webhooks.js";

let pass = 0, rig = null;
const dir = mkdtempSync(join(tmpdir(), "price-webhooks-paid-"));
const file = join(dir, "price-webhooks.json");
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-20)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true }); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const stored = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { subs: {} }; } };
const subsFor = (url) => Object.entries(stored().subs || {}).filter(([, s]) => s.url === url);
/** Poll until `test()` holds (true) or `ms` passed (false). */
const eventually = async (test, ms = 3_000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (test()) return true; await sleep(20); } return test(); };
const route = (url, slugs) => ({ method: "POST", path: "/api/price-webhook", body: { url, ...(slugs ? { slugs } : {}) } });
let n = 0;
const target = (host = "8.8.8.8") => `https://${host}/hooks/${++n}`;

rig = await bootPaidWires({ label: "price-webhooks-paid", env: { PRICE_WEBHOOK_SIGNING_KEY: "a-signing-key-for-the-paid-test", PRICE_WEBHOOKS_FILE: file, PRICE_WEBHOOK_DELIVERIES: "off", PRICE_WEBHOOK_MAX_PER_PAYER: "2" } });
try {
  const unpaid = await rig.send(route(target()));
  await ok(unpaid.status === 402 && Object.keys(stored().subs).length === 0, `an unpaid registration answers 402 and stores nothing (${unpaid.status})`);

  for (const wire of ["evm", "tempo", "svm"]) {
    // Control: a funded wallet's registration settles and is kept.
    const good = await rig.wallet(wire);
    const urlGood = target();
    const paid = await rig.pay(good, route(urlGood, ["hash"]));
    await ok(paid.status === 200 && paid.json?.registered === true && /^pw_[0-9a-f]{32}$/.test(paid.json.id) && rig.outcomesOf(good).settled === 1, `${wire}: a settled registration answers 200 (control: ${paid.status}, settle ${JSON.stringify(rig.outcomesOf(good))})`);
    await ok(await eventually(() => { const s = stored().subs[paid.json.id]; return Boolean(s) && s.pending === undefined && s.url === urlGood; }), `${wire}: and is stored, confirmed, once its response has ended (${JSON.stringify(stored().subs[paid.json.id])})`);

    // A payment that verifies and is then refused at settlement.
    const broke = await rig.wallet(wire);
    rig.fund(broke, 0n, { shown: 10n ** 12n });
    const urlBroke = target();
    const call = rig.pay(broke, route(urlBroke));
    const sawPending = await eventually(() => subsFor(urlBroke).some(([, s]) => s.pending > Date.now() && s.pending <= Date.now() + PENDING_MS));
    const r = await call;
    await ok(sawPending, `${wire}: while the settlement is under way the registration is stored as pending (control: the handler ran)`);
    await ok(r.status === 402 && rig.outcomesOf(broke).refused === 1 && !/a402whsec_/.test(r.text), `${wire}: the settlement is refused and the call answers 402 without the secret (${r.status}, settle ${JSON.stringify(rig.outcomesOf(broke))})`);
    await ok(await eventually(() => subsFor(urlBroke).length === 0), `${wire}: a registration whose settlement failed leaves nothing stored (${JSON.stringify(subsFor(urlBroke))})`);
    await sleep(150);
    await ok(subsFor(urlBroke).length === 0 && stored().subs[paid.json.id] !== undefined, `${wire}: and it stays so, with the settled one untouched`);

    // The registrant is the payer: its own excess is refused, uncharged; nobody else's is.
    const second = await rig.pay(good, route(target("8.8.4.4")));
    const third = await rig.pay(good, route(target("8.8.4.4")));
    await ok(second.status === 200 && third.status === 409 && /already holds 2 price webhooks/.test(third.json?.error || "") && rig.outcomesOf(good).settled === 2, `${wire}: a payer's third registration past its cap of two is a 409 that says so, with nothing settled for it (${second.status}, ${third.status}, settle ${JSON.stringify(rig.outcomesOf(good))})`);
    const other = await rig.wallet(wire);
    const shared = await rig.pay(other, route(target("8.8.4.4")));
    await ok(shared.status === 200 && shared.json?.registered === true, `${wire}: another payer registers an endpoint on the same host (${shared.status})`);
    // The same URL again from the same payer renews it in place, at its cap.
    const renewal = await rig.pay(good, route(urlGood, ["uuid"]));
    await ok(renewal.status === 200 && renewal.json?.id === paid.json.id && renewal.json.secret === paid.json.secret && renewal.json.renewed === true && rig.outcomesOf(good).settled === 3, `${wire}: registering a URL it holds again renews it: the same id and secret (${renewal.status}, renewed ${renewal.json?.renewed})`);
    await ok(await eventually(() => { const s = stored().subs[paid.json.id]; return Boolean(s) && JSON.stringify(s.slugs) === JSON.stringify(["uuid"]) && s.renew === undefined; }), `${wire}: and takes the slugs it sent once that call has settled (${JSON.stringify(stored().subs[paid.json.id])})`);
    // A renewal whose settlement is refused changes nothing.
    const was = JSON.stringify(stored().subs[paid.json.id]);
    rig.fund(good, 0n, { shown: 10n ** 12n });
    const lapsed = await rig.pay(good, route(urlGood, ["hash", "search"]));
    await ok(lapsed.status === 402 && await eventually(() => stored().subs[paid.json.id]?.renew === undefined) && JSON.stringify(stored().subs[paid.json.id]) === was, `${wire}: a renewal whose settlement failed leaves the subscription as it was (${lapsed.status}; ${JSON.stringify(stored().subs[paid.json.id])})`);
  }
  await ok(!/0x[0-9a-fA-F]{40}|payer:|svm:|tempo:/.test(JSON.stringify(Object.values(stored().subs).map((s) => s.owner))) && Object.values(stored().subs).every((s) => /^o_[0-9a-f]{32}$/.test(s.owner)), "every stored subscription names its registrant by a digest, never by its wallet");
} finally { await rig.stop(); rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${pass} checks passed`);
