// Pins for the @solana/kit 8 install shape (2026-09-18, kit 5.5.1 -> 8.3.0 with
// @solana-program/token 0.16.1 + compute-budget 0.18.1; 0.17.0 + 0.19.0 since 2026-09-24).
//
// @x402/svm 2.26 still depends on kit-5-peered program packages (token ^0.9.0,
// compute-budget ^0.11.0, token-2022 ^0.6.1) while peering kit >=5.1.0, so a
// plain install of kit 8 is an ERESOLVE: the nested copies' `@solana/kit ^5.0`
// peer cannot be met by a kit-8 root. The root `overrides` lift those three to
// the kit-8-peered releases, and this test is what keeps that safe: every name
// @x402/svm imports from them must still be exported (checked TEXTUALLY from
// the svm dist against the installed packages, so a future svm bump that
// imports a name the overridden version lacks fails here, not at a buyer's
// first Solana payment), the overrides must match the direct deps, and exactly
// one kit must be reachable from our code and from @x402/svm. Offline.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } pass++; };
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = (p) => JSON.parse(readFileSync(p, "utf8")).version;
const major = (v) => Number(String(v).replace(/^[^\d]*/, "").split(".")[0]);

// ---- 1. root kit is 8.x and is the ONE kit our code and @x402/svm resolve ----
const rootKit = version(join(ROOT, "node_modules/@solana/kit/package.json"));
ok(major(rootKit) >= 8, `root @solana/kit is 8.x (got ${rootKit})`);
ok(pkg.dependencies["@solana/kit"] === rootKit, `package.json pins the installed kit exactly (${pkg.dependencies["@solana/kit"]} vs ${rootKit})`);
// Package DIRECTORIES are found by walking node_modules (a package with an
// `exports` map, like @x402/svm, refuses `require.resolve("<pkg>/package.json")`).
const pkgDir = (fromDir, name) => {
  for (let d = fromDir; ; d = dirname(d)) {
    const c = join(d, "node_modules", name);
    if (existsSync(join(c, "package.json"))) return c;
    if (d === dirname(d) || d.length <= ROOT.length) break;
  }
  throw new Error(`${name} not found from ${fromDir}`);
};
const svmDir = pkgDir(ROOT, "@x402/svm");
const svmReq = createRequire(join(svmDir, "package.json"));
ok(pkgDir(svmDir, "@solana/kit") === pkgDir(ROOT, "@solana/kit"),
  "@x402/svm resolves the SAME kit copy as our code (a nested kit 5 under svm would sign with a different library than the buyer verifies with)");

// ---- 2. the overrides are what the direct deps say, and each overridden package peers kit ^8 ----
for (const name of ["@solana-program/token", "@solana-program/compute-budget"]) {
  ok(pkg.overrides[name] === pkg.dependencies[name], `override for ${name} equals the direct dependency (${pkg.overrides[name]} vs ${pkg.dependencies[name]})`);
  ok(version(join(ROOT, "node_modules", name, "package.json")) === pkg.dependencies[name], `${name} installed at the pinned version`);
}
ok(typeof pkg.overrides["@solana-program/token-2022"] === "string", "token-2022 is overridden too (svm's third program dep)");
for (const name of ["@solana-program/token", "@solana-program/compute-budget", "@solana-program/token-2022"]) {
  const j = JSON.parse(readFileSync(join(pkgDir(svmDir, name), "package.json"), "utf8"));
  const peer = j.peerDependencies?.["@solana/kit"] || "";
  ok(/\^8|>=8|>=5/.test(peer) && !/\^5(\.|$)|\^6|\^7/.test(peer), `@x402/svm's ${name}@${j.version} peers a kit range that admits 8 (${peer})`);
}

// ---- 3. every name @x402/svm imports from the program packages exists in the installed (overridden) versions ----
function* walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) yield* walk(p); else if (p.endsWith(".mjs")) yield p; } }
const need = {};
for (const f of walk(join(svmDir, "dist/esm"))) {
  for (const m of readFileSync(f, "utf8").matchAll(/import \{([^}]*)\} from "(@solana-program\/[a-z0-9-]+)"/g)) {
    (need[m[2]] ??= new Set());
    m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => need[m[2]].add(n));
  }
}
ok(Object.keys(need).length === 3, `svm imports from three program packages (${Object.keys(need).join(", ")})`);
let checked = 0;
for (const [name, names] of Object.entries(need)) {
  const mod = await import(svmReq.resolve(name));
  const missing = [...names].filter((n) => !(n in mod));
  ok(missing.length === 0, `${name}: every name svm imports is exported by the installed version (missing: ${missing.join(", ") || "none"})`);
  checked += names.size;
}
ok(checked >= 10, `checked ${checked} svm imports`);

// ---- 4. our own imports resolve on the new majors, and the svm schemes load ----
const kit = await import("@solana/kit");
for (const n of ["createKeyPairSignerFromBytes", "getBase58Encoder", "createSolanaRpc", "pipe", "createTransactionMessage",
  "setTransactionMessageFeePayerSigner", "setTransactionMessageLifetimeUsingBlockhash", "appendTransactionMessageInstructions",
  "signTransactionMessageWithSigners", "getBase64EncodedWireTransaction", "getSignatureFromTransaction", "partiallySignTransactionMessageWithSigners",
  "prependTransactionMessageInstruction", "generateKeyPairSigner", "getAddressEncoder", "AccountRole", "address", "blockhash"]) {
  ok(n in kit, `kit 8 exports ${n}`);
}
const tok = await import("@solana-program/token");
for (const n of ["TOKEN_PROGRAM_ADDRESS", "findAssociatedTokenPda", "getCreateAssociatedTokenIdempotentInstruction", "getTransferCheckedInstruction", "getTransferInstruction"]) ok(n in tok, `token exports ${n}`);
const cb = await import("@solana-program/compute-budget");
for (const n of ["getSetComputeUnitLimitInstruction", "setTransactionMessageComputeUnitPrice"]) ok(n in cb, `compute-budget exports ${n}`);
const { ExactSvmScheme } = await import("@x402/svm/exact/client");
const { ExactSvmScheme: ServerScheme } = await import("@x402/svm/exact/server");
ok(typeof ExactSvmScheme === "function" && typeof ServerScheme === "function", "@x402/svm exact client + server load on the overridden program packages");
ok(existsSync(join(ROOT, "node_modules/@coinbase/cdp-sdk/node_modules/@solana/kit")) || true, "note: @coinbase/cdp-sdk carries its own nested kit 5 by design (not reachable from our code)");

console.log(`\ntest-solana-kit-deps: ${pass} assertions passed`);
