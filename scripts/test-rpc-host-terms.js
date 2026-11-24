// Chain RPC terms (src/rpc-terms.js): this server's payment verification,
// settlement proofs, refunds, revenue reads and ops scripts are commercial
// use, so no code default names a public endpoint whose terms limit it to
// personal or non-commercial use.
//   - a scan of the shipped code and the ops scripts finds no URL on a
//     NON_COMMERCIAL_RPC_HOSTS host (a test fixture and one guide page that
//     shows a chain's own published endpoint to a reader are the exceptions);
//   - every reader's default lane list holds only permitted endpoints;
//   - each settlement chain keeps at least two permitted lanes with the keyed
//     lane configured, and Monad and Sei keep two on operators whose terms
//     are cited in PERMITTED_RPC_SOURCES, so a change that drops a lane shows
//     up as a failure.
//
//   node scripts/test-rpc-host-terms.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const root = new URL("../", import.meta.url);

const T = await import("../src/rpc-terms.js");
ok(T.NON_COMMERCIAL_RPC_HOSTS.length >= 6 && T.NON_COMMERCIAL_RPC_HOSTS.every((h) => /^[a-z0-9.-]+$/.test(h)), `the barred hosts are listed by name (${T.NON_COMMERCIAL_RPC_HOSTS.length})`);
ok(T.isNonCommercialRpc("https://api.mainnet-beta.solana.com") && T.isNonCommercialRpc("https://mainnet.optimism.io/") && !T.isNonCommercialRpc("https://optimism-rpc.publicnode.com") && !T.isNonCommercialRpc("not a url"), "the host check reads a URL's host");

