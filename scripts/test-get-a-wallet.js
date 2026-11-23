#!/usr/bin/env node
// Every served page that shows an AGENT_KEY placeholder (a key the reader is
// told to paste) also shows where to get one: the /start#fund link and the
// `agent402-mcp wallet new` command (src/get-a-wallet.js).
//
//   node scripts/test-get-a-wallet.js     (boots its own FREE_MODE server on port 0)
//
// Pages are read from the sitemap, as served, so a new page with a placeholder
// is held to the rule with no list to update here.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { bootServer } from "./lib/boot-server.js";
import { stripScripts, stripTags } from "./lib/html-text.js";
import { GET_A_WALLET_HREF, WALLET_NEW_COMMAND, getWalletHtml, getWalletMarkdown } from "../src/get-a-wallet.js";

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// A placeholder key: AGENT_KEY=0x<WORDS or ...> or "AGENT_KEY": "0x<WORDS>".
const PLACEHOLDER = /AGENT_KEY(?:=|"?\s*:\s*")0x(?:[A-Z_]{3,}|\.\.\.|<[^>]*>)/;
const text = (html) => stripTags(stripScripts(html)).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/⁠/g, "");
const carries = (html) => html.includes(`href="${GET_A_WALLET_HREF}"`) && text(html).includes(WALLET_NEW_COMMAND);

ok(PLACEHOLDER.test('claude mcp add agent402 -e AGENT_KEY=0xYOUR_FUNDED_KEY -- npx') && PLACEHOLDER.test('"env": { "AGENT_KEY": "0xYOUR_PRIVATE_KEY" }') && PLACEHOLDER.test("AGENT_KEY=0x... node") && !PLACEHOLDER.test("AGENT_KEY is read from the keychain"),
  "control: the placeholder forms are matched, a plain mention is not");
ok(carries(`<p>${getWalletHtml()}</p>`) && !carries("<p>Fund it.</p>") && getWalletMarkdown("https://x.test").includes(`(https://x.test${GET_A_WALLET_HREF})`),
  "control: the shared step carries the link and the command");
ok(/^npx -y agent402-mcp@\d+\.\d+\.\d+ wallet new$/.test(WALLET_NEW_COMMAND), `the command is pinned to the package version (${WALLET_NEW_COMMAND})`);

const srv = await bootServer({ env: { FREE_MODE: "true" }, stores: "get-a-wallet" });
try {
  const map = await (await fetch(`${srv.url}/sitemap.xml`)).text();
  // Tool and skill pages carry no install lines; every other page is read.
  const paths = [...new Set([...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname))]
    .filter((p) => !/^\/(?:tools|skills|reports\/sample|markets?|chains?|sellers?|compare)\//.test(p));
  paths.push("/quickstart", "/how-to-pay", "/docs", "/start");
  let shown = 0;
  const bare = [];
  for (const p of [...new Set(paths)]) {
    const r = await fetch(srv.url + p);
    if (r.status !== 200 || !/html/.test(r.headers.get("content-type") || "")) continue;
    const html = await r.text();
    if (!PLACEHOLDER.test(text(html))) continue;
    shown++;
    if (!carries(html)) bare.push(p);
  }
  ok(shown >= 4, `pages with an AGENT_KEY placeholder are found (${shown} of ${paths.length} read)`);
  ok(bare.length === 0, `every page with an AGENT_KEY placeholder shows where to get a wallet${bare.length ? ` (missing: ${bare.join(", ")})` : ""}`);
} finally {
  await srv.stop();
}
console.log(`\ntest-get-a-wallet: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
