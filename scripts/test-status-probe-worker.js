#!/usr/bin/env node
// Offline test for workers/status-probe — the Cloudflare cron observer.
//
// This Worker decides what /status reports about production, so the failure
// that matters is not "it crashed", it is "it recorded a broken component as
// operational". Every check below drives the real probe() against a stubbed
// fetch and asserts the mapping, including the cases where production answers
// but answers WRONG (a 200 where a 402 is required, a collapsed catalog, a
// rail silently missing from the offer) — the quiet regressions a plain
// reachability check would wave through.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { probe, observe } from "../workers/status-probe/src/index.js";

const PROD = "https://prod.test";
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const offer = (nets) => btoa(JSON.stringify({ accepts: nets.map((n) => ({ network: n })) }));

/** Install a fetch stub. `over` overrides any leg of a healthy production. */
function stub(over = {}) {
  const healthy = {
    health: () => new Response("ok", { status: 200 }),
    pricing: () => Response.json({ endpoints: new Array(516).fill({}) }),
    mcp: () => new Response(JSON.stringify({ result: { serverInfo: { name: "agent402" } } }), { status: 200 }),
    extract: () => new Response("", { status: 402, headers: { "payment-required": offer(["eip155:8453", "solana:mainnet"]) } }),
    record: () => new Response("{}", { status: 200 }),
  };
  const legs = { ...healthy, ...over };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) return legs.health();
    if (u.endsWith("/api/pricing")) return legs.pricing();
    if (u.endsWith("/mcp")) return legs.mcp();
    if (u.endsWith("/api/extract")) return legs.extract();
    if (u.endsWith("/api/status/probe")) return legs.record();
    throw new Error("unexpected url " + u);
  };
}

console.log("status-probe worker — observation mapping");

{
  stub();
  const { components, fails } = await probe(PROD);
  check("healthy production: all five components operational", () => {
    for (const k of ["api", "catalog", "mcp", "paywall", "rails"]) {
      assert.equal(components[k]?.ok, true, `${k} should be ok`);
    }
    assert.equal(fails.length, 0);
  });
  check("healthy production: paid-call is never claimed", () => {
    assert.equal(components["paid-call"], undefined,
      "this observer cannot see the paid path; claiming it would be a fabricated observation");
  });
}

{
  // The dangerous one: production answers 200 instead of 402. A reachability
  // check calls that healthy; it is actually paid tools being given away.
  stub({ extract: () => new Response("{}", { status: 200 }) });
  const { components } = await probe(PROD);
  check("paywall serving 200 instead of 402 is an outage, not a success", () => {
    assert.equal(components.paywall.ok, false);
    assert.match(components.paywall.detail, /200/);
  });
  check("an unreadable offer marks rails down rather than guessing", () => {
    assert.equal(components.rails.ok, false);
  });
}

{
  stub({ extract: () => new Response("", { status: 402, headers: { "payment-required": offer(["solana:mainnet"]) } }) });
  const { components } = await probe(PROD);
  check("Base dropping out of the offer is caught even though the 402 is correct", () => {
    assert.equal(components.paywall.ok, true, "the paywall itself is fine");
    assert.equal(components.rails.ok, false, "but the rail is gone");
  });
}

{
  stub({ pricing: () => Response.json({ endpoints: new Array(12).fill({}) }) });
  const { components } = await probe(PROD);
  check("a collapsed catalog is caught (12 routes is not a catalog)", () => {
    assert.equal(components.catalog.ok, false);
    assert.match(components.catalog.detail, /12/);
  });
  check("a collapsed catalog does not drag unrelated components down", () => {
    assert.equal(components.api.ok, true);
    assert.equal(components.mcp.ok, true);
  });
}

{
  stub({ mcp: () => new Response(JSON.stringify({ result: {} }), { status: 200 }) });
  const { components } = await probe(PROD);
  check("a 200 from /mcp without the server identity is still a failure", () => {
    assert.equal(components.mcp.ok, false);
  });
}

{
  stub({ health: () => { throw new Error("ECONNREFUSED"); } });
  const { components } = await probe(PROD);
  check("a thrown request records a failure, never a silent pass", () => {
    assert.equal(components.api.ok, false);
    assert.match(components.api.detail, /ECONNREFUSED/);
  });
  check("one dead endpoint does not abort the remaining checks", () => {
    assert.equal(components.catalog.ok, true, "catalog should still have been probed");
    assert.equal(components.paywall.ok, true, "paywall should still have been probed");
  });
}

