// Drop-in Next.js middleware: open pay-per-crawl at the edge (works on Vercel).
// Copy this file to your Next.js project root as `middleware.js` (or
// `middleware.ts`), then: npm i agent402-tollbooth
//
// Humans pass through; AI crawlers get a 402 and must pay (USDC via x402) or
// solve a free proof-of-work. The gate is built on Web Crypto + Fetch, so it
// runs in Vercel's Edge runtime with no Node dependencies.
//
// OBSERVE-ONLY: set TOLLBOOTH_OBSERVE="true" to *measure* bot traffic for a
// week without ever returning 402 — every request still gets classified and
// counted, but they all pass through. Flip the env var back to undefined to
// start enforcing. The dashboard counters (wouldCharge) show what would have
// been charged.
//
// DURABLE STATS on Vercel: edge middleware runs across cold-starting isolates
// so in-memory counters are useless across instances. To survive that, point
// `statsSink` at a shared store — e.g. httpStatsSink(VERCEL_KV_REST_URL, ...)
// or a tiny route handler that proxies to Vercel KV / Upstash. See
// app/__tollbooth/stats/route.js below.
import { NextResponse } from "next/server";
import { createEdgeTollbooth, httpStatsSink } from "agent402-tollbooth/edge";

// A stable secret is REQUIRED at the edge (PoW tokens are HMAC-signed and must
// verify across stateless invocations). Set TOLLBOOTH_SECRET in your Vercel
// project env (Settings → Environment Variables) — any long random string.
// If it's missing we fail OPEN (let everyone through) rather than 500 the whole
// site — including your human visitors. The warning makes the misconfig loud.
const statsSink = process.env.TOLLBOOTH_STATS_URL
  ? httpStatsSink(process.env.TOLLBOOTH_STATS_URL, { token: process.env.TOLLBOOTH_STATS_TOKEN })
  : undefined; // falls back to per-isolate in-memory (fine for dev)

const gate = process.env.TOLLBOOTH_SECRET
  ? createEdgeTollbooth({
      secret: process.env.TOLLBOOTH_SECRET,
      payTo: process.env.TOLLBOOTH_PAYTO || null, // optional: advertise a USDC x402 quote
      price: process.env.TOLLBOOTH_PRICE || "$0.001",
      network: process.env.TOLLBOOTH_NETWORK || "base",
      observe: process.env.TOLLBOOTH_OBSERVE === "true",
      statsSink,
      // Note: serverless edge invocations don't share memory, so proof-of-work
      // replay protection is best-effort here. For strict single-use, pass a
      // `store` backed by a durable KV (e.g. Vercel KV / Upstash).
    })
  : null;

export async function middleware(request) {
  if (!gate) {
    console.warn("agent402-tollbooth: TOLLBOOTH_SECRET is not set — pay-per-crawl is DISABLED (failing open). Set it in your env to start charging crawlers.");
    return NextResponse.next();
  }
  const blocked = await gate(request);
  // Best-effort: flush buffered stats while the isolate is still alive. On
  // Vercel Edge there's no waitUntil hook here, so this awaits inline.
  try { await gate.flush(); } catch {}
  return blocked ?? NextResponse.next();
}

// Charge crawlers everywhere except Next internals, static assets, AND the
// tollbooth's own stats/dashboard routes (so the dashboard is always reachable
// and never tries to gate itself).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|__tollbooth).*)"],
};

// ---- companion route handler (drop into app/__tollbooth/stats/route.js) ----
//
//   // app/__tollbooth/stats/route.js — JSON stats for the dashboard.
//   // Uses Vercel KV (or Upstash) as the shared counter; see sinks.js for the
//   // delta-log format. This route is the *snapshot* side; the middleware is
//   // the *writer* side via httpStatsSink → TOLLBOOTH_STATS_URL pointing here.
//   import { NextResponse } from "next/server";
//   import { kv } from "@vercel/kv";
//
//   export const runtime = "edge";
//
//   // Whitelist of known counters. The POST body is attacker-controlled (anyone
//   // who knows the URL + token can call it), so NEVER interpolate the raw
//   // field name into the KV key — that'd let a misbehaving caller pollute
//   // the namespace with arbitrary keys (e.g. "../" or "rm -rf"). Also clamp
//   // deltas to non-negative integers so they can't be used to zero out
//   // a real counter or write floats.
//   const FIELDS = ["requests", "freeAllowed", "wouldCharge", "charged", "powSolved", "x402Paid"];
//
//   function ctEq(a, b) {           // constant-time compare on the bearer token
//     a = String(a || ""); b = String(b || "");
//     if (a.length !== b.length) return false;
//     let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
//     return r === 0;
//   }
//
//   export async function POST(req) {
//     const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
//     if (!ctEq(auth, process.env.TOLLBOOTH_STATS_TOKEN)) {
//       return new NextResponse("unauthorized", { status: 401 });
//     }
//     const { incr = {} } = await req.json();
//     await Promise.all(FIELDS
//       .filter((f) => Number(incr[f]) > 0)
//       .map((f) => kv.incrby(`tb:stats:${f}`, Math.max(0, Math.floor(Number(incr[f]))))));
//     return NextResponse.json({ ok: true });
//   }
//
//   export async function GET() {
//     const values = await kv.mget(...FIELDS.map((f) => `tb:stats:${f}`));
//     return NextResponse.json(Object.fromEntries(FIELDS.map((f, i) => [f, Number(values[i] || 0)])));
//   }
//
// And drop in app/__tollbooth/page.jsx (or pages/__tollbooth.jsx):
//   import { dashboardHtml } from "agent402-tollbooth/dashboard.js";
//   export const dynamic = "force-static";
//   export default function Page() { return <div dangerouslySetInnerHTML={{__html: dashboardHtml()}} />; }
