#!/usr/bin/env bash
# The Stripe card canary, run by the operator from their own machine: one $0.50
# card purchase of a production route over the MPP stripe/charge challenge,
# approved in the Link app while it waits (scripts/stripe-link-canary.mjs does
# the work). It runs here, not in CI: a Link refresh token is single use, and
# only the Link CLI's own credential file on this machine keeps the token each
# refresh hands back, so a stored CI secret is spent after one run.
#
# Once per machine:   npx -y @stripe/link-cli@<LINK_CLI_VERSION> auth login
# Then:               STRIPE_PROFILE_ID=... POW_SECRET=... scripts/link-canary-local.sh [options]
#
# Options:
#   --probe-only               only check that the live 402 offers stripe/charge; buys nothing
#                              (needs neither the Link session nor STRIPE_PROFILE_ID)
#   --route <path>             the paid route (default /v1/premium/chat/completions)
#   --spend-request-id <id>    pay with an already-approved spend request (a rerun after a late approval)
#   -h, --help                 this text
#
# Environment: STRIPE_PROFILE_ID (the Link network id the spend request names),
# POW_SECRET (signs X-Heartbeat-Token so the buy is booked as internal; a buy
# without it is refused here), TARGET_URL (default https://agent402.tools),
# LINK_CLI_VERSION (the Link CLI version the session was signed in with).
# No Link token is read from the environment: the CLI uses its local session.
set -euo pipefail

usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }
here="$(cd "$(dirname "$0")" && pwd)"
probe_only=""
route=""
spend_request_id=""

while [ $# -gt 0 ]; do
  case "$1" in
    --probe-only) probe_only=1; shift ;;
    --route)
      [ $# -ge 2 ] || { echo "link-canary-local: --route needs a path" >&2; exit 2; }
      route="$2"; shift 2 ;;
    --spend-request-id)
      [ $# -ge 2 ] || { echo "link-canary-local: --spend-request-id needs an id" >&2; exit 2; }
      spend_request_id="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "link-canary-local: unknown option '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "link-canary-local: runs on the operator's machine, where the Link CLI keeps its session; refusing under CI" >&2
  exit 2
fi
if [ -z "$probe_only" ]; then
  [ -n "${STRIPE_PROFILE_ID:-}" ] || { echo "link-canary-local: STRIPE_PROFILE_ID is not set" >&2; exit 2; }
  [ -n "${POW_SECRET:-}" ] || { echo "link-canary-local: POW_SECRET is not set (without it the buy is booked as outside demand)" >&2; exit 2; }
fi

# Only what the canary reads; no Link token is passed on.
vars=("STRIPE_CANARY_PROBE_ONLY=$probe_only")
[ -n "$route" ] && vars+=("STRIPE_CANARY_ROUTE=$route")
[ -n "$spend_request_id" ] && vars+=("STRIPE_CANARY_SPEND_REQUEST_ID=$spend_request_id")
exec env -u LINK_ACCESS_TOKEN -u LINK_REFRESH_TOKEN "${vars[@]}" node "$here/stripe-link-canary.mjs"
