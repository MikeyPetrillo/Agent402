// Cross-chain tool matrix — buy the top-N external tools on EACH of the seven
// rails, driven by each tool's OWN canonical example (the bazaar 402 example),
// and print a tools×chains grid of real on-chain settlements with a tx receipt
// per cell. Proof-by-receipts that every top tool renders its payload through
// every chain, not an assumption. Reuses the paid-canary payment machinery per
// chain family.
//
// The tool handler is chain-agnostic (it never sees which rail settled), so a
// tool's payload is identical across chains — what each cell proves is the
// settlement→unlock→payload path for that (tool, chain) pair.
//
// Runs in CI (needs the burner secrets): BURNER_KEY covers the four EVM rails
// (Base/Polygon/Arbitrum/Robinhood); SOLANA_BURNER_KEY / STELLAR_BURNER_SECRET
// / ALGORAND_BURNER_MNEMONIC each add their rail. POW_SECRET marks the buys as
// internal (heartbeat token) so the matrix doesn't masquerade as external
// demand. Real spend (~$3-5 for the full 15×7 grid). Informational: a failed
// cell is reported, never paged.
//
//   MATRIX_DRY_RUN=1 node scripts/cross-chain-matrix.js [N]   # no keys, no spend: verifies plumbing + that every chain is offered
//   BURNER_KEY=… [SOLANA_BURNER_KEY=… …] node scripts/cross-chain-matrix.js [N]   # real buys
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { createHmac } from "node:crypto";
import { openapiReader, resolveReplayableInput } from "./lib/replayable-example.js";
import { assertOwnPaidTarget } from "./lib/buyer-guard.js";
import { slowPreferOf, paidCallHonoringSlowRoutes } from "./lib/slow-route-buy.js";

const TARGET = assertOwnPaidTarget((process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, ""), "cross-chain-matrix");
const readOpenapi = openapiReader(TARGET);
const TOP_N = Number(process.argv[2] || process.env.MATRIX_TOP_N || 15);
const DRY = process.env.MATRIX_DRY_RUN === "1" || process.env.MATRIX_DRY_RUN === "true";

const secret = (process.env.POW_SECRET || "").trim();
const heartbeat = () =>
  secret ? { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${Math.floor(Date.now() / 60_000)}`).digest("base64url").slice(0, 32) } : {};
// Preserve method/body/X-PAYMENT on the paid retry (build via new Request), then
// add the heartbeat header — same posture as scripts/paid-canary.js.
const synthFetch = (input, init) => {
  const req = new Request(input, init);
  for (const [k, v] of Object.entries(heartbeat())) req.headers.set(k, v);
  return fetch(req);
};

const b64json = (s) => { try { return JSON.parse(Buffer.from(String(s || ""), "base64").toString("utf8")); } catch { return null; } };
const txFrom = (res) => { const j = b64json(res.headers.get("payment-response") || res.headers.get("x-payment-response")); return j?.transaction || null; };

// Build a replayable request from a tool's bazaar example input.
function buildRequest(path, example) {
  const method = String(example?.method || "GET").toUpperCase();
  if (example?.queryParams) {
    const q = new URLSearchParams(Object.entries(example.queryParams).map(([k, v]) => [k, String(v)])).toString();
    return { url: `${TARGET}${path}?${q}`, init: { method } };
  }
  if (example?.body != null) {
    return { url: `${TARGET}${path}`, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(example.body) } };
  }
  return { url: `${TARGET}${path}`, init: { method } };
}

// A slow route (its /api/pricing row's `async` block) is paid with Prefer:
// respond-async and its job followed to the end (scripts/lib/slow-route-buy.js);
// a job that ends failed is a red cell. A 400 respond_async_required (refused
// before payment) is paid once more with the Prefer header its body names.
const paidCall = (send, ep, init) => paidCallHonoringSlowRoutes(send, {
  prefer: slowPreferOf(ep.async, { method: init.method, json: init.body === undefined || typeof init.body === "string" }),
  baseUrl: TARGET, fetchImpl: synthFetch, slug: ep.slug,
});
const withHeaders = (init, extra) => ({ ...init, headers: { ...(init.headers || {}), ...extra } });

// A cell is green when the PAID call returns a real payload: 200 + non-empty
// body. Deep per-tool correctness is CI's job ("answers its own example"); here
// the bar is "the settlement unlocked a payload on this rail".
async function validPayload(res) {
  if (res.status !== 200) return false;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) { const j = await res.json().catch(() => null); return !!j && typeof j === "object" && Object.keys(j).length > 0; }
  const t = await res.text().catch(() => ""); return t.length > 0;
}

const CHAINS = [
  { key: "base", label: "base", kind: "evm", caip2: "eip155:8453", match: (n) => n === "eip155:8453", tx: (h) => `https://basescan.org/tx/${h}` },
  { key: "solana", label: "sol", kind: "svm", match: (n) => n.startsWith("solana:"), tx: (h) => `https://solscan.io/tx/${h}` },
  { key: "polygon", label: "poly", kind: "evm", caip2: "eip155:137", match: (n) => n === "eip155:137", tx: (h) => `https://polygonscan.com/tx/${h}` },
  { key: "arbitrum", label: "arb", kind: "evm", caip2: "eip155:42161", match: (n) => n === "eip155:42161", tx: (h) => `https://arbiscan.io/tx/${h}` },
  { key: "stellar", label: "stel", kind: "stellar", match: (n) => n.startsWith("stellar:"), tx: (h) => `https://stellar.expert/explorer/public/tx/${h}` },
  { key: "algorand", label: "algo", kind: "avm", match: (n) => n.startsWith("algorand:"), tx: (h) => `https://allo.info/tx/${h}` },
  { key: "robinhood", label: "rh", kind: "evm", caip2: "eip155:4663", match: (n) => n === "eip155:4663", tx: (h) => `https://robinhoodchain.blockscout.com/tx/${h}` },
];