{
  // Total outage: every leg throws. Nothing may come back ok.
  const dead = () => { throw new Error("down"); };
  stub({ health: dead, pricing: dead, mcp: dead, extract: dead });
  const { components } = await probe(PROD);
  check("total outage marks every observed component down", () => {
    for (const [k, v] of Object.entries(components)) assert.equal(v.ok, false, `${k} claimed ok during a total outage`);
    assert.ok(Object.keys(components).length >= 5);
  });
}

{
  // Deploy-blip retry (2026-07-29): a single failed attempt that recovers by
  // the retry is recorded CLEAN — one probe landing inside a deploy restart
  // must not amber the whole day's bar on /status.
  let calls = 0;
  const blip = () => { calls++; if (calls === 1) throw new Error("connection reset"); return new Response("ok", { status: 200 }); };
  stub({ health: blip });
  const result = await observe(PROD, { sleep: async () => {} });
  check("transient blip: retry succeeds and is recorded clean", () => {
    assert.equal(result.retried, true, "should have retried");
    assert.equal(result.fails.length, 0, `expected no recorded fails, got: ${result.fails.join(" ")}`);
    assert.equal(result.components.api.ok, true);
  });
}

{
  // A failure that SURVIVES the retry is a real outage and must be recorded —
  // the retry may never soften a sustained failure.
  const dead = () => { throw new Error("down"); };
  stub({ health: dead });
  const result = await observe(PROD, { sleep: async () => {} });
  check("sustained failure: recorded down even after the retry", () => {
    assert.equal(result.retried, true);
    assert.equal(result.components.api.ok, false, "a real outage must never be retried away");
    assert.ok(result.fails.some((f) => f.startsWith("api(")));
  });
}

{
  // Healthy path never pays the retry pause.
  stub();
  let slept = false;
  const result = await observe(PROD, { sleep: async () => { slept = true; } });
  check("healthy production: no retry, no pause", () => {
    assert.equal(result.retried, false);
    assert.equal(slept, false, "healthy path must not sleep");
  });
}


