#!/usr/bin/env node
// /openapi.json prose about payment must name what the 402 offers, read from
// the same config. The per-operation clause once said "MPP (Tempo or Base)" on
// every route while the evm challenges cover Base and Celo by default
// (MPP_CHALLENGE_NETWORKS) and identity-bound / long-running routes get no
// tempo challenge; the creditsKey scheme pointed at /credits for purchase while
// credit sales are off unless CREDITS_SALES is set. Offline: openapiSpec is
// driven directly on a three-route fixture catalog under controlled env.
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

for (const k of ["MPP_CHALLENGE_NETWORKS", "STRIPE_SECRET_KEY", "STRIPE_PROFILE_ID", "CREDITS_SALES", "TEMPO_RECIPIENT_ADDRESS", "NETWORK"]) delete process.env[k];
process.env.MPP_SECRET_KEY = "test-secret";
process.env.TEMPO_API_KEY = "test-tempo";
process.env.WALLET_ADDRESS = "0x" + "1".repeat(40);
process.env.PAYMENT_NETWORKS = "base,celo,polygon";

const { openapiSpec } = await import("../src/pages.js");
const mk = (slug, extra = {}) => ({ name: slug, slug, category: "x", price: "$0.001", description: "d", discovery: { inputSchema: { type: "object", properties: {} } }, ...extra });
const catalog = {
  "GET /api/a": mk("a"),
  "POST /api/m": mk("m", { identityBound: true }),
  "POST /api/l": mk("l", { longRunning: true }),
};
const clauseOf = (spec, path) => Object.values(spec.paths[path])[0].description.split("\n\n")[1];
const offersOf = (spec, path) => Object.values(spec.paths[path])[0]["x-payment-info"].offers;

{
  const spec = openapiSpec("https://example.test", catalog);
  const a = clauseOf(spec, "/api/a");
  ok(/or MPP \(Tempo, Base or Celo\)\./.test(a), `an ordinary route names Tempo, Base and Celo (got: ${a})`);
  ok(!/Tempo or Base\)/.test(a), "the old fixed clause is gone");
  const m = clauseOf(spec, "/api/m"), l = clauseOf(spec, "/api/l");
  ok(/or MPP \(Base or Celo\)\./.test(m) && !/Tempo/.test(m), `an identity-bound route names no Tempo (got: ${m})`);
  ok(/or MPP \(Base or Celo\)\./.test(l) && !/Tempo/.test(l), `a long-running route names no Tempo (got: ${l})`);
  // The clause and x-payment-info read one offer list.
  for (const p of ["/api/a", "/api/m", "/api/l"]) {
    const rails = [...new Set(offersOf(spec, p).map((o) => (o.method === "tempo" ? "Tempo" : o.description.replace(/^.* on /, ""))))];
    ok(rails.every((r) => clauseOf(spec, p).includes(r)), `${p}: every offered rail is named in the clause`);
  }
  ok(/or over MPP \(Machine Payments Protocol: [^)]*Tempo[^)]*USDC on Base or Celo\)/.test(spec.info.description), "info.description names the instance's MPP rails");
  const ck = spec.components.securitySchemes.creditsKey.description;
  ok(/GET \/api\/credits\/balance/.test(ck) && /not on sale/.test(ck) && !/sold at \/credits/.test(ck), `with sales off, creditsKey points at the balance read and offers no purchase (got: ${ck})`);
}

{
  process.env.MPP_CHALLENGE_NETWORKS = "8453";
  const spec = openapiSpec("https://example.test", catalog);
  ok(/or MPP \(Tempo or Base\)\./.test(clauseOf(spec, "/api/a")), "MPP_CHALLENGE_NETWORKS narrows the clause the way it narrows the 402");
  delete process.env.MPP_CHALLENGE_NETWORKS;
}

{
  delete process.env.MPP_SECRET_KEY;
  delete process.env.TEMPO_API_KEY;
  const spec = openapiSpec("https://example.test", catalog);
  const a = clauseOf(spec, "/api/a");
  ok(!/MPP/.test(a) && /via x402\)$/.test(Object.values(spec.paths["/api/a"])[0].summary), `with MPP off, no operation promises MPP (got: ${a})`);
  ok(!/over MPP/.test(spec.info.description), "and info.description promises none");
}

{
  process.env.CREDITS_SALES = "on";
  const spec = openapiSpec("https://example.test", catalog);
  ok(/sold at \/credits/.test(spec.components.securitySchemes.creditsKey.description), "with sales on, creditsKey offers purchase at /credits");
  delete process.env.CREDITS_SALES;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
