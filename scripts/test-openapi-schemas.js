#!/usr/bin/env node
// Every operation in /openapi.json declares its request and its answer with a
// schema that compiles, and every published example matches its schema.
//
//   node scripts/test-openapi-schemas.js
//
// Boots FREE_MODE on port 0 and reads the live document. For each operation:
//   - a 2xx answer with content, each content type with a schema; a JSON
//     schema says something (a type with properties, items, a composition or
//     a $ref), never a bare `{ "type": "object" }`
//   - a body route (POST, PUT, PATCH) has a requestBody whose every content
//     type carries a non-empty schema
//   - a GET route of a catalog tool declares a query parameter for every
//     property of the tool's input schema (read through the hosted
//     connector's catalog.find, which serves each tool's inputSchema), so a
//     GET route with no query parameter is a tool that takes no input
//   - every schema (answers, bodies, parameters) compiles under JSON Schema
//     2020-12 (OpenAPI 3.1's dialect), with $refs into components resolved
//   - every example beside a schema validates against it
// A failure names the route, so a new tool without a schema fails here.
import "./lib/offline-stores.js";
import { createRequire } from "node:module";
import { bootServer } from "./lib/boot-server.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL: ${m}`); } };
const list = (a) => `${a.slice(0, 8).join("; ")}${a.length > 8 ? ` ... +${a.length - 8} more` : ""}`;

/** True when a schema states something a reader can use. */
export function saysSomething(schema, spec) {
  let s = schema, hops = 0;
  while (s && typeof s === "object" && s.$ref && hops++ < 10) {
    s = String(s.$ref).replace(/^#\//, "").split("/").reduce((o, k) => (o == null ? o : o[k]), spec);
  }
  if (!s || typeof s !== "object") return false;
  if (s.oneOf || s.anyOf || s.allOf || s.enum || "const" in s || s.items || s.prefixItems) return true;
  if (s.type === "object" || (Array.isArray(s.type) && s.type.includes("object"))) return !!(s.properties || s.additionalProperties || s.patternProperties);
  return typeof s.type === "string" || Array.isArray(s.type) || typeof s.format === "string";
}

const srv = await bootServer({ env: { FREE_MODE: "true", X402_SYNC_ON_START: "false", AGENT402_MCP_MAX_PER_MIN: "999999", AGENT402_MCP_MAX_PER_HOUR: "9999999" }, stores: "openapi-schemas" });
/** A catalog tool's input schema properties, through catalog.find; null when not found. */
async function inputPropsOf(slug) {
  const r = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog.find", arguments: { query: slug } } }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const out = JSON.parse(line ? line.slice(5) : t);
  const body = JSON.parse(out?.result?.content?.[0]?.text || "{}");
  const hit = (body.results || []).find((x) => x.slug === slug);
  return hit ? Object.keys(hit.inputSchema?.properties || {}) : null;
}
try {
  const spec = await (await fetch(`${srv.url}/openapi.json`)).json();
  const pricing = await (await fetch(`${srv.url}/api/pricing`)).json();
  ok(String(spec.openapi).startsWith("3.1"), `OpenAPI 3.1 (${spec.openapi})`);
  const toolByPath = new Map((pricing.endpoints || []).filter((e) => e.method === "GET").map((e) => [e.path, e]));

  const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
  addFormats(ajv);
  for (const k of ["example", "examples", "x-example-source", "discriminator", "xml", "externalDocs", "deprecated", "nullable"]) { try { ajv.addKeyword(k); } catch { /* already known */ } }
  ajv.addSchema({ $id: "openapi-components", components: spec.components || {} });
  const local = (s) => JSON.parse(JSON.stringify(s).replace(/"#\/components\//g, '"openapi-components#/components/'));

  const no2xx = [], noSchema = [], vague = [], noBody = [], missingParams = [], noInputGet = [], unread = [], compile = [], examples = [];
  let getTools = 0;
  let ops = 0, schemas = 0;
  const check = (where, schema, example) => {
    schemas++;
    let v;
    try { v = ajv.compile(local(schema)); } catch (e) { compile.push(`${where}: ${String(e.message).slice(0, 100)}`); return; }
    if (example !== undefined && !v(example)) examples.push(`${where}: ${ajv.errorsText(v.errors).slice(0, 140)}`);
  };
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== "object" || !op.responses) continue;
      ops++;
      const where = `${method.toUpperCase()} ${path}`;
      const okCode = Object.keys(op.responses).find((c) => /^2\d\d$/.test(c));
      const ok2 = okCode ? op.responses[okCode] : null;
      if (!ok2 || !ok2.content || !Object.keys(ok2.content).length) no2xx.push(where);
      for (const [code, r] of Object.entries(op.responses)) {
        for (const [type, c] of Object.entries(r?.content || {})) {
          if (!c.schema) { noSchema.push(`${where} ${code} ${type}`); continue; }
          if (/^2/.test(code) && /json/.test(type) && !saysSomething(c.schema, spec)) vague.push(`${where} ${code}`);
          check(`${where} ${code} ${type}`, c.schema, /json/.test(type) ? c.example : undefined);
        }
      }
      if (["post", "put", "patch"].includes(method)) {
        const content = op.requestBody?.content || {};
        if (!Object.keys(content).length) noBody.push(where);
        for (const [type, c] of Object.entries(content)) {
          if (!c.schema || !saysSomething(c.schema, spec)) noBody.push(`${where} ${type}`);
          else check(`${where} body ${type}`, c.schema, /json/.test(type) ? c.example : undefined);
        }
      }
      const params = op.parameters || [];
      for (const p of params) if (p.schema) check(`${where} param ${p.name}`, p.schema, p.example);
      if (method === "get") {
        const query = new Set(params.filter((p) => p.in === "query").map((p) => p.name));
        const tool = toolByPath.get(path);
        if (tool) {
          getTools++;
          const props = await inputPropsOf(tool.slug);
          if (props === null) { unread.push(where); continue; }
          const missing = props.filter((p) => !query.has(p));
          if (missing.length) missingParams.push(`${where}: ${missing.join(",")}`);
          if (!query.size && props.length) noInputGet.push(where);
        }
      }
    }
  }
  ok(ops > 400, `the document holds every route (${ops} operations, ${schemas} schemas)`);
  ok(no2xx.length === 0, `every operation declares a 2xx answer with content (${list(no2xx) || "all"})`);
  ok(noSchema.length === 0, `every answer content type carries a schema (${list(noSchema) || "all"})`);
  ok(vague.length === 0, `every JSON success schema says something beyond a bare object (${list(vague) || "all"})`);
  ok(noBody.length === 0, `every body route declares a request schema (${list(noBody) || "all"})`);
  ok(getTools > 20 && unread.length === 0, `every GET tool's input schema was read (${getTools} tools; unread: ${list(unread) || "none"})`);
  ok(missingParams.length === 0, `every GET tool declares a query parameter per input property (${list(missingParams) || "all"})`);
  ok(noInputGet.length === 0, `a GET with no query parameter takes no input (${list(noInputGet) || "all"})`);
  ok(compile.length === 0, `every schema compiles under JSON Schema 2020-12 (${list(compile) || "all"})`);
  ok(examples.length === 0, `every published example matches its schema (${list(examples) || "all"})`);
  // A control: the check catches what it is for.
  ok(!saysSomething({ type: "object" }, spec) && saysSomething({ type: "object", properties: { a: { type: "string" } } }, spec) && !saysSomething(undefined, spec), "control: a bare object schema is caught, a described one passes");
} finally { await srv.stop(); }

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
