// Several processes opening the stats store at once on one fresh directory
// (file mode: no state database) must all boot. Their first opens race on the
// switch to WAL, which needs a lock the others hold for a moment; SQLite can
// answer SQLITE_BUSY there without waiting, so src/stats.js retries the switch
// briefly instead of crashing the process at import (src/sqlite-wal.js, used
// by every SQLite store that switches to WAL).
//
// Offline: no server, no network. Spawns short-lived child processes, ROUNDS
// rounds of PROCS each, every round on a directory of its own.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const ROUNDS = Number(process.env.STATS_OPEN_ROUNDS) || 6;
const PROCS = Number(process.env.STATS_OPEN_PROCS) || 8;
const STATS = new URL("../src/stats.js", import.meta.url).href;
let failed = 0;
const fail = (m) => { failed++; console.error(`FAIL - ${m}`); };
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else fail(m); };

function child(dir, gate) {
  // Every child loads the store's own imports first, then waits on the same
  // start time, so the opens themselves (the store's import) overlap.
  const src = `
    await import("better-sqlite3");
    await import(${JSON.stringify(new URL("../src/state-db.js", import.meta.url).href)});
    await import(${JSON.stringify(new URL("../src/store-retry.js", import.meta.url).href)});
    await import(${JSON.stringify(new URL("../src/sqlite-wal.js", import.meta.url).href)}).catch(() => null);
    const at = ${gate}; while (Date.now() < at) {}
    const s = await import(${JSON.stringify(STATS)});
    console.log(JSON.stringify({ ok: typeof s.statsPersistent === "boolean" }));
    process.exit(0);`;
  const env = { ...process.env, STATS_DB_DIR: dir };
  delete env.STATE_DATABASE_URL; delete env.REDIS_URL;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", src], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    const t = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// The helper: SQLITE_BUSY is retried, anything else (and a lock that outlasts
// the wait) is thrown as before.
{
  const { enableWal } = await import("../src/sqlite-wal.js");
  const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  let n = 0;
  const flaky = { pragma: () => { if (++n <= 2) throw busy(); return [{ journal_mode: "wal" }]; } };
  ok(enableWal(flaky)?.[0]?.journal_mode === "wal" && n === 3, `two SQLITE_BUSY answers are retried and the third switch lands (${n} tries)`);
  let thrown = null; n = 0;
  try { enableWal({ pragma: () => { n++; throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }); } }); } catch (e) { thrown = e; }
  ok(thrown?.code === "SQLITE_IOERR" && n === 1, "any other error is thrown at once, untried");
  thrown = null; const t0 = Date.now();
  try { enableWal({ pragma: () => { throw busy(); } }, { maxWaitMs: 120, stepMs: 10 }); } catch (e) { thrown = e; }
  ok(thrown?.code === "SQLITE_BUSY" && Date.now() - t0 >= 100 && Date.now() - t0 < 2000, `a lock that outlasts the wait is thrown after it (${Date.now() - t0} ms)`);
}
// Every WAL switch in src/ goes through the helper.
{
  const raw = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".js") && !f.endsWith("sqlite-wal.js") && /\.pragma\(\s*["'`]journal_mode\s*=\s*WAL/i.test(readFileSync(f, "utf8"))) raw.push(f); } };
  walk(new URL("../src", import.meta.url).pathname);
  ok(raw.length === 0, `no module switches to WAL without the retry (${raw.join(", ") || "none"})`);
}

let crashes = 0;
for (let r = 0; r < ROUNDS; r++) {
  const dir = mkdtempSync(join(tmpdir(), "stats-open-"));
  try {
    const gate = Date.now() + 2500;
    const res = await Promise.all(Array.from({ length: PROCS }, () => child(dir, gate)));
    const bad = res.filter((x) => x.code !== 0 || !/"ok":true/.test(x.out));
    crashes += bad.length;
    for (const b of bad.slice(0, 2)) console.error(`  round ${r}: exit ${b.code}: ${(b.err.match(/Sqlite\w*: [^\n]*|Error: [^\n]*/) || [b.err.slice(0, 200)])[0]}${process.env.STATS_OPEN_STACK ? "\n" + b.err.slice(0, 1200) : ""}`);
    ok(bad.length === 0, `round ${r + 1}/${ROUNDS}: ${PROCS} processes opened one fresh stats directory at once and all booted (${PROCS - bad.length}/${PROCS})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`${crashes} crashed of ${ROUNDS * PROCS}`);
if (failed) { console.error(`FAILED: ${failed} round(s)`); process.exit(1); }
console.log("PASS");
