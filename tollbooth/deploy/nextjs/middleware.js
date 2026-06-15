// Drop-in Next.js middleware: open pay-per-crawl at the edge (works on Vercel).
// Copy this file to your Next.js project root as `middleware.js` (or
// `middleware.ts`), then: npm i agent402-tollbooth
//
// Humans pass through; AI crawlers get a 402 and must pay (USDC via x402) or
// solve a free proof-of-work. The gate is built on Web Crypto + Fetch, so it
// runs in Vercel's Edge runtime with no Node dependencies.
import { NextResponse } from "next/server";
import { createEdgeTollbooth } from "agent402-tollbooth/edge";

// A stable secret is REQUIRED at the edge (PoW tokens are HMAC-signed and must
// verify across stateless invocations). Set TOLLBOOTH_SECRET in your Vercel
// project env (Settings → Environment Variables) — any long random string.
// If it's missing we fail OPEN (let everyone through) rather than 500 the whole
// site — including your human visitors. The warning makes the misconfig loud.
const gate = process.env.TOLLBOOTH_SECRET
  ? createEdgeTollbooth({
      secret: process.env.TOLLBOOTH_SECRET,
      payTo: process.env.TOLLBOOTH_PAYTO || null, // optional: advertise a USDC x402 quote
      price: process.env.TOLLBOOTH_PRICE || "$0.001",
      network: process.env.TOLLBOOTH_NETWORK || "base",
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
  return (await gate(request)) ?? NextResponse.next();
}

// Charge crawlers everywhere except Next internals and static assets. Narrow
// this to the paths you actually want to meter (e.g. ["/articles/:path*"]).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
