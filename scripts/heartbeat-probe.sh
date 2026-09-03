#!/usr/bin/env bash
# Shared production probe + status recorder for .github/workflows/heartbeat.yml.
#
# Extracted so the SAME checks can run several times per workflow run. GitHub
# only delivers this workflow's "*/15" schedule about once an hour (measured
# 2026-07-27: gaps of 60-72 min, and one 3.3h stall), while /status marks a
# component stale after 45 minutes. That mismatch made the page report
# "degraded" on a healthy production, which is exactly the failure mode
# src/status.js warns about: a threshold that no longer matches the cadence of
# whatever is doing the observing.
#
# The fix is more observations per run, not a looser alarm. Sourced, never
# executed: it defines probe() and record_observation() and does nothing else.
#
# Required env: PROD, RUN_URL, and PROBE_TOKEN (or OP_TOKEN as the fallback). Optional: POW_SECRET,
# ROBINHOOD_FACILITATOR_URL (presence = the operator intends the Robinhood rail).
#
# probe() sets the global FAILS to a space-separated list of what failed and
# returns 0 only when everything passed.
#
# SINGLE-RETRY SEMANTICS (2026-07-29, parity with workers/status-probe): a
# failed pass re-probes once after PROBE_RETRY_DELAY (default 20s) and only a
# failure that survives is recorded. A single transient blip (a probe landing
# inside a deploy restart, one dropped TCP connect) was writing sub-minute
# incidents into /status history - the 03:40Z entry on 2026-07-29 arrived
# AFTER the worker got its retry, proving this observer needed the same
# treatment. A real outage fails both passes and records exactly as before;
# the first attempt's blip still goes to the job log, so nothing is invisible.

probe() {
  probe_once && return 0
  echo "[heartbeat-probe] first attempt FAILS:$FAILS - retrying once in ${PROBE_RETRY_DELAY:-20}s (only a failure that survives is recorded)"
  sleep "${PROBE_RETRY_DELAY:-20}"
  probe_once
}

probe_once() {
  FAILS=""
  curl -sf --max-time 15 "$PROD/health" >/dev/null || FAILS="$FAILS /health"
  N=$(curl -s --max-time 15 "$PROD/api/pricing" | jq '.endpoints | length' 2>/dev/null || echo 0)
  # Catalog floor tracks "The 500" era (462 curated tools interim,
  # 500 at launch). The alarm should only fire on a real catalog
  # collapse (routes failing to mount), never on deliberate curation.
  [ "${N:-0}" -ge 400 ] || FAILS="$FAILS catalog($N)"
  MCP=$(curl -s --max-time 15 -X POST "$PROD/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"heartbeat","version":"0"}}}' \
    | grep -c '"agent402"' || true)
  [ "${MCP:-0}" -ge 1 ] || FAILS="$FAILS /mcp"
  # Paywall must be ENGAGED: a wallet-only tool returns 402 when unpaid.
  # Catches an accidental FREE_MODE / gate regression that would give
  # paid tools away for free (a silent revenue-loss incident).
  PW=$(curl -s --max-time 15 -D /tmp/hb-402.h -o /dev/null -w "%{http_code}" -X POST "$PROD/api/extract" -H 'Content-Type: application/json' -d '{"url":"https://example.com"}')
  [ "$PW" = "402" ] || FAILS="$FAILS paywall($PW)"
  # The retired pairwise converters are paid too ($0.001, same as the
  # unit-convert tool that replaced them) but they are NOT catalog
  # routes, so the check above can't see them. They served that exact
  # output for FREE until 2026-07-25 because their handlers were
  # registered above the paywall middleware — a gap no probe noticed
  # for weeks. A servable request must 402; an unservable one must
  # still get the free teaching 410, so both halves are asserted.
  RC=$(curl -s --max-time 15 -o /dev/null -w "%{http_code}" -X POST "$PROD/api/convert/feet-to-meters" -H 'Content-Type: application/json' -d '{"value":10}')
  [ "$RC" = "402" ] || FAILS="$FAILS retired-convert-paywall($RC)"
  RG=$(curl -s --max-time 15 -o /dev/null -w "%{http_code}" -X POST "$PROD/api/convert/feet-to-meters" -H 'Content-Type: application/json' -d '{}')
  [ "$RG" = "410" ] || FAILS="$FAILS retired-convert-teaching($RG)"
  # Payment RAILS must stay in the offer. A rail silently dropping
  # out of the 402 accepts loses that chain's revenue with no error
  # anywhere (the 2026-07-02 incident class: buyers simply never see
  # the option). Base is always required; Robinhood/USDG is required
  # iff the ROBINHOOD_FACILITATOR_URL secret says the operator
  # intends the rail.
  if [ "$PW" = "402" ]; then
    NETS=$(tr -d '\r' < /tmp/hb-402.h | awk -F': ' 'tolower($1)=="payment-required"{print $2}' | head -1 \
      | base64 -d 2>/dev/null | jq -r '[.accepts[]?.network] | join(",")' 2>/dev/null || echo "")
    case "$NETS" in *eip155:8453*) : ;; *) FAILS="$FAILS rails(base-missing:${NETS:-unparsed})";; esac
    if [ -n "$ROBINHOOD_FACILITATOR_URL" ]; then
      case "$NETS" in *eip155:4663*) : ;; *) FAILS="$FAILS rails(robinhood-missing:${NETS:-unparsed})";; esac
    fi
  fi
  node --input-type=module -e '
    const B = process.env.PROD;
    const { createHash, createHmac } = await import("node:crypto");
    const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
    const c = await (await fetch(B + "/api/pow/challenge?slug=hash")).json();
    let n = 0; while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
    // X-Heartbeat-Token = HMAC(POW_SECRET, "heartbeat:" + UTC-minute),
    // truncated to 32 base64url chars. The server verifies with the
    // same secret and a ±5 minute skew window, so spoofed UAs can no
    // longer poison the operator dashboard heartbeat rail.
    const minute = Math.floor(Date.now() / 60000);
    const hb = createHmac("sha256", process.env.POW_SECRET || "").update("heartbeat:" + minute).digest("base64url").slice(0, 32);
    const r = await fetch(B + "/api/hash", { method: "POST", headers: { "Content-Type": "application/json", "X-Pow-Solution": c.token + ":" + n, "X-Heartbeat-Token": hb, "User-Agent": "agent402-heartbeat/1.0" }, body: JSON.stringify({ text: "heartbeat" }) });
    if (r.status !== 200) { console.error("pow call -> " + r.status); process.exit(1); }
  ' || FAILS="$FAILS pow-paid-call"
  [ -z "$FAILS" ]
}

