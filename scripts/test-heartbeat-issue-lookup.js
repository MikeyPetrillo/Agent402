// heartbeat.yml finds its open alarm issue by a title search, and GitHub's
// in:title search matches words, not the whole title: "Upstream buyer wallet
// LOW (x402)" also finds "EVM chains upstream buyer wallet LOW (x402)". A
// lookup that takes the first search hit can comment on or close another
// alarm's issue. Every lookup must keep only the issue whose title equals
// the alarm's own.
//
// Three checks, all offline: every lookup line binds the title and filters
// on it; every lookup's own jq, run over a list holding a near-identical
// title, picks only the exact one; and the four buyer wallet steps, run as
// written with stubbed curl and gh, never touch each other's issues.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.error(`FAIL - ${name}: ${e?.stack || e}`); }
}

const src = await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8");
const wf = yamlLoad(src);
const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []);

// Every `gh issue list ... --search ...` command in the workflow.
const lookups = src.split("\n").map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => /gh issue list\b/.test(line) && /--search\b/.test(line));
const jqOf = (line) => (line.match(/--jq '([^']*)'/) || [])[1];
const boundName = (line) => (line.match(/select\(\.title == env\.([A-Z_][A-Z0-9_]*)\)/) || [])[1];

const dir = await mkdtemp(path.join(tmpdir(), "hb-lookup-"));

await check("the workflow has issue lookups to check", () => {
  assert.ok(lookups.length >= 40, `found ${lookups.length}`);
});

await check("every title-search lookup binds the title and keeps only the exact match", () => {
  const bad = [];
  for (const { line, n } of lookups) {
    const name = boundName(line);
    const jq = jqOf(line);
    if (!name || !jq) { bad.push(`${n}: no exact-title filter`); continue; }
    if (!new RegExp(`\\b${name}=`).test(line)) bad.push(`${n}: env.${name} is not set on the command`);
    if (!/--json [^ ]*\btitle\b/.test(line)) bad.push(`${n}: --json does not request title`);
    if (/^\s*\.\[0\]/.test(jq)) bad.push(`${n}: takes the first search hit`);
  }
  assert.deepEqual(bad, []);
});

await check("each lookup's own jq picks the exact title over a near-identical one", () => {
  const T = "Upstream buyer wallet LOW (x402)";
  const bot = { login: "github-actions[bot]" };
  for (const { line, n } of lookups) {
    const jq = jqOf(line), name = boundName(line);
    if (!jq || !name) continue; // reported by the check above
    const runJq = (issues) => {
      const r = spawnSync("jq", ["-r", jq], { input: JSON.stringify(issues), env: { ...process.env, [name]: T, ALARM_OWNER: "o" }, encoding: "utf8" });
      assert.equal(r.status, 0, `${n}: ${r.stderr}`);
      return r.stdout.trim();
    };
    assert.equal(runJq([{ number: 7, title: `EVM chains ${T}`, author: bot }]), "", `${n}: matched another alarm's title`);
    assert.equal(runJq([{ number: 7, title: `EVM chains ${T}`, author: bot }, { number: 3, title: T, author: bot }]), "3", `${n}: missed its own title`);
    assert.equal(runJq([]), "", `${n}: an empty list must read as no issue (not "null")`);
  }
});

