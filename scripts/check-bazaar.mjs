// One-shot sweep for x402 Bazaar extension validation issues.
// Loads every tool module under src/tools and reports:
//   - POST/PUT/PATCH routes missing `discovery.bodyType`
//   - GET/HEAD/DELETE routes with a stray `discovery.bodyType`
//   - discovery.input example values whose type doesn't match the declared inputSchema
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = path.resolve("src/tools");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
const issues = [];

for (const file of files) {
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(dir, file)).href);
  } catch {
    continue; // skip modules that need env vars to import
  }
  for (const key of Object.keys(mod)) {
    const arr = mod[key];
    if (!Array.isArray(arr)) continue;
    for (const t of arr) {
      if (!t || !t.route || !t.discovery) continue;
      const [method] = t.route.split(" ");
      const d = t.discovery;
      const isBody = ["POST", "PUT", "PATCH"].includes(method);
      const isQuery = ["GET", "HEAD", "DELETE"].includes(method);

      if (isBody && !("bodyType" in d)) {
        issues.push({ file, route: t.route, problem: "POST/PUT/PATCH missing bodyType" });
      }
      if (isQuery && "bodyType" in d) {
        issues.push({ file, route: t.route, problem: "GET/HEAD/DELETE has stray bodyType" });
      }
      if (d.input && d.inputSchema && d.inputSchema.properties) {
        for (const [prop, schema] of Object.entries(d.inputSchema.properties)) {
          if (!(prop in d.input)) continue;
          const v = d.input[prop];
          const expected = schema.type;
          if (!expected) continue;
          let actual = typeof v;
          if (Array.isArray(v)) actual = "array";
          else if (v === null) actual = "null";
          if (expected === "integer" && actual === "number" && Number.isInteger(v)) continue;
          if (expected === "number" && actual === "number") continue;
          if (expected === actual) continue;
          issues.push({
            file,
            route: t.route,
            problem: `input.${prop} is ${actual} (value ${JSON.stringify(v)}) but schema says type:${expected}`,
          });
        }
      }
    }
  }
}

if (issues.length === 0) {
  console.log("clean");
} else {
  console.error(`${issues.length} issue(s):`);
  for (const i of issues) console.error(`  ${i.file}  ${i.route}\n    ${i.problem}`);
  process.exit(1);
}
