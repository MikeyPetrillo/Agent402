// Offline unit tests for the route-and-execute tool (src/tools/route-execute.js).
// Uses a miniature catalog — no server boot, no network.
import { createHash } from "node:crypto";
import { buildRouteExecuteTool } from "../src/tools/route-execute.js";
import { USAGE_TOOLS } from "../src/tools/usage-kit.js";
import { isIdentityBoundRoute } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`${cond ? "ok" : "FAIL"} - ${name}`); };

const CATALOG = {};
const addTool = (def) => { CATALOG[def.route] = def; };
addTool({
  route: "POST /api/hash", slug: "hash", name: "Hash", category: "encoding", price: "$0.001",
  description: "Cryptographic hash of a text string", tags: ["hash", "sha256"],
  discovery: { bodyType: "json", input: { text: "hello" } },
  handler: async ({ text }) => ({ algo: "sha256", hex: `hex(${text})` }),
});
addTool({
  route: "GET /api/screenshot", slug: "screenshot", name: "Screenshot", category: "browser", price: "$0.02",
  description: "Screenshot a web page in a headless browser", tags: ["browser", "screenshot"],
  discovery: { input: { url: "https://example.com" } },
  handler: async () => ({ png: "…" }),
});
addTool({
  route: "POST /api/memory-write", slug: "memory-write", name: "Memory write", category: "memory", price: "$0.002",
  description: "Write to wallet-keyed memory", tags: ["memory"],
  discovery: { bodyType: "json", input: { key: "k", value: "v" } },
  handler: async () => ({ okay: true }),
});
addTool({
  route: "POST /api/images-to-pdf", slug: "images-to-pdf", name: "Images to PDF", category: "pdf", price: "$0.003",
  description: "Combine images into a pdf", tags: ["pdf"],
  discovery: { bodyType: "multipart", input: {} },
  handler: async () => ({ pdf: "…" }),
});
addTool({
  route: "POST /api/broken-tool", slug: "broken-tool", name: "Broken", category: "misc", price: "$0.001",
  description: "always fails with a 422", tags: ["broken"],
  discovery: { bodyType: "json", input: {} },
  handler: async () => { throw Object.assign(new Error("upstream said no"), { statusCode: 422 }); },
});

const tool = buildRouteExecuteTool({ getCatalog: () => CATALOG, baseUrl: "https://agent402.tools" });
CATALOG[tool.route] = tool;

const expectErr = async (input, statusCode, name, contains) => {
  try {
    await tool.handler(input);
    ok(false, `${name} (no error thrown)`);
  } catch (e) {
    const codeOk = e.statusCode === statusCode;
    const msgOk = !contains || String(e.message).includes(contains);
    ok(codeOk && msgOk, `${name}${codeOk ? "" : ` (got ${e.statusCode})`}${msgOk ? "" : ` (msg: ${e.message})`}`);
  }
};

// 1. Direct slug dispatch — the discovery example's own path.
{
  const r = await tool.handler({ slug: "hash", params: { text: "agent402" } });
  ok(r.result.hex === "hex(agent402)", "slug dispatch runs the tool with params");
  ok(r.receipt.slug === "hash" && r.receipt.resolvedBy === "slug", "receipt names the tool and resolution mode");
  ok(r.receipt.underlyingPriceUsd === 0.001 && r.receipt.paidUsd === 0.01, "receipt itemizes underlying vs paid");
  ok(Math.abs(r.receipt.routingFeeUsd - 0.009) < 1e-9, "routing fee is the spread");
}

// 2. Task resolution via the ranker.
{
  const r = await tool.handler({ task: "sha256 hash of a text string", params: { text: "x" } });
  ok(r.receipt.slug === "hash" && r.receipt.resolvedBy === "task", "task resolves to the hash tool");
}

