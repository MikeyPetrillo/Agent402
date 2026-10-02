// A tool page names MPP only when this server offers it. MPP rides the shim,
// which mounts only with MPP_SECRET_KEY; a self-host without the key offers
// x402 alone, and its pages must not tell a buyer to pay over a rail it lacks.
import { toolPage } from "../src/pages.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const tool = { slug: "hash", name: "Hash", path: "/api/hash", method: "POST", price: "$0.001", category: "encoding", description: "Hash text.", tags: ["hash"], discovery: { inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, input: { text: "a" }, output: { example: { hash: "x" } } } };

for (const computePayable of [true, false]) {
  const on = toolPage("https://x.test", tool, [], { computePayable, mpp: true });
  const off = toolPage("https://x.test", tool, [], { computePayable, mpp: false });
  ok(/over x402[^.<]{0,60} or MPP/.test(on), `mpp on (${computePayable ? "free tier" : "wallet-only"}): the page offers MPP`);
  // The site nav links the MPP ecosystem pages on every page; the claim that
  // matters is in the head (meta, JSON-LD offer) and the page's own <main>.
  const own = off.slice(0, off.indexOf("</head>")) + off.slice(off.indexOf("<main"), off.indexOf("</main>"));
  ok(!/\bMPP\b/.test(own), `mpp off (${computePayable ? "free tier" : "wallet-only"}): the page never names MPP`);
}
const dflt = toolPage("https://x.test", tool, [], {});
ok(/ or MPP/.test(dflt), "default (no option) keeps the hosted wording");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
