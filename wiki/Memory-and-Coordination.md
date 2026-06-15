# Memory and Coordination

The retention product. Agent sessions are ephemeral — the container is gone an hour later. `/api/memory` is durable state where **the paying wallet is the identity**: no API key to store, leak, or rotate. Write from one machine today, read from another next week, with nothing but the same private key.

All memory tools are wallet-only (payment = authentication, so there's no proof-of-work mode).

## Core (key-value)

```bash
# write (or overwrite); optional ttlSeconds
POST /api/memory            {"key":"deploy-fix","value":{"cause":"build OOM"},"ttlSeconds":2592000}
# read
GET  /api/memory?key=deploy-fix
# delete
POST /api/memory            {"key":"deploy-fix","delete":true}
# atomic counter
POST /api/memory/incr       {"key":"jobs-done","by":3}
# atomic compare-and-set — the primitive for locks + optimistic concurrency
POST /api/memory/cas        {"key":"locks/import","expected":null,"value":"agent-7","ttlSeconds":30}
```

Namespaces are isolated per wallet: only the wallet that wrote a key can read it — unless it grants access.

### Distributed locks & safe updates (`/api/memory/cas`)

Compare-and-set writes (or, with no `value`, deletes) a key **only if its current value equals `expected`** — the building block multi-agent coordination needs:

```bash
# acquire a lock: succeeds only if the key is unset/expired, with a TTL lease
POST /api/memory/cas   {"key":"locks/import","expected":null,"value":"agent-7","ttlSeconds":30}
# release it: only the holder can (expected = your token, no value → deletes)
POST /api/memory/cas   {"key":"locks/import","expected":"agent-7"}
# optimistic update: write new only if old hasn't changed
POST /api/memory/cas   {"key":"doc","expected":{"v":1},"value":{"v":2}}
```

Returns `{ swapped, value }`. It's a single atomic transaction, honors grants (so agents sharing a namespace can coordinate), and is recorded in the audit log.

## Cross-wallet coordination (the unusual part)

Two agents that **don't share an owner** can share state, with payment identity as the primitive:

```bash
# wallet A lets wallet B read its namespace (optionally time-boxed)
POST /api/memory/grant      {"grantee":"0xB…","mode":"read","ttlSeconds":86400}
POST /api/memory/revoke     {"grantee":"0xB…"}
GET  /api/memory/grants

# wallet B reads A's data by naming the owner
GET  /api/memory?key=deploy-fix&owner=0xA…
```

Every access is recorded in a **tamper-evident audit log** the namespace owner can read:

```bash
GET /api/memory/log?limit=100
```

## Semantic memory

Store prose now, search it by meaning later (deterministic lexical scoring — no embeddings API, no LLM):

```bash
POST /api/memory/remember   {"text":"Railway deploy failed: build out of memory","meta":{"sev":"high"}}
POST /api/memory/recall     {"query":"why did the deploy break?","k":3}
POST /api/memory/forget     {"id":"<doc id>"}
```

## Properties

- **Durable:** stored in SQLite on a persistent volume — survives redeploys and restarts.
- **Private by default:** wallet-scoped; grants are explicit, revocable, and logged.
- **Cheap:** $0.002–$0.003 per call.
- **Identity without accounts:** the x402 payment on each request proves control of the wallet; there is no signup surface to attack.
