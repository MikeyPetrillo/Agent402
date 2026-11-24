// The server's version on its machine surfaces is package.json's: the OpenAPI
// document's info.version and the A2A agent card's version (both read
// src/server-version.js), so a directory never shows a release from months ago.
//   - SERVER_VERSION is package.json's version, and an unreadable file is 0.0.0;
//   - openapiSpec() reports it;
//   - server.js hands the same value to the agent card, with no literal version;
//   - the card builder carries the version it is given.
//
//   node scripts/test-server-version.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SERVER_VERSION, serverVersionFrom } from "../src/server-version.js";
import { openapiSpec } from "../src/pages.js";
import { buildOurAgentCard } from "../src/tools/a2a-card.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
ok(SERVER_VERSION === pkg, `SERVER_VERSION is package.json's version (${SERVER_VERSION})`);
const dir = mkdtempSync(join(tmpdir(), "server-version-"));
writeFileSync(join(dir, "bad.json"), "{");
writeFileSync(join(dir, "nover.json"), JSON.stringify({ version: "next" }));
ok(serverVersionFrom(pathToFileURL(join(dir, "missing.json"))) === "0.0.0", "a missing file reads 0.0.0");
ok(serverVersionFrom(pathToFileURL(join(dir, "bad.json"))) === "0.0.0" && serverVersionFrom(pathToFileURL(join(dir, "nover.json"))) === "0.0.0", "an unreadable file or a version that is not semver reads 0.0.0");

const spec = openapiSpec("https://agent402.tools", {});
ok(spec?.info?.version === pkg, `the OpenAPI document's info.version is ${pkg} (read ${spec?.info?.version})`);

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const cardCall = /buildOurAgentCard\(\{([\s\S]*?)\}\)/.exec(server);
ok(cardCall && /version: SERVER_VERSION/.test(cardCall[1]), "server.js gives the agent card SERVER_VERSION");
ok(cardCall && !/version: "\d/.test(cardCall[1]), "server.js gives the agent card no literal version");
const pages = readFileSync(new URL("../src/pages.js", import.meta.url), "utf8");
ok(!/info: \{[\s\S]{0,400}?version: "\d/.test(pages), "pages.js types no literal OpenAPI version");
const card = buildOurAgentCard({ baseUrl: "https://agent402.tools", version: SERVER_VERSION, toolCount: 1 });
ok(card.version === pkg, "the agent card carries the version it is given");

console.log(`\ntest-server-version: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
