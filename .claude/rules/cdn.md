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
---

# Request edge: CDN, client address, async jobs, large bodies, outbound fetches

Loaded when an edge, job or fetch-guard file is read.

- **Async jobs:** `Prefer: respond-async` on a paid slow route (`runSeconds`, from `EVM_RUN_SECONDS`) answers 202 and a job link (`src/async-jobs.js`, mounted before every payment gate); the call is replayed over 127.0.0.1 with the buyer's payment and settles only on a final 200; `GET /api/jobs/:id` serves it. Jobs report progress: `status` keeps working/completed/failed, `state` is queued/running/succeeded/failed with `stage`, `progress`, `etaSeconds` and `Retry-After` (`src/job-progress.js`); which routes are slow, and what the 402, /api/pricing, /openapi.json and /llms-full.txt say about them, comes from `src/slow-routes.js`.
  A Tempo push credential's transfer is final before the call, so neither sync window refuses it directly: `src/slow-sync-window.js` and `src/cdn-sync-window.js` park the refusal on the request with `deferSyncWindowRefusal` and the Tempo gate answers it from `syncWindowRefusalOf(req)` in its push input check (the transfer booked as owed until the same credential returns with the header); server.js defers only while `tempoGateMounted` is true, set right after the gate mounts, so with no gate the windows refuse as for any other payment. That deferred answer applies to a slow route that offers Tempo, of which the current catalog has none: every slow route is long-running (`isLongRunningSlug`), so `tempoOfferedFor` is false there and the gate's binding check refuses the push credential first (`routeRefusal`: long-running, identity-bound, priced above the challenge, free), asks the relay whether the transfer pays the challenge and books a confirmed one as owed the same way; `scripts/test-tempo-push-debts.js` pins that no slow route offers Tempo, so a change that adds one is noticed and covers the deferred path there.
  Through the CDN proxy (`req.viaCdn`), a paid call without the header to a route whose run budget is past `CDN_SYNC_MAX_SECONDS` (default 90) runs as a job only for a client that follows a 202 on its own (agent402-client 0.8.16+) and is otherwise refused with a 504 before any gate, while LLM attempts, image fallback links and route-execute's seller waits are bounded by `cdnSyncLeftMs(req)` (`src/cdn-sync-window.js`).
- **Client address:** `trust proxy` is `TRUST_PROXY_HOPS` (`src/trust-proxy.js`): unset or invalid reads 0 with a boot warning (req.ip is the socket address and no X-Forwarded-For counts), production sets 1; with 0, a genuine loopback replay (MCP marker or async-job token) takes the buyer address it carries. `src/cdn-client-ip.js` redefines `req.ip` right after `trust proxy`: CF-Connecting-IP is the client only when the edge-reported peer is inside the embedded CDN ranges (plus `CF_IP_RANGES_EXTRA`) and the header parses as an address; from any other peer it is ignored. `CDN_PROXY` (`cloudflare` or `on`, default off) turns the resolver and the CDN sync window on, and while on a peer's CF-Connecting-IP counts (and the request is `req.viaCdn`) only when it also carries `CDN_ORIGIN_SECRET` in `X-Origin-Auth` (constant-time compare, stripped before handlers), so off or without the secret `req.ip` is the trust-proxy address. Read the client address only through `req.ip`.
  `cdnOrigin` on `/api/gateway-status` reads `unauthenticated` while a CDN-range peer reached the origin without the secret inside the window.
- **Large bodies:** `src/large-body-gate.js` sits before the parsers of the routes that take more
  than the global 100 KB body: it refuses a Content-Encoding (415), answers an unpaid oversized
  body whose price does not read it without reading it, rate-limits the unpaid ones that are
  parsed, and reserves each parse against one in-flight budget (`LARGE_BODY_INFLIGHT_MAX_MB`,
  default 256; 503 with Retry-After when spent), of which one client address holds at most a
  quarter (never less than two of the largest route's bodies). A slow body is bounded by the
  server's `HTTP_REQUEST_TIMEOUT_MS`.
- **Outbound fetches:** every buyer-supplied URL goes through `src/tools/fetch-guard.js`. A name
  that does not resolve and a private address get one neutral 400; a resolver that cannot answer
  (EAI_AGAIN and the other transient codes, or a lookup past `DNS_LOOKUP_TIMEOUT_MS`, default 10 s)
  is a retryable 503 attributed to our side (`attribution: "ours"`, `hint: "our-egress"`). The guard resolves with c-ares (`resolveHostAddresses`: every A and AAAA answer, one query per name in flight, each try held to `RESOLVER_MAX_TIMEOUT_MS` so an unanswered query ends near the 10 s bound; the connect-time pin refuses a name when any A answer is private, not only the first), never `dns.lookup`, so an unanswered name holds no libuv pool thread; a hosts-file-only name reads as unresolved, and test stubs go through `scripts/lib/guard-resolver-stub.js`. A caller URL
  that times out or refuses the connection is a 504 with `attribution: "unknown"` and `hint` `source-timeout` or
  `source-unreachable`, advising to check the URL or retry; the attribution vocabulary lives in `src/upstream-deadline.js`, where a named upstream whose host name does not resolve is `attribution: "unknown"`, `hint: "connect-failed"`, and only a lookup our resolver could not finish is `our-egress`. The MCP connector's loopback replay carries a
  per-process secret in its marker (`src/mcp-loopback.js`); an inbound marker is stripped by the
  first middleware, so only the real replay is exempt from the discovery limits.
