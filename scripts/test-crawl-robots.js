// The ecosystem crawler honours robots.txt.
//
// It did not, while our own tollbooth product and the site-crawl tool both do -
// a double standard we would rightly be called out for, and a good way to be
// null-routed at an edge (Nodely already 403s our egress outright).
//
// Policy asserted here, because each half is a deliberate choice:
//   - an explicit Disallow that matches is honoured;
//   - a robots.txt we cannot read FAILS OPEN, because dropping thousands of
//     sellers out of the index over a transient 500 on an unrelated file is a
//     worse outcome than one extra request;
//   - the parser is kit.js's, so the catastrophic-backtracking guard is not
//     re-implemented (and mis-implemented) here.
import { robotsForbids, __resetRobotsCacheForTest } from "../src/x402-index.js";
import { parseRobots, robotsAllows } from "../src/tools/kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// The fetcher is INJECTED, not a global-fetch stub. safeFetch rejects an
// unresolvable hostname before it ever issues a request, so a global stub would
// never fire and every "is it blocked" case would quietly take the fail-open
// path and pass while proving nothing. The first draft of this file did exactly
// that.
let hits = 0;
const fetcher = (body) => async () => { hits++; if (body instanceof Error) throw body; return body; };

{
  // --- an explicit Disallow for everyone is honoured -----------------------
  __resetRobotsCacheForTest();
  const f1 = fetcher("User-agent: *\nDisallow: /\n");
  // The path here is a CONTENT path on purpose: /.well-known/x402 became
  // robots-exempt on 2026-09-01 (see the exemption block at the end), so this
  // assertion pins the blanket-Disallow rule where it still applies.
  ok(await robotsForbids("https://blocked.example", "/openapi.json", { fetchText: f1 }),
    "a site that disallows everything is not crawled");

  // --- a Disallow naming US specifically is honoured -----------------------
  __resetRobotsCacheForTest();
  const f2 = fetcher("User-agent: Agent402\nDisallow: /openapi.json\n\nUser-agent: *\nAllow: /\n");
  ok(await robotsForbids("https://picky.example", "/openapi.json", { fetchText: f2 }),
    "a rule naming Agent402 blocks the path it names");
  ok(!(await robotsForbids("https://picky.example", "/.well-known/x402", { fetchText: f2 })),
    "...and only that path - the manifest is still crawled");

  // --- a permissive file allows everything --------------------------------
  __resetRobotsCacheForTest();
  const f3 = fetcher("User-agent: *\nDisallow: /admin\n");
  ok(!(await robotsForbids("https://open.example", "/.well-known/x402", { fetchText: f3 })),
    "an unrelated Disallow does not block the manifest");
  ok(await robotsForbids("https://open.example", "/admin/secret", { fetchText: f3 }),
    "...and the rule it does state is enforced");

  // --- FAIL OPEN on everything we cannot read ------------------------------
  for (const [label, responder] of [
    ["404", fetcher(new Error("Source URL returned HTTP 404"))],
    ["500", fetcher(new Error("Source URL's host returned HTTP 500"))],
    ["a connection error", fetcher(new Error("ECONNREFUSED"))],
  ]) {
    __resetRobotsCacheForTest();
    ok(!(await robotsForbids("https://unreadable.example", "/.well-known/x402", { fetchText: responder })),
      `robots.txt returning ${label} fails OPEN - politeness must not delete the index`);
  }

  // --- the result is cached, so this costs one request per origin per day --
  __resetRobotsCacheForTest();
  hits = 0;
  const fc = fetcher("User-agent: *\nDisallow: /\n");
  await robotsForbids("https://cached.example", "/a", { fetchText: fc });
  await robotsForbids("https://cached.example", "/b", { fetchText: fc });
  await robotsForbids("https://cached.example", "/c", { fetchText: fc });
  ok(hits === 1, `robots.txt is fetched ONCE per origin, not per probe (got ${hits})`);

  // --- a failed read is cached too ----------------------------------------
  __resetRobotsCacheForTest();
  hits = 0;
  const fd = fetcher(new Error("ECONNREFUSED"));
  await robotsForbids("https://down.example", "/a", { fetchText: fd });
  await robotsForbids("https://down.example", "/b", { fetchText: fd });
  ok(hits === 1, "a FAILED robots read is cached too, so an unreachable origin is asked once a day not once a cycle");

  // --- we reuse kit.js's hardened parser, not a second one ----------------
  const evil = parseRobots("User-agent: *\nDisallow: /a*a*a*a*a*a*a*a*!\n");
  const t0 = Date.now();
  robotsAllows(evil, "Agent402", "/" + "a".repeat(400));
  ok(Date.now() - t0 < 500,
    "the shared parser's wildcard cap still bounds a catastrophic-backtracking rule (both sides third-party text)");
}

