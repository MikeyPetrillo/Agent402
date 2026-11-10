#!/usr/bin/env node
// Public sentences a review found saying something the code does not do, each
// pinned to the constant or switch that decides it, so the sentence cannot
// come back while the code stays as it is. Offline.
//   - card reports: the charge is taken at checkout (no manual capture).
//   - /privacy and /terms: job and task results, the funding screen's verdict
//     and the MPP subscription record, with the figures the server runs with.
//   - wiki/Self-Hosting.md: every payTo variable the payment setup reads, and
//     BASE_URL with its default.
//   - README: the leaderboard's refresh cadence.
//   - plain punctuation in answer strings and example READMEs, the Tempo
//     screening scope, the token risk descriptions and the README's tollbooth
//     paragraph, each as the review left it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const flat = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

// --- Card reports: charged at checkout ---------------------------------------
{
  const hc = read("src/human-checkout.js");
  const at = hc.indexOf("stripe.checkout.sessions.create({");
  const block = at >= 0 ? hc.slice(at, at + 2500) : "";
  const chargedAtCheckout = /mode: "payment"/.test(block) && !/capture_method/.test(hc);
  ok(chargedAtCheckout, "card report checkout is mode \"payment\" with no manual capture: the card is charged at checkout");
  const HELD = /held by the payment\s+processor/;
  ok(HELD.test("a card report purchase is held by the payment\nprocessor until the report is delivered"), "control: the held-until-delivery sentence is matched across a line break");
  for (const f of ["src/guides.js", "wiki/Payments-and-x402.md", "src/security-page.js", "src/terms.js", "README.md"]) {
    ok(!chargedAtCheckout || !HELD.test(read(f)), `${f} does not say a card report charge is held until delivery`);
  }
  for (const f of ["src/guides.js", "wiki/Payments-and-x402.md"]) {
    ok(/taken at checkout; if the\s+report fails to generate, the charge is refunded to the card automatically/.test(read(f)), `${f} says the charge is taken at checkout and refunded when the report fails`);
  }
  ok(/refundSession\(/.test(hc) && /stripe\.refunds\.create\(/.test(hc), "the failed-report refund the sentence names exists in the checkout module");
}

// --- /privacy and /terms: retention figures read from the modules ----------------
{
  const { taskRetentionPublic, createTaskStore, TASK_TTL_DEFAULT_MS, TASK_MAX_RESULT_DEFAULT_BYTES } = await import("../src/mcp-tasks.js");
  const { oneHopPublicBounds } = await import("../src/sanctions-screen.js");
  const { privacyPage } = await import("../src/privacy.js");
  const { termsPage } = await import("../src/terms.js");
  const KEYS = ["AGENT402_MCP_TASK_TTL_MS", "AGENT402_MCP_TASK_MAX_RESULT_BYTES", "SANCTIONS_ONE_HOP_TTL_MS"];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  const store = createTaskStore({ dir: mkdtempSync(join(tmpdir(), "copy-truth-tasks-")), log: () => {} });
  const jobs = taskRetentionPublic();
  ok(store.TTL_MS === TASK_TTL_DEFAULT_MS && store.MAX_RESULT_BYTES === TASK_MAX_RESULT_DEFAULT_BYTES && jobs.ttlMs === store.TTL_MS && jobs.maxBytes === store.MAX_RESULT_BYTES,
    `the printed job retention is the store's own (${jobs.keptFor}, ${jobs.maxSize})`);
  const check = (label) => {
    const j = taskRetentionPublic(), h = oneHopPublicBounds();
    const p = flat(privacyPage("https://agent402.test")), t = flat(termsPage("https://agent402.test"));
    ok(p.includes(`keeps its result (up to ${j.maxSize})`) && p.includes(`the record is deleted ${j.keptFor} after the job was created`) && /nightly backup made inside that time copies it/.test(p),
      `/privacy ${label}: job and task results, ${j.maxSize}, deleted after ${j.keptFor}, copied by a backup`);
    ok(p.includes(`result is deleted ${j.keptFor} after the job was created, and a wallet's funding-screen result after ${h.ttlDays} days`), `/privacy ${label}: the Retention section repeats both figures`);
    ok(p.includes(`inbound transfers (up to ${h.maxTransfers}, from the last ${h.lookbackDays} days)`) && p.includes(`is kept under the wallet address for ${h.ttlDays} days`),
      `/privacy ${label}: the funding screen reads ${h.maxTransfers} transfers and keeps its result ${h.ttlDays} days`);
    ok(t.includes(`which is kept for ${j.keptFor} after the job was created`), `/terms ${label}: generated content names the job result kept for ${j.keptFor}`);
    return { p, t };
  };
  const { p, t } = check("defaults");
  process.env.AGENT402_MCP_TASK_TTL_MS = String(2 * 60 * 60_000);
  process.env.AGENT402_MCP_TASK_MAX_RESULT_BYTES = String(4 * 1024 * 1024);
  process.env.SANCTIONS_ONE_HOP_TTL_MS = String(3 * 86400_000);
  ok(taskRetentionPublic().keptFor === "2 hours" && taskRetentionPublic().maxSize === "4 MB" && oneHopPublicBounds().ttlDays === 3, "the figures follow the server's settings");
  check("with other settings");
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }

  // "Everything we keep ... is listed below": the page says it, so the three
  // stores the review found missing stay listed.
  ok(/Everything we keep, and for how long, is listed below/.test(p), "/privacy still says everything kept is listed");
  // The MPP subscription record holds wallet, email and a signing key together.
  const subs = read("src/mpp-subscriptions.js");
  const recAt = subs.indexOf("const rec = {\n      subId,");
  const rec = recAt >= 0 ? subs.slice(recAt, recAt + 900) : "";
  ok(/email: b\.email/.test(rec) && /\bpayer, accessKeyAddress: b\.accessKeyAddress/.test(rec) && /typeof v\.privateKey === "string"/.test(subs),
    "an MPP subscription record holds the payer, the email and an access key");
  ok(!/For x402 and MPP payments there are no card numbers, names, or emails/.test(p), "/privacy no longer says MPP payments carry no email");
  ok(/A monitor subscription paid over MPP is different: its record holds the paying wallet together with/.test(p) && /the email you give for delivery \(optional\), and a signing key/.test(p),
    "/privacy names the MPP subscription record: wallet, email, signing key");
  // What happens to that record when the subscription ends, with the engine's own figures.
  const { ENDED_RECORD_KEEP_MS, ENDED_SWEEP_INTERVAL_MS } = await import("../src/mpp-subscription-retention.js");
  const { TOMBSTONE_FIELDS } = await import("../src/mpp-subscriptions.js");
  const keepDays = ENDED_RECORD_KEEP_MS / 86_400_000, sweepMin = ENDED_SWEEP_INTERVAL_MS / 60_000;
  const flatP = p.replace(/\s+/g, " ");
  ok(!/is kept for the life of the subscription and after it ends/.test(flatP) && !/subscription's record is kept after the subscription ends/.test(flatP), "/privacy no longer says the MPP subscription record and key are kept after it ends");
  ok(flatP.includes("it is deleted from our records when you cancel, when the expiry you signed passes, or when the subscription ends for any other reason") && flatP.includes("holds a copy until that backup is deleted"),
    "/privacy says when the signing key is deleted, and that a backup made before then holds a copy until it is deleted");
  ok(flatP.includes(`A check that runs every ${sweepMin} minutes does this for a subscription that ends on a date, and deletes the reduced record ${keepDays} days after the subscription ends.`) && flatP.includes(`record ${keepDays} days after it ends`),
    `/privacy prints the engine's figures: reduced record deleted after ${keepDays} days, by a check every ${sweepMin} minutes`);
  ok(flatP.includes("the email and the subject you asked us to watch are removed") && !TOMBSTONE_FIELDS.includes("email") && !TOMBSTONE_FIELDS.includes("target")
    && ["subId", "product", "payer", "accessKeyAddress", "chainId", "currency", "amountAtomic", "periodCount", "billingAnchor", "canceledAt", "status", "canceledReason", "lastChargeTx", "unconfirmedCharge"].every((k) => TOMBSTONE_FIELDS.includes(k)),
    "the reduced record's fields are the ones /privacy lists: id, product, wallet, key address, chain, token, amount, period, dates, final state, reason, last transaction, unconfirmed-payment marker; no email, no subject");
  const SENTENCE = "its record is reduced to the subscription's id and product, how it was paid (the payment rail and wire), whether it was one of our own test subscriptions, the paying wallet, the key's public address, the chain and token, the amount and billing period, the dates, the final state and the reason it ended, the last payment's transaction and a marker for a payment whose outcome was never confirmed;";
  ok(flatP.includes(SENTENCE), "/privacy lists the reduced record's rail, wire, test marker, chain, token, end reason and unconfirmed-payment marker");
  // Every kept field is named by words of the sentence itself: the words
  // each field reads as are looked up in the sentence as the page prints it,
  // so a field added to the record, or words dropped from the page, fail here.
  const WORDS = {
    subId: "the subscription's id", mppxSubscriptionId: "the subscription's id", lookupKey: "the subscription's id", product: "and product",
    rail: "the payment rail", wire: "and wire)", canary: "whether it was one of our own test subscriptions",
    payer: "the paying wallet", accessKeyAddress: "the key's public address", chainId: "the chain", currency: "and token",
    amountAtomic: "the amount", priceUsd: "the amount", periodCount: "billing period", periodUnit: "billing period", lastChargedPeriod: "billing period",
    createdAt: "the dates", billingAnchor: "the dates", subscriptionExpires: "the dates", lastChargeAt: "the dates", canceledAt: "the dates",
    status: "the final state", cancelAtPeriodEnd: "the final state", canceledReason: "the reason it ended",
    lastChargeTx: "the last payment's transaction", unconfirmedCharge: "a marker for a payment whose outcome was never confirmed",
  };
  const at = flatP.indexOf("its record is reduced to"), printed = at < 0 ? "" : flatP.slice(at, flatP.indexOf(";", at) + 1);
  const unnamed = TOMBSTONE_FIELDS.filter((k) => !WORDS[k] || !printed.includes(WORDS[k]));
  ok(printed.length > 0 && unnamed.length === 0, `every field the reduced record keeps is named by words in the /privacy sentence (${unnamed.join(", ") || "none unnamed"})`);
  ok(!/aside from short-lived caches that make repeated identical calls cheaper, not retained/.test(t), "/terms no longer says outputs are kept in caches only");
}

// --- wiki/Self-Hosting.md: every payTo variable, and BASE_URL -------------------
{
  const wiki = read("wiki/Self-Hosting.md");
  const names = new Set([...read("src/payments.js").matchAll(/process\.env\.([A-Z0-9]+_WALLET_ADDRESS)\b/g)].map((m) => m[1]));
  ok(["SOLANA_WALLET_ADDRESS", "STELLAR_WALLET_ADDRESS", "ALGORAND_WALLET_ADDRESS"].every((n) => names.has(n)), `the payment setup reads ${[...names].sort().join(", ")}`);
  for (const n of names) {
    const row = wiki.split("\n").find((l) => l.startsWith(`| \`${n}\` |`)) || "";
    ok(row.length > 0 && /boot warning/.test(row) && /out of the 402s/.test(row), `Self-Hosting documents ${n} and what an unset one does`);
    ok(new RegExp(`${n} is unset - "\\s*\\+\\s*"the \\w+ payment option will be OMITTED from every 402`).test(read("src/payments.js")), `the server warns and omits the option when ${n} is unset`);
  }
  const m = read("src/server.js").match(/const BASE_URL = process\.env\.BASE_URL \|\| `(http:\/\/[0-9.]+):\$\{PORT\}`;/);
  const baseRow = wiki.split("\n").find((l) => l.startsWith("| `BASE_URL` |")) || "";
  ok(!!m && baseRow.includes(`\`${m[1]}:<PORT>\``), `Self-Hosting documents BASE_URL and its default (${m ? m[1] : "not found"})`);
  ok(!/payTo \/ facilitator settings \(see below\)/.test(wiki), "the PAYMENT_NETWORKS row no longer points at a section that does not exist");
}

// --- README: the leaderboard's refresh cadence ----------------------------------
{
  const { LEADERBOARD_DEFAULT_REFRESH_MS, cadenceWords } = await import("../src/refresh-cadence.js");
  const readme = read("README.md");
  const words = cadenceWords(LEADERBOARD_DEFAULT_REFRESH_MS);
  const lines = readme.split("\n").filter((l) => l.includes("/api/leaderboard") && /snapshot/i.test(l));
  ok(lines.length >= 2 && lines.every((l) => l.includes(`The snapshot refreshes ${words}`)), `README's leaderboard lines say the snapshot refreshes ${words} (${lines.length} lines)`);
}

// --- Buyer-facing strings and example READMEs: plain punctuation ----------------
{
  const DASH = "—";
  ok(`a ${DASH} b`.includes(DASH) && !"a - b".includes(DASH), "control: the long dash is read, a hyphen is not");
  for (const f of ["examples/agentcore-x402-buyer/README.md", "examples/agentcore-x402-buyer/tempo-mpp-probe/README.md", "examples/agentcore/README.md", "workers/algorand-relay/README.md"]) {
    ok(!read(f).includes(DASH), `${f} uses plain punctuation`);
  }
  // One answer string per file, found by a phrase it keeps.
  for (const [f, anchor] of [
    ["src/tools/research-deep-kit.js", '"query" (string) is required'],
    ["src/server.js", 'reason: "no-merchant-data", note:'],
    ["src/settlement-proof.js", "matches no origin in our crawl"],
  ]) {
    const lines = read(f).split("\n").filter((l) => l.includes(anchor));
    ok(lines.length >= 1 && lines.every((l) => !l.includes(DASH)), `${f}: the answer string holding '${anchor}' uses plain punctuation (${lines.length} line(s))`);
  }
  const notice = read("NOTICE");
  ok(/full license texts/.test(notice) && !/licence/i.test(notice), "NOTICE spells license the US way");
}

// --- Tempo screening copy: per-call payments, as the screen runs ----------------
{
  const tempo = read("src/mpp-tempo.js");
  ok(/screens every Tempo payment/.test("which this server screens every Tempo payment against") && /every Tempo payment address/.test("screens every Tempo payment address against"), "control: the unscoped screening sentences are read");
  // The listed-address refusal is one sentence shared with the subscription screen.
  const screen = read("src/sanctions-screen.js");
  ok(!/every Tempo payment/.test(tempo) && !/every Tempo payment/.test(screen), "neither module says every Tempo payment, or every payment address, is screened");
  ok(/screens the addresses of a Tempo per-call payment against/.test(tempo), "the list-not-loaded refusal names a per-call payment");
  const sec = read("wiki/Security-Model.md");
  ok(!/every party to a payment\b/.test(sec) && /every party to a per-call payment is checked against/.test(sec), "wiki/Security-Model.md scopes the Tempo screen to a per-call payment");
}

// --- Token risk copy: the published evidence, no safety assurance ---------------
{
  const ASSURANCE = /Safety (?:verdict|headline)|one compact verdict|before an agent buys, quotes, or recommends/;
  ok(ASSURANCE.test("Safety verdict for one Solana token mint") && ASSURANCE.test("Safety headline for any") && ASSURANCE.test("one compact verdict for pre-trade"), "control: the assurance wording is read");
  const bazaar = read("src/payments.js").split("\n").find((l) => l.includes('"sol-token-safety": "')) || "";
  ok(bazaar.length > 0 && !ASSURANCE.test(bazaar) && /^\s*"sol-token-safety": "Risk summary for one Solana token mint/.test(bazaar) && /not a 'safe' or 'scam' verdict/.test(bazaar), "the listing description of sol-token-safety is a risk summary and says it is not a verdict");
  const { SOLANA_INTEL_TOOLS } = await import("../src/tools/solana-intel-kit.js");
  const def = (SOLANA_INTEL_TOOLS || []).find((x) => x.slug === "sol-token-safety");
  ok(!!def && !ASSURANCE.test(def.description) && def.description.startsWith("Risk summary for any Solana SPL token mint") && /never a 'safe' or 'scam' verdict/.test(def.description), "the catalog description of sol-token-safety is a risk summary and says it is not a verdict");
}

// --- README: tollbooth is described on its own terms -----------------------------
{
  const readme = read("README.md").replace(/\s+/g, " ");
  const COMPARED = /crypto-native answer to|no CDN lock-in/;
  ok(COMPARED.test("The open, crypto-native answer to another product: no CDN lock-in"), "control: the comparison sentence is read");
  ok(!COMPARED.test(readme) && readme.includes("Open source and self-hosted: no platform lock-in, no card processor required"), "README describes tollbooth as open source and self-hosted, with no comparison to another product");
}

console.log(`\ntest-copy-truth: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
