// The private credits table (src/credits-guards.js): purchase checks, card
// review signals, the automatic fraud-warning refund day total and the
// connector sign-in's limits are read only from CREDITS_GUARDS_JSON or
// CREDITS_GUARDS_FILE, with no defaults in code.
//   - the format example loads and holds exactly the keys the loader needs
//   - missing or incomplete: credit sales and the connector sign-in stay off,
//     the status word reads attention while a switch asks for the table, and
//     a checkout started anyway answers a generic 503
//   - raw JSON and base64 both load
//   - no source, doc or rule file states a threshold or signal the table holds,
//     and the variables that used to hold them are gone everywhere
//
//   node scripts/test-credits-guards.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { guardsTable, useGuardsTable } from "./lib/credits-guards-table.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const G = await import("../src/credits-guards.js");
const S = await import("../src/credits-sales.js");
const table = guardsTable();

// ---- the format example ---------------------------------------------------------------
{
  const keep = process.env.CREDITS_GUARDS_JSON;
  delete process.env.CREDITS_GUARDS_JSON;
  process.env.CREDITS_GUARDS_FILE = join(ROOT, "docs/example-credits-guards.json");
  ok(G.creditsGuardsState() === "ok", "docs/example-credits-guards.json loads as a complete table");
  const ex = JSON.parse(readFileSync(join(ROOT, "docs/example-credits-guards.json"), "utf8"));
  const keys = Object.entries(ex).filter(([k]) => k !== "_readme").flatMap(([s, o]) => Object.keys(o).map((k) => `${s}.${k}`)).sort();
  ok(JSON.stringify(keys) === JSON.stringify([...G.CREDITS_GUARD_KEYS].sort()), `the example holds exactly the loader's keys (${keys.length})`);
  delete process.env.CREDITS_GUARDS_FILE;
  process.env.CREDITS_GUARDS_JSON = Buffer.from(keep).toString("base64");
  ok(G.creditsGuardsState() === "ok" && G.creditsGuards().purchase.buyerPerHour === table.purchase.buyerPerHour, "a base64 table loads the same values");
  process.env.CREDITS_GUARDS_JSON = keep;
}

// ---- missing or incomplete: nothing is sold -----------------------------------------------
{
  process.env.CREDITS_SALES = "on"; process.env.MCP_OAUTH = "on";
  ok(S.creditsSalesEnabled() && S.creditsConnectorOn() && G.creditsGuardsWord(true) === "ok", "control: with the table and the switches on, sales and the connector are on (status ok)");
  const keep = process.env.CREDITS_GUARDS_JSON;
  delete process.env.CREDITS_GUARDS_JSON;
  ok(G.creditsGuardsState() === "missing" && !S.creditsSalesEnabled() && !S.creditsConnectorOn(), "table missing: CREDITS_SALES=on sells nothing and the connector sign-in is off");
  ok(S.purchaseChecks() === null && S.mcpOAuthGuards() === null, "table missing: no purchase check or sign-in limit is read from anywhere else");
  ok(G.creditsGuardsWord(true) === "attention", "table missing: the status word reads attention while a switch asks for the table");
  ok(G.creditsGuardsWord(false) === "ok", "table missing, neither switch on: the status word reads ok (a deployment that sells no credits never pages)");
  const partial = structuredClone(table); delete partial.mcpOAuth.badTokenMax;
  process.env.CREDITS_GUARDS_JSON = JSON.stringify(partial);
  ok(G.creditsGuardsState() === "partial" && !S.creditsSalesEnabled() && G.creditsGuardsWord(true) === "attention", "a table missing one key is partial: nothing is sold, the word reads attention");
  process.env.CREDITS_GUARDS_JSON = "not json";
  ok(G.creditsGuardsState() === "partial" && !S.creditsSalesEnabled(), "a table that does not parse sells nothing");
  // A checkout started without the table (a stale page, a direct call) answers a generic 503.
  delete process.env.CREDITS_GUARDS_JSON;
  const dir = mkdtempSync(join(tmpdir(), "guards-"));
  const { createCredits } = await import("../src/credits.js");
  const cr = createCredits({ stripe: { checkout: { sessions: { create: async () => ({ id: "cs_x", url: "https://checkout.stripe.com/x" }) } } }, baseUrl: "https://agent402.tools", storeDir: dir, log: () => {} });
  let e = null; try { await cr.createCheckout("credits-5", { email: "g@x.com", ip: "192.0.2.1" }); } catch (x) { e = x; }
  ok(e?.statusCode === 503 && e.buyerSafe && !/table|guard|check|limit|\d/i.test(e.message), `table missing: a checkout answers a generic 503 (${e?.statusCode})`);
  rmSync(dir, { recursive: true, force: true });
  process.env.CREDITS_GUARDS_JSON = keep;
  delete process.env.CREDITS_SALES; delete process.env.MCP_OAUTH;
}