// --- THE CALLER PATH ---------------------------------------------------------
//
// Everything above proves robotsForbids decides correctly and says nothing
// about whether the crawler ever ASKS it. Deleting the two lines that wire it
// into probePath left every assertion above green - the same shape that left
// the metered branch dead for a day with two passing tests. probePath is not
// exported, so this is a source assertion, which is the weaker instrument and
// used only because the stronger one is unavailable.
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const start = src.indexOf("async function probePath(originUrl, path");
  const helper = src.slice(start, src.indexOf("\n}", start));
  ok(/await robotsForbids\(originUrl, path, \{ manifestPublished \}\)/.test(helper),
    "probePath consults robots.txt, so EVERY per-origin probe is gated by it and not just the ones we remembered");
  ok(/robotsBlocked: true/.test(helper),
    "a robots refusal is marked, so the crawl can report it as an exclusion rather than as a failure");
  ok(helper.indexOf("robotsForbids") < helper.indexOf("safeFetch"),
    "and it is consulted BEFORE the fetch, which is the only ordering that saves the seller a request");
}

// ---- the x402 discovery document is robots-EXEMPT --------------------------
// robots.txt governs content crawling; /.well-known/x402 is a protocol
// endpoint the seller publishes to be fetched. A blanket Disallow: / (a
// common API-host default) hid sol.blockrun.ai's manifest while they served
// it 200 for exactly this discovery (2026-09-01). Everything else stays
// gated - the second assertion is the one that keeps this narrow.
{
  const { robotsForbids, __resetRobotsCacheForTest } = await import("../src/x402-index.js");
  const { WELL_KNOWN_PATH } = await import("../src/discovery-note.js");
  __resetRobotsCacheForTest();
  const blockAll = async () => "User-agent: *\nDisallow: /\n";
  ok((await robotsForbids("https://blocked.example", WELL_KNOWN_PATH, { fetchText: blockAll })) === null,
    "Disallow: / does NOT gate the x402 discovery document - the seller published it to be fetched");
  ok((await robotsForbids("https://blocked.example", "/openapi.json", { fetchText: blockAll })) !== null,
    "with no manifest in hand the same Disallow still gates openapi.json (and everything else)");
}

// ---- a manifest-published seller's OpenAPI is read under a BLANKET Disallow --
// The manifest is the seller's opt-in to machine discovery; the OpenAPI is
// what NAMES the routes it lists. sol.blockrun.ai: manifest 200, robots
// "Disallow: /", OpenAPI 200 with "Grok Live Search" for the route our index
// called "/api/v1/search" - unrankable by any normal task text (2026-09-02).
// Three edges keep this narrow: only /openapi.json, only with the manifest,
// and never over a robots group that names Agent402 itself.
{
  const { robotsForbids, __resetRobotsCacheForTest } = await import("../src/x402-index.js");
  const blockAll = async () => "User-agent: *\nDisallow: /\n";
  __resetRobotsCacheForTest();
  ok((await robotsForbids("https://blocked.example", "/openapi.json", { fetchText: blockAll, manifestPublished: true })) === null,
    "manifest in hand: a blanket Disallow: / no longer hides the OpenAPI that names the manifest's routes");
  ok((await robotsForbids("https://blocked.example", "/llms.txt", { fetchText: blockAll, manifestPublished: true })) !== null,
    "the exemption is ONLY /openapi.json: llms.txt under the same manifest stays gated");
  ok((await robotsForbids("https://blocked.example", "/admin/secret", { fetchText: blockAll, manifestPublished: true })) !== null,
    "and a content path stays gated");
  __resetRobotsCacheForTest();
  const namesUs = async () => "User-agent: Agent402\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
  ok((await robotsForbids("https://refuses-us.example", "/openapi.json", { fetchText: namesUs, manifestPublished: true })) !== null,
    "a robots group addressed to Agent402 by name is a decision, not a default: honoured even with the manifest");
  __resetRobotsCacheForTest();
  const namesUsPath = async () => "User-agent: agent402\nDisallow: /openapi.json\n";
  ok((await robotsForbids("https://refuses-us.example", "/openapi.json", { fetchText: namesUsPath, manifestPublished: true })) !== null,
    "same when the rule names us case-insensitively and targets exactly that path");
  // The CALLER: the well-known branch is the only one that may pass the flag.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/x402-index.js", import.meta.url), "utf8");
  const calls = [...src.matchAll(/fetchOpenapi\((\{[^)]*\})?\)/g)].map((m) => m[1] || "");
  ok(calls.length === 2, `crawlSeller fetches the OpenAPI from exactly two sites (found ${calls.length})`);
  ok(calls.filter((c) => /manifestPublished:\s*true/.test(c)).length === 1,
    "exactly ONE of them (the manifest branch) passes manifestPublished: the no-manifest fallback stays robots-honoured");
  const wk = src.indexOf("fetchOpenapi({ manifestPublished: true })");
  const fb = src.indexOf("fetchOpenapi()");
  ok(wk > -1 && fb > wk, "and the flagged call is the manifest branch's, which runs before the fallback's bare call");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
