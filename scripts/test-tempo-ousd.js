#!/usr/bin/env node
// OUSD on the Tempo MPP rail (src/tempo-currencies.js).
//
// Offline: the address matches viem's token definition (mppx reads the same), the
// `ousd` name in TEMPO_CURRENCY resolves to it in every reader, the offers
// label it "OUSD", and the dollar readers (price-usd, sanctions-screen) value
// it at face with six decimals.
// Booted PAID server (scripts/lib/paid-wires-rig.js) with TEMPO_CURRENCY
// "usdc,ousd": the 402 lists the USDC.e challenge first and OUSD second, a
// pull credential for the OUSD challenge is checked and broadcast by the
// relay and answered 200 with a receipt, and the USDC.e one still pays
// (control). An OUSD credential is refused when TEMPO_CURRENCY does not list
// OUSD, with nothing broadcast.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { bootPaidWires } from "./lib/paid-wires-rig.js";

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-20)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };

const cur = await import("../src/tempo-currencies.js");
const OUSD = "0x20c0000000000000000000006a37DA5C996874BE";
const USDC_E = "0x20C000000000000000000000b9537d11c60E8b50";

// ---- offline ----
{
  const { ousd } = await import("viem/tokens");
  await ok(cur.TEMPO_OUSD_ADDRESS === OUSD && ousd(4217).address.toLowerCase() === OUSD.toLowerCase() && ousd(4217).decimals === 6, "the OUSD address and decimals match viem's definition on Tempo mainnet");
  for (const name of ["ousd", "OUSD", " Ousd "]) await ok(cur.resolveTempoCurrency(name) === OUSD, `TEMPO_CURRENCY name ${JSON.stringify(name)} resolves to OUSD`);
  await ok(cur.resolveTempoCurrency("usdc") === USDC_E && cur.resolveTempoCurrency("pathusd") === cur.TEMPO_PATH_USD_ADDRESS, "the usdc and pathusd names still resolve as before");
  await ok(cur.resolveTempoCurrency("0x2000000000000000000000000000000000000000") === "0x2000000000000000000000000000000000000000", "an address is kept as written");

  const saved = { ...process.env };
  Object.assign(process.env, { MPP_SECRET_KEY: "x".repeat(40), TEMPO_API_KEY: "stub", TEMPO_RECIPIENT_ADDRESS: "0x000000000000000000000000000000000000dEaD", TEMPO_CURRENCY: "usdc,ousd" });
  delete process.env.TEMPO_RELAY;
  const tempo = await import("../src/mpp-tempo.js");
  const info = tempo.tempoDiscoveryInfo();
  await ok(info?.currency === USDC_E && info.currencies.length === 2 && info.currencies[1] === OUSD, `"usdc,ousd": USDC.e is the first currency and OUSD the second (${JSON.stringify(info?.currencies)})`);
  const { mppOffersFor, tempoCurrencyLabel } = await import("../src/mpp-offers.js");
  const tempoOffers = mppOffersFor({ priceUsd: 0.01 }).filter((o) => o.method === "tempo");
  await ok(tempoOffers.map((o) => o.description).join("|") === "USDC.e on Tempo|OUSD on Tempo", `the offers name OUSD, after USDC.e (${tempoOffers.map((o) => o.description).join("|")})`);
  await ok(tempoCurrencyLabel(OUSD.toLowerCase()) === "OUSD" && tempoCurrencyLabel("0xabc") === "0xabc", "the label reads OUSD in any case; an unknown token keeps its address");
  // The Visa CLI sentence is read from the same offer: said on the MPP
  // surfaces while a tempo challenge names OUSD, and nowhere otherwise.
  {
    const { visaCliMppSentence, VISA_CLI_MPP_SENTENCE } = await import("../src/mpp-offers.js");
    const { llmsTxt, llmsFullTxt } = await import("../src/seo.js");
    const { whatIsMppPage } = await import("../src/what-is-mpp.js");
    const { howToPayPage } = await import("../src/how-to-pay.js");
    const surfaces = () => ({ "/llms.txt": llmsTxt("https://agent402.example.test", {}), "/llms-full.txt": llmsFullTxt("https://agent402.example.test", {}), "/what-is-mpp": whatIsMppPage("https://agent402.example.test", {}), "/how-to-pay": howToPayPage("https://agent402.example.test", {}) });
    await ok(VISA_CLI_MPP_SENTENCE === "Agents using Visa CLI can pay over MPP on Tempo." && visaCliMppSentence() === VISA_CLI_MPP_SENTENCE, "with OUSD listed the Visa CLI sentence is said");
    for (const [path, text] of Object.entries(surfaces())) await ok(text.split(VISA_CLI_MPP_SENTENCE).length === 2, `${path} says it once while OUSD is listed`);
    process.env.TEMPO_CURRENCY = "usdc,pathusd";
    await ok(visaCliMppSentence() === "", "without OUSD it is not said");
    for (const [path, text] of Object.entries(surfaces())) await ok(!/Visa/.test(text), `${path} names no Visa CLI without OUSD`);
    process.env.TEMPO_CURRENCY = "usdc,ousd";
    process.env.TEMPO_API_KEY = ""; process.env.TEMPO_RELAY = "";
    await ok(visaCliMppSentence() === "", "with the tempo method off it is not said");
    process.env.TEMPO_API_KEY = "stub";
  }
  process.env.TEMPO_CURRENCY = "ousd";
  await ok(tempo.tempoDiscoveryInfo()?.currency === OUSD, "the name resolves where TEMPO_CURRENCY names OUSD alone");
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);

  const { priceToMicroUsd } = await import("../src/price-usd.js");
  await ok(priceToMicroUsd({ amount: "5000", currency: OUSD, method: "tempo", intent: "charge" }) === 5000, "an MPP x-payment-info amount in OUSD reads as base units at six decimals ($0.005)");
  await ok(priceToMicroUsd({ amount: "5000", asset: OUSD.toLowerCase() }) === 5000, "and an accept naming the OUSD asset in lower case");
  const { transferUsd } = await import("../src/sanctions-screen.js");
  await ok(transferUsd({ destinationToken: { address: OUSD.toLowerCase(), symbol: "" }, destinationAmount: { baseUnits: "2500000" } }) === 2.5, "the funding screen values an OUSD transfer at face by its address, with no symbol or decimals");
}

