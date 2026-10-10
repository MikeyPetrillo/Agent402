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
// PAID-CALL, AND WHAT IT STILL DOES NOT HOLD: this Worker also walks the
// proof-of-work path end to end (challenge, solve, call, check the payload),
// and it does so WITHOUT POW_SECRET. It walks a probe challenge, NOT the one a
// buyer is issued: lower difficulty, shorter TTL, a marked token with its own
// verify branch. The GitHub heartbeat walks the buyer's, and /status judges
// paid-call per observer, so this Worker's success never clears a failure the
// heartbeat saw on the buyer's path (stateFromSources in src/status-store.js). The heartbeat marks its own
// call as internal by minting an X-Heartbeat-Token from that secret; copying it
// onto a second platform would widen what a leak of this Worker can forge, so
// it stays on GitHub. Instead the Worker presents STATUS_PROBE_TOKEN - the
// credential it already holds for /api/status/probe - when it ASKS for the
// challenge. For that one pure-CPU slug the server answers with a low-difficulty
// challenge whose signed token is marked as the probe's, and the call it unlocks
// is booked as internal exactly like the heartbeat's. The token opens nothing
// else: no other slug, no paid route, no operator surface. Without that, 288
// synthetic calls a day would read as outside free-tier demand on /revenue.
//
// Deploy: see README.md. Requires the STATUS_PROBE_TOKEN secret.

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

// ---------------------------------------------------------------------------
// paid-call: the proof-of-work path, end to end.
//
// CPU AND SUBREQUEST BUDGET. This Worker is sized to the tightest Workers
// limits: 10 ms of CPU and 50 subrequests per invocation. Exceeding the CPU
// limit kills the whole run - every other observation and every alarm with
// it. So the work this check may do is bounded before it starts, not
// discovered afterwards:
//
//  - The server hands a STATUS_PROBE_TOKEN holder a 4-bit challenge (16 hashes
//    expected; PROBE_POW_DIFFICULTY in src/pow.js). A normal free-tier
//    challenge is 16 bits (65,536 expected, hundreds of milliseconds of CPU).
//    Anything above PAID_CALL_MAX_DIFFICULTY is REFUSED, never solved: it is
//    what an older server, or one without the token set, hands back, and
//    solving it would blow the limit. A refused challenge is reported as NOT
//    OBSERVED, never as an outage - the paid path may be perfectly healthy.
//  - One solve stops after SOLVE_CAP_FACTOR x the expected hashes (256 at 4
//    bits). An honest solve needs more about once in nine million attempts
//    (e^-16), and that case is also "not observed".
//  Measured 2026-09-28 with crypto.subtle.digest, the call this Worker makes:
//  inside workerd (the Workers runtime) about 2.5-4.5 us of CPU per hash, and
//  about 10 us in Node 22. So the expected solve is 16 hashes, about 0.05 ms
//  (0.16 ms at Node's cost), and the hard cap of 256 hashes is about 1.1 ms
//  (2.6 ms at Node's cost) - at least 3.8x under the 10 ms limit even at the
//  slower figure. The rest of a run is mostly parsing /api/pricing (about
//  1.5 ms) and /api/status (about 0.3 ms). scripts/test-status-probe-worker.js
//  pins the arithmetic so raising either knob fails a test with the reason.
//  - Two subrequests per attempt (challenge + call); the worst case for a whole
//    run is counted in that test and stays at least ten under the limit of 50.
const PAID_CALL_SLUG = "hash";
const PAID_CALL_UA = "agent402-status-probe/1.0";
export const PAID_CALL_MAX_DIFFICULTY = 4;
export const SOLVE_CAP_FACTOR = 16;
const enc = new TextEncoder();

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const errText = (e) => String(e?.message || e).slice(0, 60);

/**
 * Find a nonce so sha256("<challenge>:<nonce>") has `difficulty` leading zero
 * bits - the same rule src/pow.js verifies. Returns null past `maxHashes`.
 */
