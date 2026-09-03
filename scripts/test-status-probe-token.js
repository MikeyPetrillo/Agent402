// The probe-only credential (2026-08-30).
//
// Until this shipped, BOTH observers outside production - the GitHub heartbeat
// and the Cloudflare status Worker - carried AGENT402_OPERATOR_TOKEN purely so
// they could POST /api/status/probe. That token is the root credential: it also
// reaches /__operator/refunds/update (void a refund debt), /credits/disable
// (kill a customer's prepaid key), /well-known (publish a document at our own
// domain), /leads, /backup/run, /monitors/run, /alerts/run, /stats and
// /wishes. Two off-platform observers were holding a master key to use one door.
//
// STATUS_PROBE_TOKEN opens that one door. What this test has to prove is not
// that it works - that is the easy half - but that it does NOT work anywhere
// else, and that adding it broke nothing that used the operator token before.
// Boots the real server, because the value of the check is in the route wiring.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const OP = "operator-root-token-aaaaaaaaaaaaaaaa";
const PROBE = "status-probe-only-token-bbbbbbbbbbbb";
const PORT = await getFreePort();
const base = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), AGENT402_OPERATOR_TOKEN: OP, STATUS_PROBE_TOKEN: PROBE, X402_INDEX_CRAWL: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });
const done = (code) => { try { child.kill("SIGKILL"); } catch { /* */ } process.exit(code); };

const probeBody = JSON.stringify({ source: "test", ts: Date.now(), components: { api: { ok: true } } });
const postProbe = (token) =>
  fetch(`${base}/api/status/probe`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "X-Operator-Token": token } : {}) },
    body: probeBody,
  });

(async () => {
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* */ }
    await wait(500);
  }
  ok(up, "server booted");
  if (!up) { console.error(serverLog.slice(-800)); return done(1); }

  // 1. It opens the one door.
  const r1 = await postProbe(PROBE);
  ok(r1.status === 200, `probe token records an observation (got ${r1.status})`);

  // 2. Nothing breaks mid-rotation: the operator token still works here, which
  //    is what lets the two be swapped without an observer going dark.
  ok((await postProbe(OP)).status === 200, "operator token still records (rotation is not a cutover)");

  // 3. An unauthenticated or wrong credential is refused, exactly as before.
  ok((await postProbe(null)).status === 404, "no credential -> 404");
  ok((await postProbe("wrong-token-xxxxxxxxxxxxxxxxxxxxx")).status === 404, "wrong credential -> 404");
  // Same length as the real one: a length-only comparison would pass this.
  ok((await postProbe(PROBE.slice(0, -1) + "c")).status === 404, "near-miss of the same length -> 404");

  // 4. THE POINT. The probe token must open nothing else.
  //
  //    The route list is DERIVED FROM SOURCE, not typed here: a hand-written
  //    list silently stops covering the next operator endpoint somebody adds,
  //    which is exactly the drift this credential exists to prevent. The first
  //    draft of this test did type them, and eight of the fifteen turned out
  //    not to mount under FREE_MODE - so eight "refused (404)" lines were
  //    proving nothing at all. Hence the two-sided assertion below.
  const srcFiles = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".js")) srcFiles.push(p);
    }
  };
  await walk("src");
  const routes = new Map(); // path -> "get" | "post"
  for (const f of srcFiles) {
    const text = await readFile(f, "utf8");
    for (const m of text.matchAll(/app\.(get|post)\("(\/__operator[a-zA-Z0-9/._-]*)"/g)) {
      if (!routes.has(m[2])) routes.set(m[2], m[1]);
    }
  }
  ok(routes.size >= 20, `found the operator routes in source (${routes.size})`);

  const hit = (path, method, token) =>
    fetch(`${base}${path}`, {
      method: method.toUpperCase(),
      headers: { "content-type": "application/json", "X-Operator-Token": token },
      redirect: "manual",
      ...(method === "post" ? { body: JSON.stringify({}) } : {}),
    });

  // The operator surface is rate-limited at 10 wrong credentials per minute per
  // IP, and a spent budget refuses even a CORRECT token (that is the design).
  // So a probe-token 404 is only evidence about the CREDENTIAL when the
  // operator token still works on the same route immediately afterwards -
  // otherwise the 404 came from the limiter and proves nothing. Check both
  // sides around every attempt, and stop counting once the budget is gone.
  // (The first draft did not, and read ten limiter refusals as ten passes.)
  let verified = 0;
  const leaked = [];
  const unmounted = [];
  for (const [path, method] of routes) {
    // /login and /logout are the unauthenticated session endpoints; they are
    // not token-gated at all, so they are not part of this claim.
    if (path === "/__operator/login" || path === "/__operator/logout") continue;
    if ((await hit(path, method, OP)).status === 404) { unmounted.push(path); continue; }
    const withProbe = await hit(path, method, PROBE);
    if ((await hit(path, method, OP)).status === 404) break; // budget gone; nothing after this is evidence
    verified++;
    if (withProbe.status !== 404) leaked.push(`${method.toUpperCase()} ${path} -> ${withProbe.status}`);
  }
  ok(leaked.length === 0, `the probe token opens no operator route (${verified} verified under clean conditions; leaks: ${leaked.join(", ") || "none"})`);
  // Guard against a vacuous pass: a green line above means nothing if nothing
  // was actually reachable to try.
  ok(verified >= 5, `enough operator routes verified to make that meaningful (${verified}; ${unmounted.length} not mounted under FREE_MODE)`);
  if (unmounted.length) console.log(`     (not mounted under FREE_MODE, so untested here: ${unmounted.join(" ")})`);

  // Those routes all share one gate, so the loop above is a check on the gate
  // rather than on each route. What has to hold for that to keep being true is
  // that the probe-only gate is wired to ONE route and no other - otherwise a
  // future endpoint could quietly accept it.
  const serverSrc = await readFile("src/server.js", "utf8");
  const gateUses = [...serverSrc.matchAll(/statusProbeAuthed\(/g)].length;
  ok(gateUses === 2, `statusProbeAuthed is declared once and called from exactly one route (found ${gateUses} occurrences)`);
  ok(/app\.post\("\/api\/status\/probe"[\s\S]{0,400}?statusProbeAuthed\(req\)/.test(serverSrc),
    "and the one caller is POST /api/status/probe");

  // 5. It must not authenticate an operator SESSION either - a login with it
  //    would hand over everything above through the cookie instead.
  const login = await fetch(`${base}/__operator/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: PROBE }),
  });
  ok(login.status === 401, `probe token cannot mint an operator session (got ${login.status})`);

  // 6. Source guard: the value is read in exactly one place. A second reader is
  //    how a narrow credential silently becomes a wide one.
  const readers = [];
  for (const f of srcFiles) {
    if (/process\.env\.STATUS_PROBE_TOKEN/.test(await readFile(f, "utf8"))) readers.push(f);
  }
  ok(readers.length === 1 && readers[0] === "src/server.js", `STATUS_PROBE_TOKEN is read in exactly one file (found: ${readers.join(", ") || "none"})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