# Record what a probe observed on /status. Best-effort by design: never fails
# the caller, because a status-page write must not turn a healthy heartbeat
# red. When prod is down this POST cannot land either, and that absence is the
# evidence -- /status renders a missing observation as a gap, never as uptime.
# $1 = "up" | "down", $2 = the FAILS string from that probe.
record_observation() {
  local STATUS="$1" FAILS="$2"
  # PROBE_TOKEN is the narrow credential: it opens POST /api/status/probe and
  # nothing else. OP_TOKEN is the ROOT operator token, which also reaches
  # /__operator/refunds/update, /credits/disable, /well-known and the rest, and
  # is only still accepted so the two can be rotated without an observer going
  # dark. Prefer the narrow one wherever it is configured.
  local TOKEN="${PROBE_TOKEN:-$OP_TOKEN}"
  [ -n "$TOKEN" ] || { echo "no probe token - skipping status record"; return 0; }
  # A component is false only when the probe named it in FAILS, so a check that
  # passed is never marked down by another check's failure.
  has() { case "$FAILS" in *"$1"*) echo false;; *) echo true;; esac; }
  local API CATALOG MCP PAYWALL RAILS PAID
  if [ "$STATUS" = "up" ]; then
    API=true; CATALOG=true; MCP=true; PAYWALL=true; RAILS=true; PAID=true
  else
    API=$(has "/health"); CATALOG=$(has "catalog("); MCP=$(has "/mcp")
    PAYWALL=$(has "paywall("); RAILS=$(has "rails("); PAID=$(has "pow-paid-call")
  fi
  local BODY
  BODY=$(jq -nc --arg u "$RUN_URL" --arg d "$FAILS" \
    --argjson a "$API" --argjson c "$CATALOG" --argjson m "$MCP" \
    --argjson w "$PAYWALL" --argjson r "$RAILS" --argjson p "$PAID" \
    '{source:"heartbeat", ts:(now*1000|floor), url:$u, components:{
       "api":{ok:$a, detail:(if $a then null else $d end)},
       "catalog":{ok:$c, detail:(if $c then null else $d end)},
       "mcp":{ok:$m, detail:(if $m then null else $d end)},
       "paywall":{ok:$w, detail:(if $w then null else $d end)},
       "rails":{ok:$r, detail:(if $r then null else $d end)},
       "paid-call":{ok:$p, detail:(if $p then null else $d end)}}}')
  curl -sf --max-time 20 -X POST "$PROD/api/status/probe" \
    -H "Content-Type: application/json" -H "X-Operator-Token: $TOKEN" \
    -d "$BODY" >/dev/null && echo "probe recorded" || echo "probe not recorded (prod unreachable - the gap is the signal)"
}
