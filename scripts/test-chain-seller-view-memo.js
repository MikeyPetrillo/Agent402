// Chain market ?seller= views are cheap under a burst:
//   - the seller is resolved first; a value that names no listed seller is
//     served from the plain page's memo and never starts a build;
//   - a view for a listed seller is memoized per (chain, all, seller host),
//     single-flight, in a bounded LRU (src/bounded-memo.js);
//   - the build cap applies to cache misses only.
// Part A drives the memo in process (with --expose-gc for the heap reading);
// part B boots a FREE_MODE server on a seeded index and counts builds through
// /__operator/perf.json.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getFreePort } from "./lib/free-port.js";

// The heap readings need gc(); re-run under --expose-gc when it is absent.
if (typeof globalThis.gc !== "function") {
  const child = spawn(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
} else {
  await main();
}

async function main() {
  const { createBoundedMemo, SHED } = await import("../src/bounded-memo.js");
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mb = (n) => Math.round((n / 1048576) * 10) / 10;

  // ---------------------------------------------------------------- A. the memo
  {
    const memo = createBoundedMemo({ max: 8, ttlMs: 60_000 });
    let builds = 0;
    const build = async () => { builds++; await sleep(30); return "page"; };
    const got = await Promise.all(Array.from({ length: 50 }, () => memo.get("a", build)));
    ok(builds === 1 && got.every((v) => v === "page"), `50 concurrent misses on one key share one build (${builds} build(s))`);
    await memo.get("a", build);
    ok(builds === 1, "a fresh hit builds nothing");

    const refused = await memo.get("b", build, { admit: () => false });
    ok(refused === SHED && builds === 1 && !memo.has("b"), "a miss the admission refuses resolves to SHED and builds nothing");
    let admits = 0;
    const joinBuild = memo.get("c", build, { admit: () => { admits++; return true; } });
    const joined = await Promise.all(Array.from({ length: 10 }, () => memo.get("c", build, { admit: () => { admits++; return false; } })));
    ok((await joinBuild) === "page" && joined.every((v) => v === "page") && admits === 1, `callers joining a running build never ask admission (${admits} admission read(s))`);

    for (let i = 0; i < 2000; i++) { await memo.get(`k${i}`, async () => `v${i}`); if (memo.size() > memo.max) break; }
    ok(memo.size() <= 8, `after 2000 distinct keys the memo holds at most its bound (${memo.size()} of ${memo.max})`);
    ok(memo.has("k1999") && !memo.has("k0"), "the least recently used entry is the one evicted");

    const byBytes = createBoundedMemo({ max: 100, maxBytes: 1000 });
    for (let i = 0; i < 50; i++) await byBytes.get(`b${i}`, async () => "y".repeat(300));
    ok(byBytes.bytes() <= 1000 && byBytes.size() === 3, `the byte bound holds too (${byBytes.size()} entries, ${byBytes.bytes()} bytes of 1000)`);
    const huge = await byBytes.get("huge", async () => "z".repeat(5000));
    ok(huge.length === 5000 && !byBytes.has("huge") && byBytes.bytes() <= 1000, "a value over the byte bound is returned but not kept");

    let failBuilds = 0;
    await memo.get("f", async () => { failBuilds++; throw new Error("boom"); }).catch(() => null);
    ok(!memo.has("f"), "a failed build is not cached");
    const syncThrow = createBoundedMemo({ max: 4, isPartial: () => { throw new Error("sync"); } });
    await syncThrow.get("s", async () => "never").catch(() => null);
    await sleep(0);
    ok(syncThrow.pendingSize() === 0, "a build that throws before its first await leaves no pending entry behind");

    const swr = createBoundedMemo({ max: 4, ttlMs: 40 });
    let n = 0;
    const b2 = async () => { n++; await sleep(20); return `v${n}`; };
    await swr.get("x", b2);
    await sleep(60);
    const stale = await Promise.all(Array.from({ length: 10 }, () => swr.get("x", b2)));
    ok(stale.every((v) => v === "v1") && n === 2, `an expired entry serves its last value at once while ONE rebuild runs (${n - 1} rebuild(s))`);
    await sleep(40);
    ok((await swr.get("x", b2)) === "v2", "the rebuilt value replaces it");
    const shedStale = createBoundedMemo({ max: 4, ttlMs: 10 });
    let m = 0;
    await shedStale.get("y", async () => `w${++m}`);
    await sleep(20);
    ok((await shedStale.get("y", async () => `w${++m}`, { admit: () => false })) === "w1" && m === 1, "an expired entry still serves when admission refuses its rebuild");

    const partial = createBoundedMemo({ max: 4, ttlMs: 60_000, partialTtlMs: 20, isPartial: () => true });
    let p = 0;
    await partial.get("z", async () => `p${++p}`);
    await sleep(40);
    await partial.get("z", async () => `p${++p}`);
    ok(p === 2, "a value built while state is loading expires after the partial TTL");

    // Heap: values about the size of a chain page, many more distinct keys
    // than the bound, collected and read at checkpoints.
    const big = createBoundedMemo({ max: 64, ttlMs: 60_000 });
    const page = () => randomBytes(100_000).toString("hex");
    const heapAt = [];
    let key = 0;
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 500; i++, key++) await big.get(`seller${key}.example`, async () => page());
      globalThis.gc(); globalThis.gc();
      heapAt.push(process.memoryUsage().heapUsed);
    }
    const growth = heapAt[heapAt.length - 1] - heapAt[1];
    console.log(`  in-process heap after each 500 distinct keys (MB): ${heapAt.map(mb).join(", ")}; size ${big.size()}/${big.max}`);
    ok(big.size() <= 64 && growth < 8 * 1048576, `in-process heap is flat over ${key} distinct keys (${mb(growth)} MB from round 2 to round 6)`);
  }

  // ---------------------------------------------------------------- B. the server
  const SELLERS = 400, MEMO_MAX = 16;
  const dir = mkdtempSync(join(tmpdir(), "a402-seller-view-"));
  const now = Date.now();
  const lines = [];
  for (let i = 0; i < SELLERS; i++) {
    const origin = `https://seller${i}.example`;
    // No payTo: a seller view without a wallet runs no activity scan, so the
    // test makes no outbound call.
    const tools = [{ seller: origin, method: "GET", route: `/api/t${i}`, slug: `t${i}`, name: `Tool ${i}`, description: "a test tool", category: "data", tags: ["data"], price: 0.001, networks: ["eip155:8453"] }];
    lines.push(JSON.stringify([origin, { manifest: { name: `Seller ${i}`, homepage: origin }, tools, fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1] }]));
  }
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: lines.length }), ...lines].join("\n") + "\n");
  const TOKEN = "seller-view-operator-token-0123456789";
  const port = await getFreePort();
  const proc = spawn(process.execPath, ["--expose-gc", "src/server.js"], {
    env: {
      ...process.env, FREE_MODE: "true", PORT: String(port), INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999",
      X402_INDEX_CRAWL: "", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"),
      ROUTER_WORKERS: "0", AGENT402_OPERATOR_TOKEN: TOKEN, CHAIN_SELLER_VIEW_MEMO_MAX: String(MEMO_MAX), LOAD_SHED: "off",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const base = `http://127.0.0.1:${port}`;
  const op = { headers: { authorization: `Bearer ${TOKEN}` } };
  const views = async () => (await (await fetch(`${base}/__operator/perf.json?top=1`, op)).json()).chainSellerViews;
  const heap = async () => (await (await fetch(`${base}/__operator/heap.json?gc=1`, op)).json()).heapUsedMb;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(500); } }
    ok(up, "server booted");
    let sellers = 0;
    for (let i = 0; i < 60 && sellers < SELLERS; i++) {
      try { sellers = (await (await fetch(`${base}/api/index?limit=1`)).json()).sellerCount || 0; } catch { /* warming */ }
      if (sellers < SELLERS) await sleep(500);
    }
    ok(sellers >= SELLERS, `the index warm-started with the seeded sellers (${sellers})`);

    const plain = await fetch(`${base}/base`);
    const plainHtml = await plain.text();
    ok(plain.status === 200, "the plain page answers");

    // Unknown values: served from the plain page's memo, no seller build.
    const v0 = await views();
    const unknown = await Promise.all(Array.from({ length: 60 }, (_, i) => fetch(`${base}/base?seller=nobody-${i}-${Math.random().toString(36).slice(2)}.example`).then(async (r) => ({ status: r.status, html: await r.text() }))));
    const v1 = await views();
    ok(unknown.every((r) => r.status === 200), `60 concurrent views naming no listed seller all answer 200 (${[...new Set(unknown.map((r) => r.status))].join(",")})`);
    ok(v1.builds === v0.builds && v1.size === v0.size, `they start no seller build and add no memo entry (builds ${v0.builds} -> ${v1.builds}, size ${v1.size})`);
    ok(unknown.every((r) => r.html === plainHtml), "each is the plain page, byte for byte, as before");
    const ownHost = await fetch(`${base}/base?seller=agent402.tools`);
    ok(ownHost.status === 200 && (await ownHost.text()) === plainHtml && (await views()).builds === v1.builds, "naming this host's own view is the plain page too");

    // One listed seller, a burst: one build.
    const t0 = Date.now();
    const burst = await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/base?seller=seller7.example`).then(async (r) => ({ status: r.status, html: await r.text() }))));
    const burstMs = Date.now() - t0;
    const v2 = await views();
    ok(burst.every((r) => r.status === 200), `40 concurrent views of one listed seller all answer 200 (${[...new Set(burst.map((r) => r.status))].join(",")}, ${burstMs} ms)`);
    ok(v2.builds - v1.builds === 1 && (v2.joins - v1.joins) + (v2.hits - v1.hits) === 39, `they cause exactly one build (${v2.builds - v1.builds} build(s), ${v2.joins - v1.joins} joined it, ${v2.hits - v1.hits} hit the memo; page ${burst[0].html.length} bytes)`);
    ok(burst.every((r) => r.html === burst[0].html) && burst[0].html !== plainHtml && burst[0].html.includes("seller7.example"), "every caller gets the same seller view");
    const caseVariant = await fetch(`${base}/base?seller=SELLER7.EXAMPLE`);
    ok(caseVariant.status === 200 && (await views()).builds === v2.builds, "a spelling that resolves to the same seller reuses its entry");
    const t1 = Date.now();
    await Promise.all(Array.from({ length: 200 }, () => fetch(`${base}/base?seller=seller7.example`).then((r) => r.text())));
    console.log(`  200 concurrent cached views of one seller: ${Date.now() - t1} ms`);

    // Many distinct listed sellers: the LRU stays within its bound and the
    // heap stays flat.
    let maxSize = 0, shed = 0, served = 0;
    const heapAt = [];
    let next = 0;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 100; i++, next = (next + 1) % SELLERS) {
        const r = await fetch(`${base}/base?seller=seller${next}.example`);
        await r.text();
        if (r.status === 200) served++; else if (r.status === 503) shed++;
        if (i % 25 === 0) maxSize = Math.max(maxSize, (await views()).size);
      }
      const v = await views();
      maxSize = Math.max(maxSize, v.size);
      heapAt.push(await heap());
    }
    const v3 = await views();
    ok(v3.maxBytes === 32 * 1048576 && v3.bytes <= v3.maxBytes, `the memo also holds a byte bound (${Math.round(v3.bytes / 1048576)} of ${v3.maxBytes / 1048576} MB)`);
    ok(maxSize <= MEMO_MAX && v3.max === MEMO_MAX, `after ${served + shed} views of 400 distinct sellers the memo never held more than its bound (max ${maxSize} of ${MEMO_MAX}, ${v3.evictions} evictions)`);
    ok(served === 400 && shed === 0, `sequential distinct views are all served (${served} served, ${shed} shed)`);
    console.log(`  server heap after each 100 distinct sellers, collected (MB): ${heapAt.join(", ")}`);
    ok(heapAt[heapAt.length - 1] - heapAt[0] < 20, `server heap is flat over distinct-seller views (${heapAt[0]} -> ${heapAt[heapAt.length - 1]} MB)`);

    // The build cap applies to misses only: a hit or a join returns before
    // admission is read (part A), and the admission the route passes reads
    // the build gauge, which only a build enters. A local build finishes
    // too fast to hold two at once, so the wiring is pinned from source.
    const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
    const loop = src.slice(src.indexOf("for (const chainKey of Object.keys(SNAPSHOT_RAIL_LABEL))"), src.indexOf("app.get(\"/api/market/:chain/panel\""));
    const memoCall = loop.slice(loop.indexOf("chainSellerViewMemo.get("));
    ok(/admit: \(\) => chainSellerViewsInFlight\.live\(\) < CHAIN_SELLER_VIEW_MAX_INFLIGHT/.test(memoCall), "admission to a build reads the build cap");
    ok(memoCall.indexOf("chainSellerViewsInFlight.enter(") < memoCall.indexOf("buildChainPage(") && /finally \{ releaseView\(\); \}/.test(memoCall), "only a build enters the gauge, and always leaves it");
    ok(/if \(html === SHED\) \{ noteShed\("chain-seller-view"\); return shedResponse\(res, 5, \{ reason: "chain-seller-view" \}\); \}/.test(loop), "a refused miss is shed and counted as a chain-seller-view shed");
  } finally { proc.kill("SIGKILL"); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
