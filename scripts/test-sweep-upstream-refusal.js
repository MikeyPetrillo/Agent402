// The strict sweep's upstream-refusal rule (scripts/test-non-metered-examples.js),
// on the real route: a listed keyless upstream that refuses with a 5xx is
// reported, our own 5xx is a failure.
//   - the classifier: the tool's own "<Label> upstream error (HTTP 5xx)" 502
//     for a listed upstream is a refusal; a 500, a 502 in other words, an
//     upstream 4xx and an unlisted upstream are not;
//   - the caller path: the server booted with Jupiter answering 503 (stubbed
//     at the fetch layer, the risk summary beside it answering clean) answers
//     POST /api/sol-token-safety with exactly the body the rule recognizes;
//     with Jupiter answering garbage, the tool's own 502 is NOT recognized,
//     so the sweep fails it.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { fileURLToPath } from "node:url";
import { bootServer } from "./lib/boot-server.js";
import { upstreamRefusalOf, SHARED_IP_LIMITED_UPSTREAMS } from "./test-non-metered-examples.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const PRELOAD = fileURLToPath(new URL("./lib/stub-jupiter-fetch.mjs", import.meta.url));

ok(SHARED_IP_LIMITED_UPSTREAMS.has("Jupiter") && SHARED_IP_LIMITED_UPSTREAMS.size <= 3, `the list is short and names Jupiter (${[...SHARED_IP_LIMITED_UPSTREAMS].join(", ")})`);
ok(upstreamRefusalOf(502, { error: "Jupiter upstream error (HTTP 503)" })?.upstreamStatus === 503, "a Jupiter 503 relayed as the tool's 502 is a refusal");
ok(upstreamRefusalOf(500, { error: "internal" }) === null, "our own 500 is not");
ok(upstreamRefusalOf(502, { error: "Jupiter returned non-JSON" }) === null, "our own 502 in our words is not");
ok(upstreamRefusalOf(502, { error: "Jupiter upstream error (HTTP 404)" }) === null, "an upstream 4xx is not");
ok(upstreamRefusalOf(502, { error: "DexScreener upstream error (HTTP 503)" }) === null, "an unlisted upstream is not");

async function callWith(mode) {
  const srv = await bootServer({
    stores: "sweep-refusal",
    args: ["--import", PRELOAD],
    env: { FREE_MODE: "true", X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", STATE_DATABASE_URL: "", STUB_JUPITER_MODE: mode, JUPITER_API_BASE: "", POSTHOG_API_KEY: "", RUGCHECK_TOOLS: "on" },
  });
  const base = srv.url;
  try {
    const res = await fetch(`${base}/api/sol-token-safety`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await srv.stop();
  }
}

const refused = await callWith("503");
ok(refused.status === 502 && upstreamRefusalOf(refused.status, refused.body)?.label === "Jupiter", `the route's answer to a Jupiter 503 is recognized as a refusal (${refused.status} ${JSON.stringify(refused.body).slice(0, 120)})`);
const ours = await callWith("garbage");
ok(ours.status >= 500 && upstreamRefusalOf(ours.status, ours.body) === null, `the route's own 5xx is not recognized, so the sweep fails it (${ours.status} ${JSON.stringify(ours.body).slice(0, 120)})`);

console.log(`\ntest-sweep-upstream-refusal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
