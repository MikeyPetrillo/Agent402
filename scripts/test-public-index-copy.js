#!/usr/bin/env node
// FACILITATOR_PUBLIC_INDEX_CHAINS: /privacy discloses that a facilitator we
// settle through publishes each settlement it relays on its public index, and
// /terms points to that paragraph, only while the switch lists a chain, with
// wording for exactly the chains listed (src/facilitator-public-index.js).
// The pages read the switch at render time, so each case renders them again.
//   node scripts/test-public-index-copy.js        (offline, no server)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { pageText } from "./lib/html-text.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const { privacyPage } = await import("../src/privacy.js");
const { termsPage } = await import("../src/terms.js");

const FIELDS = "publishes each settlement it relays on its public index: payer and payee wallets, amount, time, transaction hash and the service paid. Pay on another chain to keep a payment off that index.";
const PRIVACY = {
  "robinhood,solana": `On Robinhood Chain, and on Solana when a settlement falls back past its first facilitators, the facilitator that settles the payment ${FIELDS}`,
  robinhood: `On Robinhood Chain, the facilitator that settles the payment ${FIELDS}`,
  solana: `On Solana, only for a settlement that falls back past its first facilitators, the facilitator that settles the payment ${FIELDS}`,
};
const TERMS = {
  "robinhood,solana": "On Robinhood Chain, and on Solana for a settlement that falls back, the facilitator that settles a payment publishes it on its public index, as the privacy policy describes.",
  robinhood: "On Robinhood Chain, the facilitator that settles a payment publishes it on its public index, as the privacy policy describes.",
  solana: "On Solana, for a settlement that falls back, the facilitator that settles a payment publishes it on its public index, as the privacy policy describes.",
};
const render = (value) => {
  if (value === undefined) delete process.env.FACILITATOR_PUBLIC_INDEX_CHAINS; else process.env.FACILITATOR_PUBLIC_INDEX_CHAINS = value;
  const p = privacyPage("https://agent402.tools"), t = termsPage("https://agent402.tools");
  return { p, t, pt: pageText(p), tt: pageText(t) };
};
const ANY = /public index/;

for (const value of [undefined, "", " , ", "base,stellar"]) {
  const r = render(value);
  ok(!ANY.test(r.pt) && !r.p.includes('id="public-settlement-index"'), `privacy: no paragraph with the switch ${JSON.stringify(value ?? "unset")}`);
  ok(!ANY.test(r.tt) && !r.t.includes("/privacy#public-settlement-index"), `terms: no sentence with the switch ${JSON.stringify(value ?? "unset")}`);
}
for (const [value, key] of [["robinhood,solana", "robinhood,solana"], ["solana, Robinhood", "robinhood,solana"], ["robinhood", "robinhood"], ["solana", "solana"], ["solana,stellar", "solana"]]) {
  const r = render(value);
  ok(r.pt.includes(PRIVACY[key]), `privacy ${JSON.stringify(value)}: the ${key} paragraph, word for word`);
  ok((r.pt.match(/public index/g) || []).length === 1, `privacy ${JSON.stringify(value)}: one paragraph, no other chain's wording`);
  ok(/<li id="public-settlement-index">/.test(r.p), `privacy ${JSON.stringify(value)}: the paragraph carries the anchor terms links to`);
  ok(r.tt.includes(TERMS[key]) && (r.tt.match(/public index/g) || []).length === 1, `terms ${JSON.stringify(value)}: the ${key} sentence, once`);
  ok(r.t.includes('<a href="/privacy#public-settlement-index">privacy policy</a>'), `terms ${JSON.stringify(value)}: it links to the privacy paragraph`);
  for (const [name, html] of [["privacy", r.p], ["terms", r.t]]) ok(!/—/.test(html), `${name} ${JSON.stringify(value)}: no em dash`);
}
{
  const r = render("robinhood");
  ok(!/Solana when a settlement|falls back/.test(r.pt.slice(r.pt.indexOf("public index") - 300, r.pt.indexOf("public index"))), "robinhood only: the paragraph says nothing about Solana");
  const s = render("solana");
  ok(!/Robinhood Chain, the facilitator|On Robinhood Chain, and/.test(s.pt + s.tt), "solana only: neither page names Robinhood for the index");
}
delete process.env.FACILITATOR_PUBLIC_INDEX_CHAINS;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
