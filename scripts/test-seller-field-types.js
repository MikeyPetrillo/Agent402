// A crawled seller listing (parsed JSON) can carry a number, an object, an
// array or null where a string belongs (name, slug, description, category, route, tags,
// aliases). Routing reads those fields as text; a non-string name threw
// `(t.name || "").toLowerCase is not a function` and the uncaught exception
// took the whole server down. Every shape here must route without throwing,
// and the well-formed seller beside them must still be found.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { routeQuery, _cacheForTests } from "../src/x402-index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const cache = _cacheForTests(); cache.clear();
const tool = (origin, over) => ({ seller: origin, method: "POST", route: "/api/ocr", slug: "ocr", name: "ocr", description: "ocr a thing", category: "vision", tags: ["ocr"], price: 0.003, ...over });
const seed = (origin, over) => cache.set(origin, { manifest: { name: origin, homepage: origin }, openapiSummary: null, tools: [tool(origin, over)], fetchedAt: Date.now(), error: null, history: [1, 1, 1, 1, 1] });
const shapes = {
  "a number name": { name: 404 },
  "an object name": { name: { en: "ocr" } },
  "an array name": { name: ["ocr"] },
  "a number slug": { slug: 7 },
  "an object description": { description: { text: "ocr" } },
  "a number category": { category: 5 },
  "a string of tags": { tags: "ocr,vision" },
  "tags holding objects": { tags: [{ t: "ocr" }, null, 3] },
  "a number route": { route: 12 },
  "aliases holding objects": { aliases: [{ a: 1 }, "ocr-alt"] },
};
let i = 0;
for (const over of Object.values(shapes)) seed(`https://odd-${i++}.example`, over);
seed("https://good.example", {});
const ctx = { baseUrl: "https://agent402.tools", catalog: {}, prices: {} };

let r = null, err = null;
try { r = routeQuery({ query: "ocr a thing", top: 50, include: "external", ...ctx }); } catch (e) { err = e; }
ok(!err, `a route query over sellers with ${Object.keys(shapes).length} non-text field shapes answers (${err ? err.message : "no throw"})`);
ok(r?.results?.some((x) => x.seller === "https://good.example"), "the well-formed seller beside them is still found");
console.log(`\ntest-seller-field-types: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
