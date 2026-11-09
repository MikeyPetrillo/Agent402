// The content-pipeline guide and its wiki page name the stages that take x402
// exact on EVM chains only (and no Tempo) from the code that decides it
// (isLongRunningSlug), never a typed list; the guide's stage list is its
// stage table. Offline.
import "./lib/offline-stores.js";
import { readFileSync } from "node:fs";
const { guidePage, evmOnlyStagesText, PIPELINE_STAGE_SLUGS } = await import("../src/guides.js");
const { isLongRunningSlug } = await import("../src/composite-spend-guard.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../src/guides.js", import.meta.url), "utf8");
const table = src.slice(src.indexOf('slug: "content-pipeline"'));
const tableSlugs = [...table.slice(0, table.indexOf("## Set up once")).matchAll(/^\| [^|]+ \| ([^|]+) \|/gm)]
  .flatMap((m) => [...m[1].matchAll(/\\`([a-z0-9-]+)\\`/g)].map((x) => x[1]));
ok(tableSlugs.length > 10 && JSON.stringify(tableSlugs) === JSON.stringify(PIPELINE_STAGE_SLUGS), `PIPELINE_STAGE_SLUGS is the stage table, in order (${tableSlugs.join(",")})`);

const longOnes = PIPELINE_STAGE_SLUGS.filter((s) => isLongRunningSlug(s));
ok(longOnes.length > 0, `some stages are long-running (${longOnes.join(", ")})`);
const text = evmOnlyStagesText(PIPELINE_STAGE_SLUGS);
ok(longOnes.every((s) => text.includes(`\`${s}\``)) && PIPELINE_STAGE_SLUGS.filter((s) => !isLongRunningSlug(s)).every((s) => !text.includes(`\`${s}\``)), `the derived list names exactly the long-running stages: ${text}`);

const html = String(guidePage("https://x.test", "content-pipeline") || "").replace(/\s+/g, " ");
const htmlList = text.replace(/`([a-z0-9-]+)`/g, "<code>$1</code>");
ok(html.includes(`${htmlList} run long enough that they take x402 exact on EVM chains only`), "the guide's chain sentence renders the derived list");
ok(html.includes(`Tempo is offered on every stage except ${htmlList}.`), "the guide's Tempo sentence renders the derived list");
ok(!/\{\{evmOnly:/.test(html), "no token is left unrendered");

const wiki = readFileSync(new URL("../wiki/Content-Pipeline.md", import.meta.url), "utf8");
ok(wiki.includes(`**Chains.** ${text} are long-running`) && wiki.includes(`**Tempo.** Offered on every stage except ${text} (`), "the wiki page names the same stages");

let threw = null;
try { evmOnlyStagesText(["answer", "tts"]); } catch (e) { threw = e; }
ok(threw, "a token naming no long-running route is an error, not an empty sentence");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
