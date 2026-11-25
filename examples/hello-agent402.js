// The smallest possible Agent402 client: discover a tool by task, then call it.
// Free tier — no wallet, no API key, no signup. The client solves the tiny
// proof-of-work for you.
//
//   npm install agent402-client
//   node hello-agent402.js
import { Agent402 } from "agent402-client";

const a = new Agent402(); // → https://agent402.tools, free proof-of-work tier

// 1. Discover — describe a task, get ranked matching tools.
const matches = await a.find("compound interest calculator");
console.log("top matches:", matches.slice(0, 3).map((m) => m.slug).join(", "));

// 2. Call any tool by slug. Pure-CPU tools are free: the client pays the
//    proof-of-work; no wallet required.
const r = await a.call("compound-interest", { principal: 1000, annualRate: 0.05, years: 10 });
console.log(`$1,000 at 5% for 10 years → $${r.futureValue} (${r.periods} periods)`);

// Want live data / browser / search / LLMs (the wallet-only tools)? Pass an
// x402-wrapped fetch and the SAME a.call(...) pays USDC automatically — non-
// custodial, you hold the key; spending caps optional:
//
//   import { wrapFetchWithPayment } from "@x402/fetch";
//   const a = new Agent402({ fetch: wrapFetchWithPayment(fetch, x402Client), maxPerCallUsd: 0.05 });
//   const quote = await a.call("crypto-price", { coins: "bitcoin" });
