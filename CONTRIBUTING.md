# Contributing to Agent402

Thanks for being here. The fastest, most valuable contribution is **a new
tool** - Agent402 is a catalog, and every good tool makes the whole thing more
useful to every agent that connects. Bug fixes and docs are just as welcome.

Issues and tool ideas: [open an issue](https://github.com/MikeyPetrillo/Agent402/issues).
For anything that doesn't fit a public issue, email **mike@agent402.tools**.
Licensing (inbound = outbound): by contributing you agree your contribution is
licensed under the same license as the component you're changing - AGPL-3.0 for
the server (the repository root, where most tool contributions land) and MIT for
the `client/`, `mcp/`, and `tollbooth/` packages. You keep the copyright on your
code. The "Agent402" name and logo are trademarks of Havok Holdings LLC - see
[TRADEMARKS.md](TRADEMARKS.md).

**Developer Certificate of Origin (DCO):** every commit must be signed off
(`git commit -s`), which adds a `Signed-off-by: Your Name <email>` line
certifying you wrote the change or otherwise have the right to submit it under
the project's license - the industry-standard [DCO 1.1](https://developercertificate.org/).
It is a provenance certification, not a copyright assignment: you still keep
your copyright. Forgot it? `git commit --amend -s && git push -f` fixes the
last commit. CI checks this on every PR.

## List your x402 seller

Running your own x402 service? Listing takes one request, no PR:

1. Publish a service manifest at `/.well-known/x402` (identity + payment options)
   on a **stable HTTPS origin** (no ephemeral tunnels like `*.trycloudflare.com`;
   they flap to `STALE`).
2. Register it:

   ```bash
   curl -s -X POST https://agent402.tools/api/index/register \
     -H 'content-type: application/json' \
     -d '{"origin":"https://your-origin.example"}'
   ```

3. Check your listing at `https://agent402.tools/api/index?seller=<your origin>`.
   The index re-crawls and health-checks it on every cycle, so manifest changes
   show up there on their own. Full details: [agent402.tools/sell](https://agent402.tools/sell).

`DEFAULT_SEEDS` in [`src/x402-index.js`](src/x402-index.js) is maintained by
the project; a PR is not needed to get listed.

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
`src/server.js`, so **appending an object is all it takes** - it's routed, its
schema is published to `/openapi.json` and `/api/pricing`, it's exposed over MCP,
and CI's "every tool answers its own example" check picks it up automatically.

The simplest home for a pure-CPU tool is `AGENT_TOOLS` in
[`src/tools/agent-kit.js`](src/tools/agent-kit.js):

```js
{
  route: "POST /api/reverse",          // METHOD /path - must be unique
  name: "Reverse text",
  slug: "reverse",                     // unique; how MCP/PoW refer to it
  category: "text",                    // see the category list below
  price: "$0.001",                     // pure-CPU tools are free via proof-of-work
  description: 'Reverse a string. Example: {"text":"abc"} → {"reversed":"cba"}',
  discovery: {
    inputSchema: { properties: { text: { type: "string" } }, required: ["text"] },
    example: { text: "abc" },          // CI POSTs this and asserts it works - keep it valid
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

- **Input:** `handler(input, ctx)` - `input` is the merged query + JSON body.
  `ctx` carries `{ headers, query, body, ip }` if you need it; most tools don't.
- **Success:** return any JSON-serializable value. For binary output, return
  `{ __binary: Buffer, contentType: "image/png" }`.
- **Client error:** `throw` an `Error` with `.statusCode = 400` (or another 4xx).
  Anything else surfaces as a 500.

### Ground rules (a tool ships only if it can be served *honestly*)

1. **Deterministic** - a utility tool runs no model: same input, same output.
   (The `/v1` gateway and the finished report products under `src/tools/*-report-kit.js`,
   `research-deep-kit.js`, `dossier-kit.js`, `token-risk-kit.js` are the explicit
   exceptions: priced as LLM surfaces, wallet-only, never proof-of-work.)
2. **Self-describing** - price, description, `inputSchema`, and a working
   `example` all live in the one catalog entry. Docs, OpenAPI, llms.txt, MCP
   exposure, and CI tests are generated from it.
3. **Tested against its own example** - CI calls every endpoint with its
   `discovery.example` and blocks the build on any failure, so keep it valid.
4. **Reliable** - if an upstream is flaky from datacenter IPs, the tool gets
   removed rather than charge-and-502.
5. **Free-tier safe or wallet-only** - by default a tool is pure-CPU and free
   via proof-of-work. Anything that spends real resources per call (browser,
   network egress, paid APIs, disk) must add its `slug` to `WALLET_ONLY_SLUGS`
   in [`src/pow.js`](src/pow.js), and route every caller-supplied URL through
   `safeFetch`/`assertPublicUrl` from
   [`src/tools/fetch-guard.js`](src/tools/fetch-guard.js) - never raw `fetch`
   (that's the SSRF guard).

### Categories

`web`, `memory`, `network`, `data`, `payments`, `conversion`, `text`, `math`,
`encoding`, `identifiers`, `time`, `validation`, `llm`, `crypto`, `skill-pack`,
`ai`, `date-time`, `chain`, `wallet`, `research`, `agent`, `api`, `x402`.
Defined in `CATEGORIES` in [`src/pages.js`](src/pages.js); add a new one there if
nothing fits.

Every category the catalog uses **must** have an entry in that map: it is the
source for the `/tools` category pages, the `/api/pricing` categories map, the
`/.well-known/x402` capabilities list, and `llms.txt`. A category missing from it
means a 404 category page, an unlabelled price row, a capabilities total that
doesn't reconcile, and tools that are invisible to agents.

## Test your change

```bash
node scripts/test-all.js                 # every endpoint vs its own example (the key one)
node scripts/test-kit2.js                # exact-output tests for pure-CPU tools
node scripts/test-mcp-http.js            # the hosted MCP connector
node scripts/test-mcp-all.js             # every tool through the MCP connector
TARGET_URL=http://localhost:3000 node scripts/test-docs-truth.js   # docs vs the served catalog (routes, prices, slug links)
```

Each kit also has a focused test under [`scripts/`](scripts) (e.g.
`test-agent-kit.js`) - add or extend one if your tool has interesting edge cases.

## Open a PR

1. Fork, branch, commit with a clear message, signed off (`git commit -s`).
2. Make sure the checks above pass.
3. Fill in the PR template: what changed, and how you verified it. A test
   that fails without the change and passes with it is the best evidence; a
   live check against production is the next best.

Small, focused PRs merge fastest. Three things worth knowing before you open one:

- **AI-authored contributions are welcome.** Say so in the description, and
  hold them to the same bar as any other: a reproduction, a test, and a
  claim that has been checked rather than remembered. A PR that corrects its
  own earlier claim in public is a good PR.
- **Merit, not payment.** PRs are reviewed and accepted on what they fix.
  Opening one creates no payment obligation on either side, and a PR must
  not be conditional on one. Proposals for paid work go to
  **mike@agent402.tools**, not into a PR or an issue.
- **Money-path changes are reviewed as a set.** Anything touching payments,
  the router's buyer, or settlement is landed alongside our own next round
  of changes there rather than merged alone, however green the checks are.
  A closed PR of that kind is not a rejection; the branch stays referenced.

## Report a defect

The best issue is one we can replay: the exact request, the status code and
the body you got, and what you expected. The issue templates ask for exactly
that. If our index lists your seller wrong, the "Index listing is wrong"
template wants the row we publish next to what your origin serves. A pitch
for your own service, or a request that we run a paid test call, is not an
issue and is closed without comment; listing and routing follow the process
above and settlement history, never a request. The wiki is edited in [`wiki/`](wiki) in this
repo (CI syncs it) - don't edit the GitHub wiki directly.
