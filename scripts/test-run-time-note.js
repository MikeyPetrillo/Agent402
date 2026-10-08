// Every slow route tells the buyer how long it can take. The sentence comes
// from EVM_RUN_SECONDS (the run budget the payment window is sized to), so a
// new long-running product carries it automatically and the stated time can
// never drift from the window the server enforces. Boots a FREE_MODE server
// and reads /api/pricing, the surface agents and the MCP packages read.
import { spawn } from "node:child_process";
import { EVM_RUN_SECONDS, runTimeNote } from "../src/evm-validity.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
ok(runTimeNote(180).startsWith("Takes up to 3 minutes") && runTimeNote(75).startsWith("Takes up to 75 seconds") && runTimeNote(240).includes("at least 270 seconds"), "the note states the run budget and a timeout above it");

const PORT = 3074;
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off" },
  stdio: "ignore",
});
try {
  const B = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${B}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  const j = await (await fetch(`${B}/api/pricing`)).json();
  const eps = j.endpoints || j;
  const bySlug = new Map(eps.map((e) => [e.slug, e]));
  let checked = 0;
  for (const [slug, s] of Object.entries(EVM_RUN_SECONDS)) {
    const e = bySlug.get(slug);
    if (!e) continue;
    checked++;
    const d = String(e.description || "");
    ok(d.endsWith(runTimeNote(s)), `${slug}: description ends with its run-time note (${s} s)`);
    ok(d.split("keep the connection open").length === 2, `${slug}: the note appears once`);
  }
  ok(checked >= 15, `the slow routes are in the catalog (${checked} checked)`);
  const fast = bySlug.get("uuid");
  ok(fast && !/keep the connection open/.test(fast.description || ""), "a fast route carries no run-time note");
} finally {
  proc.kill("SIGKILL");
}
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
