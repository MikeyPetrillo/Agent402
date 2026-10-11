// The hosted tollbooth offer (its plans, white-label dashboard and referral
// program) is retired. This guard keeps it retired everywhere a reader meets
// it, not only on the route that served it:
//   1. offline: no served-page source, README, wiki page or tollbooth/ doc
//      offers it or links to its retired URLs (dated changelog history may
//      name it in plain text, never as a link);
//   2. offline: the operator leads page and its reads are gone (no module, no
//      link from the operator dashboard, no list/count/insert export);
//   3. booted: GET /tollbooth/cloud and GET /tollbooth/waitlist answer 301 to
//      /tollbooth, POST /api/tollbooth/waitlist answers 410 and stores
//      nothing, /tollbooth and the sitemap carry no retired link, and
//      GET /__operator/leads answers 404 with or without the operator token.
//   The boot step that drops the stored rows is tested against a real
//   Postgres in scripts/test-leads-purge-pg.js.
//
//   node scripts/test-tollbooth-cloud-retired.js
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// What "offering it" looks like in text.
const OFFER = [
  [/tollbooth\s+cloud/i, "names the hosted tollbooth product"],
  [/tollbooth\/(?:cloud|waitlist)/i, "links a retired tollbooth URL"],
  [/partner[\s-]+program/i, "offers the partner program"],
  [/white[\s-]?label/i, "offers white-label"],
  [/\bcloud\s+(?:solo|team|agency|enterprise)\b/i, "names a hosted plan"],
  [/\b(?:solo|team|agency)\s+plans?\b/i, "names a hosted plan"],
];
// Control: every pattern fires on the sentence the /tollbooth banner used to carry.
const OLD_BANNER = "Managing multiple sites? Multi-site rollup, white-label dashboard, 20% partner program. <a href=\"/tollbooth/cloud\">Tollbooth Cloud</a> Cloud Team, Agency plan";
ok(OFFER.every(([re]) => re.test(OLD_BANNER)), "control: every offer pattern fires on the retired banner copy");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const TEXT = /\.(?:js|mjs|cjs|md|txt|php|json|html|toml|ya?ml)$/;
// Files that may still mention the retired surfaces, and why:
//   server.js answers the retired URLs (301/410); leads-db.js drops the
//   table the intake wrote and says the intake is closed;
//   changelog.js is dated history (checked separately below).
const ALLOW = new Set(["src/server.js", "src/leads-db.js", "src/changelog.js"]);
const files = [
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "wiki")),
  ...walk(join(ROOT, "tollbooth")),
  ...walk(join(ROOT, "docs")),
  ...walk(join(ROOT, "mcp")),
  ...walk(join(ROOT, "openclaw")),
  ...walk(join(ROOT, "adapters")),
  ...walk(join(ROOT, "client")),
  ...walk(join(ROOT, "assets")).filter((p) => !p.includes(`${join("assets", "samples")}`)),
  join(ROOT, "README.md"),
].filter((p) => TEXT.test(p) && existsSync(p));
ok(files.length > 100, `scanned the served sources and docs (${files.length} files)`);
const hits = [];
for (const f of files) {
  const rel = relative(ROOT, f).split("\\").join("/");
  if (ALLOW.has(rel)) continue;
  const src = readFileSync(f, "utf8");
  for (const [re, why] of OFFER) {
    const m = src.match(re);
    if (m) hits.push(`${rel}: ${why} ("${m[0]}")`);
  }
}
ok(hits.length === 0, `no page source, README, wiki or tollbooth doc offers the retired hosted product${hits.length ? `:\n  ${hits.join("\n  ")}` : ""}`);
const changelog = readFileSync(join(ROOT, "src/changelog.js"), "utf8");
ok(!/tollbooth\/(?:cloud|waitlist)/i.test(changelog), "changelog history names it only in plain text, never as a link to a retired URL");
for (const f of ["src/tollbooth-cloud.js", "src/tollbooth-waitlist.js", "assets/js/tollbooth-waitlist.js"]) {
  ok(!existsSync(join(ROOT, f)), `${f} is removed`);
}

