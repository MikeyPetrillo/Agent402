#!/usr/bin/env bash
# Offline test for scripts/heartbeat-probe.sh — the shared heartbeat probe.
#
# The risky logic is record_observation()'s FAILS -> per-component mapping. Get
# it wrong and /status silently reports the wrong component down (or worse,
# reports a broken component as operational), which is the one thing a status
# page must never do. Everything here runs against a stubbed curl, so no
# request ever reaches production.
set -u

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; echo "       $2"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Stub curl: capture the POST body instead of sending it.
cat > "$TMP/curl" <<'EOF'
#!/usr/bin/env bash
body=""
while [ $# -gt 0 ]; do
  case "$1" in -d) body="$2"; shift 2;; *) shift;; esac
done
[ -n "$body" ] && printf '%s' "$body" > "$CAPTURE"
exit 0
EOF
chmod +x "$TMP/curl"
export PATH="$TMP:$PATH"
export CAPTURE="$TMP/body.json"
export PROD="https://example.invalid" RUN_URL="https://run" OP_TOKEN="test-token"

# shellcheck source=/dev/null
. "$(dirname "$0")/heartbeat-probe.sh"

field() { jq -r ".components[\"$1\"].ok" < "$CAPTURE"; }

echo "heartbeat probe — component mapping"

rm -f "$CAPTURE"; record_observation up "" >/dev/null
for c in api catalog mcp paywall rails paid-call; do
  v=$(field "$c")
  [ "$v" = "true" ] && ok "up: $c is operational" || bad "up: $c is operational" "got $v"
done

rm -f "$CAPTURE"; record_observation down "/mcp" >/dev/null
[ "$(field mcp)" = "false" ] && ok "down(/mcp): mcp marked down" || bad "down(/mcp): mcp marked down" "got $(field mcp)"
for c in api catalog paywall rails paid-call; do
  v=$(field "$c")
  [ "$v" = "true" ] && ok "down(/mcp): $c stays operational" || bad "down(/mcp): $c stays operational" "got $v"
done

# A failing check must never drag unrelated components down with it.
rm -f "$CAPTURE"; record_observation down "catalog(12) rails(base-missing:)" >/dev/null
[ "$(field catalog)" = "false" ] && ok "multi: catalog down" || bad "multi: catalog down" "got $(field catalog)"
[ "$(field rails)" = "false" ]   && ok "multi: rails down"   || bad "multi: rails down"   "got $(field rails)"
[ "$(field api)" = "true" ]      && ok "multi: api unaffected" || bad "multi: api unaffected" "got $(field api)"
[ "$(field mcp)" = "true" ]      && ok "multi: mcp unaffected" || bad "multi: mcp unaffected" "got $(field mcp)"

rm -f "$CAPTURE"; record_observation down "pow-paid-call" >/dev/null
[ "$(field paid-call)" = "false" ] && ok "paid-call failure maps to paid-call" || bad "paid-call failure maps to paid-call" "got $(field paid-call)"
[ "$(field paywall)" = "true" ]    && ok "paid-call failure leaves paywall up" || bad "paid-call failure leaves paywall up" "got $(field paywall)"

rm -f "$CAPTURE"; record_observation down "rails(arc-missing:eip155:8453,eip155:5042002)" >/dev/null
[ "$(field rails)" = "false" ] && ok "an Arc rail missing from the offer maps to rails" || bad "an Arc rail missing from the offer maps to rails" "got $(field rails)"
# The Arc match is exact: the testnet id (eip155:5042002) never satisfies it.
for nets in "eip155:8453,eip155:5042002" "eip155:5042002"; do
  case "$nets" in *eip155:5042,*|*eip155:5042) bad "arc match is exact ($nets)" "matched" ;; *) ok "arc match is exact ($nets)" ;; esac
done
grep -q 'case "$NETS" in \*eip155:5042,\*|\*eip155:5042)' "$(dirname "$0")/heartbeat-probe.sh" && ok "the probe uses the exact Arc pattern" || bad "the probe uses the exact Arc pattern" "pattern not found"

# The retired-converter checks share the substring "paywall(" with the real
# paywall check. They must not be confused for each other.
rm -f "$CAPTURE"; record_observation down "retired-convert-paywall(200)" >/dev/null
v=$(field paywall)
[ "$v" = "false" ] && ok "retired-convert failure flags the paywall component" \
  || bad "retired-convert failure flags the paywall component" "got $v (a free-serving regression must show somewhere)"