export async function solvePow(challenge, difficulty, maxHashes) {
  for (let n = 0; n < maxHashes; n++) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${challenge}:${n}`)));
    if (leadingZeroBits(d) >= difficulty) return { nonce: n, hashes: n + 1 };
  }
  return null;
}

/**
 * One paid-call observation. Returns {ok, detail} when it observed the path,
 * or {skip} when it could not observe it honestly (no token, a challenge too
 * hard to solve inside the CPU limit, an unlucky solve) - a skip records nothing.
 */
export async function checkPaidCall(prod, token) {
  if (!token) return { skip: "no STATUS_PROBE_TOKEN" };
  let c;
  try {
    const r = await grab(`${prod}/api/pow/challenge?slug=${PAID_CALL_SLUG}`, {
      headers: { "X-Operator-Token": token, "User-Agent": PAID_CALL_UA },
    });
    if (!r.ok) return { ok: false, detail: `challenge ${r.status}` };
    c = await r.json();
  } catch (e) {
    return { ok: false, detail: `challenge ${errText(e)}` };
  }
  const difficulty = Number(c?.difficulty);
  if (typeof c?.challenge !== "string" || typeof c?.token !== "string" || c?.slug !== PAID_CALL_SLUG || !Number.isInteger(difficulty) || difficulty < 0) {
    return { ok: false, detail: "challenge unreadable" };
  }
  if (difficulty > PAID_CALL_MAX_DIFFICULTY) {
    return { skip: `challenge is ${difficulty} bits and this Worker solves at most ${PAID_CALL_MAX_DIFFICULTY}: the server did not honour the probe token (STATUS_PROBE_TOKEN unset or different on the server, or a server that predates the probe challenge)` };
  }
  const cap = SOLVE_CAP_FACTOR * 2 ** difficulty;
  const solved = await solvePow(c.challenge, difficulty, cap);
  if (!solved) return { skip: `no nonce within ${cap} hashes` };
  // Unique per call, so the answer cannot come from any cache, and the Worker
  // can check it against its own digest of the same bytes.
  const text = `status-probe ${c.challenge}`;
  const want = hexOf(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  try {
    const r = await grab(`${prod}/api/${PAID_CALL_SLUG}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": PAID_CALL_UA, "X-Pow-Solution": `${c.token}:${solved.nonce}` },
      body: JSON.stringify({ text }),
    });
    if (r.status !== 200) {
      const why = r.headers.get("x-pow-error");
      return { ok: false, detail: `call ${r.status}${why ? ` (${why.slice(0, 60)})` : ""}` };
    }
    // The unlock is the thing under test: a 200 that did not come through the
    // proof-of-work gate is not an observation of that gate.
    if (r.headers.get("x-pow-accepted") !== "true") return { ok: false, detail: "call 200 without X-Pow-Accepted" };
    const j = await r.json();
    if (j?.hex !== want) return { ok: false, detail: "payload is not the hash of what was sent" };
    return { ok: true, detail: null };
  } catch (e) {
    return { ok: false, detail: `call ${errText(e)}` };
  }
}

/**
 * Observe production. Returns { components, fails, paidCall } where components
 * maps the /status component keys to {ok, detail}. Any thrown error is a failed
 * check, never a failed run: an observation we could not make must be recorded
 * as a failure or not at all, never silently as success.
 *
 * `paidCallToken` switches the paid-call check on. Absent, the check does not
 * run and paid-call is never claimed; present but empty, it is skipped.
 */
