# Contributing to Agent402

Thanks for being here. The fastest, most valuable contribution is **a new
tool** — Agent402 is a catalog, and every good tool makes the whole thing more
useful to every agent that connects. Bug fixes and docs are just as welcome.

Issues and tool ideas: [open an issue](https://github.com/MikeyPetrillo/Agent402/issues).
For anything that doesn't fit a public issue, email **mike@agent402.tools**.
MIT licensed — by contributing you agree your contribution is too.

## Dev quickstart

```bash
git clone https://github.com/MikeyPetrillo/Agent402 && cd Agent402
npm install
FREE_MODE=true npm start                  # no payments, port 3000 (HTTP API + /mcp)
```

```bash
# confirm it's up
curl -s -X POST localhost:3000/api/hash -H 'content-type: application/json' \
  -d '{"text":"hello","algo":"sha256"}'
```

## Add a tool

A tool is a plain object in one of the kit arrays under
[`src/tools/`](src/tools). Each kit array is already spread into `ALL_KIT` in
`src/server.js`, so **appending an object is all it takes** — it's routed, its
schema is published to `/openapi.json` and `/api/pricing`, it's exposed over MCP,
and CI's "every tool answers its own example" check picks it up automatically.

The simplest home for a pure-CPU tool is `AGENT_TOOLS` in
[`src/tools/agent-kit.js`](src/tools/agent-kit.js):

```js
{
  route: "POST /api/reverse",          // METHOD /path — must be unique
  name: "Reverse text",
  slug: "reverse",                     // unique; how MCP/PoW refer to it
  category: "text",                    // see the category list below
  price: "$0.001",                     // pure-CPU tools are free via proof-of-work
  description: 'Reverse a string. Example: {"text":"abc"} → {"reversed":"cba"}',
  discovery: {
    inputSchema: { properties: { text: { type: "string" } }, required: ["text"] },
    example: { text: "abc" },          // CI POSTs this and asserts it works — keep it valid
  },
  handler: (input) => {
    if (typeof input.text !== "string") {
      const e = new Error('"text" is required'); e.statusCode = 400; throw e;
    }
    return { reversed: [...input.text].reverse().join("") };
  },
}
```

### The handler contract

- **Input:** `handler(input, ctx)` — `input` is the merged query + JSON body.
  `ctx` carries `{ headers, query, body, ip }` if you need it; most tools don't.
- **Success:** return any JSON-serializable value. For binary output, return
  `{ __binary: Buffer, contentType: "image/png" }`.
- **Client error:** `throw` an `Error` with `.statusCode = 400` (or another 4xx).
  Anything else surfaces as a 500.

### Ground rules (a tool ships only if it can be served *honestly*)

1. **Deterministic** — no LLM in the serving path; same input, same output.
2. **Self-describing** — price, description, `inputSchema`, and a working
   `example` all live in the one catalog entry. Docs, OpenAPI, llms.txt, MCP
   exposure, and CI tests are generated from it.
3. **Tested against its own example** — CI calls every endpoint with its
   `discovery.example` and blocks the build on any failure, so keep it valid.
4. **Reliable** — if an upstream is flaky from datacenter IPs, the tool gets
   removed rather than charge-and-502.
5. **Free-tier safe or wallet-only** — by default a tool is pure-CPU and free
   via proof-of-work. Anything that spends real resources per call (browser,
   network egress, paid APIs, disk) must add its `slug` to `WALLET_ONLY_SLUGS`
   in [`src/pow.js`](src/pow.js), and route every caller-supplied URL through
   `safeFetch`/`assertPublicUrl` from
   [`src/tools/fetch-guard.js`](src/tools/fetch-guard.js) — never raw `fetch`
   (that's the SSRF guard).

### Categories

`web`, `memory`, `network`, `data`, `payments`, `conversion`, `text`, `math`,
`convert`, `encoding`, `identifiers`, `time`, `validation` — defined in
[`src/pages.js`](src/pages.js); add a new one there if nothing fits.

## Test your change

```bash
node scripts/test-all.js                 # every endpoint vs its own example (the key one)
node scripts/test-kit2.js                # exact-output tests for pure-CPU tools
node scripts/test-mcp-http.js            # the hosted MCP connector
node scripts/test-mcp-all.js             # every tool through the MCP connector
```

Each kit also has a focused test under [`scripts/`](scripts) (e.g.
`test-agent-kit.js`) — add or extend one if your tool has interesting edge cases.

## Open a PR

1. Fork, branch, commit with a clear message.
2. Make sure the checks above pass.
3. Open a PR describing what the tool does and why it's useful to agents.

Small, focused PRs merge fastest. The wiki is edited in [`wiki/`](wiki) in this
repo (CI syncs it) — don't edit the GitHub wiki directly.