// --- the alarms ------------------------------------------------------------
// heartbeat.yml carries eighteen alarm checks and is their ONLY observer, but
// GitHub does not deliver its schedule: measured 2026-08-30, `*/15` gave gaps
// of 2-12 h and a gentler `9,39` gave ONE run in 9.8 h. This Worker's 5-minute
// cron IS honoured, so it takes over every alarm readable from one public
// endpoint. These pin the four properties that keep a faster observer from
// being worse than a slow one: it never pages on a single reading, it never
// closes on silence, it never duplicates the workflow's issue, and it cannot
// spend or deploy anything (issues-only credential, no workflow dispatch).
{
  const { syncAlarms, judge, ALARMS } = await import("../workers/status-probe/src/index.js");
  const acheck = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}`); console.log(`       ${e.message}`); }
  };
  const HEALTHY_GATEWAY = {
    status: "ok",
    upstreamBuyer: { status: "ok", trend: "ok" },
    upstreamBuyerAvm: { status: "ok" },
    upstreamBuyerTempo: { status: "ok" },
    subscriptionFeePayer: { status: "ok" },
    databases: { leads: { status: "ok" }, analytics: { status: "ok" } },
    operatorAuth: { status: "ok" },
  };
  const HEALTHY_STATUS = { components: [{ key: "settlement", current: { state: "operational", ageMs: 3600000 } }] };
  const HEALTHY = { gateway: HEALTHY_GATEWAY, status: HEALTHY_STATUS };
  const withGateway = (over) => ({ gateway: { ...HEALTHY_GATEWAY, ...over }, status: HEALTHY_STATUS });
  const ENV = { GITHUB_ISSUES_TOKEN: "t" };
  const realFetch = globalThis.fetch;
  let created, closed, comments, calls;
  const mkGh = (openIssues = []) => {
    created = []; closed = []; comments = []; calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url); const m = (init.method || "GET").toUpperCase();
      calls.push(`${m} ${u.replace("https://api.github.com", "")}`);
      if (u.includes("/issues?state=open")) return Response.json(openIssues);
      if (m === "POST" && /\/issues$/.test(u)) { created.push(JSON.parse(init.body)); return new Response("{}", { status: 201 }); }
      if (m === "POST" && /\/comments$/.test(u)) { comments.push(JSON.parse(init.body)); return new Response("{}", { status: 201 }); }
      if (m === "PATCH" && /\/issues\/\d+$/.test(u)) { closed.push(u); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    };
  };
  const nosleep = { sleep: async () => {}, confirmDelayMs: 0 };
  const feed = (...bodies) => { let i = 0; return async () => bodies[Math.min(i++, bodies.length - 1)]; };

  await acheck("a healthy read opens nothing", async () => {
    mkGh();
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.opened, []); assert.deepEqual(r.bad, []);
    assert.ok(!calls.some((c) => c.startsWith("POST")), `posted: ${calls}`);
  });

  await acheck("a bad reading CONFIRMED by a second read opens exactly one issue", async () => {
    mkGh();
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "ok" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(r.opened, ["Upstream buyer wallet LOW (x402)"]);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, "Upstream buyer wallet LOW (x402)");
  });

  // The class that filed #1057 on a perfectly healthy service: production is
  // volume-backed, so every deploy has a 60-90s no-container window and a
  // reading taken inside it is indistinguishable from a fault.
  await acheck("a bad reading the second read does NOT confirm pages nobody", async () => {
    mkGh();
    const bad = withGateway({ databases: { leads: { status: "unreachable" }, analytics: { status: "ok" } } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(bad, HEALTHY) });
    assert.deepEqual(r.opened, []);
    assert.equal(created.length, 0, `created: ${JSON.stringify(created)}`);
  });

  await acheck("an alarm the workflow already opened is never duplicated", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "ok" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(r.opened, []);
    assert.equal(created.length, 0);
    // and it does not comment either: 288 ticks a day would be 288 comments
    assert.equal(comments.length, 0);
  });

  await acheck("recovery closes the open issue, whoever opened it", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.closed, ["Upstream buyer wallet LOW (x402)"]);
    assert.equal(closed.length, 1);
    assert.equal(comments.length, 1);
  });

  await acheck("a pull request with a colliding title is not an alarm", async () => {
    mkGh([{ number: 9, title: "Upstream buyer wallet LOW (x402)", pull_request: { url: "x" } }]);
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "ok" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(r.opened, ["Upstream buyer wallet LOW (x402)"]);
  });

  // unknown/unconfigured must do NOTHING - never page, and never close a real
  // alarm on the strength of silence.
  await acheck("unknown neither opens nor closes", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const unk = withGateway({ status: "unknown", upstreamBuyer: { status: "unknown", trend: "unknown" } });
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(unk) });
    assert.deepEqual(r.opened, []); assert.deepEqual(r.closed, []);
    assert.equal(created.length + closed.length, 0);
  });

  await acheck("an unreadable endpoint changes nothing at all", async () => {
    mkGh([{ number: 77, title: "Upstream buyer wallet LOW (x402)" }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: async () => { throw new Error("502"); } });
    assert.match(r.error, /unreadable/);
    assert.equal(created.length + closed.length, 0);
    assert.ok(!calls.length, `touched GitHub: ${calls}`);
  });

  await acheck("without a token it is an env-gated no-op", async () => {
    mkGh();
    const r = await syncAlarms({}, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.match(r.error, /no GITHUB_ISSUES_TOKEN/);
    assert.ok(!calls.length);
  });

  // The whole point of choosing issues:write over actions:write. A token that
  // can dispatch workflows can deploy production (deploy.yml), post as the
  // company (announce.yml) and spend the canary and refund wallets.
  await acheck("it never calls a workflow dispatch or any Actions endpoint", async () => {
    mkGh();
    const low = withGateway({ upstreamBuyer: { status: "low", trend: "draining" } });
    await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.ok(!calls.some((c) => /\/actions\/|dispatches/.test(c)), `Actions call: ${calls}`);
  });

  await acheck("the unreadable-balance alarm needs 180 minutes, not one bad read", async () => {
    assert.equal(judge({ gateway: { status: "unknown", unknownForMinutes: 30 } })["Gateway balance UNREADABLE (OpenRouter)"], "quiet");
    assert.equal(judge({ gateway: { status: "unknown", unknownForMinutes: 200 } })["Gateway balance UNREADABLE (OpenRouter)"], "bad");
  });

  // Settlement freshness moved here from heartbeat.yml on 2026-08-30: GitHub
  // was delivering that workflow about once every five hours, and the canary
  // had already gone 16 h without buying with nothing paging.
  const SETTLE = "Settlement stale - the paid canary is not buying";
  await acheck("a stale settlement observation pages", async () => {
    mkGh();
    const stale = { gateway: HEALTHY_GATEWAY, status: { components: [{ key: "settlement", current: { state: "unknown", ageMs: 99 * 3600000 } }] } };
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(stale, stale) });
    assert.deepEqual(r.opened, [SETTLE]);
    assert.match(created[0].body, /99h/);
    // It cannot dispatch the canary (issues-only credential), so it must SAY so.
    assert.match(created[0].body, /gh workflow run paid-canary\.yml/);
  });
  await acheck("a fresh settlement observation closes it", async () => {
    mkGh([{ number: 5, title: SETTLE }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(HEALTHY) });
    assert.deepEqual(r.closed, [SETTLE]);
  });
  await acheck("an unreadable /api/status neither pages nor closes settlement", async () => {
    mkGh([{ number: 5, title: SETTLE }]);
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed({ gateway: HEALTHY_GATEWAY, status: null }) });
    assert.deepEqual(r.opened, []); assert.deepEqual(r.closed, []);
  });
  await acheck("the gateway alarms still work when /api/status is missing", async () => {
    mkGh();
    const low = { gateway: { ...HEALTHY_GATEWAY, upstreamBuyer: { status: "low", trend: "ok" } }, status: null };
    const r = await syncAlarms(ENV, { ...nosleep, fetchStatus: feed(low, low) });
    assert.deepEqual(r.opened, ["Upstream buyer wallet LOW (x402)"]);
  });

  await acheck("every alarm title also exists in heartbeat.yml, so the two never fork", async () => {
    const yml = await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
    for (const a of ALARMS) assert.ok(yml.includes(a.title), `heartbeat.yml has no "${a.title}"`);
  });

  globalThis.fetch = realFetch;
}

// --- the deploy workflow ---------------------------------------------------
// Nothing deployed this Worker for a month: CI tested workers/status-probe on
// every push and no step shipped it, so on 2026-08-30 the live code was from
// 07-29 with three merged commits behind it. A deploy step fixes that instance;
// what rots is the step itself, so pin the two properties that make it worth
// having - it fails loudly with no credential, and it proves the deploy against
// the RUNNING Worker rather than trusting wrangler's exit code.
{
  const wf = await readFile(new URL("../.github/workflows/deploy-status-probe.yml", import.meta.url), "utf8");
  const acheck = (name, cond) => {
    if (cond) { console.log(`  ok   ${name}`); }
    else { failures++; console.log(`  FAIL ${name}`); }
  };
  acheck("it deploys on a push to main that touches the worker", /branches:\s*\[main\]/.test(wf) && /workers\/status-probe\/\*\*/.test(wf));
  acheck("a missing CLOUDFLARE_API_TOKEN FAILS the run, never a silent pass", /::error::CLOUDFLARE_API_TOKEN is not set/.test(wf) && /exit 1/.test(wf));
  acheck("the sha is injected so the running Worker can be asked what it is", /--var BUILD_SHA:/.test(wf));
  acheck("the deploy is verified against the live Worker, not wrangler's exit code", /\/run/.test(wf) && /\.recorded == true/.test(wf));
  // It must POLL for propagation (Cloudflare's edge lags a deploy by seconds)
  // but still FAIL if the new build never arrives: "deployed but not serving"
  // is the state this check exists to catch.
  acheck("and the verify requires the reported build to BE the deployed sha", /still reports build \$BUILD, not \$GITHUB_SHA/.test(wf));
  acheck("it polls for edge propagation rather than reading once", /edge still serving/.test(wf) && /for i in \$\(seq 1 20\)/.test(wf));
  acheck("a daily drift check exists and can page", /schedule:/.test(wf) && /Status probe Worker is NOT the code on main/.test(wf));
  acheck("an unreadable Worker is 'unknown', never reported as drift", /state=unknown/.test(wf));
  acheck("the drift issue auto-closes on recovery", /gh issue close/.test(wf));
  // The Worker has to actually serve the identity the workflow reads.
  const src = await readFile(new URL("../workers/status-probe/src/index.js", import.meta.url), "utf8");
  acheck("the Worker serves /version with its BUILD_SHA", /"\/version"/.test(src) && /env\.BUILD_SHA/.test(src));
}

console.log(failures ? `\nFAILED (${failures})` : "\nall passed");
process.exit(failures ? 1 : 0);