export async function probe(prod, opts = {}) {
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

  let paidCall = null;
  if (Object.hasOwn(opts, "paidCallToken")) {
    const r = await checkPaidCall(prod, opts.paidCallToken);
    if (r.skip) paidCall = { observed: false, reason: r.skip };
    else {
      mark("paid-call", r.ok, r.detail);
      paidCall = { observed: true };
    }
  }

  return { components, fails, paidCall };
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
export async function observe(prod, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 20000, ...probeOpts } = {}) {
  const first = await probe(prod, probeOpts);
  if (!first.fails.length) return { ...first, retried: false };
  await sleep(retryDelayMs);
  const second = await probe(prod, probeOpts);
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
      "The OpenRouter balance behind the /v1 gateway is below the low-water mark (OPENROUTER_LOW_CREDITS_USD) OR the production key's own monthly USD limit has under 25% left (OPENROUTER_LOW_KEY_LIMIT_FRACTION). Either ceiling stops the gateway: upstream refuses, we answer 502, settlement is cancelled, so buyers are NOT charged but every /v1 sale is lost until it is topped up. Auto top-up is on for this account, so a low balance means a refill did not land (declined card, or auto top-up switched off): check https://openrouter.ai/settings/credits. Raise the key limit: https://openrouter.ai/settings/keys (key: Agent402).",
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
      "The x402 upstream spending wallet (X402_UPSTREAM_BUYER_KEY) is below the low-water mark (UPSTREAM_BUYER_LOW_USD). When it empties, route-execute external buys and seller-payability refuse (buyers are never charged, but those paths go dark). attest signs from the same wallet but pays Base gas in ETH, which this alarm reads nothing about. Top up: send USDC on Base to the upstream buyer address (see CLAUDE.md env docs).",
  },
  {
    title: "Upstream buyer wallet is DRAINING (unexplained fall)",
    // The route-execute tiers that spend from that wallet also settle into it,
    // so a healthy trend is flat or rising. A low-water alarm fires after the
    // money is gone; this fires on the first unexplained dollar. A manual
    // withdrawal trips it too, deliberately.
    verdict: ({ gateway: b }) => (b.upstreamBuyer?.trend === "draining" ? "bad" : b.upstreamBuyer?.trend === "ok" ? "good" : "quiet"),
    body: () =>
      "The x402 upstream spending wallet has fallen below its high-water mark across several consecutive reads.\n\nThe route-execute tiers are SELF-FUNDING: they settle into this wallet and each charges more than it can spend, so their traffic can only raise the balance. A sustained fall means one of:\n\n1. A manual withdrawal - close this issue if that was you.\n2. seller-payability or attest, which spend from this wallet without settling into it (seller-payability probes external sellers; attest pays Base gas in ETH). A slow trickle from those is expected and sits inside the tolerance; a sustained fall is not.\n3. Upstream spend whose revenue never arrived: a buyer's payment verified and then failed to settle, which is the drain the per-payer ceiling in src/external-spend-guard.js bounds. Check /__operator/stats and the route-execute receipts.\n4. Something we do not understand, which is why this alarm exists.\n\n" + TOPUP,
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
    // The server posts the approved tweet queue itself (src/tweet-queue.js),
    // and a post that fails loses an approved slot for good unless someone
    // looks. One word on /api/gateway-status: these four page, ok and off
    // clear, and retrying (a post waiting for its one retry) does neither.
    title: "Tweet queue needs attention (server poster)",
    verdict: ({ gateway: b }) => {
      const w = b.tweetQueue?.status;
      if (TWEET_QUEUE_BAD.has(w)) return "bad";
      return w === "ok" || w === "off" ? "good" : "quiet";
    },
    body: ({ gateway: b }) => {
      const w = TWEET_QUEUE_BAD.has(b.tweetQueue?.status) ? b.tweetQueue.status : "unknown";
      return `/api/gateway-status reports tweetQueue.status=${w}. The server posts the approved queue (Railway TWEET_QUEUE) one item per clock hour; nothing else posts it once tweet-queue.yml is disabled.

- in_doubt: a post may not have reached X, and its one retry has been used (or its window closed, or the process died mid-post). Read /__operator/tweet-queue.json for the ids and hours, check the account on X, and if a post did not land re-queue its text under a new id. Removing the old id from TWEET_QUEUE clears this.
- refused: X answered 401/402/403 (credentials or the API balance). The queue pauses and retries; items older than the catch-up window are dropped.
- no_credentials: one of X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET is missing on Railway.
- halted: TWEET_QUEUE is not a JSON array, the state file on /data cannot be read, or the service has no /data volume. Nothing posts until it is fixed.

The server log carries a [tweet-queue] line for every outcome (ids and status codes, never text). TWEET_QUEUE_POSTING=off stops posting and closes this issue. Auto-closes when the word is ok.`;
    },
  },
  {
    // A buyer paid and got an error. The server keeps the log and publishes one
    // word (chargedFailures on /api/gateway-status, 402 refusals excluded); the
    // charged-failure workflow ran every 4-6 h in practice (measured
    // 2026-10-02), so this Worker pages within minutes. Title matches that
    // workflow's exactly; this Worker is the one that CLOSES it, when the
    // server's window reads clear.
    title: "Charged failure: a paid tool returned an error to a paying agent",
    verdict: ({ gateway: b }) => (b.chargedFailures?.status === "recent" ? "bad" : b.chargedFailures?.status === "ok" ? "good" : "quiet"),
    body: ({ gateway: b }) =>
      `/api/gateway-status reports chargedFailures.status=recent: at least one paid call in the last ${Number(b.chargedFailures?.windowHours) || 6} h settled on chain and then answered an error, so a buyer paid and got nothing. The itemised rows (slug, status, time) are on /__operator/stats -> chargedFailures; each is also a debt in the refund ledger (/__operator/refunds.json). Fix the failing tool, then run the refund job for the owed rows. Auto-closes when the window reads clear.`,
  },
  {
    // Money we owe a buyer (refundsOwed on /api/gateway-status). The refund
    // job is dispatched by hand, so a debt can sit unpaid with nothing else
    // noticing (2026-10-06: 44 debts to one buyer, found by reading the
    // ledger). aging and stuck page; ok clears; unknown or absent does neither.
    title: "Refunds owed to a buyer are waiting",
    verdict: ({ gateway: b }) => {
      const w = b.refundsOwed?.status;
      if (w === "aging" || w === "stuck") return "bad";
      return w === "ok" ? "good" : "quiet";
    },
    body: ({ gateway: b }) => {
      const w = b.refundsOwed?.status === "stuck" ? "stuck" : "aging";
      return `/api/gateway-status reports refundsOwed.status=${w}.

- aging: a debt in the refund ledger has been owed longer than REFUND_OWED_ALARM_HOURS (default 48). Read /__operator/refunds.json, then dispatch refund.yml (dry run first; include_repeat_hangups for hang-up debts held for review). A debt that should not be paid is voided there with a note.
- stuck: a row has been in "sending" for over 30 minutes, so a refund run stopped between claiming it and recording the transfer. Check the refund wallet on chain for a transfer to that payer. If one landed, mark the row paid with that tx; if not, release it back to owed (POST /__operator/refunds/update {"action":"release","note":...}).

Auto-closes when the word is ok.`;
    },
  },
  {
    // Money writes (sales, refund debts, checkout finals, subscription and
    // decide records) kept on the container's local disk because the
    // state database has not taken them (ledgerDeadLetter on
    // /api/gateway-status, src/ledger-mirror.js). stuck pages; none and off
    // clear; pending (the replay is working) and unknown do neither. Title
    // matches heartbeat.yml's.
    title: "Ledger rows waiting on local disk (dead-letter stuck)",
    verdict: ({ gateway: b }) => {
      const w = b.ledgerDeadLetter?.status;
      if (w === "stuck") return "bad";
      return w === "none" || w === "off" ? "good" : "quiet";
    },
    body: () =>
      `/api/gateway-status reports ledgerDeadLetter.status=stuck: a money write (a sale, a refund debt, a card report's final record, a subscription record or a decide write) has waited on the container's local disk for the state database longer than LEDGER_DEAD_LETTER_STUCK_MINUTES (default 20). Each journal's replay retries on a timer; while it cannot land them they exist only on that container, so do not redeploy or restart it until they land. Check stateDb on the same endpoint, the Postgres service on Railway, and the [sales-ledger] / [refund-ledger] / [human-checkout] / [subscriptions] / [decide] log lines (a row the database refuses is named there). The operator read of /api/gateway-status has the counts per journal. Auto-closes when the word is none.`,
  },
  {
    // The nightly offsite backup (backup on /api/gateway-status,
    // src/backup.js). held, failed and stale page; ok clears; off and
    // unknown do neither. Title matches heartbeat.yml's.
    title: "Offsite backup is not current",
    verdict: ({ gateway: b }) => {
      const w = b.backup?.status;
      if (BACKUP_BAD.has(w)) return "bad";
      return w === "ok" ? "good" : "quiet";
    },
    body: ({ gateway: b }) => {
      const w = BACKUP_BAD.has(b.backup?.status) ? b.backup.status : "unknown";
      return `/api/gateway-status reports backup.status=${w}.

- held: the last run left a state table, or the whole database snapshot, without an offsite copy (older days are kept, not pruned, while this lasts).
- failed: the last run threw (bucket unreachable, bill guard, unreadable data dir).
- stale: no successful run in 26 h while configured.

Read /__operator/backup.json (lastError, lastHeld, lastHeldState) and the [backup] log line; POST /__operator/backup/run retries. Auto-closes when the word is ok.`;
    },
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

const TWEET_QUEUE_BAD = new Set(["halted", "no_credentials", "refused", "in_doubt"]);
const BACKUP_BAD = new Set(["held", "failed", "stale"]);

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
export async function syncAlarms(env, { fetchStatus, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), confirmDelayMs = CONFIRM_DELAY_MS, openList = null } = {}) {
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

  let open = openList;
  if (!open) {
    try { open = await openIssues(token); } catch (e) {
      return { opened: [], closed: [], bad: [], error: String(e?.message || e).slice(0, 100) };
    }
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
      // One subrequest per close, not two: a Cloudflare invocation may make 50,
      // and a worst-case run closes every alarm at once. The close itself is
      // the recovery record (its timestamp is when the Worker saw it clear).
      const r = await gh(`/repos/${ISSUES_REPO}/issues/${existing}`, token, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      if (r.ok) closed.push(a.title);
    }
  }
  return { opened, closed, bad };
}