# The observation carries a source and a timestamp, or the store cannot order it.
rm -f "$CAPTURE"; record_observation up "" >/dev/null
[ "$(jq -r .source < "$CAPTURE")" = "heartbeat" ] && ok "observation names its source" || bad "observation names its source" "missing"
ts=$(jq -r .ts < "$CAPTURE")
[ "$ts" -gt 1700000000000 ] 2>/dev/null && ok "observation carries a ms timestamp" || bad "observation carries a ms timestamp" "got $ts"

# Without a token it must no-op rather than POST unauthenticated.
rm -f "$CAPTURE"; OP_TOKEN="" record_observation up "" >/dev/null
[ ! -f "$CAPTURE" ] && ok "no token: records nothing" || bad "no token: records nothing" "posted anyway"

# --- single-retry semantics (2026-07-29, parity with the CF worker) ----------
# probe() must re-run probe_once ONCE on failure and report the SECOND verdict:
# a transient blip is never recorded, a sustained failure always is, and a
# healthy pass never pays the retry.
echo "heartbeat probe — retry semantics"
export PROBE_RETRY_DELAY=0
COUNT_FILE="$TMP/probe-count"; echo 0 > "$COUNT_FILE"
probe_once() {  # test override: fail on the first call, pass on the second
  n=$(( $(cat "$COUNT_FILE") + 1 )); echo "$n" > "$COUNT_FILE"
  if [ "$n" -eq 1 ]; then FAILS=" /health"; return 1; else FAILS=""; return 0; fi
}
if probe >/dev/null && [ -z "$FAILS" ] && [ "$(cat "$COUNT_FILE")" = "2" ]; then
  ok "transient blip: retry succeeds, FAILS empty, exactly two attempts"
else
  bad "transient blip: retry succeeds, FAILS empty, exactly two attempts" "rc=$? FAILS='$FAILS' attempts=$(cat "$COUNT_FILE")"
fi

echo 0 > "$COUNT_FILE"
probe_once() {  # sustained failure: both attempts fail
  n=$(( $(cat "$COUNT_FILE") + 1 )); echo "$n" > "$COUNT_FILE"
  FAILS=" /health"; return 1
}
if ! probe >/dev/null && [ "$FAILS" = " /health" ] && [ "$(cat "$COUNT_FILE")" = "2" ]; then
  ok "sustained failure: recorded down after exactly two attempts"
else
  bad "sustained failure: recorded down after exactly two attempts" "FAILS='$FAILS' attempts=$(cat "$COUNT_FILE")"
fi

echo 0 > "$COUNT_FILE"
probe_once() {  # healthy: single attempt, no retry
  n=$(( $(cat "$COUNT_FILE") + 1 )); echo "$n" > "$COUNT_FILE"
  FAILS=""; return 0
}
if probe >/dev/null && [ "$(cat "$COUNT_FILE")" = "1" ]; then
  ok "healthy pass: exactly one attempt, no retry pause"
else
  bad "healthy pass: exactly one attempt, no retry pause" "attempts=$(cat "$COUNT_FILE")"
fi

