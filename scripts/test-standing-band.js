#!/usr/bin/env node
// The framing paragraph on /revenue, /proof and /leaderboard.
//
// It exists because a diligence review found the same thing on all three:
// every number was true, published on purpose, and unframed - so the reader
// supplied the frame, and the frame they reach for from "$109 lifetime" is
// "small business" rather than "market operator that publishes its own P&L".
//
// The band is the one sentence asking to be trusted, which makes two things
// non-negotiable: every figure is DERIVED, and a cold cache says NOTHING
// rather than a wrong number.
import { strict as assert } from "node:assert";
import { standingBand, standingCountsExcludingHost } from "../src/standing.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const text = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// --- a cold or half-loaded index must stay silent ---------------------------
// The crawl cache warm-starts incrementally and holds only our own entry for
// the first seconds of a boot. "1 seller origin indexed" is true and useless,
// and publishing it inside the sentence that asks to be trusted is worse than
// publishing nothing.
for (const cold of [{}, { sellers: 0 }, { sellers: 1, listings: 581, rails: 12 }, { sellers: 49 }]) {
  ok(standingBand(cold) === "", `a cold index publishes no frame (${JSON.stringify(cold)})`);
}
ok(standingBand({ sellers: 50 }) !== "", "at the floor it speaks");

// --- warm: every figure present ---------------------------------------------
{
  const t = text(standingBand({ sellers: 4153, listings: 101583, settled: 42934, ourUsd: 109.42, rails: 12 }));
  ok(/4,153 seller origins indexed/.test(t), "sellers, with thousands separators");
  ok(/101,583 tool listings/.test(t), "listings");
  ok(/42,934 settlements through these gates/.test(t), "settlements, described as throughput rather than revenue");
  ok(/12 payment rails/.test(t), "rails");
  ok(!/is ours/.test(t) && !/109\.42/.test(t),
     "the host's revenue is NOT restated in the band: it followed a list of counts as 'Of that, $N is ours', a dollar figure with no dollar total to be of (2026-09-14)");
  ok(/we index this market, we are not trying to be it/i.test(t), "and the frame is stated, not implied");
  ok(/ranks other sellers above this one/.test(t),
     "the leaderboard ranking a rival above us is cited AS the evidence of neutrality, which is the reason to trust the index at all");
}

// --- grammar, because a framing sentence with a plural bug reads careless ---
{
  const one = text(standingBand({ sellers: 50, settled: 1, rails: 1 }));
  ok(/1 settlement through/.test(one) && !/1 settlements/.test(one), "singular settlement");
  ok(/1 payment rail\b/.test(one) && !/1 payment rails/.test(one), "singular rail");
}

// --- a figure that cannot be read is omitted, never guessed -----------------
{
  const partial = text(standingBand({ sellers: 4153 }));
  ok(/4,153 seller origins indexed/.test(partial), "what is known is stated");
  ok(!/listings|settlements|rails/.test(partial), "and what is not known is simply absent");
  ok(!/\$/.test(partial), "with no dollar figure invented when the ledger could not be read");
}

// --- it is wired into all three pages, from source -------------------------
{
  const { readFileSync } = await import("node:fs");
  for (const [file, label] of [["../src/revenue-live.js", "/revenue"], ["../src/proof.js", "/proof"], ["../src/ledger-leaderboard.js", "/leaderboard"]]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    ok(/standingBand\(/.test(src), `${label} renders the band`);
  }
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/function standingFigures\(\)/.test(server), "one derivation feeds all three");
  ok(/standingCountsExcludingHost\(getIndexSnapshot\(\)\)/.test(server), "...read from the index, host left out, not typed into the copy");
  ok(!/standing: \{ sellers: idx\.sellers/.test(server), "/revenue's band goes through the same derivation");
  // The settled figure beside the rail count includes Tempo, so the rail
  // count must include it too, on every page the band renders.
  ok(/function settlementRailCount\(\) \{\s*return RAILS\.length \+ \(tempoEnabled\(\) \? 1 : 0\);/.test(server), "the rail count adds Tempo when its relay is on");
  ok(!/rails: RAILS\.length/.test(server), "no band is fed the x402-only rail count");
}

// --- the band says the host is in no count, so the counts leave it out -------
{
  const snap = { totals: { sellers: 4732, tools: 128772 }, sellers: [{ local: true, toolCount: 584 }, { origin: "https://a.example", toolCount: 3 }] };
  const c = standingCountsExcludingHost(snap);
  ok(c.sellers === 4731 && c.listings === 128188, `host row and its tools left out (got ${c.sellers} / ${c.listings})`);
  const none = standingCountsExcludingHost({ totals: { sellers: 10, tools: 50 }, sellers: [] });
  ok(none.sellers === 10 && none.listings === 50, "no local row, nothing subtracted");
  ok(standingCountsExcludingHost(null).sellers === 0, "no snapshot reads zero, which suppresses the band");
}

console.log(`\ntest-standing-band: ${n} assertions OK`);