// Production DOWN. The api check (GET /health) already failed twice 20 s apart
// inside observe(); two more reads 45 s apart must fail too before anything
// opens, so the whole window (~110 s) outlasts a deploy's 60-90 s no-container
// gap. Title matches heartbeat.yml's exactly, and this Worker opens AND closes
// it: heartbeat.yml ran every 4-7 h in practice (measured 2026-10-02), which
// is how long an outage could go unpaged.
export const DOWN_TITLE = "Heartbeat: production DOWN";
export async function syncOutage(env, { apiFailed, detail = "", sleep = (ms) => new Promise((r) => setTimeout(r, ms)), confirmDelayMs = 45000, healthRead, openList = null } = {}) {
  const token = env.GITHUB_ISSUES_TOKEN;
  if (!token) return { action: "none", error: "no GITHUB_ISSUES_TOKEN" };
  const prod = env.PROD || "https://agent402.tools";
  const read = healthRead || (async () => { try { return (await grab(`${prod}/health`, {}, 15000)).ok; } catch { return false; } });
  let down = false;
  if (apiFailed) {
    down = true;
    for (let i = 0; i < 2 && down; i++) { await sleep(confirmDelayMs); if (await read()) down = false; }
  }
  let open = openList;
  if (!open) { try { open = await openIssues(token); } catch (e) { return { action: "none", error: String(e?.message || e).slice(0, 100) }; } }
  const existing = open.get(DOWN_TITLE);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  if (down && !existing) {
    const r = await gh(`/repos/${ISSUES_REPO}/issues`, token, {
      method: "POST",
      body: JSON.stringify({ title: DOWN_TITLE, body: `GET ${prod}/health failed on four reads over about two minutes (${detail || "no detail"}).\n\nRailway dashboard: https://railway.app - check the agent402 service and its latest deployment. A deploy's no-container window is 60-90 s, shorter than this check.\n\n---\nObserved from outside production by the status Worker (Cloudflare cron) at ${now}. Auto-closes when /health answers again.` }),
    });
    return { action: r.ok ? "opened" : "open-failed" };
  }
  if (!apiFailed && existing) {
    const r = await gh(`/repos/${ISSUES_REPO}/issues/${existing}`, token, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    return { action: r.ok ? "closed" : "close-failed" };
  }
  return { action: "none", down };
}

// The credential this Worker presents to /api/status/probe. STATUS_PROBE_TOKEN
// is the narrow one and opens that endpoint and nothing else; OPERATOR_TOKEN is
// the root credential that also reaches /__operator/refunds/update,
// /credits/disable, /well-known, /leads and the rest, and is only still
// accepted here so the two can be rotated without the observer going dark.
// Once STATUS_PROBE_TOKEN is set, DELETE the OPERATOR_TOKEN secret:
//   wrangler secret delete OPERATOR_TOKEN
export const probeToken = (env) => env.STATUS_PROBE_TOKEN || env.OPERATOR_TOKEN || "";

// `timing` exists for the tests (no real 20 s / 30 s pauses); the scheduler and
// /run pass nothing.
export async function run(env, timing = {}) {
  const prod = env.PROD || "https://agent402.tools";
  const token = probeToken(env);
  if (!token) {
    // Fail loudly in the log rather than posting unauthenticated: a silent skip
    // is exactly what let a different alarm sit dead for months.
    console.error("status-probe: neither STATUS_PROBE_TOKEN nor OPERATOR_TOKEN is set — refusing to probe");
    return { ok: false, error: "no probe token" };
  }
  // The paid-call challenge takes the NARROW token only, never OPERATOR_TOKEN:
  // the root credential has no business on a public route, and the server
  // honours only STATUS_PROBE_TOKEN there anyway.
  const { components, fails, paidCall } = await observe(prod, {
    paidCallToken: env.STATUS_PROBE_TOKEN || "",
    ...(timing.sleep ? { sleep: timing.sleep, retryDelayMs: 0 } : {}),
  });
  // When production is unreachable this POST cannot land either. That absence
  // is the evidence: /status renders a missing observation as a gap, never as
  // uptime, so there is nothing to fake here.
  const recorded = await record(prod, token, components, "https://github.com/MikeyPetrillo/Agent402/tree/main/workers/status-probe")
    .catch(() => false);
  // One open-issues read serves both the outage and the alarm reconcile.
  let openList = null;
  if (env.GITHUB_ISSUES_TOKEN) { try { openList = await openIssues(env.GITHUB_ISSUES_TOKEN); } catch { openList = null; } }
  const apiFailed = fails.some((f) => f.startsWith("api("));
  const outage = await syncOutage(env, { apiFailed, detail: fails.join(" "), openList, ...(timing.sleep ? { sleep: timing.sleep, confirmDelayMs: 0 } : {}) })
    .catch((e) => ({ action: "none", error: String(e?.message || e).slice(0, 100) }));
  // Independent of the probe result: the balance and reachability alarms are
  // healthy-path work too, and their only other observer runs every few hours.
  const alarms = await syncAlarms(env, { openList, ...(timing.sleep ? { sleep: timing.sleep, confirmDelayMs: 0 } : {}) })
    .catch((e) => ({ opened: [], closed: [], bad: [], error: String(e?.message || e).slice(0, 100) }));
  const alarmLine = alarms.error
    ? `alarms skipped (${alarms.error})`
    : `alarms bad=[${alarms.bad.join(" ")}] opened=[${alarms.opened.join(" ")}] closed=[${alarms.closed.join(" ")}]`;
  // A skipped paid-call is logged every time: the component simply ages on
  // /status, so this line is where the reason is readable.
  const paidLine = paidCall?.observed ? "paid-call observed" : `paid-call NOT observed (${paidCall?.reason || "check off"})`;
  const outageLine = outage.error ? `outage skipped (${outage.error})` : `outage ${outage.action}`;
  console.log(`status-probe: ${fails.length ? `FAILS ${fails.join(" ")}` : "all healthy"} | ${paidLine} | recorded=${recorded} | ${alarmLine} | ${outageLine}`);
  return { ok: true, recorded, fails, components, paidCall, alarms, outage };
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
