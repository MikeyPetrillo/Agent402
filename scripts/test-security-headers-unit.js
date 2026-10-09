// src/security-headers.js: the document-only headers (CSP, frame, permissions,
// cross-domain policy) ride every page, stay off a JSON answer under /api, /v1
// and /mcp, and come back on an API path the moment its answer is HTML. The
// last case is the one a path-only skip would miss: a page added under /api
// later would ship without a CSP and nothing would say so. Drives the real
// middleware in a throwaway Express app with the four answer shapes.
import express from "express";
import { securityHeaders, headIsHtml } from "../src/security-headers.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DOC = ["content-security-policy", "x-frame-options", "permissions-policy", "x-permitted-cross-domain-policies"];
const ALWAYS = ["x-content-type-options", "strict-transport-security", "referrer-policy"];

const app = express();
app.use(securityHeaders());
app.get("/page", (_req, res) => res.type("html").send("<p>page</p>"));
app.get("/api/json", (_req, res) => res.json({ ok: true }));
app.get("/api/page", (_req, res) => res.type("html").send("<p>api page</p>"));
app.get("/v1/page-writehead", (_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<p>v1</p>"); });
app.get("/mcp", (_req, res) => res.json({ ok: true }));
app.get("/mcp/text", (_req, res) => res.type("text/plain").send("plain"));
app.get("/apix", (_req, res) => res.json({ ok: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const head = async (p) => (await fetch(base + p)).headers;
const allDoc = (h) => DOC.every((k) => h.get(k));
const noDoc = (h) => DOC.every((k) => !h.get(k));
const always = (h) => ALWAYS.every((k) => h.get(k));

let h = await head("/page");
ok(allDoc(h) && always(h), "a page carries every security header");
h = await head("/api/json");
ok(noDoc(h) && always(h), "a JSON answer under /api carries only the always-on headers");
h = await head("/mcp");
ok(noDoc(h) && always(h), "/mcp itself (no trailing slash) is an API path");
h = await head("/mcp/text");
ok(noDoc(h) && always(h), "a non-HTML text answer under /mcp carries no document headers");
h = await head("/api/page");
ok(allDoc(h) && always(h), "an HTML answer under /api carries every document header");
h = await head("/v1/page-writehead");
ok(allDoc(h) && always(h), "an HTML answer written with writeHead(status, headers) under /v1 carries them too");
h = await head("/apix");
ok(allDoc(h), "/apix is not an API path (prefix needs a slash)");
ok(/default-src 'self'/.test((await head("/api/page")).get("content-security-policy")), "the API-path CSP is the page CSP");

const fake = { getHeader: () => "application/json" };
ok(headIsHtml(fake, [200, { "content-type": "TEXT/HTML; charset=utf-8" }]), "headIsHtml reads a header object passed to writeHead, any case");
ok(!headIsHtml(fake, [200, "OK", ["content-type", "text/html"]]), "headIsHtml ignores a non-object argument");
ok(!headIsHtml({ getHeader: () => "text/htmlish" }, [200]), "headIsHtml needs a word boundary after text/html");

server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
