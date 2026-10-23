// Security audit A402-03: identity-bound routes (wallet-scoped memory + the
// wallet-keyed my-usage report) derive identity from the SIGNED EVM
// authorization (payerFromRequest, EVM-only). Advertising a non-EVM rail on them
// lets a buyer settle on Solana/Stellar/Algorand and THEN fail identity — a
// charged failure. These routes must offer EVM rails only.
//
// The load-bearing invariant this test guards, per the owner's mandate: the
// restriction is scoped STRICTLY to identity routes. Every other tool keeps ALL
// configured chains, so no rail loses the ability to sell the rest of the
// catalog. Pure functions, no server boot, no network.
import { acceptsForItem, isIdentityBoundRoute, priceForNetwork } from "../src/payments.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// A fully multi-chain deployment: every rail enabled, every payout wallet set.
const RAILS = {
  evmCaip2: ["eip155:8453", "eip155:137", "eip155:42161", "eip155:4663", "eip155:143"],
  svmCaip2: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  stellarCaip2: ["stellar:pubnet"],
  avmCaip2: ["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="],
  walletAddress: "0xabF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
  solanaWallet: "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg",
  stellarWallet: "GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL",
  algorandWallet: "C7IIHG7SPLPZ5H7ZT6HW3UV2OQMQQE6Y2HBNGZXSLRJULE42BEE2OY2XIE",
};
const nets = (accepts) => accepts.map((a) => a.network);

// ---- 1. A normal (sellable) tool advertises EVERY configured chain ----
{
  const accepts = acceptsForItem({ price: "$0.01" }, RAILS);
  const n = nets(accepts);
  ok(n.length === 8, `normal tool advertises all 8 rails (got ${n.length}: ${n.join(",")})`);
  for (const c of [...RAILS.evmCaip2, ...RAILS.svmCaip2, ...RAILS.stellarCaip2, ...RAILS.avmCaip2]) {
    ok(n.includes(c), `normal tool keeps rail ${c}`);
  }
  // payTo is the right wallet per chain family — no cross-wiring.
  ok(accepts.find((a) => a.network === "eip155:8453").payTo === RAILS.walletAddress, "EVM payTo is the EVM wallet");
  ok(accepts.find((a) => a.network.startsWith("solana:")).payTo === RAILS.solanaWallet, "Solana payTo is the Solana wallet");
  ok(accepts.find((a) => a.network.startsWith("stellar:")).payTo === RAILS.stellarWallet, "Stellar payTo is the Stellar wallet");
  ok(accepts.find((a) => a.network.startsWith("algorand:")).payTo === RAILS.algorandWallet, "Algorand payTo is the Algorand wallet");
}

// ---- 2. An identity-bound route advertises EVM rails ONLY ----
{
  const accepts = acceptsForItem({ price: "$0.002", identityBound: true }, RAILS);
  const n = nets(accepts);
  ok(n.length === RAILS.evmCaip2.length && n.every((c) => c.startsWith("eip155:")),
    `identity route is EVM-only (got ${n.join(",")})`);
  ok(!n.some((c) => c.startsWith("solana:") || c.startsWith("stellar:") || c.startsWith("algorand:")),
    "identity route advertises NO non-EVM rail (the charged-failure fix)");
  // Each chain quotes its own price for the route (a per-chain premium or
  // floor applies on identity routes like any other).
  ok(accepts.every((a) => a.payTo === RAILS.walletAddress && a.price === priceForNetwork("$0.002", a.network)),
    "identity route keeps the EVM wallet + its per-chain price");
}

// ---- 3. isIdentityBoundRoute classifies exactly the intended routes ----
ok(isIdentityBoundRoute({ category: "memory", slug: "memory-write" }) === true, "memory-category route is identity-bound");
ok(isIdentityBoundRoute({ category: "usage", slug: "my-usage" }) === true, "my-usage is identity-bound");
ok(isIdentityBoundRoute({ category: "web", slug: "extract" }) === false, "a normal web tool is NOT identity-bound");
ok(isIdentityBoundRoute({ category: "llm", slug: "llm-nano" }) === false, "a wallet-only LLM tool is NOT identity-bound (wallet-only != identity-bound)");
ok(isIdentityBoundRoute(null) === false && isIdentityBoundRoute(undefined) === false, "null/undefined is not identity-bound");

// ---- 4. Behavior preservation: unset wallets omit their rail (unchanged) ----
{
  const noSol = acceptsForItem({ price: "$0.01" }, { ...RAILS, solanaWallet: "" });
  ok(!nets(noSol).some((c) => c.startsWith("solana:")), "Solana omitted when SOLANA_WALLET unset (pre-existing behavior preserved)");
  ok(nets(noSol).some((c) => c.startsWith("stellar:")), "other chains unaffected when one wallet is unset");
}

// ---- 5. Identity route with only EVM configured is unchanged ----
{
  const evmOnlyRails = { ...RAILS, svmCaip2: [], stellarCaip2: [], avmCaip2: [] };
  const a1 = acceptsForItem({ price: "$0.002", identityBound: true }, evmOnlyRails);
  const a2 = acceptsForItem({ price: "$0.002" }, evmOnlyRails);
  ok(JSON.stringify(nets(a1)) === JSON.stringify(nets(a2)),
    "single-chain (EVM-only) deployment: identity routes look identical to normal ones");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
