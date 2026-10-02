#!/usr/bin/env node
// Every catalog tool's `category` is a key of CATEGORIES (src/pages.js).
//
// A tool whose category is not a key renders its raw string in the tool
// page's breadcrumb and links to /tools/category/<raw>, which 404s
// (categoryPage returns null for an unknown key). decide and decide-execute
// shipped with "agents" against the "agent" key.
//
// Offline half: the env-gated decide tools are built here directly (CI holds
// no decision service, so they are absent from a booted catalog). Booted half
// (TARGET_URL): every row of /api/pricing.
import { CATEGORIES, toolPage } from "../src/pages.js";
import { buildDecideTools } from "../src/tools/decide-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };

const stubLedger = new Proxy({}, { get: () => () => null });
const decide = buildDecideTools({ getCatalog: () => ({}), ledger: stubLedger });
ok(decide.length >= 2, "decide tools build offline");
for (const t of decide) ok(Object.hasOwn(CATEGORIES, t.category), `${t.slug}: category "${t.category}" is a CATEGORIES key`);

// decide-execute is offered on Base only (onlyNetworks); its page must say so.
const exec = decide.find((t) => t.slug === "decide-execute");
if (exec) {
  const [method, path] = exec.route.split(" ");
  const html = toolPage("https://agent402.tools", { ...exec, method, path, longRunning: true }, []);
  ok(!/USDC on (an EVM chain|EVM chains)/.test(html), "decide-execute's page does not offer USDC on any EVM chain");
  ok(/USDC on Base/.test(html), "decide-execute's page names Base, its only network");
  ok(html.includes('href="/tools/category/agent"'), "decide-execute's breadcrumb links a real category page");
}

const T = (process.env.TARGET_URL || "").replace(/\/$/, "");
if (T) {
  const j = await (await fetch(`${T}/api/pricing`)).json();
  const bad = (j.endpoints || []).filter((e) => e.category && !Object.hasOwn(CATEGORIES, e.category) && e.category !== "skill-pack");
  ok((j.endpoints || []).length > 100, "pricing lists the catalog");
  ok(bad.length === 0, `every served tool's category is a CATEGORIES key${bad.length ? `: ${bad.map((e) => `${e.slug}=${e.category}`).join(", ")}` : ""}`);
} else {
  console.log("(TARGET_URL unset: booted half skipped)");
}

console.log(`test-tool-categories: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
