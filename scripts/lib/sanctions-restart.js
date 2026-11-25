// The sanctions events store across a hard kill (src/sanctions-events.js):
// one child process records a list hit, three repeats of it and one
// unproven-refusal count, then kills itself with SIGKILL 300 ms later, before
// the write-behind flush; a second process starts on the same store and reads
// the operator view. Resolves { killedBy, rows } (rows: the second process's
// `recent`, every row). `env` names the store (SANCTIONS_EVENTS_FILE, and
// STATE_DATABASE_URL for the database).
import { spawnSync } from "node:child_process";

const STORE = new URL("../../src/sanctions-events.js", import.meta.url).href;

const WRITER = `
const EV = await import(${JSON.stringify(STORE)});
const addr = process.env.RESTART_ADDRESS;
await EV.recordSanctionsEvent({ kind: "screen-hit", address: addr, rail: "x402", route: "POST /api/hash" });
for (let i = 0; i < 3; i++) await EV.recordSanctionsEvent({ kind: "screen-hit", address: addr, rail: "x402", route: "POST /api/hash" });
await EV.recordSanctionsAggregate({ kind: "unproven-refusal", reason: "unsigned-field", rail: "x402", route: "POST /ref/hash" });
setTimeout(() => process.kill(process.pid, "SIGKILL"), 300);
setInterval(() => {}, 1000);
`;
const READER = `
const EV = await import(${JSON.stringify(STORE)});
const view = await EV.sanctionsEventsOperatorView({ recent: 1000 });
// A pipe takes a large write asynchronously: exit only once it is flushed.
process.stdout.write("ROWS " + JSON.stringify(view.recent) + "\\n", () => process.exit(0));
`;

export function runRestartCase({ env, address }) {
  const base = { ...process.env, ...env, RESTART_ADDRESS: address };
  for (const k of ["REDIS_URL", "LEDGER_JOURNAL_REDIS"]) delete base[k];
  if (!env.STATE_DATABASE_URL) delete base.STATE_DATABASE_URL;
  const w = spawnSync(process.execPath, ["--input-type=module", "-e", WRITER], { env: base, encoding: "utf8", timeout: 60_000 });
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", READER], { env: base, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("ROWS "));
  let rows = null;
  try { rows = line ? JSON.parse(line.slice(5)) : null; } catch { rows = null; }
  return { killedBy: w.signal, writerErr: String(w.stderr || "").slice(-400), readerErr: String(r.stderr || "").slice(-400), rows };
}