// The four wallet steps, run as written: the status reads ok and every OTHER
// wallet's issue is open. A lookup that crosses titles would close it.
await writeFile(path.join(dir, "curl"), `#!/usr/bin/env bash
printf '%s' "$GS_BODY"
`);
await writeFile(path.join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue list" ]; then
  jqx=""; prev=""; for a in "$@"; do [ "$prev" = "--jq" ] && jqx="$a"; prev="$a"; done
  printf '%s' "$ISSUES_JSON" | jq -r "$jqx"; exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\x1e' >> "$GH_LOG"
`);
await chmod(path.join(dir, "curl"), 0o755);
await chmod(path.join(dir, "gh"), 0o755);

const WALLETS = [
  ["Upstream buyer wallet check", "Upstream buyer wallet LOW (x402)", "upstreamBuyer"],
  ["EVM chains upstream buyer wallet", "EVM chains upstream buyer wallet LOW (x402)", "upstreamBuyerEvm"],
  ["Algorand upstream buyer wallet check", "Algorand upstream buyer wallet LOW (x402)", "upstreamBuyerAlgorand"],
  ["Solana upstream buyer wallet check", "Solana upstream buyer wallet LOW (x402)", "upstreamBuyerSolana"],
];
const bot = { login: "github-actions[bot]" };

for (const [prefix, title] of WALLETS) {
  await check(`${prefix}: an ok read leaves the other wallets' issues alone`, async () => {
    const step = steps.find((s) => String(s.name || "").startsWith(prefix));
    assert.ok(step, `heartbeat.yml has a step named "${prefix}..."`);
    assert.ok(step.run.includes(`TITLE="${title}"`), `step pages under "${title}"`);
    const others = WALLETS.filter(([, t]) => t !== title).map(([, t], i) => ({ number: 100 + i, title: t, author: bot }));
    // Every status field reads ok, whatever the step's field is called.
    const ok = { status: "ok", chains: {} };
    const gs = Object.fromEntries(["upstreamBuyer", "upstreamBuyerEvm", "upstreamBuyerAlgorand", "upstreamBuyerSolana", "algorandBuyer", "solanaBuyer", "svmBuyer", "avmBuyer", "upstreamBuyerSvm", "upstreamBuyerAvm"].map((k) => [k, ok]));
    const log = path.join(dir, "gh.log");
    await writeFile(log, "");
    const r = spawnSync("bash", ["-c", step.run], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r", GS_BODY: JSON.stringify(gs), ISSUES_JSON: JSON.stringify(others), GH_LOG: log },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = (await readFile(log, "utf8")).split("\x1e").filter((l) => l.trim()).map((l) => l.split("\x1f").filter((x) => x !== ""));
    assert.deepEqual(calls, [], `the step touched another alarm's issue: ${JSON.stringify(calls)}`);
  });
}

// The EVM chains step's own UNREADABLE alarm: a balance unknown for an hour
// or more pages under its own title, a shorter spell does not, a readable
// read closes it, and "off" never pages.
{
  const step = steps.find((s) => String(s.name || "").startsWith("EVM chains upstream buyer wallet"));
  const UNR = "EVM chains upstream buyer wallet UNREADABLE (x402)";
  const runEvm = async (evm, issues = []) => {
    const log = path.join(dir, "gh.log");
    await writeFile(log, "");
    const r = spawnSync("bash", ["-c", step.run], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r", GS_BODY: JSON.stringify(evm === undefined ? {} : { upstreamBuyerEvm: evm }), ISSUES_JSON: JSON.stringify(issues), GH_LOG: log },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return (await readFile(log, "utf8")).split("\x1e").filter((l) => l.trim()).map((l) => l.split("\x1f").filter((x) => x !== ""));
  };
  const titlesCreated = (calls) => calls.filter((c) => c[1] === "create").map((c) => c[c.indexOf("--title") + 1]);
  await check("EVM chains: unknown for an hour or more opens the UNREADABLE issue, once", async () => {
    assert.deepEqual(titlesCreated(await runEvm({ status: "unknown", unknownForMinutes: 70 })), [UNR]);
    assert.deepEqual(await runEvm({ status: "unknown", unknownForMinutes: 70 }, [{ number: 9, title: UNR }]), [], "an open issue is not duplicated or commented on");
  });
  await check("EVM chains: a short unknown spell, an unreadable gateway-status and off page nothing", async () => {
    assert.deepEqual(await runEvm({ status: "unknown", unknownForMinutes: 20 }), []);
    assert.deepEqual(await runEvm(undefined), []);
    assert.deepEqual(await runEvm({ status: "off" }), []);
  });
  await check("EVM chains: a readable read closes the UNREADABLE issue; a blind read never does", async () => {
    for (const status of ["ok", "low", "off"]) {
      const calls = await runEvm({ status }, [{ number: 9, title: UNR }]);
      assert.ok(calls.some((c) => c[1] === "close" && c[2] === "9"), `${status}: ${JSON.stringify(calls)}`);
    }
    const blind = await runEvm(undefined, [{ number: 9, title: UNR }]);
    assert.ok(!blind.some((c) => c[1] === "close"), JSON.stringify(blind));
  });
  const LOW = "EVM chains upstream buyer wallet LOW (x402)";
  await check("EVM chains: the LOW issue closes on ok, off and unconfigured; never on unknown or a blind read", async () => {
    for (const status of ["ok", "off", "unconfigured"]) {
      const calls = await runEvm({ status }, [{ number: 7, title: LOW }]);
      assert.ok(calls.some((c) => c[1] === "close" && c[2] === "7"), `${status}: ${JSON.stringify(calls)}`);
    }
    for (const evm of [{ status: "unknown", unknownForMinutes: 5 }, undefined]) {
      const calls = await runEvm(evm, [{ number: 7, title: LOW }]);
      assert.ok(!calls.some((c) => c[1] === "close"), JSON.stringify(calls));
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
