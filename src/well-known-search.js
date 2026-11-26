// The site search endpoint at /.well-known/search: an agent that knows only
// the site's origin asks it for tools by task and gets the catalog's own
// ranked answer.
//
//   GET   /.well-known/search?q=<task>[&limit=N]   (`k` and `top`, the names
//                               /api/find and /api/route take, read as `limit`)
//   QUERY /.well-known/search   body: text/plain "<task>" or
//                               application/json {"q":"<task>","limit":N}
//
// Everything that decides the answer is /api/find's: the same ranking, the
// same answer cache, the same per-client search limits and the same miss
// rule (a weak match records a wish unless the operator's token is on the
// request). This module only reads the request, hands the task to the
// /api/find serving path that server.js passes in, and reshapes that path's
// JSON into the search answer (or a Markdown list for Accept: text/markdown).
//
// The body is bounded before any parse: a Content-Length over
// SEARCH_BODY_MAX_BYTES is refused 413 unread, and a body sent without a
// length stops at the same bound inside the parser.
import express from "express";
import { FIND_TOP_MAX } from "./find.js";
import { clampFields } from "./partial-answer.js";
import { WELL_KNOWN_SEARCH_PATH, SEARCH_ALLOW } from "./well-known-search-path.js";

export { WELL_KNOWN_SEARCH_PATH, SEARCH_ALLOW, SEARCH_ADVERTISED_METHODS } from "./well-known-search-path.js";
/** findTools reads at most 500 characters of a task; this many bytes holds
 *  that as UTF-8 text, or as JSON with every character escaped, plus a limit. */
export const SEARCH_BODY_MAX_BYTES = 4096;

const usage = (baseUrl) => ({
  error: "missing-query",
  detail: "Send the task to search for as q.",
  usage: [
    `GET ${baseUrl}${WELL_KNOWN_SEARCH_PATH}?q=<task>&limit=<1-${FIND_TOP_MAX}>`,
    `QUERY ${baseUrl}${WELL_KNOWN_SEARCH_PATH} with a text/plain body holding the task, or application/json {"q":"<task>","limit":5}`,
  ],
  markdown: "Send Accept: text/markdown for a Markdown list of the same results.",
});

const BODY_TYPES = /^\s*(?:application\/json|text\/plain)\s*(?:;|$)/i;
const jsonParser = express.json({ limit: SEARCH_BODY_MAX_BYTES, type: "application/json", strict: true });
const textParser = express.text({ limit: SEARCH_BODY_MAX_BYTES, type: "text/plain" });

/** A caller value read as text: a string as it is, a number as its digits,
 *  anything else (an object, an array) as nothing. */
const textOf = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/**
 * Mounted before the global body parsers: refuses an unsupported method (405
 * with Allow), an oversized body (413, unread when it states its length) and
 * a QUERY body of another type (415), and parses the two accepted types
 * within SEARCH_BODY_MAX_BYTES. A parse error is answered here, so nothing
 * past this reads a search body.
 */
export function wellKnownSearchBodyGate() {
  return function searchBodyGate(req, res, next) {
    if (req.path !== "/" && req.path !== "") return next();
    const m = req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "QUERY" && m !== "OPTIONS") {
      res.set("Allow", SEARCH_ALLOW);
      return res.status(405).json({ error: "method-not-allowed", allow: SEARCH_ALLOW });
    }
    if (m !== "QUERY") return next();
    const len = Number(req.headers["content-length"]);
    if (Number.isFinite(len) && len > SEARCH_BODY_MAX_BYTES) {
      res.set("Connection", "close");
      return res.status(413).json({ error: "body-too-large", maxBytes: SEARCH_BODY_MAX_BYTES });
    }
    const type = String(req.headers["content-type"] || "");
    const hasBody = (Number.isFinite(len) && len > 0) || req.headers["transfer-encoding"] !== undefined;
    if (hasBody && !BODY_TYPES.test(type.slice(0, 256))) {
      return res.status(415).json({ error: "unsupported-media-type", accept: ["text/plain", "application/json"] });
    }
    const parser = /^\s*application\/json/i.test(type.slice(0, 256)) ? jsonParser : textParser;
    return parser(req, res, (err) => {
      if (!err) return next();
      const status = err.status === 413 || err.type === "entity.too.large" ? 413 : 400;
      if (status === 413) res.set("Connection", "close");
      return res.status(status).json(status === 413
        ? { error: "body-too-large", maxBytes: SEARCH_BODY_MAX_BYTES }
        : { error: "unreadable-body", detail: "A JSON body is an object with q, a text body is the task itself." });
    });
  };
}

