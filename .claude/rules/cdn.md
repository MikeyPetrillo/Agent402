---
paths:
  - "src/cdn-*.js"
  - "src/async-jobs.js"
  - "src/job-progress.js"
  - "src/slow-routes.js"
  - "src/slow-sync-window.js"
  - "src/large-body-gate.js"
  - "src/tools/fetch-guard.js"
  - "src/mcp-loopback.js"
  - "src/price-webhooks.js"
  - "src/tools/price-webhook-kit.js"
  - "src/feature-flags.js"
---

# Request edge: CDN, client address, async jobs, large bodies, outbound fetches

Loaded when an edge, job or fetch-guard file is read.

- **Async jobs:** `Prefer: respond-async` on a paid slow route (`runSeconds`, from `EVM_RUN_SECONDS`) answers 202 and a job link (`src/async-jobs.js`, mounted before every payment gate); the call is replayed over 127.0.0.1 with the buyer's payment and settles only on a final 200 (a Tempo push transfer is final before the run); `GET /api/jobs/:id` serves it. Jobs report progress: `status` keeps working/completed/failed, `state` is queued/running/succeeded/failed with `stage`, `progress`, `etaSeconds` and `Retry-After` (`src/job-progress.js`); which routes are slow, and what the 402, /api/pricing, /openapi.json and /llms-full.txt say about them, comes from `src/slow-routes.js`.
  A Tempo push credential's transfer is final before the call, so neither sync window refuses it directly: `src/slow-sync-window.js` and `src/cdn-sync-window.js` park the refusal on the request with `deferSyncWindowRefusal` and the Tempo gate answers it from `syncWindowRefusalOf(req)` in its push input check (the transfer booked as owed until the same credential returns with the header); server.js defers only while `tempoGateMounted` is true, set right after the gate mounts, so with no gate the windows refuse as for any other payment. That deferred answer applies to a slow route that offers Tempo, of which the current catalog has none: every slow route is long-running (`isLongRunningSlug`), so `tempoOfferedFor` is false there and the gate's binding check refuses the push credential first (`routeRefusal`: long-running, identity-bound, priced above the challenge, free), asks the relay whether the transfer pays the challenge and books a confirmed one as owed the same way; `scripts/test-tempo-push-debts.js` pins that no slow route offers Tempo, so a change that adds one is noticed and covers the deferred path there.
  Through the CDN proxy (`req.viaCdn`), a paid call without the header to a route whose run budget is past `CDN_SYNC_MAX_SECONDS` (default 90) runs as a job only for a client that follows a 202 on its own (agent402-client 0.8.16+) and is otherwise refused with a 504 before any gate, while LLM attempts, image fallback links and route-execute's seller waits are bounded by `cdnSyncLeftMs(req)` (`src/cdn-sync-window.js`).
- **Client address:** `trust proxy` is `TRUST_PROXY_HOPS` (`src/trust-proxy.js`): unset or invalid reads 0 with a boot warning (req.ip is the socket address and no X-Forwarded-For counts), production sets 1; with 0, a genuine loopback replay (MCP marker or async-job token) takes the buyer address it carries. `src/cdn-client-ip.js` redefines `req.ip` right after `trust proxy`: CF-Connecting-IP is the client only when the edge-reported peer is inside the embedded CDN ranges (plus `CF_IP_RANGES_EXTRA`) and the header parses as an address; from any other peer it is ignored. `CDN_PROXY` (`cloudflare` or `on`, default off) turns the resolver and the CDN sync window on, and while on a peer's CF-Connecting-IP counts (and the request is `req.viaCdn`) only when it also carries `CDN_ORIGIN_SECRET` in `X-Origin-Auth` (constant-time compare, stripped before handlers), so off or without the secret `req.ip` is the trust-proxy address. Read the client address only through `req.ip`.
  `cdnOrigin` on `/api/gateway-status` reads `unauthenticated` while a CDN-range peer reached the origin without the secret inside the window. Our own loopback replay (an async job's or the MCP connector's, proven by its per-process token or marker on a loopback socket: `isReplay` in `cdnClientIpMiddleware`) carries the buyer's address and no secret and is never counted.
