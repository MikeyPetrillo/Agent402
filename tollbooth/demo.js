// Live, narrated pay-per-crawl demo. Spins up a "premium content" site behind
// the tollbooth, then shows a human getting it free and an AI crawler paying to
// get through (here: by solving a proof-of-work, since that needs no wallet).
//
//   node demo.js        (or: npm run demo)
import express from "express";
import { createHash } from "node:crypto";
import { createTollbooth } from "./index.js";

const c = { dim: "\x1b[2m", reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m" };
const log = (s = "") => console.log(s);
const lz = (buf) => { let b = 0; for (const x of buf) { if (x === 0) { b += 8; continue; } b += Math.clz32(x) - 24; break; } return b; };

// A "premium content" site, fronted by the tollbooth.
const app = express();
app.use(createTollbooth({ price: "$0.002", payTo: "0xYourWalletHere000000000000000000000000", powDifficulty: 18 }));
app.use((_req, res) => res.send("📄 The Future of Machine Payments — full article text…"));
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;
const visit = (ua, extra = {}) => fetch(`${base}/article`, { headers: { "user-agent": ua, ...extra } });

const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CRAWLER = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";

try {
  log(`${c.bold}agent402-tollbooth — live pay-per-crawl demo${c.reset}`);
  log(`${c.dim}A premium-content site is now running behind the tollbooth.${c.reset}\n`);

  // 1) A human browses — free.
  log(`${c.cyan}① A human opens the page (normal browser)${c.reset}`);
  let r = await visit(HUMAN);
  log(`   → HTTP ${r.status} ${c.green}FREE${c.reset}  "${await r.text()}"`);
  log(`   ${c.dim}Humans are never charged.${c.reset}\n`);

  // 2) An AI crawler hits the same page — 402.
  log(`${c.cyan}② An AI crawler hits the same page (ClaudeBot)${c.reset}`);
  r = await visit(CRAWLER);
  const q = await r.json();
  const a = q.accepts?.[0];
  log(`   → HTTP ${r.status} ${c.yellow}Payment Required${c.reset}`);
  if (a) log(`   ${c.dim}pay with USDC:${c.reset} ${a.maxAmountRequired} ${a.asset} on ${a.network} → ${a.payTo}`);
  log(`   ${c.dim}…or free with proof-of-work:${c.reset} a ${q.proofOfWork.difficulty}-bit sha256 puzzle\n`);

  // 3) The crawler has no wallet, so it solves the proof-of-work.
  log(`${c.cyan}③ The crawler has no wallet, so it spends CPU instead${c.reset}`);
  const t0 = Date.now();
  let nonce = 0;
  while (lz(createHash("sha256").update(`${q.proofOfWork.challenge}:${nonce}`).digest()) < q.proofOfWork.difficulty) nonce++;
  log(`   ${c.dim}solved in ${((Date.now() - t0) / 1000).toFixed(2)}s (nonce=${nonce})${c.reset}`);

  // 4) Retry with the solution — unlocked.
  r = await visit(CRAWLER, { "x-pow-solution": `${q.proofOfWork.token}:${nonce}` });
  log(`   → HTTP ${r.status} ${c.green}OK${c.reset} (paid via ${r.headers.get("x-tollbooth-paid")})  "${await r.text()}"\n`);

  log(`${c.bold}${c.green}✓ Pay-per-crawl, end to end${c.reset} — humans free, bots pay (USDC or compute). No Cloudflare, no Stripe, no signup.`);
} finally {
  server.close();
}