// 3. Guards.
await expectErr({ slug: "screenshot", params: {} }, 409, "over-cap tool refused with self-correcting 409", "Call it directly");
await expectErr({ slug: "memory-write", params: {} }, 409, "memory tools refused", "wallet-keyed");
await expectErr({ slug: "images-to-pdf", params: {} }, 409, "non-JSON bodyType refused", "not dispatchable");
await expectErr({ slug: "route-execute", params: {} }, 409, "self-dispatch refused", "itself");
await expectErr({ slug: "nope-nope", params: {} }, 404, "unknown slug is a 404", "Unknown slug");
await expectErr({}, 400, "missing task and slug is a 400", "Provide");
await expectErr({ task: "screenshot a web page in a headless browser" }, 404, "task resolving only to over-cap tools is a 404", "top hit");

// 4. maxUsd narrows the cap but can't raise it above the ceiling.
await expectErr({ slug: "hash", params: { text: "x" }, maxUsd: 0.0005 }, 409, "caller maxUsd below tool price refuses");
{
  const r = await tool.handler({ slug: "hash", params: { text: "x" }, maxUsd: 99 });
  ok(r.receipt.slug === "hash", "maxUsd above the ceiling clamps to the ceiling, hash still dispatches");
}

// 5. Underlying tool errors surface with the tool's own status code.
await expectErr({ slug: "broken-tool", params: {} }, 422, "underlying tool 422 passes through", "Routed tool");

// 6. Recomputable call identity (issue #282): callRef rides the receipt when
// the request carried an EIP-3009 payment authorization; absent otherwise.
{
  const nonce = "0x" + "ab".repeat(32);
  const header = Buffer.from(JSON.stringify({ payload: { authorization: { from: "0x1111111111111111111111111111111111111111", nonce } } })).toString("base64");
  const req = { header: (n) => (String(n).toLowerCase() === "x-payment" ? header : undefined) };
  const r = await tool.handler({ slug: "hash", params: { text: "x" } }, req);
  ok(typeof r.receipt.ts === "string" && r.receipt.ts.endsWith("Z"), "receipt carries the dispatch timestamp");
  const expected = "sha256:" + createHash("sha256").update(JSON.stringify({ nonce, slug: "hash", ts: r.receipt.ts })).digest("hex");
  ok(r.receipt.callRef === expected, "callRef re-derives from {nonce, slug, ts} exactly");
}
{
  const r = await tool.handler({ slug: "hash", params: { text: "x" } });
  ok(r.receipt.callRef === undefined && typeof r.receipt.ts === "string", "nonce-less call omits callRef but keeps ts");
}
{
  const req = { header: () => Buffer.from("not json").toString("base64") };
  const r = await tool.handler({ slug: "hash", params: { text: "x" } }, req);
  ok(r.receipt.callRef === undefined, "malformed payment header degrades to no callRef, not an error");
}

// 7. Identity-bound tools (audit R-03): the executor must refuse EVERY
// identity-bound def BEFORE dispatch. These tools read the SIGNED payment
// identity off the Express request (payerFromRequest / the memory namespace);
// route-execute invokes handlers as `def.handler(params)` with no request, so
// dispatching my-usage would 502 mid-handler AFTER the buyer paid, and memory
// would key the wrong namespace. Verified with the REAL my-usage definition.
{
  const myUsage = USAGE_TOOLS.find((t) => t.slug === "my-usage");
  ok(!!myUsage && isIdentityBoundRoute(myUsage), "real my-usage def is classified identity-bound");
  CATALOG[myUsage.route] = myUsage;
  // A 409 here (not a 502 from payerFromRequest(undefined)) proves the block
  // fires BEFORE the handler runs — no charged deterministic failure.
  await expectErr({ slug: "my-usage", params: {} }, 409, "real my-usage refused pre-dispatch (not a post-payment 502)", "identity-bound");
}
{
  // Memory-category def: the other arm of isIdentityBoundRoute. Its handler
  // throws a NON-statusCode error, so a clean 409 (not a 500) proves the tool
  // was refused before dispatch and the handler never ran.
  addTool({
    route: "POST /api/memory-incr", slug: "memory-incr", name: "Memory incr", category: "memory", price: "$0.002",
    description: "Increment a wallet-keyed counter", tags: ["memory"],
    discovery: { bodyType: "json", input: { key: "k" } },
    handler: async () => { throw new Error("identity-bound handler must never run through route-execute"); },
  });
  await expectErr({ slug: "memory-incr", params: {} }, 409, "memory-category tool refused pre-dispatch", "identity-bound");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