async function setupEvm() {
  const pk = (process.env.BURNER_KEY || "").trim();
  if (!pk) return null;
  const [{ privateKeyToAccount }, { x402Client, x402HTTPClient }, { registerExactEvmScheme }] = await Promise.all([
    import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"),
  ]);
  const account = privateKeyToAccount(pk);
  const client = disableVendorSpendControls(new x402Client());
  registerExactEvmScheme(client, { signer: account });
  return { client, http: new x402HTTPClient(client), payer: account.address };
}

async function setupWrappers() {
  const w = {};
  await (async () => {
    const raw = (process.env.SOLANA_BURNER_KEY || "").trim(); if (!raw) return;
    const [{ x402Client: C }, { registerExactSvmScheme }, { wrapFetchWithPayment: wrap }, kit] = await Promise.all([
      import("@x402/core/client"), import("@x402/svm/exact/client"), import("@x402/fetch"), import("@solana/kit")]);
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
    const signer = await kit.createKeyPairSignerFromBytes(bytes);
    w.solana = { pay: wrap(synthFetch, registerExactSvmScheme(disableVendorSpendControls(new C()), { signer })), payer: signer.address };
  })().catch((e) => console.warn(`solana setup skipped: ${e.message}`));
  await (async () => {
    const sec = (process.env.STELLAR_BURNER_SECRET || "").trim(); if (!sec) return;
    const [{ x402Client: C }, { ExactStellarScheme }, { wrapFetchWithPayment: wrap }, sdk] = await Promise.all([
      import("@x402/core/client"), import("@x402/stellar/exact/client"), import("@x402/fetch"), import("@stellar/stellar-sdk")]);
    const kp = sdk.Keypair.fromSecret(sec);
    const signer = { address: kp.publicKey(), ...sdk.contract.basicNodeSigner(kp, sdk.Networks.PUBLIC) };
    const c = disableVendorSpendControls(new C()); c.register("stellar:*", new ExactStellarScheme(signer, { url: (process.env.STELLAR_RPC_URL || "https://mainnet.sorobanrpc.com").trim() }));
    w.stellar = { pay: wrap(synthFetch, c), payer: kp.publicKey() };
  })().catch((e) => console.warn(`stellar setup skipped: ${e.message}`));
  await (async () => {
    const mn = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim(); if (!mn) return;
    const [{ x402Client: C }, { ExactAvmScheme }, { wrapFetchWithPayment: wrap }, { toClientAvmSigner }, algosdk] = await Promise.all([
      import("@x402/core/client"), import("@x402/avm/exact/client"), import("@x402/fetch"), import("@x402/avm"), import("algosdk")]);
    const acct = algosdk.mnemonicToSecretKey(mn);
    const c = disableVendorSpendControls(new C()); c.register("algorand:*", new ExactAvmScheme(toClientAvmSigner(Buffer.from(acct.sk).toString("base64")), { algodUrl: (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim() }));
    w.algorand = { pay: wrap(synthFetch, c), payer: acct.addr.toString() };
  })().catch((e) => console.warn(`algorand setup skipped: ${e.message}`));
  return w;
}

async function main() {
  const evm = DRY ? null : await setupEvm();
  const wrappers = DRY ? {} : await setupWrappers();
  if (!DRY && !evm) { console.error("cross-chain-matrix: no BURNER_KEY — cannot run the paid grid (use MATRIX_DRY_RUN=1 for a keyless plumbing check)"); process.exit(2); }

  const [pricing, sales] = await Promise.all([
    (await fetch(`${TARGET}/api/pricing`)).json(),
    (await fetch(`${TARGET}/api/sales`)).json(),
  ]);
  const bySlug = Object.fromEntries((pricing.endpoints || []).map((e) => [e.slug, e]));
  const topSlugs = (sales.topExternal || []).map((r) => r.slug).filter((s) => bySlug[s]).slice(0, TOP_N);
  if (!topSlugs.length) { console.error("cross-chain-matrix: no top tools resolved from /api/sales + /api/pricing"); process.exit(2); }

  console.log(`\nCross-chain tool matrix — top ${topSlugs.length} tools × ${CHAINS.length} rails${DRY ? "  (DRY RUN — no payments)" : ""}`);
  console.log(`target ${TARGET}\n`);

  const grid = {};
  for (const slug of topSlugs) {
    const ep = bySlug[slug];
    grid[slug] = {};
    // one 402 per tool → its canonical example input
    const bare = await synthFetch(`${TARGET}${ep.path}`, ep.method === "POST" ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } : { method: "GET" });
    const pr = b64json(bare.headers.get("payment-required"));
    await bare.text().catch(() => "");
    const example = await resolveReplayableInput(pr?.extensions?.bazaar?.info?.input, { method: ep.method, path: ep.path, readOpenapi });
    const offered = new Set((pr?.accepts || []).map((a) => String(a.network)));
    const { url, init } = buildRequest(ep.path, example);

    for (const chain of CHAINS) {
      let cell = { ok: false, tx: null, note: "" };
      const isOffered = [...offered].some((n) => chain.match(n));
      if (DRY) {
        cell.ok = isOffered; cell.note = isOffered ? "offered" : "not offered";
        grid[slug][chain.key] = cell; process.stdout.write(cell.ok ? "✓" : "·"); continue;
      }
      if (!isOffered) { cell.note = "not offered"; grid[slug][chain.key] = cell; process.stdout.write("·"); continue; }
      try {
        if (chain.kind === "evm") {
          const bare2 = await synthFetch(url, init);
          if (bare2.status !== 402) { cell.note = `no 402 (HTTP ${bare2.status})`; await bare2.text().catch(() => ""); }
          else {
            const body2 = await bare2.json().catch(() => undefined);
            const paymentRequired = evm.http.getPaymentRequiredResponse((n) => bare2.headers.get(n), body2);
            const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network) === chain.caip2);
            if (!accepts.length) cell.note = "chain not in live accepts";
            else {
              const call = await paidCall(async (extra) => {
                const payHeaders = evm.http.encodePaymentSignatureHeader(await evm.client.createPaymentPayload({ ...paymentRequired, accepts }));
                return synthFetch(url, withHeaders(init, { ...extra, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" }));
              }, ep, init);
              const paid = call.res;
              cell.ok = await validPayload(paid); cell.tx = txFrom(paid);
              if (!cell.ok) cell.note = `${call.jobFailed ? "job failed: " : ""}HTTP ${paid.status}`;
            }
          }
        } else {
          const wp = wrappers[chain.key];
          if (!wp) cell.note = "no burner key";
          else {
            const call = await paidCall((extra) => wp.pay(url, withHeaders(init, extra)), ep, init);
            const paid = call.res;
            cell.ok = await validPayload(paid); cell.tx = txFrom(paid);
            if (!cell.ok) cell.note = `${call.jobFailed ? "job failed: " : ""}HTTP ${paid.status}`;
          }
        }
      } catch (e) { cell.note = (e?.message || String(e)).slice(0, 70); }
      grid[slug][chain.key] = cell;
      process.stdout.write(cell.ok ? "✓" : "✗");
    }
    process.stdout.write(`  ${slug}\n`);
  }

  printMatrix(grid, topSlugs);
}

function printMatrix(grid, slugs) {
  const w = Math.max(...slugs.map((s) => s.length), 8);
  const header = "".padEnd(w + 2) + CHAINS.map((c) => c.label.padStart(5)).join("");
  console.log("\n" + header);
  console.log("".padEnd(header.length, "─"));
  let green = 0, total = 0, cells = [];
  for (const slug of slugs) {
    let row = slug.padEnd(w + 2);
    for (const c of CHAINS) {
      const cell = grid[slug][c.key] || { ok: false, note: "?" };
      total++; if (cell.ok) green++;
      cells.push({ slug, chain: c.key, ...cell });
      row += (cell.ok ? "✓" : (cell.note === "not offered" ? "—" : "✗")).padStart(5);
    }
    console.log(row);
  }
  const fails = cells.filter((c) => !c.ok && c.note !== "not offered");
  console.log(`\n${green}/${total} cells green` + (DRY ? " (offered)" : " (settled + payload)"));
  if (fails.length) {
    console.log(`\n${fails.length} non-green cell(s):`);
    for (const f of fails.slice(0, 40)) console.log(`  ✗ ${f.slug} / ${f.chain}: ${f.note}`);
  }
  if (!DRY) {
    const sample = cells.filter((c) => c.ok && c.tx).slice(0, 7);
    if (sample.length) {
      console.log("\nsample on-chain receipts:");
      for (const s of sample) { const chain = CHAINS.find((c) => c.key === s.chain); console.log(`  ${s.slug} / ${s.chain}: ${chain.tx(s.tx)}`); }
    }
  }
  console.log(`\n${green === total ? "PASS" : "PARTIAL"}: ${green}/${total} ${DRY ? "offered" : "settled"}`);
}

main().catch((e) => { console.error("cross-chain-matrix fatal:", e?.stack || e?.message || String(e)); process.exit(1); });
