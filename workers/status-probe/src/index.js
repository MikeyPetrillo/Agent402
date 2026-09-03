// status-probe — Cloudflare Worker that observes agent402.tools from OUTSIDE
// production on a cron trigger, and records what it saw on /api/status/probe.
//
// Why this exists: /status is only as good as its observer, and the observer
// was a single GitHub Actions schedule. GitHub delivers a "*/15" cron roughly
// once an HOUR (measured 2026-07-27: 60-72 min gaps, plus a 3.3h stall), so a
// perfectly healthy production kept reading "degraded" — every component past
// its 45-minute staleness threshold with nobody looking. The heartbeat now
// re-probes within each run, which covers routine throttling, but nothing
// covers GitHub simply not running for hours. This does: Cloudflare cron
// triggers are a completely independent scheduler on independent infra, so a
// GitHub outage and a Cloudflare outage are not the same event.
//
// WHAT IT DELIBERATELY DOES NOT DO: the paid-call probe. That requires solving
// a 16-bit proof-of-work AND minting an X-Heartbeat-Token from POW_SECRET.
// Copying POW_SECRET onto a second platform widens the blast radius of that
// secret, and WITHOUT it every probe would be counted as genuine external
// free-tier demand — 288 synthetic calls a day against ~130 real ones, which
// would corrupt the free-tier series on /revenue outright. So paid-call stays
// the GitHub heartbeat's job, and src/status.js sizes that component's
// staleness against ITS observer, not this one.
//
// Deploy: see README.md. Requires the OPERATOR_TOKEN secret.

const REQUIRED_NETWORK = "eip155:8453"; // Base is always expected in the offer
const CATALOG_FLOOR = 400; // matches the heartbeat + sync-count floor

