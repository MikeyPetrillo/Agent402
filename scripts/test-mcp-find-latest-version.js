// Offline test for scripts/mcp-find-latest-version.js — the helper the
// publish job in deploy.yml pipes the MCP Registry's search response
// through, right before publishing, to capture which version is ABOUT to
// become stale so it can be deprecated right after the new one goes live.
// Drives the real CLI script via child_process + stdin, not a re-import of
// its logic, since the script IS the interface (deploy.yml pipes into it).
//
//   node scripts/test-mcp-find-latest-version.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "mcp-find-latest-version.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

function run(input, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out));
    child.stdin.write(input);
    child.stdin.end();
  });
}

const FIXTURE = JSON.stringify({
  servers: [
    { server: { version: "0.10.0" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
    { server: { version: "0.11.0" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
    { server: { version: "0.12.5" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } } },
  ],
});

const NO_LATEST = JSON.stringify({
  servers: [
    { server: { version: "0.10.0" }, _meta: { "io.modelcontextprotocol.registry/official": { isLatest: false } } },
  ],
});

const out1 = await run(FIXTURE);
ok(out1 === "0.12.5", `finds the isLatest:true row's version (got "${out1}")`);

const out2 = await run(NO_LATEST);
ok(out2 === "", `no row is isLatest -> empty output, not a crash (got "${out2}")`);

const out3 = await run("{}");
ok(out3 === "", "empty servers list -> empty output");

const out4 = await run("not json at all");
ok(out4 === "", "unparseable input -> empty output, never a throw (the caller treats blank as 'nothing to deprecate')");

const out5 = await run("");
ok(out5 === "", "empty stdin -> empty output");

// --superseded: every version of OUR server name still "active" and not the
// latest, one per line, read from one or more pages (one JSON document per
// line), so the publish job can deprecate them all, not only the one it just
// superseded. Another publisher's entries (a similar name) are never listed.
const NAME = "io.github.MikeyPetrillo/agent402";
const row = (name, version, status, isLatest = false) => ({ server: { name, version }, _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest } } });
const page1 = JSON.stringify({ servers: [row(NAME, "0.2.3", "active"), row(NAME, "0.12.5", "deprecated"), row(NAME, "0.13.2", "active"), row("io.github.someone-else/agent402-x", "0.1.0", "active", true)] });
const page2 = JSON.stringify({ servers: [row(NAME, "0.13.22", "active"), row(NAME, "0.14.0", "active", true), row(NAME, "0.14.1", "active")] });
const sup = (await run(`${page1}\n${page2}\n`, ["--superseded", "--name", NAME, "--except", "0.14.1"])).trim().split("\n").filter(Boolean);
ok(sup.join(",") === "0.2.3,0.13.2,0.13.22", `--superseded lists every active non-latest version of our name across pages, oldest first (got ${sup.join(",")})`);
ok(!sup.includes("0.14.0") && !sup.includes("0.12.5") && !sup.includes("0.1.0") && !sup.includes("0.14.1"), "never the latest, never one already deprecated, never another publisher's entry, never the version being published");
const none = await run(`${page1}\n`, ["--superseded"]);
ok(none === "", "--superseded without --name lists nothing (it never acts on a name it was not given)");
ok((await run("garbage\n{\n", ["--superseded", "--name", NAME])) === "", "--superseded on unparseable pages lists nothing");
const latestOurs = await run(`${page1}\n${page2}\n`, ["--name", NAME]);
ok(latestOurs === "0.14.0", `with --name, the latest is read from our own entries across pages, never another publisher's isLatest row (got "${latestOurs}")`);

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
