// agent402-tollbooth CLI stops cleanly on SIGTERM and SIGINT: it stops taking
// connections, lets a request in flight finish (a paid request settles only
// after its answer), and exits 0; a request still running past
// TOLLBOOTH_SHUTDOWN_GRACE_MS is cut and the exit code is 1.
//
// Drives the real CLI process (spawned, env only, port 0 read back from its
// banner) in front of a loopback upstream whose answers are slow or never come.
//
//   node scripts/test-tollbooth-sigterm.js
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// /slow answers after 600 ms; /hang never answers.
const upstream = createServer((req, res) => {
  if (req.url.startsWith("/hang")) return;
  setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ upstream: "done" })); }, 600);
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UP = `http://127.0.0.1:${upstream.address().port}`;

/** Start the CLI; resolves { child, port, stderr(), exited } once it listens. */
function startCli(env = {}) {
  const child = spawn(process.execPath, [join(ROOT, "tollbooth", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: "0", TOLLBOOTH_UPSTREAM: UP, TOLLBOOTH_SECRET: "sigterm-test-secret-0123456789", TOLLBOOTH_ADMIN_TOKEN: "sigterm-admin", TOLLBOOTH_PAYTO: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const port = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { out += d; const m = out.match(/listening on :(\d+)/); if (m) resolve(Number(m[1])); });
    child.on("exit", () => reject(new Error(`CLI exited before listening: ${err.slice(0, 400)}`)));
    setTimeout(() => reject(new Error("CLI did not listen within 30 s")), 30_000).unref();
  });
  return port.then((p) => ({ child, port: p, stderr: () => err, exited }));
}

const timed = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ms))]);

try {
  // 1. A request in flight finishes, then the process exits 0.
  {
    const cli = await startCli();
    const inflight = fetch(`http://127.0.0.1:${cli.port}/slow`, { headers: { "user-agent": HUMAN, accept: "text/html" } })
      .then(async (r) => ({ status: r.status, body: await r.text() }), (e) => ({ error: e.message }));
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    cli.child.kill("SIGTERM");
    const answer = await inflight;
    const answeredAt = Date.now();
    const exit = await timed(cli.exited, 15_000);
    ok(answer.status === 200 && /"upstream":"done"/.test(answer.body || ""), `a request in flight at SIGTERM is answered in full (${JSON.stringify(answer).slice(0, 120)})`);
    ok(exit !== "timeout" && exit.code === 0 && Date.now() - answeredAt < 1_500, `the process exits 0 once the answer is sent, without waiting out the client's keep-alive (${JSON.stringify(exit)}, ${Date.now() - t0} ms after the signal)`);
    ok(/SIGTERM: no new connections/.test(cli.stderr()) && /stopped cleanly/.test(cli.stderr()), "it says it is stopping and that it stopped cleanly");
  }
  // 2. An idle process exits 0 on SIGINT at once.
  {
    const cli = await startCli();
    const t0 = Date.now();
    cli.child.kill("SIGINT");
    const exit = await timed(cli.exited, 15_000);
    ok(exit !== "timeout" && exit.code === 0 && Date.now() - t0 < 5_000, `an idle process exits 0 on SIGINT promptly (${JSON.stringify(exit)}, ${Date.now() - t0} ms)`);
  }
  // 3. A request that outlives the grace period is cut and the exit code is 1.
  {
    const cli = await startCli({ TOLLBOOTH_SHUTDOWN_GRACE_MS: "300" });
    const stuck = fetch(`http://127.0.0.1:${cli.port}/hang`, { headers: { "user-agent": HUMAN, accept: "text/html" } }).then((r) => r.status, () => "cut");
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    cli.child.kill("SIGTERM");
    const exit = await timed(cli.exited, 15_000);
    ok(exit !== "timeout" && exit.code === 1 && Date.now() - t0 < 5_000, `a request still running after the grace period is cut and the exit code is 1 (${JSON.stringify(exit)}, ${Date.now() - t0} ms)`);
    ok(/still running after 300 ms/.test(cli.stderr()), "it names the grace period it waited");
    await timed(stuck, 5_000);
  }
} catch (e) {
  ok(false, `run completed (${e?.stack || e})`);
} finally {
  upstream.closeAllConnections?.();
  upstream.close();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