/** Fetch with a hard timeout so one hung endpoint can't stall the whole run. */
async function grab(url, init = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Observe production. Returns { components, fails } where components maps the
 * /status component keys to {ok, detail}. Any thrown error is a failed check,
 * never a failed run: an observation we could not make must be recorded as a
 * failure or not at all, never silently as success.
 */
export async function probe(prod) {
  const components = {};
  const fails = [];
  const mark = (key, ok, detail) => {
    components[key] = { ok, detail: ok ? null : detail || "failed" };
    if (!ok) fails.push(`${key}(${detail || "failed"})`);
  };

  // api — is it serving at all
  try {
    const r = await grab(`${prod}/health`);
    mark("api", r.ok, r.ok ? null : `health ${r.status}`);
  } catch (e) {
    mark("api", false, `health ${String(e?.message || e).slice(0, 60)}`);
  }

  // catalog — every route still mounted and advertised
  try {
    const r = await grab(`${prod}/api/pricing`);
    const j = await r.json();
    const n = Array.isArray(j?.endpoints) ? j.endpoints.length : 0;
    mark("catalog", n >= CATALOG_FLOOR, `${n} endpoints`);
  } catch (e) {
    mark("catalog", false, String(e?.message || e).slice(0, 60));
  }

  // mcp — the connector agents actually attach to
  try {
    const r = await grab(`${prod}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cf-status-probe", version: "1" } },
      }),
    });
    const body = await r.text();
    mark("mcp", body.includes('"agent402"'), `mcp ${r.status}`);
  } catch (e) {
    mark("mcp", false, String(e?.message || e).slice(0, 60));
  }

  // paywall + rails — one unpaid request answers both. The paywall must be
  // ENGAGED (402, not 200: a 200 here is silent revenue loss), and the 402's
  // accepts must still carry Base, because a rail dropping out of the offer
  // loses that chain's revenue with no error anywhere.
  try {
    const r = await grab(`${prod}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const is402 = r.status === 402;
    mark("paywall", is402, `paywall ${r.status}`);
    if (!is402) {
      mark("rails", false, "no 402 to read the offer from");
    } else {
      const hdr = r.headers.get("payment-required") || "";
      let nets = [];
      try {
        const decoded = JSON.parse(atob(hdr));
        nets = (decoded?.accepts || []).map((a) => a?.network).filter(Boolean);
      } catch {
        /* fall through to the unparsed branch below */
      }
      if (!nets.length) mark("rails", false, "offer unparsed");
      else mark("rails", nets.includes(REQUIRED_NETWORK), `base missing: ${nets.join(",").slice(0, 80)}`);
    }
  } catch (e) {
    mark("paywall", false, String(e?.message || e).slice(0, 60));
    mark("rails", false, "paywall probe threw");
  }

  return { components, fails };
}

/**
 * Probe with one retry: a deploy switchover blip lasts seconds, but a recorded
 * failure ambers the whole day's bar on /status - which reads as "currently
 * degraded" against a perfectly healthy service (2026-07-29: 6 of 7 amber days
 * traced to single probes landing inside deploy restarts). Only a failure that
 * SURVIVES the pause is recorded; a real outage fails both attempts and is
 * recorded exactly as before. The first attempt's failure still goes to the
 * worker log, so the blip itself is never invisible.
 */
export async function observe(prod, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 20000 } = {}) {
  const first = await probe(prod);
  if (!first.fails.length) return { ...first, retried: false };
  await sleep(retryDelayMs);
  const second = await probe(prod);
  console.log(`status-probe: first attempt FAILS ${first.fails.join(" ")} - after ${retryDelayMs}ms retry: ${second.fails.length ? `FAILS ${second.fails.join(" ")}` : "clean (transient blip, not recorded as down)"}`);
  return { ...second, retried: true };
}

/** POST the observation. Returns true only if production accepted it. */
async function record(prod, token, components, url) {
  const r = await grab(`${prod}/api/status/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Operator-Token": token },
    body: JSON.stringify({ source: "cloudflare-cron", ts: Date.now(), url, components }),
  }, 20000);
  return r.ok;
}
// ---------------------------------------------------------------------------
// Alarms.
//
// heartbeat.yml carries eighteen alarm checks and is their only observer, but
// GitHub does not deliver its schedule: measured 2026-08-30, "*/15" produced
// gaps of 2-12 hours and a gentler "9,39" produced ONE run in 9.8 hours. At a
// five-hour cadence a drained wallet or a dead database goes unseen for hours
// and a resolved alarm stays open long after the operator fixed it.
//
// This Worker's five-minute Cloudflare cron IS honoured, so it takes over the
// subset of those checks that read a SINGLE public endpoint - /api/gateway-status
// - which is every balance and reachability alarm. The rest (the production
// probe, settlement freshness, the quota watches, the canary burner) stay on
// heartbeat.yml: they need data this Worker cannot cheaply reach.
//
// The credential is a fine-grained PAT scoped to this one repository with
// "Issues: Read and write" and NOTHING else. Deliberately not Actions: an
// Actions token can dispatch ANY workflow in the repo - deploy.yml deploys
// production, announce.yml posts as the company, paid-canary/tempo-volume/
// refund/algorand-external-buy spend real money - and GitHub has no per-workflow
// scoping. An issues-only token cannot deploy, post, or spend.
//
// Two rules keep this from being worse than no alarm:
//   1. TITLES MATCH heartbeat.yml EXACTLY, and an open issue is found by title
//      before anything is created. The two observers therefore coordinate:
//      whichever runs first opens or closes, and neither ever duplicates.
//   2. A bad reading is CONFIRMED by a second read 30s later before it opens
//      anything. Production is volume-backed, so every deploy has a 60-90s
//      no-container window, and a reading taken inside it looks exactly like an
//      outage. That is what filed #1057 on a healthy service. A real fault
//      fails both reads.
//
// This Worker never COMMENTS on an open issue. It runs 288 times a day; the
// heartbeat's "still low" comment would be 288 comments a day. Open and closed
// is the whole state that matters, and heartbeat.yml still comments when it runs.
const ISSUES_REPO = "MikeyPetrillo/Agent402";
const CONFIRM_DELAY_MS = 30000;

async function gh(path, token, init = {}) {
  return grab(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent402-status-probe",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  }, 15000);
}

const TOPUP = "Balances are deliberately not published on /api/gateway-status; read the wallet directly to see the number.";

// Each alarm answers "bad" (open it), "good" (close it) or "quiet" (do neither).
// "quiet" is the important one: an unreadable or unconfigured leg must never
// page AND must never close a real alarm, so anything that is not an explicit
// verdict leaves the current state exactly as it is.
export const ALARMS = [
  {
    title: "Gateway credits LOW (OpenRouter)",
    verdict: ({ gateway: b }) => (b.status === "low" ? "bad" : b.status === "ok" ? "good" : "quiet"),
    body: () =>
      "The OpenRouter balance behind the /v1 gateway is below the low-water mark (OPENROUTER_LOW_CREDITS_USD, default $15) OR the production key's own monthly USD limit has under 25% left (OPENROUTER_LOW_KEY_LIMIT_FRACTION). Either ceiling stops the gateway: upstream refuses, we answer 502, settlement is cancelled, so buyers are NOT charged but every /v1 sale is lost until it is topped up. Top up credits: https://openrouter.ai/settings/credits (manual - the programmatic top-up API is gone). Raise the key limit: https://openrouter.ai/settings/keys (key: Agent402).",
  },
  {
    title: "Gateway balance UNREADABLE (OpenRouter)",
    // A balance we cannot READ is its own alarm once it persists: "unknown"
    // never paged, which is exactly how a dead alarm stays dead.
    verdict: ({ gateway: b }) =>
      b.status === "unknown" && Number(b.unknownForMinutes || 0) >= 180 ? "bad" : b.status && b.status !== "unknown" ? "good" : "quiet",
    body: ({ gateway: b }) =>
      `/api/gateway-status has reported status=unknown for ${Number(b.unknownForMinutes || 0)} minutes: neither OpenRouter /credits nor /key answered readably with the production key. The low-balance alarm is blind while this lasts. Check the key (https://openrouter.ai/settings/keys), OpenRouter status, and the server log for fetch errors.`,
  },
  {
    title: "Upstream buyer wallet LOW (x402)",
    verdict: ({ gateway: b }) => lowOk(b.upstreamBuyer?.status),
    body: () =>
      "The x402 upstream spending wallet (X402_UPSTREAM_BUYER_KEY) behind the blockscout-kit tools is below the low-water mark (UPSTREAM_BUYER_LOW_USD, default $0.50). When it empties, contract-inspect/address-profile fail 502 (buyers are never charged, but the tools go dark). Top up: send USDC on Base to the upstream buyer address (see CLAUDE.md env docs).",
  },
  {
    title: "Upstream buyer wallet is DRAINING (unexplained fall)",
    // That wallet is SELF-FUNDING, so its balance should only rise. A low-water
    // alarm fires after the money is gone; this fires on the first unexplained
    // dollar. A manual withdrawal trips it too, deliberately.
    verdict: ({ gateway: b }) => (b.upstreamBuyer?.trend === "draining" ? "bad" : b.upstreamBuyer?.trend === "ok" ? "good" : "quiet"),
    body: () =>
      "The x402 upstream spending wallet has fallen below its high-water mark across several consecutive reads.\n\nThat wallet is SELF-FUNDING: every tool that spends from it also settles into it, and every execution tier charges more than it can spend. Its balance should only rise. A sustained fall means one of:\n\n1. A manual withdrawal - close this issue if that was you.\n2. Upstream spend whose revenue never arrived: a buyer's payment verified and then failed to settle, which is the drain the per-payer ceiling in src/external-spend-guard.js bounds. Check /__operator/stats and the route-execute receipts.\n3. Something we do not understand, which is why this alarm exists.\n\n" + TOPUP,
  },
  {
    title: "Algorand upstream buyer wallet LOW (x402)",
    verdict: ({ gateway: b }) => lowOk(b.upstreamBuyerAvm?.status),
    body: () =>
      "The Algorand x402 spending wallet (ALGORAND_UPSTREAM_BUYER_MNEMONIC) behind the SOR's Algorand external routing is below the low-water mark (ALGORAND_UPSTREAM_BUYER_LOW_USD, default $0.50) - or not yet opted in to USDC ASA 31566704 (check /api/gateway-status upstreamBuyerAvm.optedIn). When it empties, Algorand external routing fails 502 (buyers are never charged, but the path goes dark). Top up: send USDC on Algorand to the AVM spending wallet address (see CLAUDE.md env docs).",
  },
  {
    title: "Tempo upstream buyer wallet LOW (MPP)",
    verdict: ({ gateway: b }) => lowOk(b.upstreamBuyerTempo?.status),
    body: () =>
      "The Tempo (MPP) spending wallet (TEMPO_UPSTREAM_BUYER_KEY) behind the SOR's Tempo external leg is below the low-water mark (TEMPO_UPSTREAM_BUYER_LOW_USD, default $0.50). It is funded in USDC.e on Tempo. When it empties, MPP external routing goes dark (buyers are never charged). Top up with fund-tempo-fee-payer.yml (token=usdc) or directly.",
  },
  {
    title: "Subscription gas sponsor LOW (PathUSD)",
    // Watches PATHUSD, not USDC.e: a sponsored transaction pays its fee in
    // Tempo's default token, so a sponsor full of USDC.e and empty of PathUSD
    // is EMPTY for this purpose. An empty sponsor fails activations loudly but
    // sends RENEWALS to past_due - existing subscribers are served for free
    // until their grace window ends.
    verdict: ({ gateway: b }) => lowOk(b.subscriptionFeePayer?.status),
    body: () =>
      "The Tempo subscription gas sponsor (TEMPO_SUBSCRIPTION_FEE_PAYER_KEY) is below the low-water mark (TEMPO_SUBSCRIPTION_FEE_PAYER_LOW_USD, default $0.25) in PATHUSD - the token Tempo charges sponsored fees in, NOT the USDC.e the products are priced in. An empty sponsor fails subscription activations loudly (402, nobody charged) but sends RENEWALS to past_due, so existing subscribers keep being served for free until their grace window ends. Top up with fund-tempo-fee-payer.yml and token=pathusd.",
  },
  {
    title: "Postgres UNREACHABLE (leads/analytics)",
    verdict: ({ gateway: b }) => {
      const leads = b.databases?.leads?.status;
      const analytics = b.databases?.analytics?.status;
      if (leads === "unreachable" || analytics === "unreachable") return "bad";
      if (leads === "ok" && analytics === "ok") return "good";
      return "quiet";
    },
    body: ({ gateway: b }) =>
      `A Postgres database is unreachable from production (leads=${b.databases?.leads?.status || "unknown"}, analytics=${b.databases?.analytics?.status || "unknown"}, per /api/gateway-status). The app keeps serving - tollbooth leads and the tool-call analytics simply stop being recorded - so this does not show as an outage anywhere else. Check the Postgres services in the Railway project (a stopped container looks exactly like this; the platform's own image updates restart them). The app boot log carries a [leads-db]/[analytics-db] probe line naming the failing family/port.`,
  },
  {
    title: "Operator token guessing ELEVATED",
    verdict: ({ gateway: b }) => (b.operatorAuth?.status === "elevated" ? "bad" : b.operatorAuth?.status === "ok" ? "good" : "quiet"),
    body: ({ gateway: b }) =>
      `/api/gateway-status reports operatorAuth.status=elevated: ${b.operatorAuth?.failures1h ?? "?"} wrong operator credentials in the last hour (threshold OPERATOR_AUTH_FAIL_ALERT). The per-IP limiter caps each source; this is the aggregate. If it persists, rotate AGENT402_OPERATOR_TOKEN on Railway and in Actions secrets. Auto-closes when the rate drops.`,
  },
  {
    // Settlement freshness. The daily canary must actually BUY, not merely
    // conclude green: on 2026-08-02 a gate skipped every scheduled purchase for
    // five days while the workflow reported success, so this watches the
    // OBSERVATION (which only a real settled purchase writes) and cannot be
    // fooled by the monitor's own verdict. The server owns the threshold - 26h
    // on the settlement component - and we read its verdict rather than
    // re-deriving an age here, so the two can never disagree.
    //
    // NOTE the one thing this Worker CANNOT do that heartbeat.yml can: dispatch
    // the canary to self-heal. That needs Actions write, which would also let
    // this credential deploy production and spend wallets - the whole reason it
    // is an issues-only token. So it pages, and the body says what to run.
    title: "Settlement stale - the paid canary is not buying",
    verdict: ({ status }) => {
      const c = (status?.components || []).find((x) => x?.key === "settlement");
      if (!c) return "quiet";
      const state = c.current?.state;
      return state === "unknown" ? "bad" : state === "operational" ? "good" : "quiet";
    },
    body: ({ status }) => {
      const c = (status?.components || []).find((x) => x?.key === "settlement");
      const hours = Math.floor((c?.current?.ageMs || 0) / 3600000);
      return `No canary has proven a real USDC purchase in ${hours}h, so /status reports the settlement component as \`unknown\` and the public page reads "Degraded".

The daily proof that BUYING works is not running. That does not by itself mean buying is broken - the 2026-08-02 case was a gate that skipped every scheduled attempt while the workflow reported success, which is why this watches the observation rather than the workflow's own conclusion.

Check, in order: recent runs of \`paid-canary.yml\` and whether the \`canary\` job was SKIPPED rather than run; then the gate step's log, which prints the observation age it read; then the burner balances.

This observer cannot dispatch the canary itself (it holds an issues-only credential by design). To heal it: \`gh workflow run paid-canary.yml --repo MikeyPetrillo/Agent402 --ref main\` - a dispatch always buys, because the freshness gate applies to scheduled runs only.`;
    },
  },
];

// The shape shared by every wallet balance: low pages, ok clears, and
// unknown/unconfigured do neither.
function lowOk(status) {
  return status === "low" ? "bad" : status === "ok" ? "good" : "quiet";
}

/**
 * Pure: what each alarm says about one reading.
 * @param {{gateway?:object, status?:object}} ctx - /api/gateway-status and /api/status
 */
export function judge(ctx) {
  const c = { gateway: ctx?.gateway || {}, status: ctx?.status || null };
  const out = {};
  for (const a of ALARMS) {
    let v = "quiet";
    try { v = a.verdict(c) || "quiet"; } catch { v = "quiet"; }
    out[a.title] = v;
  }
  return out;
}

async function openIssues(token) {
  const r = await gh(`/repos/${ISSUES_REPO}/issues?state=open&per_page=100`, token);
  if (!r.ok) throw new Error(`issue list failed (${r.status})`);
  const rows = await r.json();
  const byTitle = new Map();
  // Pull requests come back on this endpoint too; they are not alarms.
  for (const x of Array.isArray(rows) ? rows : []) {
    if (!x || x.pull_request) continue;
    if (!byTitle.has(x.title)) byTitle.set(x.title, x.number);
  }
  return byTitle;
}

/**
 * Reconcile every alarm against GitHub issues.
 * @returns {{opened:string[], closed:string[], bad:string[], error?:string}}
 */
export async function syncAlarms(env, { fetchStatus, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), confirmDelayMs = CONFIRM_DELAY_MS } = {}) {
  const token = env.GITHUB_ISSUES_TOKEN;
  if (!token) return { opened: [], closed: [], bad: [], error: "no GITHUB_ISSUES_TOKEN (alarms disabled)" };
  const prod = env.PROD || "https://agent402.tools";
  // Two endpoints, one reading. /api/status is fetched alongside because the
  // settlement alarm lives there; a failure to read it is NOT fatal - the
  // gateway alarms are still judgeable, and an absent status simply makes the
  // settlement verdict "quiet".
  const read = fetchStatus || (async () => {
    const r = await grab(`${prod}/api/gateway-status`, {}, 15000);
    if (!r.ok) throw new Error(`gateway-status ${r.status}`);
    const gateway = await r.json();
    let status = null;
    try {
      const s2 = await grab(`${prod}/api/status`, {}, 20000);
      if (s2.ok) status = await s2.json();
    } catch { /* the gateway half still stands */ }
    return { gateway, status };
  });

  let body;
  try { body = await read(); } catch (e) {
    // An unreadable endpoint is not a verdict about anything. Do nothing: the
    // production probe above already records reachability, and opening nine
    // alarms every time a deploy swaps the container would be its own outage.
    return { opened: [], closed: [], bad: [], error: `status unreadable: ${String(e?.message || e).slice(0, 80)}` };
  }

  let verdicts = judge(body);
  const anyBad = Object.values(verdicts).some((v) => v === "bad");
  if (anyBad) {
    // Confirm before paging. A deploy's no-container window reads exactly like
    // a fault; a real fault survives the second look. Only alarms bad in BOTH
    // readings may open - a first-read-bad, second-read-good alarm is left
    // untouched rather than closed, because one good reading is no more proof
    // than one bad one.
    await sleep(confirmDelayMs);
    let second;
    try { second = judge(await read()); } catch { second = null; }
    if (!second) return { opened: [], closed: [], bad: [], error: "confirm read failed" };
    const merged = {};
    for (const [title, v] of Object.entries(verdicts)) {
      if (v === "bad") merged[title] = second[title] === "bad" ? "bad" : "quiet";
      else merged[title] = v === second[title] ? v : "quiet";
    }
    verdicts = merged;
  }

  let open;
  try { open = await openIssues(token); } catch (e) {
    return { opened: [], closed: [], bad: [], error: String(e?.message || e).slice(0, 100) };
  }

  const opened = [];
  const closed = [];
  const bad = [];
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  for (const a of ALARMS) {
    const v = verdicts[a.title];
    if (v === "bad") bad.push(a.title);
    const existing = open.get(a.title);
    if (v === "bad" && !existing) {
      const r = await gh(`/repos/${ISSUES_REPO}/issues`, token, {
        method: "POST",
        body: JSON.stringify({
          title: a.title,
          body: `${a.body(body)}\n\n---\nObserved from outside production by the status Worker (Cloudflare cron) at ${now}, confirmed by a second reading. Auto-closes when the condition clears.`,
        }),
      });
      if (r.ok) opened.push(a.title);
    } else if (v === "good" && existing) {
      await gh(`/repos/${ISSUES_REPO}/issues/${existing}/comments`, token, {
        method: "POST",
        body: JSON.stringify({ body: `Recovered: the condition cleared at ${now} (observed by the status Worker).` }),
      });
      const r = await gh(`/repos/${ISSUES_REPO}/issues/${existing}`, token, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      if (r.ok) closed.push(a.title);
    }
  }
  return { opened, closed, bad };
}

// The credential this Worker presents to /api/status/probe. STATUS_PROBE_TOKEN
// is the narrow one and opens that endpoint and nothing else; OPERATOR_TOKEN is
// the root credential that also reaches /__operator/refunds/update,
// /credits/disable, /well-known, /leads and the rest, and is only still
// accepted here so the two can be rotated without the observer going dark.
// Once STATUS_PROBE_TOKEN is set, DELETE the OPERATOR_TOKEN secret:
//   wrangler secret delete OPERATOR_TOKEN
export const probeToken = (env) => env.STATUS_PROBE_TOKEN || env.OPERATOR_TOKEN || "";

async function run(env) {
  const prod = env.PROD || "https://agent402.tools";
  const token = probeToken(env);
  if (!token) {
    // Fail loudly in the log rather than posting unauthenticated: a silent skip
    // is exactly what let a different alarm sit dead for months.
    console.error("status-probe: neither STATUS_PROBE_TOKEN nor OPERATOR_TOKEN is set — refusing to probe");
    return { ok: false, error: "no probe token" };
  }
  const { components, fails } = await observe(prod);
  // When production is unreachable this POST cannot land either. That absence
  // is the evidence: /status renders a missing observation as a gap, never as
  // uptime, so there is nothing to fake here.
  const recorded = await record(prod, token, components, "https://github.com/MikeyPetrillo/Agent402/tree/main/workers/status-probe")
    .catch(() => false);
  // Independent of the probe result: the balance and reachability alarms are
  // healthy-path work too, and their only other observer runs every few hours.
  const alarms = await syncAlarms(env).catch((e) => ({ opened: [], closed: [], bad: [], error: String(e?.message || e).slice(0, 100) }));
  const alarmLine = alarms.error
    ? `alarms skipped (${alarms.error})`
    : `alarms bad=[${alarms.bad.join(" ")}] opened=[${alarms.opened.join(" ")}] closed=[${alarms.closed.join(" ")}]`;
  console.log(`status-probe: ${fails.length ? `FAILS ${fails.join(" ")}` : "all healthy"} | recorded=${recorded} | ${alarmLine}`);
  return { ok: true, recorded, fails, components, alarms };
}

export default {
  // Cloudflare's scheduler. Independent of GitHub Actions by design.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // Manual trigger for verifying a deploy. Token-gated so this Worker cannot be
  // used by anyone else to generate observations.
  //
  // POST /verify proves the ALARM CREDENTIAL end to end, which "armed" does not:
  // while every condition is healthy the write path is never exercised, so a
  // token with the wrong scope stays invisible until the first real alarm - and
  // then fails silently, which is the one failure an alarm must not have. It
  // reads the open issues (proves the token is valid and repo-scoped) and then
  // PATCHes an existing issue with the state it already has, which requires
  // Issues:write and changes nothing a human would see.
  async fetch(request, env) {
    const url = new URL(request.url);
    // Unauthenticated identity. BUILD_SHA is injected at deploy time
    // (--var BUILD_SHA:<sha>) so a drift check can ask the RUNNING Worker what
    // it is, rather than assuming a merge reached it. Nothing had ever deployed
    // this Worker automatically: on 2026-08-30 the live code was from 07-29,
    // with three merged commits sitting undeployed behind it.
    if (url.pathname === "/" || url.pathname === "/version") {
      return Response.json({
        worker: "agent402-status-probe",
        build: env.BUILD_SHA || "unknown",
        usage: "POST /run with X-Operator-Token to trigger manually",
      });
    }
    if (url.pathname === "/verify") {
      const want = probeToken(env);
      if (!want || request.headers.get("X-Operator-Token") !== want) return new Response("unauthorized\n", { status: 401 });
      const token = env.GITHUB_ISSUES_TOKEN;
      if (!token) return Response.json({ ok: false, error: "no GITHUB_ISSUES_TOKEN" });
      const out = { canRead: false, canWrite: false, openIssues: null, note: null };
      try {
        const r = await gh(`/repos/${ISSUES_REPO}/issues?state=open&per_page=100`, token);
        out.canRead = r.ok;
        if (!r.ok) { out.note = `read failed (${r.status}) - token invalid, expired, or not scoped to this repository`; return Response.json(out); }
        const rows = (await r.json()).filter((x) => x && !x.pull_request);
        out.openIssues = rows.length;
        if (!rows.length) { out.note = "no open issue to write-probe against; read works"; return Response.json(out); }
        // No-op write: set the state it already has. Needs Issues:write, edits nothing.
        const w = await gh(`/repos/${ISSUES_REPO}/issues/${rows[0].number}`, token, {
          method: "PATCH", body: JSON.stringify({ state: "open" }),
        });
        out.canWrite = w.ok;
        out.note = w.ok
          ? "read and write both confirmed - alarms can open and close issues"
          : `write refused (${w.status}) - the token is probably Issues: Read-only`;
      } catch (e) { out.note = `error: ${String(e?.message || e).slice(0, 100)}`; }
      return Response.json(out);
    }
    if (url.pathname !== "/run") return new Response("status-probe: POST /run with X-Operator-Token to trigger manually\n", { status: 200 });
    const want = probeToken(env);
    if (!want || request.headers.get("X-Operator-Token") !== want) {
      return new Response("unauthorized\n", { status: 401 });
    }
    const out = await run(env);
    return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
  },
};
