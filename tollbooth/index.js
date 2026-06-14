#!/usr/bin/env node
// agent402-tollbooth — an open-source, self-hostable x402 "pay-per-crawl" gate.
//
// Put it in front of any site or API: human visitors pass through free, while
// AI crawlers / agents must pay per request — either in USDC over the x402
// protocol, or for free by solving a proof-of-work (no wallet, no signup, no
// Stripe, no Cloudflare). Use it two ways:
//
//   1. Express middleware:   app.use(createTollbooth({ ... }))
//   2. Reverse proxy (CLI):  TOLLBOOTH_UPSTREAM=https://your-site.com npx agent402-tollbooth
//
// The proof-of-work rail works out of the box with zero configuration. To also
// accept USDC, set `payTo` and supply `verifyX402` (wire it to the standard
// x402 server middleware / your facilitator — see README).
import { fileURLToPath } from "node:url";
import { createPow } from "./pow.js";
import { makeBotMatcher, AI_BOTS } from "./bots.js";

export { AI_BOTS, makeBotMatcher } from "./bots.js";
export { createPow, leadingZeroBits } from "./pow.js";

/**
 * Create the tollbooth Express middleware.
 * @param {object} [config]
 * @param {string} [config.price="$0.001"]     advertised price per request
 * @param {string|null} [config.payTo]         wallet for the x402 quote (enables USDC rail)
 * @param {string} [config.network="base"]     x402 network
 * @param {string} [config.asset="USDC"]
 * @param {boolean} [config.pow=true]          enable the free proof-of-work rail
 * @param {number} [config.powDifficulty]      PoW difficulty in leading zero bits
 * @param {string[]} [config.botUserAgents]    user-agents to charge (default: AI_BOTS)
 * @param {(req)=>boolean} [config.charge]     custom "should this client pay?" predicate
 * @param {(req)=>boolean} [config.free]       custom force-allow predicate (wins over charge)
 * @param {(req, requirements)=>boolean|Promise<boolean>} [config.verifyX402]  USDC settlement check
 * @param {string} [config.resourceBaseUrl]    absolute base for the x402 `resource`/PoW binding
 * @param {string} [config.message]            human-readable note included in the 402
 */
export function createTollbooth(config = {}) {
  const {
    price = process.env.TOLLBOOTH_PRICE || "$0.001",
    payTo = process.env.TOLLBOOTH_PAYTO || null,
    network = process.env.TOLLBOOTH_NETWORK || "base",
    asset = "USDC",
    pow = true,
    powDifficulty,
    powSecret,
    botUserAgents = AI_BOTS,
    charge,
    free,
    verifyX402,
    resourceBaseUrl = process.env.TOLLBOOTH_RESOURCE_BASE || "",
    message = "This resource charges automated / AI clients per request. Humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.",
  } = config;

  const isBot = makeBotMatcher(botUserAgents);
  const powEngine = pow ? createPow({ difficulty: powDifficulty, secret: powSecret }) : null;

  const shouldCharge = (req) => {
    if (typeof free === "function" && free(req)) return false;
    if (typeof charge === "function") return Boolean(charge(req));
    return isBot(req.headers["user-agent"] || "");
  };
  const resourceOf = (req) =>
    (resourceBaseUrl ? resourceBaseUrl.replace(/\/$/, "") : "") + (req.originalUrl || req.url || "/");

  function tollbooth(req, res, next) {
    if (!shouldCharge(req)) return next();
    const resource = resourceOf(req);

    const send402 = (extra = {}) => {
      const body = {
        error: "Payment Required",
        message,
        accepts: payTo
          ? [{ scheme: "exact", network, maxAmountRequired: String(price), asset, payTo, resource }]
          : [],
        ...extra,
      };
      if (powEngine) body.proofOfWork = powEngine.challenge(resource);
      res.status(402).json(body);
    };

    // Free rail: proof-of-work.
    const powHeader = req.headers["x-pow-solution"];
    if (powEngine && powHeader) {
      const r = powEngine.verify(powHeader, resource);
      if (r.ok) { res.setHeader("X-Tollbooth-Paid", "pow"); return next(); }
      res.setHeader("X-Pow-Error", r.reason);
    }

    // Paid rail: x402 (USDC). Settlement verification is operator-supplied so
    // we reuse the standard, audited x402 stack rather than reinvent it.
    const payHeader = req.headers["x-payment"] || req.headers["payment-signature"];
    if (payTo && typeof verifyX402 === "function" && payHeader) {
      return Promise.resolve(verifyX402(req, { price, network, asset, payTo, resource }))
        .then((ok) => {
          if (ok) { res.setHeader("X-Tollbooth-Paid", "x402"); return next(); }
          send402();
        })
        .catch(() => { res.setHeader("X-Tollbooth-Error", "x402-verify-failed"); send402(); });
    }

    return send402();
  }

  tollbooth.shouldCharge = shouldCharge;
  tollbooth.pow = powEngine;
  return tollbooth;
}

/** Minimal reverse proxy: forward a request to `upstream`, streaming-safe-ish. */
export function createProxy(upstream) {
  return async (req, res) => {
    try {
      const target = new URL(req.originalUrl || req.url, upstream);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "connection" || lk === "content-length") continue;
        headers[k] = v;
      }
      const method = req.method;
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      const up = await fetch(target, { method, headers, body, redirect: "manual" });
      res.status(up.status);
      up.headers.forEach((val, key) => {
        const lk = key.toLowerCase();
        // fetch already decoded the body; drop hop-by-hop / length/encoding headers.
        if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lk)) return;
        res.setHeader(key, val);
      });
      res.send(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      res.status(502).json({ error: `tollbooth proxy failed: ${e.message}` });
    }
  };
}

function readBody(req, cap = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > cap) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startCli() {
  const upstream = process.env.TOLLBOOTH_UPSTREAM;
  const port = Number(process.env.PORT) || 4021;
  const { default: express } = await import("express");
  const app = express();
  const gate = createTollbooth({ resourceBaseUrl: process.env.TOLLBOOTH_RESOURCE_BASE || upstream || "" });
  app.use(gate);
  if (upstream) {
    app.use(createProxy(upstream));
  } else {
    app.use((_req, res) => res.json({ ok: true, note: "Bare tollbooth gate (no TOLLBOOTH_UPSTREAM set). Clients that reach here paid or solved a proof-of-work." }));
  }
  app.listen(port, () => {
    const rails = `${gate.pow ? "proof-of-work" : ""}${process.env.TOLLBOOTH_PAYTO ? (gate.pow ? " + x402(USDC)" : "x402(USDC)") : ""}`;
    console.log(`agent402-tollbooth listening on :${port} — charging AI bots via ${rails || "proof-of-work"}`);
    if (upstream) console.log(`  proxying → ${upstream}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startCli();
