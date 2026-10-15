// The gateway response cache (embeddings, rerank, opted-in chat) is shared
// across replicas (2026-10-15): an entry one process stores is a hit in
// another, so a paid repeat on the other replica is served free instead of
// charged again. Needs a Redis (REDIS_URL); under CI a missing one fails.
//   REDIS_URL=redis://... node scripts/test-prompt-cache-shared.js
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
if (!process.env.REDIS_URL) {
  if (process.env.CI) { console.error("FAIL - test-prompt-cache-shared: REDIS_URL is required under CI"); process.exit(1); }
  console.log("SKIP - test-prompt-cache-shared: no REDIS_URL"); process.exit(0);
}
const K = await import("../src/tools/llm-gateway-kit.js");
const key = `test-${randomUUID()}`;
const body = { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "text-embedding-3-small" };
ok((await K.promptCacheGetShared(key)) === null, "a key nobody stored is a miss");
// Another process (another replica) stores the entry and exits.
execFileSync(process.execPath, ["--input-type=module", "-e", `
  const K = await import(${JSON.stringify(new URL("../src/tools/llm-gateway-kit.js", import.meta.url).href)});
  K.promptCacheStore(${JSON.stringify(key)}, ${JSON.stringify(body)});
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
`], { env: process.env, stdio: "inherit", timeout: 30_000 });
ok(K.promptCacheGet(key) === null, "this process's own store does not have it (the old per-replica miss)");
const hit = await K.promptCacheGetShared(key);
ok(JSON.stringify(hit) === JSON.stringify(body), "the shared read finds the other process's entry");
ok(JSON.stringify(K.promptCacheGet(key)) === JSON.stringify(body), "...and keeps a local copy, so the next read stays local");
const src = (await import("node:fs")).readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
ok(/const hit = await promptCacheGetShared\(key\);/.test(src), "the pre-paywall cache check reads the shared cache");
const { closeSharedRedis } = await import("../src/shared-limit.js");
await closeSharedRedis();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