// ---- the word on a booted server: ok without the switches, attention with one and no table ----
{
  const { bootServer } = await import("./lib/boot-server.js");
  for (const [label, env, want] of [
    ["neither switch, no table", { CREDITS_SALES: "", MCP_OAUTH: "", CREDITS_GUARDS_JSON: "", CREDITS_GUARDS_FILE: "" }, "ok"],
    ["CREDITS_SALES on, no table", { CREDITS_SALES: "on", MCP_OAUTH: "", CREDITS_GUARDS_JSON: "", CREDITS_GUARDS_FILE: "" }, "attention"],
    ["MCP_OAUTH on, no table", { CREDITS_SALES: "", MCP_OAUTH: "on", CREDITS_GUARDS_JSON: "", CREDITS_GUARDS_FILE: "" }, "attention"],
    ["CREDITS_SALES on, table complete", { CREDITS_SALES: "on", MCP_OAUTH: "" }, "ok"],
  ]) {
    const srv = await bootServer({ stores: `guards-${want}-${label.length}`, env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", ...env } });
    try {
      const w = (await (await fetch(`${srv.url}/api/gateway-status`)).json()).creditsGuards?.status;
      ok(w === want, `${label}: /api/gateway-status creditsGuards reads ${want} (${w})`);
    } finally { await srv.stop(); }
  }
}

// ---- nothing public states what the table holds -----------------------------------------------
{
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === "generated" ? [] : walk(p)) : [p]; });
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "docs")), ...walk(join(ROOT, "wiki")), ...walk(join(ROOT, ".claude")), join(ROOT, "CLAUDE.md"), join(ROOT, "README.md")].filter((f) => /\.(js|md|json)$/.test(f));
  const GONE = /\b(CREDITS_(BUYER|SOURCE)_(HOUR|DAY)_MAX|CREDITS_FAILED_(MAX|WINDOW_MS|HOLD_MS)|CREDITS_EFW_AUTO_REFUND_DAY_MAX_USD|MCP_OAUTH_(EMAIL_CODE_TRIES|CODE_SENDS_PER_(EMAIL|IP)|CODE_FAILS_PER_EMAIL|LOCKOUT_MINUTES|TOKEN_PER_IP|AUTHORIZE_PER_IP|REGISTER_PER_IP|LIMIT_WINDOW_MINUTES))\b/;
  const named = files.filter((f) => GONE.test(readFileSync(f, "utf8"))).map((f) => f.slice(ROOT.length + 1));
  ok(named.length === 0, `no source, doc or rule names a variable that used to hold a threshold${named.length ? `: ${named.join(", ")}` : ""}`);
  const src = files.filter((f) => f.includes(`${join(ROOT, "src")}/`));
  const signal = src.filter((f) => /["']manual_review["']|risk_level\s*===\s*["']|type\s*===\s*["']blocked["']/.test(readFileSync(f, "utf8"))).map((f) => f.slice(ROOT.length + 1));
  ok(signal.length === 0, `no source file names a card review signal a purchase is refused on${signal.length ? `: ${signal.join(", ")}` : ""}`);
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const guardsSrc = strip(readFileSync(join(ROOT, "src/credits-guards.js"), "utf8"));
  ok(!/\b[1-9]\d*\b/.test(guardsSrc.replace(/\\u0000/g, "")), "src/credits-guards.js holds no number but zero (no defaults)");
  const sales = strip(readFileSync(join(ROOT, "src/credits-sales.js"), "utf8"));
  const fnBody = (t, name) => { const i = t.indexOf(`export const ${name}`); return i < 0 ? "" : t.slice(i, t.indexOf("};", i)); };
  ok(!/\d/.test(fnBody(sales, "purchaseChecks")) && !/\d/.test(fnBody(sales, "mcpOAuthGuards")), "purchaseChecks and mcpOAuthGuards hold no number");
  const oauth = strip(readFileSync(join(ROOT, "src/mcp-oauth.js"), "utf8"));
  const lim = oauth.slice(oauth.indexOf("emailCodeTries:"), oauth.indexOf("documentMaxBytes:") + 60);
  ok(lim.length > 60 && !/\d/.test(lim), "the connector sign-in's limits hold no number in code");
  const credits = strip(readFileSync(join(ROOT, "src/credits.js"), "utf8"));
  const efw = credits.slice(credits.indexOf("const efwDayMaxCents"), credits.indexOf("\n", credits.indexOf("const efwDayMaxCents")));
  ok(efw && !/[1-9]/.test(efw.replace(/100/g, "")), "the automatic fraud-warning day total has no default in code");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
