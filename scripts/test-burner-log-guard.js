// Burner-key log guard (audit R-02 / R-08). The concrete incident:
// scripts/agent-e2e.js printed the generated burner PRIVATE KEY on funding
// timeout, and that line landed in two PUBLIC GitHub Actions logs. This test
// locks the fix so it can never regress. Two layers:
//
//   1) BEHAVIORAL — force agent-e2e.js down its funding-timeout failure path
//      (FUND_WAIT_MINUTES=0 → loop skipped, no network, immediate no-funding
//      exit) with a known throwaway key on disk, capture stdout+stderr, and
//      assert the output carries ONLY the public address, never the key or any
//      key-shaped string. This is the exact path that leaked.
//   2) STATIC — scan scripts/ + src/ for a console.* that emits a raw key
//      variable's VALUE (interpolated `${pk}` or passed as an argument `, pk`),
//      as opposed to the many safe `if (!pk) console.error("no BURNER_KEY")`
//      label checks that only NAME the variable inside a string literal.
//
//   node scripts/test-burner-log-guard.js
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};

// Secret-shaped patterns: an EVM private key is 0x + 64 hex; a BIP-39 mnemonic
// is 12+ lowercase words in a row.
const EVM_PK = /0x[0-9a-fA-F]{64}\b/;
const MNEMONIC = /\b(?:[a-z]{3,}\s+){11,}[a-z]{3,}\b/;

// ---- 1) BEHAVIORAL: agent-e2e.js funding-timeout path ------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "a402-burner-log-"));
  const keyFile = join(dir, "burner-key");
  const pk = generatePrivateKey();                     // throwaway, never funded
  const address = privateKeyToAccount(pk).address;
  writeFileSync(keyFile, pk, { mode: 0o600 });

  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "agent-e2e.js")], {
    cwd: ROOT,
    env: { ...process.env, KEY_FILE: keyFile, FUND_WAIT_MINUTES: "0", MODE: "run" },
    encoding: "utf8",
    timeout: 60000,
  });
  const out = `${run.stdout || ""}\n${run.stderr || ""}`;

  ok(run.status === 1, `funding-timeout path exits 1 (got ${run.status})`);
  ok(out.includes(address), "output includes the public address (debuggable)");
  ok(!out.includes(pk), "output does NOT contain the private key value");
  ok(!EVM_PK.test(out), "output contains no EVM-private-key-shaped string");
  ok(!MNEMONIC.test(out), "output contains no mnemonic-shaped string");
}

// ---- 2) STATIC: no console.* emits a raw key variable's value ----------------
{
  const KEY_VARS = ["pk", "privateKey", "PRIVATE_KEY", "mnemonic", "secretKey"];
  const offenders = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|cjs)$/.test(name)) continue;
      if (p === SELF) continue; // this file names the patterns on purpose
      const lines = readFileSync(p, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/console\.(log|error|warn|info|debug)/.test(line)) return;
        for (const v of KEY_VARS) {
          const interpolated = new RegExp("\\$\\{\\s*" + v + "\\b");   // `${pk}`
          const asArg = new RegExp(",\\s*" + v + "\\s*[),]");          // `…, pk)`
          if (interpolated.test(line) || asArg.test(line)) {
            offenders.push(`${p.replace(ROOT + "/", "")}:${i + 1}  ${line.trim().slice(0, 100)}`);
          }
        }
      });
    }
  };
  walk(join(ROOT, "scripts"));
  walk(join(ROOT, "src"));
  ok(offenders.length === 0, `no console.* prints a raw key value${offenders.length ? ":\n  " + offenders.join("\n  ") : ""}`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
