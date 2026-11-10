// scripts/lib/boot-server.js: a PORT=0 boot reads back the port the kernel
// assigned, two servers booted at once land on two ports and both answer, stop()
// ends the child, and a child that dies before listening rejects with its log
// tail instead of hanging until the deadline.
//
//   node scripts/test-boot-server.js
import "./lib/offline-stores.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "./lib/boot-server.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };
const env = { FREE_MODE: "true", X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" };

const [a, b] = await Promise.all([bootServer({ env, stores: "boot-a" }), bootServer({ env, stores: "boot-b" })]);
try {
  ok(a.port > 0 && b.port > 0 && a.port !== b.port, "two concurrent boots read back two distinct kernel-assigned ports");
  ok(a.url === `http://127.0.0.1:${a.port}`, "url is built from the bound port");
  const [ra, rb] = await Promise.all([fetch(`${a.url}/health`), fetch(`${b.url}/health`)]);
  ok(ra.status === 200 && rb.status === 200, "both servers answer /health");
  ok(/listening on :\d+/.test(a.log()) && !/listening on :0\b/.test(a.log()), "the listening line names the bound port, not 0");
} finally {
  await Promise.all([a.stop(), b.stop()]);
}
ok(a.exited() !== null && b.exited() !== null, "stop() waits for the child to exit");
let refused = 0;
try { await fetch(`${a.url}/health`, { signal: AbortSignal.timeout(2000) }); } catch { refused++; }
ok(refused === 1, "nothing answers on the port after stop()");

// A child that exits before it listens rejects fast, with its log in the error.
const dir = mkdtempSync(join(tmpdir(), "a402-boot-crash-"));
const crash = join(dir, "crash.js");
writeFileSync(crash, 'console.error("boom: planted crash"); process.exit(3);\n');
const t0 = Date.now();
let err = null;
try { await bootServer({ entry: crash, stores: false, timeoutMs: 30_000 }); } catch (e) { err = e; }
ok(err && /exited before listening/.test(err.message) && /boom: planted crash/.test(err.message), "a child that dies before listening rejects with its log tail");
ok(Date.now() - t0 < 10_000, "the rejection comes from the exit, not the deadline");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
