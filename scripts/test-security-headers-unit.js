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
// Answers a browser could open as a document, and the inert data types that
// keep the lean set (media, downloads, a stream whose head is flushed first).
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
app.get("/api/svg", (_req, res) => res.type("image/svg+xml").send(SVG));
app.get("/v1/xml", (_req, res) => res.type("application/xml").send("<a/>"));
app.get("/mcp/xhtml", (_req, res) => { res.writeHead(200, { "Content-Type": "application/xhtml+xml" }); res.end("<html/>"); });
app.get("/api/untyped", (_req, res) => { res.removeHeader("content-type"); res.end("x"); });
app.get("/api/own-csp", (_req, res) => res.set("Content-Security-Policy", "default-src 'none'").type("image/svg+xml").send(SVG));
const INERT = {
  "/api/problem": "application/problem+json", "/api/text": "text/plain", "/api/mp3": "audio/mpeg", "/api/mp4": "video/mp4",
  "/api/png": "image/png", "/api/webp": "image/webp", "/api/pdf": "application/pdf", "/api/zip": "application/zip",
  "/api/docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "/api/xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "/api/bin": "application/octet-stream", "/api/csv": "text/csv",
};
for (const [p, t] of Object.entries(INERT)) app.get(p, (_req, res) => res.type(t).send(Buffer.from("x")));
app.get("/api/sse", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.flushHeaders(); res.write("data: 1\n\n"); setTimeout(() => res.end(), 20); });
app.get("/api/sse-svg-stream", (_req, res) => { res.setHeader("Content-Type", "image/svg+xml"); res.flushHeaders(); res.write(SVG); setTimeout(() => res.end(), 20); });
app.get("/api/empty", (_req, res) => res.status(204).end());
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

const SANDBOX = "default-src 'none'; sandbox";
for (const p of ["/api/svg", "/v1/xml", "/mcp/xhtml", "/api/untyped", "/api/sse-svg-stream"]) {
  h = await head(p);
  ok(h.get("content-security-policy") === SANDBOX && h.get("x-content-type-options") === "nosniff" && !h.get("x-frame-options"),
    `${p} (${h.get("content-type") || "no type"}) carries the sandboxed policy and nosniff (${h.get("content-security-policy")})`);
}
ok((await head("/api/own-csp")).get("content-security-policy") === "default-src 'none'", "a route's own policy on an API path is left as it is");
for (const p of [...Object.keys(INERT), "/api/sse", "/api/empty", "/api/json", "/mcp/text"]) {
  h = await head(p);
  ok(noDoc(h) && always(h), `${p} (${h.get("content-type") || "no type"}) keeps the lean set, no policy`);
}
ok(!(await head("/page")).get("content-security-policy").includes("sandbox"), "a page keeps the site policy");

const fake = { getHeader: () => "application/json" };
ok(headIsHtml(fake, [200, { "content-type": "TEXT/HTML; charset=utf-8" }]), "headIsHtml reads a header object passed to writeHead, any case");
ok(!headIsHtml(fake, [200, "OK", ["content-type", "text/html"]]), "headIsHtml ignores a non-object argument");
ok(!headIsHtml({ getHeader: () => "text/htmlish" }, [200]), "headIsHtml needs a word boundary after text/html");

server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
