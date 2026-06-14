// Runnable demo: a tiny "content site" sitting behind the tollbooth.
// Humans read it free; AI crawlers get a 402 and must pay (USDC via x402) or
// solve a proof-of-work.
//
//   node tollbooth/example.js
//   curl -A "Mozilla/5.0" localhost:4021/article      # human  -> 200
//   curl -A "ClaudeBot/1.0" localhost:4021/article    # bot    -> 402
import express from "express";
import { createTollbooth } from "./index.js";

const app = express();

app.use(createTollbooth({
  price: "$0.002",
  // Set payTo to advertise a USDC x402 quote (and wire `verifyX402` to settle).
  payTo: process.env.TOLLBOOTH_PAYTO || undefined,
  // Humans pass free; AI crawlers (GPTBot/ClaudeBot/CCBot/PerplexityBot/…) pay.
}));

app.use((_req, res) =>
  res.type("html").send("<h1>Premium content</h1><p>Humans read this for free. An AI crawler paid (or solved a proof-of-work) to reach this page.</p>")
);

const port = Number(process.env.PORT) || 4021;
app.listen(port, () => {
  console.log(`Demo site behind the tollbooth → http://localhost:${port}`);
  console.log(`  human:  curl -A "Mozilla/5.0" localhost:${port}/article`);
  console.log(`  bot:    curl -A "ClaudeBot/1.0" localhost:${port}/article`);
});
