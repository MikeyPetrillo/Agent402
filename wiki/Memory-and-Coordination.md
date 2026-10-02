# Memory and Coordination

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

The retention product. Agent sessions are ephemeral - the container is gone an hour later. `/api/memory` is durable state where **the paying wallet is the identity**: no API key to store, leak, or rotate. Write from one machine today, read from another next week, with nothing but the same private key.

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
# atomic compare-and-set - the primitive for locks + optimistic concurrency
POST /api/memory/cas        {"key":"locks/import","expected":null,"value":"agent-7","ttlSeconds":30}
```

Namespaces are isolated per wallet: only the wallet that wrote a key can read it - unless it grants access.

### Distributed locks & safe updates (`/api/memory/cas`)

Compare-and-set writes (or, with no `value`, deletes) a key **only if its current value equals `expected`** - the building block multi-agent coordination needs:

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

Store prose now, search it later. By default recall scores against a hashed term vector computed in-process (word and word-pair overlap, no embeddings API, no LLM); an operator who sets `EMBEDDINGS_URL` swaps in an OpenAI-compatible embeddings endpoint for true semantic similarity:

```bash
POST /api/memory/remember   {"text":"Railway deploy failed: build out of memory","meta":{"sev":"high"}}
POST /api/memory/recall     {"query":"why did the deploy break?","k":3}
POST /api/memory/forget     {"id":"<doc id>"}
```

## Namespace quotas (both return `413`)

A namespace is bounded on two axes at once, and hitting **either** returns `413 Payload Too Large` rather than silently dropping data:

| Limit | Env var | Default | Why |
|---|---|---|---|
| Keys per namespace | `MEMORY_MAX_NS_KEYS` | 10,000 | Bounds index growth for one wallet |
| Total value bytes per namespace | `MEMORY_MAX_NS_BYTES` | 32 MB | The disk-fill guard for the shared `/data` volume: a key count alone does not bound size, since one key can hold a very large value |

Individual items are capped too: 256 bytes of key and 64 KB of value.

Both quotas are read at call time, so an operator can change them without a redeploy, and both **reclaim expired rows before rejecting**, so a namespace full of TTL'd keys frees itself rather than wedging. A shrinking or same-size overwrite is always allowed. A `413` is a `4xx`, so it **cancels settlement**: a write that bounces off a full namespace does not charge you. Free space by deleting keys (`{"key":"…","delete":true}`), shrinking values, or letting `ttlSeconds` expire them.

## Properties

- **Durable:** stored in SQLite on a persistent volume - survives redeploys and restarts.
- **Private by default:** wallet-scoped; grants are explicit, revocable, and logged.
- **Cheap:** $0.001–$0.003 per call.
- **Identity without accounts:** the x402 payment on each request proves control of the wallet; there is no signup surface to attack.