/** The task and the row cap from either verb. */
export function searchInputOf(req) {
  if (req.method === "QUERY") {
    const b = req.body;
    if (typeof b === "string") return { q: b.trim(), limit: undefined };
    if (b && typeof b === "object" && !Array.isArray(b)) {
      return { q: textOf(b.q ?? b.query ?? b.task).trim(), limit: textOf(b.limit ?? b.k ?? b.top) || undefined };
    }
    return { q: "", limit: undefined };
  }
  const qs = req.query || {};
  return { q: textOf(qs.q ?? qs.query ?? qs.task).trim(), limit: textOf(qs.limit ?? qs.k ?? qs.top) || undefined };
}

/** One find answer as the search answer: the ranked rows with the fields an
 *  agent calls from, and the partial-answer fields as find counted them. */
export function searchAnswerOf(find, { limit, baseUrl }) {
  const rows = Array.isArray(find?.results) ? find.results : [];
  const results = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    price: r.price,
    priceUsd: r.priceUsd,
    route: r.route,
    callExample: r.callExample,
    score: r.score,
    ...(r.docs ? { docs: r.docs } : {}),
    ...(r.weak ? { weak: true } : {}),
  }));
  return {
    query: find?.query ?? "",
    count: results.length,
    returned: find?.returned ?? results.length,
    matched: find?.matched ?? results.length,
    complete: find?.complete ?? true,
    truncated: find?.truncated ?? false,
    topMax: FIND_TOP_MAX,
    ...clampFields(limit, FIND_TOP_MAX, "limit"),
    results,
    ...(find?.weakMatches ? { weakMatches: true } : {}),
    ...(find?.hint ? { hint: find.hint } : {}),
    full: `${baseUrl}/api/find?q=${encodeURIComponent(String(find?.query ?? ""))}`,
  };
}

// Markdown: every character that can open markup is escaped, and line breaks
// in tool text become spaces, so a row is always one list item.
const MD_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~&]/g;
export const mdText = (s) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(MD_SPECIAL, (c) => `\\${c}`);
/** A code span whose fence is longer than any backtick run inside it. */
export function mdCode(s) {
  const t = String(s ?? "").replace(/[\r\n]+/g, " ");
  let longest = 0, run = 0;
  for (const ch of t) { if (ch === "`") { run++; if (run > longest) longest = run; } else run = 0; }
  const fence = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

export function searchMarkdownOf(answer) {
  const lines = [`# Tool search: ${mdText(answer.query)}`, ""];
  if (!answer.results.length) lines.push("No tool matches this task.");
  answer.results.forEach((r, i) => {
    lines.push(`${i + 1}. **${mdText(r.name)}** (${mdCode(r.slug)}), ${mdText(r.price)}, ${mdCode(r.route)}`);
    if (r.description) lines.push(`   ${mdText(r.description)}`);
    if (r.callExample) lines.push(`   Example: ${mdCode(JSON.stringify(r.callExample))}`);
  });
  lines.push("", `${answer.returned} of ${answer.matched} matching tools${answer.truncated ? " (more with a higher limit)" : ""}.`);
  if (answer.hint) lines.push("", mdText(answer.hint));
  return `${lines.join("\n")}\n`;
}

/**
 * The route handler. `serveFind(req, res, { q, k })` is the /api/find
 * serving path (cache, limits, compute and miss rule); its JSON is reshaped
 * on the way out. Refusals it answers (429, 503) pass through unchanged.
 */
export function wellKnownSearchHandler({ serveFind, baseUrl }) {
  return function wellKnownSearch(req, res) {
    const m = req.method;
    if (m !== "GET" && m !== "HEAD" && m !== "QUERY") {
      res.set("Allow", SEARCH_ALLOW);
      return res.status(405).json({ error: "method-not-allowed", allow: SEARCH_ALLOW });
    }
    res.vary("Accept");
    const { q, limit } = searchInputOf(req);
    if (!q) return res.status(400).json(usage(baseUrl));
    const markdown = req.accepts(["application/json", "text/markdown"]) === "text/markdown";
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode !== 200 || !body || !Array.isArray(body.results)) return json(body);
      const answer = searchAnswerOf(body, { limit, baseUrl });
      if (markdown) return res.type("text/markdown; charset=utf-8").send(searchMarkdownOf(answer));
      return json(answer);
    };
    return serveFind(req, res, { q, k: limit });
  };
}
