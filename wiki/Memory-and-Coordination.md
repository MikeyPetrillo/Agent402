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
```

Namespaces are isolated per wallet: only the wallet that wrote a key can read it — unless it grants access.

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