- **Large bodies:** `src/large-body-gate.js` sits before the parsers of the routes that take more
  than the global 100 KB body: it refuses a Content-Encoding (415), answers an unpaid oversized
  body whose price does not read it without reading it, rate-limits the unpaid ones that are
  parsed, and reserves each parse against one in-flight budget (`LARGE_BODY_INFLIGHT_MAX_MB`,
  default 256; 503 with Retry-After when spent), of which one client address holds at most a
  quarter (never less than two of the largest route's bodies). A slow body is bounded by the
  server's `HTTP_REQUEST_TIMEOUT_MS`.
- **Outbound fetches:** every buyer-supplied URL goes through `src/tools/fetch-guard.js`. A name
  that does not resolve and a private address get one neutral 400 (a host a kit reads on its own passes `ownUpstream: true` to `safeFetch` or `assertPublicUrl`, and the same refusal is our 503, `attribution: "ours"`, `hint: "our-egress"`, Retry-After 5: `ownUpstreamUnresolved`); a resolver that cannot answer
  (EAI_AGAIN and the other transient codes, or a lookup past `DNS_LOOKUP_TIMEOUT_MS`, default 10 s)
  is a retryable 503 attributed to our side (`attribution: "ours"`, `hint: "our-egress"`). The guard resolves with c-ares (`resolveHostAddresses`: every A and AAAA answer, one query per name in flight, each try held to `RESOLVER_MAX_TIMEOUT_MS` so an unanswered query ends near the 10 s bound; the connect-time pin refuses a name when any A answer is private, not only the first), so an unanswered name holds no libuv pool thread; `dns.lookup` (`{all: true}`, inside the same bound, every address checked) runs once only when the name server refuses the query at once (ECONNREFUSED, EREFUSED, ECONNRESET), never on a timeout, SERVFAIL or no-such-name. `resolvePublicAddresses` is the one checked resolve, shared by the connect-time pin and the browser's egress proxy (`worker/egress-proxy.js`), so both refuse the same hosts (192.88.99.0/24, the 6to4 relay block, among the special ranges). A hosts-file-only name reads as unresolved unless that fallback runs, and test stubs go through `scripts/lib/guard-resolver-stub.js` (`stubGuardResolver`, `stubGuardLookup`). A caller URL
  that times out or refuses the connection is a 504 with `attribution: "unknown"` and `hint` `source-timeout` or
  `source-unreachable`, advising to check the URL or retry; the attribution vocabulary lives in `src/upstream-deadline.js`, where a named upstream whose host name does not resolve is `attribution: "unknown"`, `hint: "connect-failed"`, and only a lookup our resolver could not finish is `our-egress`. The MCP connector's loopback replay carries a
  per-process secret in its marker (`src/mcp-loopback.js`); an inbound marker is stripped by the
  first middleware, so only the real replay is exempt from the discovery limits.
- **Price webhooks** (`src/price-webhooks.js`, `POST /api/price-webhook`): a registration keeps an https URL,
  the slugs it watches, its expiry and a keyed digest of its registrant (no secret, wallet or address). **Who is
  bounded:** the registrant (`registrantOf` in `src/tools/price-webhook-kit.js`: the signed payer, a credits key, a
  Tempo sender, the signer of a Solana, Algorand or Stellar payment; any other paid call is a registrant of its own;
  in FREE_MODE, where there is no payer, the client address) holds at most `PRICE_WEBHOOK_MAX_PER_PAYER` (25), and
  its own next one is the 409; nothing is refused for the host a URL names. **Kept only when the call settles:**
  the handler stores the subscription pending and a `req.__onSettled` hook confirms it on a final settled 200 and
  removes it on anything else (`PENDING_MS`, ten minutes, ends one never reported); a pending one is never
  delivered to (`scripts/test-price-webhooks-paid.js`). **Lifetime:** `PRICE_WEBHOOK_LIFETIME_DAYS` (90); the same
  URL again from the same proven registrant renews it in place (same id and secret, no second place against the
  cap); a subscription stored with no expiry gets one lifetime from this build's first store write. **Store
  bound:** expired ones go at every registration and each time the prices are recorded (a boot), and are
  never delivered to in between; from `PRICE_WEBHOOK_MAX` (5,000) a new registration first removes
  the subscriptions whose last delivery was dropped after every attempt and is admitted all the same, up to twice
  that (a 503 with Retry-After); nothing a receiver still answers is removed for room. At boot the catalog's list
  prices are compared with the ones kept and the changes are stored once as a set that one queued delivery per
  watching subscription names (`price-webhooks-note`, leased; at most `MAX_CHANGE_SETS`). The delivery turn
  (`price-webhooks-deliver`, leased, and guarded in the process so it never runs beside itself in file mode) sends
  each through `probePublicUrl` (the host checked, the address re-checked at connect, no redirect followed) with a
  signature header keyed by a secret derived from the signing key and the subscription id: one request at a time
  to a receiving host, `DELIVERY_LANES` (16) hosts at once, `DELIVERY_TIMEOUT_MS` (4 s) for one whole attempt, a
  host that does not answer gets no more that turn and one that answers gets `HOST_TURN_MS` (8 s) of it,
  subscriptions whose last attempt got a 2xx first and one per registrant before anyone's second, no attempt
  started after `TURN_BUDGET_MS` (40 s). A 2xx ends a delivery, a 410 removes the subscription, anything else is
  retried on `RETRY_DELAYS_MS` (per subscription) and then dropped. A documentation host is answered in full and
  nothing is stored. The slug is in the lasting-effect list; removal is the free
  `POST /api/price-webhook/unsubscribe`. `PRICE_WEBHOOK_DELIVERIES` is a runtime switch
  (`src/feature-flags.js`: a flag provider when one is registered, else the variable, else the declared
  default; the provider is Railway's flags while `FEATURE_FLAGS_RAILWAY_TOKEN` is set, unset by default,
  `.claude/rules/ops.md`). Suite: `scripts/test-price-webhooks.js`.
