// A tool page names MPP only when this server offers it. MPP rides the shim,
// which mounts only with MPP_SECRET_KEY; a self-host without the key offers
// x402 alone, and its pages must not tell a buyer to pay over a rail it lacks.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { toolPage } from "../src/pages.js";
import { glossaryPage } from "../src/glossary.js";
import { siteOrgLd, mppOffered } from "../src/site-org.js";

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
  // The site entity's knowsAbout reads the same switch as the page copy.
  const knows = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find((n) => n && n["@type"] === "Organization" && Array.isArray(n.knowsAbout))?.knowsAbout || [];
  ok(knows(on).includes("Machine Payments Protocol (MPP)") && knows(on).includes("x402"), `mpp on (${computePayable ? "free tier" : "wallet-only"}): the site entity knows about MPP`);
  ok(knows(off).includes("x402") && !knows(off).some((k) => /\bMPP\b|Machine Payments/.test(k)), `mpp off (${computePayable ? "free tier" : "wallet-only"}): the site entity's knowsAbout leaves MPP out`);
}
const dflt = toolPage("https://x.test", tool, [], {});
ok(/ or MPP/.test(dflt), "default (no option) keeps the hosted wording");

// One entity per @id: every page reads the server's MPP switch (mppOffered),
// so a tool page (which passes it explicitly, as the server does) and a page
// module that calls siteOrgLd(baseUrl) bare publish the same knowsAbout,
// with MPP_SECRET_KEY set and unset.
{
  const orgOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .flatMap((n) => (n && Array.isArray(n["@graph"]) ? n["@graph"] : [n]))
    .filter((n) => n && n["@id"] === "https://x.test/#organization");
  const saved = process.env.MPP_SECRET_KEY;
  try {
    for (const [label, key] of [["on", "k".repeat(32)], ["off", ""], ["blank", "   "]]) {
      process.env.MPP_SECRET_KEY = key;
      const want = label === "on";
      ok(mppOffered() === want, `MPP_SECRET_KEY ${label}: mppOffered reads ${want}`);
      const tp = orgOf(toolPage("https://x.test", tool, [], { mpp: mppOffered() }));
      const gp = orgOf(glossaryPage("https://x.test"));
      const lists = [...tp, ...gp].map((n) => JSON.stringify(n.knowsAbout || null));
      ok(tp.length >= 1 && gp.length >= 1 && new Set(lists).size === 1, `MPP ${label}: the tool page and the glossary page publish one knowsAbout for the site entity (${[...new Set(lists)].join(" | ")})`);
      ok(lists.every((l) => l.includes("Machine Payments Protocol (MPP)") === want), `MPP ${label}: knowsAbout ${want ? "names" : "leaves out"} MPP on both pages`);
      ok(siteOrgLd("https://x.test").knowsAbout.includes("Machine Payments Protocol (MPP)") === want, `MPP ${label}: siteOrgLd(baseUrl) with no option follows the switch`);
    }
  } finally {
    if (saved === undefined) delete process.env.MPP_SECRET_KEY; else process.env.MPP_SECRET_KEY = saved;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
