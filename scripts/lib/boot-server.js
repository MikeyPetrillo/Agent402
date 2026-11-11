// Boot src/server.js on PORT=0 and read the port the kernel assigned back from
// its listening line.
//
// Why not getFreePort() + PORT=<n>: a port picked before the child binds it is
// free only at the moment it was picked. A test that reserves ports and boots
// a second server later (after the first finished a slow boot) leaves that
// port open for minutes, and another lane's outbound socket can take it
// (test-state-db-overlap, 2026-11-09: B's reserved port held by a socket while
// A booted). PORT=0 has no window: the port is the one the child bound.
// scripts/test-port-hygiene.js keeps new tests on this helper.
//
//   const srv = await bootServer({ env: { FREE_MODE: "true" } });
//   const r = await fetch(`${srv.url}/health`);
//   await srv.stop();
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownStoreEnv } from "./own-stores.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LISTENING = /listening on :(\d+)/;

/**
 * Start a server and wait until it answers `readyPath`.
 *
 * @param {object} [o]
 * @param {Record<string,string>} [o.env]      merged over process.env (and the own stores); PORT is always "0"
 * @param {string|false} [o.stores]          a label: every file store goes to a fresh temp dir and the
 *                                            state database is off (ownStoreEnv); false keeps the caller's stores
 * @param {string} [o.entry]                   script to run, relative to the repo root
 * @param {string[]} [o.args]                  extra node arguments (before the entry)
 * @param {string} [o.readyPath]               polled until it answers 200 (null: the listening line is enough)
 * @param {number} [o.timeoutMs]               give up after this long
 * @param {boolean} [o.ipc]                    open an IPC channel to the child (child.send / child.on("message")),
 *                                            for a preload that reports from inside the server process
 * @returns {Promise<{ child, port: number, url: string, log: () => string, exited: () => object|null, stop: () => Promise<void> }>}
 *          rejects with the log tail when the child exits or never becomes ready
 */
export async function bootServer({ env = {}, stores = "boot", entry = "src/server.js", args = [], readyPath = "/health", timeoutMs = 120_000, ipc = false } = {}) {
  let log = "";
  let exited = null;
  const child = spawn(process.execPath, [...args, entry], {
    cwd: ROOT,
    env: { ...process.env, ...(stores ? ownStoreEnv(stores) : {}), ...env, PORT: "0" },
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const stop = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
    await new Promise((r) => (exited ? r() : child.once("exit", r)));
    clearTimeout(t);
  };
  const fail = async (why) => {
    await stop();
    throw new Error(`${entry} ${why}; log tail:\n${log.slice(-2000)}`);
  };

  const deadline = Date.now() + timeoutMs;
  let port = 0;
  while (!port) {
    if (exited) return fail(`exited before listening (${JSON.stringify(exited)})`);
    if (Date.now() > deadline) return fail(`printed no listening line within ${timeoutMs} ms`);
    const m = LISTENING.exec(log);
    if (m) port = Number(m[1]);
    else await new Promise((r) => setTimeout(r, 100));
  }
  const url = `http://127.0.0.1:${port}`;
  while (readyPath) {
    if (exited) return fail(`exited before ${readyPath} answered (${JSON.stringify(exited)})`);
    if (Date.now() > deadline) return fail(`${readyPath} did not answer 200 within ${timeoutMs} ms`);
    try {
      const r = await fetch(url + readyPath, { signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer();
      if (r.status === 200) break;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, port, url, log: () => log, exited: () => exited, stop };
}