# The paywall read and the unpaid-quote budget's 429 (body reason
# "unpaid-quote-budget"): one capped re-read; two budget refusals leave paywall
# and rails unobserved, never failed; a plain 429 or a 500 fails as before.
# These cases are the unsigned fallback: no POW_SECRET, no token.
unset POW_SECRET
BUDGET_BODY='{"ok":false,"error":"rate-limited","reason":"unpaid-quote-budget","retryAfterSeconds":1800}'
# Each answer is "status|body"; the stub writes the body and a Retry-After header.
pw_case() {  # $1 = expected PW, $2 = expected PAYWALL_UNKNOWN, $3 = expected reads, $4 = expected sleeps, rest = answers
  local want_pw="$1" want_unknown="$2" want_reads="$3" want_sleeps="$4"; shift 4
  printf '%s\n' "$@" > "$TMP/answers"; : > "$TMP/reads"; : > "$TMP/sleeps"; : > "$TMP/hdrs"
  curl() {
    local hdr="" out="" ans
    while [ $# -gt 0 ]; do case "$1" in -D) hdr="$2"; shift 2;; -o) out="$2"; shift 2;; -H) echo "$2" >> "$TMP/hdrs"; shift 2;; *) shift;; esac; done
    echo x >> "$TMP/reads"
    ans=$(sed -n "$(wc -l < "$TMP/reads" | tr -d ' ')p" "$TMP/answers")
    printf 'HTTP/1.1 %s\r\nretry-after: 1800\r\n\r\n' "${ans%%|*}" > "$hdr"
    printf '%s' "${ans#*|}" > "$out"
    printf '%s' "${ans%%|*}"
  }
  sleep() { echo "$1" >> "$TMP/sleeps"; }
  paywall_read >/dev/null
  unset -f curl sleep
  local reads sleeps
  reads=$(wc -l < "$TMP/reads" | tr -d ' '); sleeps=$(tr '\n' ' ' < "$TMP/sleeps" | sed 's/ $//')
  [ "$PW" = "$want_pw" ] && [ "$PAYWALL_UNKNOWN" = "$want_unknown" ] && [ "$reads" = "$want_reads" ] && [ "$sleeps" = "$want_sleeps" ]
}
pw_case 402 "" 2 10 "429|$BUDGET_BODY" "402|{}" \
  && ok "budget 429 then 402: one re-read after a capped wait, paywall observed" \
  || bad "budget 429 then 402: one re-read after a capped wait, paywall observed" "PW=$PW unknown=$PAYWALL_UNKNOWN"
pw_case 429 1 2 10 "429|$BUDGET_BODY" "429|$BUDGET_BODY" \
  && ok "budget 429 twice: paywall not observed" \
  || bad "budget 429 twice: paywall not observed" "PW=$PW unknown=$PAYWALL_UNKNOWN"
pw_case 429 "" 1 "" '429|{"ok":false,"error":"rate-limited"}' \
  && ok "a plain 429: no re-read, not marked unobserved" \
  || bad "a plain 429: no re-read, not marked unobserved" "PW=$PW unknown=$PAYWALL_UNKNOWN"
pw_case 500 "" 1 "" "500|boom" \
  && ok "a 500: no re-read, not marked unobserved" \
  || bad "a 500: no re-read, not marked unobserved" "PW=$PW unknown=$PAYWALL_UNKNOWN"
# probe_once's own rule, on the values paywall_read leaves.
pw_fails() { FAILS=""; [ "$PW" = "402" ] || [ "$PAYWALL_UNKNOWN" = "1" ] || FAILS="$FAILS paywall($PW)"; echo "$FAILS"; }
grep -q '\[ "\$PW" = "402" \] || \[ "\$PAYWALL_UNKNOWN" = "1" \] || FAILS="\$FAILS paywall(\$PW)"' "$(dirname "$0")/heartbeat-probe.sh" \
  && ok "probe_once fails the paywall unless it is a 402 or unobserved" || bad "probe_once fails the paywall unless it is a 402 or unobserved" "rule not found"
PW=429; PAYWALL_UNKNOWN=1; [ -z "$(pw_fails)" ] && ok "unobserved: no paywall failure" || bad "unobserved: no paywall failure" "$(pw_fails)"
PW=429; PAYWALL_UNKNOWN=""; [ "$(pw_fails)" = " paywall(429)" ] && ok "plain 429: paywall fails" || bad "plain 429: paywall fails" "$(pw_fails)"
rm -f "$CAPTURE"; PAYWALL_UNKNOWN=1 record_observation up "" >/dev/null
[ "$(jq -r '.components | has("paywall") or has("rails")' < "$CAPTURE")" = "false" ] && [ "$(field api)" = "true" ] \
  && ok "record: an unobserved paywall leaves paywall and rails out, the rest recorded" \
  || bad "record: an unobserved paywall leaves paywall and rails out, the rest recorded" "$(cat "$CAPTURE")"
PAYWALL_UNKNOWN=""
rm -f "$CAPTURE"; record_observation up "" >/dev/null
[ "$(field paywall)" = "true" ] && ok "record: an observed paywall is recorded" || bad "record: an observed paywall is recorded" "$(cat "$CAPTURE")"

# The signed read: with POW_SECRET the paywall read carries X-Heartbeat-Token,
# the token src/pow.js verifies, so the budget never counts it (isSynthetic).
echo "heartbeat probe — signed paywall read"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export POW_SECRET="test-heartbeat-secret-do-not-use-in-prod"
pw_case 402 "" 1 "" "402|{}" && ok "signed: one read, paywall observed" || bad "signed: one read, paywall observed" "PW=$PW unknown=$PAYWALL_UNKNOWN"
TOK=$(sed -n 's/^X-Heartbeat-Token: //p' "$TMP/hdrs" | head -1)
[ "${#TOK}" = "32" ] && ok "signed: the paywall read sends a 32-character X-Heartbeat-Token" || bad "signed: the paywall read sends a 32-character X-Heartbeat-Token" "headers: $(tr '\n' ' ' < "$TMP/hdrs")"
# The token verifies on the server, and the server's real budget, spent from
# this address by another caller, lets the signed read through where the same
# read unsigned gets the budget's 429.
VERDICT=$(cd "$REPO" && TOK="$TOK" node --input-type=module -e '
  await import("./scripts/lib/offline-stores.js");
  const { verifyHeartbeatToken } = await import("./src/pow.js");
  const { createUnpaidQuoteBudget } = await import("./src/unpaid-quote-budget.js");
  const b = createUnpaidQuoteBudget({ budget: 1, replicas: 1, isPriced: () => true, isSynthetic: (req) => verifyHeartbeatToken(req.headers["x-heartbeat-token"]), log: () => {} });
  const run = (headers) => new Promise((resolve) => {
    const req = { method: "POST", path: "/api/extract", ip: "203.0.113.9", headers: { "user-agent": "curl/8", ...headers }, header(n) { return this.headers[String(n).toLowerCase()]; } };
    const res = { statusCode: 200, set() { return this; }, once() {}, status(c) { this.statusCode = c; return this; }, json() { resolve(this.statusCode); return this; } };
    const p = b.middleware(req, res, () => resolve("next"));
    if (p && typeof p.then === "function") p.catch(() => resolve("threw"));
  });
  const other = [await run({}), await run({})];
  const signed = await run({ "x-heartbeat-token": process.env.TOK });
  const unsigned = await run({});
  const forged = await run({ "x-heartbeat-token": "A".repeat(32) });
  process.stdout.write(JSON.stringify({ verifies: verifyHeartbeatToken(process.env.TOK), other, signed, unsigned, forged }));
' 2>&1)
[ "$(jq -r .verifies <<<"$VERDICT" 2>/dev/null)" = "true" ] && ok "signed: the token verifies with src/pow.js" || bad "signed: the token verifies with src/pow.js" "$VERDICT"
[ "$(jq -c .other <<<"$VERDICT" 2>/dev/null)" = '["next",429]' ] && ok "signed: control, another caller spends the address's budget (429)" || bad "signed: control, another caller spends the address's budget (429)" "$VERDICT"
[ "$(jq -r .signed <<<"$VERDICT" 2>/dev/null)" = "next" ] && ok "signed: the signed read passes the spent budget (no 429 can occur)" || bad "signed: the signed read passes the spent budget (no 429 can occur)" "$VERDICT"
[ "$(jq -r .unsigned <<<"$VERDICT" 2>/dev/null)" = "429" ] && [ "$(jq -r .forged <<<"$VERDICT" 2>/dev/null)" = "429" ] && ok "signed: the same read unsigned, or with a forged token, gets the 429" || bad "signed: the same read unsigned, or with a forged token, gets the 429" "$VERDICT"
# The re-read after a budget refusal is signed too (an old server, or a clock off by minutes).
pw_case 402 "" 2 10 "429|$BUDGET_BODY" "402|{}" && [ "$(grep -c '^X-Heartbeat-Token: ' "$TMP/hdrs")" = "2" ] \
  && ok "signed: the fallback re-read carries the token too" || bad "signed: the fallback re-read carries the token too" "$(cat "$TMP/hdrs")"
unset POW_SECRET
pw_case 402 "" 1 "" "402|{}" && ! grep -q '^X-Heartbeat-Token' "$TMP/hdrs" \
  && ok "unsigned: without POW_SECRET no token header is sent" || bad "unsigned: without POW_SECRET no token header is sent" "$(cat "$TMP/hdrs")"
grep -q 'POW_SECRET: \${{ secrets.POW_SECRET }}' "$REPO/.github/workflows/heartbeat.yml" \
  && ok "the heartbeat workflow hands POW_SECRET to the probe" || bad "the heartbeat workflow hands POW_SECRET to the probe" "not found"

echo
if [ "$FAIL" -eq 0 ]; then echo "all passed ($PASS)"; else echo "FAILED ($FAIL of $((PASS+FAIL)))"; fi
[ "$FAIL" -eq 0 ]
