// The post-deploy surface check's has() helper (deploy.yml) counts a needle
// only in a 2xx answer: an error page whose body happens to contain the
// needle is a miss. The function is read from the workflow and run in bash
// against a local server, so the test exercises the shipped shell text.
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const wf = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const defs = wf.split("\n").filter((l) => /^\s*has\(\) \{/.test(l));
ok(defs.length === 1, `deploy.yml defines has() once (found ${defs.length})`);
const fn = (defs[0] || "").trim();

// spawnSync blocks this process's event loop, so the server runs in a child.
const child = spawn(process.execPath, ["-e", `
  const http = require("node:http");
  const s = http.createServer((req, res) => { const st = Number(req.url.slice(1)) || 200; res.writeHead(st, {"content-type":"text/html"}); res.end("<html>needle-present</html>"); });
  s.listen(0, "127.0.0.1", () => console.log(s.address().port));
`], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => child.stdout.once("data", (d) => r(Number(String(d).trim()))));
const url = (st) => `http://127.0.0.1:${port}/${st}`;
const run = (st, needle) => spawnSync("bash", ["-c", `${fn}\nHAS_RETRY_SLEEP=0\nhas "$1" "$2"; echo "rc=$? last=\${LAST_CODE:-}"`, "_", url(st), needle], { encoding: "utf8" }).stdout.trim();

try {
  ok(/^rc=0/.test(run(200, "needle-present")), "a 200 with the needle is a hit");
  ok(/^rc=1/.test(run(200, "absent-needle")), "a 200 without the needle is a miss");
  const r503 = run(503, "needle-present");
  ok(/^rc=1 last=503/.test(r503), `a 503 whose body contains the needle is a miss that names its status (${r503})`);
  ok(/^rc=1 last=404/.test(run(404, "needle-present")), "a 404 whose body contains the needle is a miss");
} finally {
  child.kill();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