// ---- the booted server ----
const ROUTE = { method: "GET", path: "/api/uuid" };
const tempoChallenges = (o) => o.challenges.filter((c) => c.method === "tempo" && c.intent === "charge");
rig = await bootPaidWires({ label: "tempo-ousd", env: { TEMPO_CURRENCY: "usdc,ousd" } });
try {
  const offer = await rig.offerOf(ROUTE);
  const tc = tempoChallenges(offer);
  await ok(offer.status === 402 && tc.length === 2, `the 402 carries two tempo challenges (${offer.status}, ${tc.length})`);
  await ok(offer.challenges[0]?.method === "tempo" && tc[0].request.currency === USDC_E && tc[1].request.currency === OUSD, `USDC.e leads and OUSD follows, so a stock client is unchanged (${tc.map((c) => c.request.currency).join(",")})`);
  await ok(tc[0].request.amount === tc[1].request.amount && /^\d+$/.test(tc[1].request.amount), "both carry the same base-units amount");

  const w = await rig.wallet("tempo");
  const b0 = rig.st.verifies;
  const paid = await rig.pay(w, ROUTE, { tempoCurrency: OUSD });
  await ok(paid.status === 200 && !!paid.headers.get("payment-receipt") && rig.st.verifies > b0, `an OUSD pull credential verifies and settles: 200 with a receipt (${paid.status} ${paid.text.slice(0, 160)})`);
  await ok(rig.outcomesOf(w).settled === 1, `the relay broadcast it once (${JSON.stringify(rig.outcomesOf(w))})`);

  const w2 = await rig.wallet("tempo");
  const paidE = await rig.pay(w2, ROUTE, { tempoCurrency: USDC_E });
  await ok(paidE.status === 200 && rig.outcomesOf(w2).settled === 1, `control: a USDC.e credential still pays (${paidE.status})`);
} finally { await rig.stop(); }

// Not listed, not taken: the same OUSD credential against a server whose
// TEMPO_CURRENCY names USDC.e alone is refused before any broadcast.
rig = await bootPaidWires({ label: "tempo-ousd-off", env: { TEMPO_CURRENCY: "usdc" } });
try {
  const offer = await rig.offerOf(ROUTE);
  await ok(tempoChallenges(offer).length === 1 && tempoChallenges(offer)[0].request.currency === USDC_E, "TEMPO_CURRENCY=usdc offers USDC.e only");
  const w = await rig.wallet("tempo");
  // The rig finds no OUSD challenge to copy, so build one from the USDC.e challenge's shape.
  const seen = tempoChallenges(offer)[0];
  const ch = rig.Challenge.from({ realm: seen.realm, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000), request: { amount: seen.request.amount, currency: OUSD, decimals: 6, recipient: seen.request.recipient, methodDetails: { chainId: 4217 } }, secretKey: rig.secret });
  const r = await rig.send(ROUTE, { Authorization: rig.Credential.serialize({ challenge: ch, payload: { signature: "0x76" + "00".repeat(60), type: "transaction" } }) });
  await ok(r.status !== 200 && rig.outcomesOf(w).settled === 0 && rig.st.verifies === 0, `an OUSD credential is refused when OUSD is not listed, nothing checked or broadcast (${r.status})`);
} finally { await rig.stop(); }

// No public surface types the Tempo token list: payment.info, the AgentCore
// page, /learn, the skill file, the FAQ and the README name the configured
// tokens (src/mpp-tempo.js tempoCurrencyPhrase) or none at all.
{
  const { readFileSync } = await import("node:fs");
  const TYPED = /USDC\.e (or|and|\(and) PathUSD|USDC\.e\/PathUSD|PathUSD (or|and) USDC\.e/;
  for (const f of ["src/mcp-http.js", "src/agentcore-page.js", "src/learn.js", "src/skill-md.js", "src/agentic-finance.js", "README.md"]) {
    await ok(!TYPED.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")), `${f} types no Tempo token list`);
  }
}

console.log(`\n${pass} checks passed`);