// --- operator leads page and its reads are gone -----------------------------
{
  ok(!existsSync(join(ROOT, "src/operator-leads.js")), "src/operator-leads.js is removed");
  const op = readFileSync(join(ROOT, "src/operator.js"), "utf8");
  ok(!/__operator\/leads/.test(op), "the operator dashboard carries no leads link");
  const srv = readFileSync(join(ROOT, "src/server.js"), "utf8");
  ok(!/__operator\/leads/.test(srv) && !/operator-leads/.test(srv), "server.js mounts no /__operator/leads route");
  const leads = readFileSync(join(ROOT, "src/leads-db.js"), "utf8");
  ok(!/export (?:async )?function (?:insertLead|listLeads|countLeads)\b/.test(leads), "leads-db.js exports no insert, list or count");
  ok(!/CREATE\s+TABLE/i.test(leads), "leads-db.js never creates the table");
}

// --- booted: the routes ------------------------------------------------------
const TOKEN = "tbcloud-retired-test-operator-token-0123456789";
const PORT = await getFreePort();
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off", AGENT402_OPERATOR_TOKEN: TOKEN };
delete env.DATABASE_URL;
delete env.STATE_DATABASE_URL;
let childLog = "";
const child = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => { childLog += d; });
child.stderr.on("data", (d) => { childLog += d; });
const done = (code) => { try { child.kill("SIGKILL"); } catch { /* */ } process.exit(code); };
try {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  ok(up, "server boots");
  if (!up) { console.error(childLog.slice(-3000)); done(1); }

  for (const p of ["/tollbooth/cloud", "/tollbooth/waitlist", "/tollbooth/waitlist?plan=agency"]) {
    const r = await fetch(base + p, { redirect: "manual" });
    ok(r.status === 301 && /\/tollbooth$/.test(r.headers.get("location") || ""), `GET ${p} answers 301 to /tollbooth (got ${r.status} ${r.headers.get("location")})`);
  }
  const post = await fetch(`${base}/api/tollbooth/waitlist`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Fixture", email: "fixture@example.invalid", plan: "team" }),
  });
  const pj = await post.json().catch(() => ({}));
  ok(post.status === 410 && pj.ok === false && pj.error === "gone", `POST /api/tollbooth/waitlist answers 410 gone (got ${post.status} ${JSON.stringify(pj)})`);
  ok(!("id" in pj), "the 410 carries no stored-row id");

  const landing = await (await fetch(`${base}/tollbooth`)).text();
  ok(!OFFER.some(([re]) => re.test(landing)), "/tollbooth offers no hosted plan, white-label or partner program");
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  ok(sitemap.includes("/tollbooth<") && !/tollbooth\/(?:cloud|waitlist)/.test(sitemap), "sitemap lists /tollbooth and no retired URL");
  const llms = await (await fetch(`${base}/llms.txt`)).text();
  ok(!OFFER.some(([re]) => re.test(llms)), "llms.txt offers none of it");

  const anon = await fetch(`${base}/__operator/leads`);
  ok(anon.status === 404, `unauthenticated /__operator/leads answers 404 (got ${anon.status})`);
  const authed = await fetch(`${base}/__operator/leads`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const ah = await authed.text();
  ok(authed.status === 404 && !/Tollbooth leads/.test(ah), `authed /__operator/leads answers 404 like any unknown operator path (got ${authed.status})`);
  // Control: the same token opens a live operator page, so the 404 is the route, not the auth.
  const live = await fetch(`${base}/__operator/wishes`, { headers: { authorization: `Bearer ${TOKEN}` } });
  ok(live.status === 200, `control: the token opens /__operator/wishes (got ${live.status})`);
  if (authed.status !== 404 || live.status !== 200) console.error(childLog.slice(-3000));
} catch (e) {
  ok(false, `booted checks threw: ${e.message}`);
}
console.log(`\ntest-tollbooth-cloud-retired: ${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