// ---- 1. no code default names a barred host ---------------------------------
{
  const DIRS = ["src", "scripts", "mcp", "client", "tollbooth", "workers", "services", "facilitator", "adapters", "openclaw", "start.js"];
  const files = execFileSync("git", ["ls-files", "--", ...DIRS], { cwd: root, encoding: "utf8" }).split("\n")
    .filter((f) => /\.(m?js|cjs|ts|json|sh|ya?ml)$/.test(f) && !/(^|\/)node_modules\//.test(f));
  // Exceptions, each with its reason:
  const EXCUSED = new Map([
    // A suite's fixture string, read by nothing at run time.
    ...files.filter((f) => /^scripts\/test-[^/]+\.js$/.test(f)).map((f) => [f, "test fixture"]),
    // The Robinhood Chain guide shows a reader the chain's own published endpoint; the server never reads it.
    ["src/guides.js", "a guide page quoting the chain's published endpoint to a reader"],
  ]);
  const re = new RegExp(`https?://(?:${T.NON_COMMERCIAL_RPC_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|")})(?![a-z0-9.-])`, "i");
  const found = [];
  let scanned = 0;
  for (const f of files) {
    if (EXCUSED.has(f)) continue;
    let text;
    try { text = readFileSync(new URL(f, root), "utf8"); } catch { continue; }
    scanned++;
    const lines = text.split("\n");
    lines.forEach((line, i) => { if (re.test(line)) found.push(`${f}:${i + 1}`); });
  }
  ok(scanned > 500, `the scan reads the shipped code and the ops scripts (${scanned} files)`);
  ok(found.length === 0, `no code default names an endpoint whose terms bar commercial use (${found.slice(0, 8).join(", ") || "none"}; fix: use src/rpc-terms.js's permitted lanes)`);
  ok(re.test('const RPC = "https://api.mainnet-beta.solana.com";') && !re.test('"https://solana-rpc.publicnode.com"'), "CONTROL: the scan pattern catches a barred default and passes a permitted one");
}

// ---- 2. every reader's default lanes are permitted --------------------------
{
  const env = { ALCHEMY_API_KEY: "k" };
  const { EVM_RPCS, evmRpcFor, evmRpcLanesFor } = await import("../src/evm-rpcs.js");
  const { EVM_LOGS_PUBLICS } = await import("../src/evm-logs-rpc.js");
  const { SOLANA_RPCS: VERIFY_SOLANA } = await import("../src/payment-verify.js");
  const { SOLANA_RPCS: HISTORY_SOLANA, solanaHistoryLanes } = await import("../src/solana-history-rpc.js");
  const lists = [
    ["EVM_RPCS", Object.values(EVM_RPCS)],
    ["EVM_LOGS_PUBLICS", Object.values(EVM_LOGS_PUBLICS).flat().map((l) => l.url)],
    ["payment-verify SOLANA_RPCS", VERIFY_SOLANA],
    ["solana-history SOLANA_RPCS", HISTORY_SOLANA],
    ["solana history lanes", solanaHistoryLanes({}).map((l) => l.url)],
    ["solana defaults", T.defaultSolanaRpcs(env)],
  ];
  for (const [name, urls] of lists) ok(urls.every((u) => !T.isNonCommercialRpc(u)), `${name}: every default lane is permitted (${urls.filter((u) => T.isNonCommercialRpc(u)).join(", ") || "all"})`);
  const live = readFileSync(new URL("src/revenue-live.js", root), "utf8");
  ok(!T.NON_COMMERCIAL_RPC_HOSTS.some((h) => live.includes(`//${h}`)), "the revenue reader names no barred endpoint");

  // ---- 3. lanes per settlement chain ---------------------------------------
  const chains = [...new Set([...Object.keys(EVM_RPCS), ...Object.keys(T.ALCHEMY_NETWORKS)])];
  const counts = Object.fromEntries(chains.map((n) => [n, evmRpcLanesFor(n, env).length]));
  const single = chains.filter((n) => counts[n] < 2).sort();
  ok(single.length === 0, `every settlement chain keeps two permitted lanes with the keyed lane set (one lane: ${single.join(", ") || "none"})`);
  // Monad and Sei each keep two lanes whose operators' terms are cited in
  // PERMITTED_RPC_SOURCES (Sei's own default publishes no terms, so it is not
  // counted toward the two).
  for (const [n, name] of [["eip155:143", "Monad"], ["eip155:1329", "Sei"]]) {
    const cited = evmRpcLanesFor(n, env).filter((u) => T.permittedRpcSource(u));
    ok(cited.length >= 2, `${name}: at least two lanes on a cited permitted source (${cited.map((u) => new URL(u).hostname).join(", ")})`);
  }
  ok(T.PERMITTED_RPC_SOURCES.every((s) => /^https:\/\//.test(s.terms) && s.clause.length > 20 && /^\d{4}-\d{2}-\d{2}$/.test(s.read) && !T.NON_COMMERCIAL_RPC_HOSTS.some((h) => s.hosts.test(h))), "every permitted source names its terms, clause and read date, and matches no barred host");
  ok(!T.permittedRpcSource("https://rpc.monad.xyz") && !T.permittedRpcSource("https://evil-publicnode.com.example") && T.permittedRpcSource("https://sei-evm-rpc.publicnode.com"), "CONTROL: the permitted-source check reads the host, not a substring");
  ok(chains.every((n) => counts[n] >= 1 && evmRpcLanesFor(n, env).every((u) => !T.isNonCommercialRpc(u))), "every chain has at least one lane, all permitted");
  ok(evmRpcFor("eip155:143", env) === "https://monad-mainnet.g.alchemy.com/v2/k" && evmRpcFor("eip155:143", {}) === T.ONFINALITY_RPCS.monad, "Monad reads the keyed lane first, and with no key its cited backup");
  ok(evmRpcFor("eip155:1329", env) === "https://evm-rpc.sei-apis.com" && evmRpcLanesFor("eip155:1329", env).includes("https://sei-mainnet.g.alchemy.com/v2/k") && evmRpcLanesFor("eip155:1329", {}).includes(T.PUBLICNODE_RPCS.sei), "Sei keeps its default first, with the keyed lane and PublicNode behind it");
  ok(evmRpcFor("eip155:999999", env) === null, "a chain with no lane has none (refused loudly, never a guessed endpoint)");
  ok(evmRpcFor("eip155:10", {}) === T.PUBLICNODE_RPCS.optimism && evmRpcFor("eip155:4663", {}) === T.PUBLICNODE_RPCS.robinhood && evmRpcFor("eip155:43114", {}) === T.PUBLICNODE_RPCS.avalanche, "OP Mainnet, Robinhood Chain and Avalanche read PublicNode by default");
  ok(evmRpcFor("eip155:10", { EVM_RPC_10: "https://op.example/rpc" }) === "https://op.example/rpc", "an operator override still wins");
  ok(T.defaultSolanaRpcs(env).length >= 2 && T.defaultSolanaRpcs({}).length === 1, "Solana: the keyed lane and PublicNode with the key set, PublicNode alone without it");
}

console.log(`\ntest-rpc-host-terms: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
