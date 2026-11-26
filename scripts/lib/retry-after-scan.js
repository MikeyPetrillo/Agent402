// Every 429 the server answers carries Retry-After: a static scan of src/.
//
// A site is a line that answers or raises a 429: `.status(429)`,
// `writeHead(429`, `sendStatus(429)`, `statusCode = 429`, `statusCode: 429`,
// `status: 429` or `status = 429`. Its response path is the site's own line,
// the lines above it back to the last line that closes a block (at most
// LOOK_BACK lines), and the lines below it up to the statement that answers or
// throws, or the end of its block (at most LOOK_AHEAD lines: a chained
// `.set(...)`, or the fields set on an error before it is thrown).
// That path must name the header (`Retry-After`), set it through the shared
// helper (`limitedWithRetryAfter(`), or, for a thrown error or a returned
// refusal, carry a `retryAfter` field, which every error answer turns into the
// header (server.js sendToolError, the kit dispatcher, the admission catch;
// src/credits-account.js and src/mcp-oauth.js read their own refusal's field).
//
// ALLOW lists a 429 that is not ours to time: a relayed upstream status whose
// Retry-After is copied from the upstream. Each entry names its file, a text
// the site's line holds, and why.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const LOOK_BACK = 8;
export const LOOK_AHEAD = 30;
export const SITE = /\bbad\(.*,\s*429\s*\)|\.status\(\s*429\s*\)|writeHead\(\s*429\b|sendStatus\(\s*429\s*\)|\bstatusCode\s*(?:=(?!=)|:)\s*429\b|\bstatus\s*(?:=(?!=)|:)\s*429\b/;
// The header set by name (not the words "Retry-After" in a message), the shared
// helper, or a `retryAfter` field on the refusal.
export const EVIDENCE = /(?:set|setHeader|header|append)\(\s*["'`]Retry-After["'`]|["'`]Retry-After["'`]\s*:|limitedWithRetryAfter\(|spendRefusalFields\(|\bretryAfter\b\s*(?:[:=](?!=)|,|\s*\})/;
const BLOCK_END = /^\s*[})\]]+[;,)]*\s*$/;

export const ALLOW = [
  // None today: every 429 in src/ is one this server decides. A relayed
  // upstream 429 goes here as { file, text, why }: the line it is on and where
  // its upstream Retry-After is copied.
];
// Lines the pattern reads that answer nothing: a row of a table that describes
// a status. Each names why.
export const NOT_ANSWERS = [
  { file: "src/stable-error-code.js", text: 'status: 429, code: "rate_limited"', why: "the published error-code table's row for 429, not an answer" },
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "generated" || name === "node_modules") continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (/\.(m?js|cjs)$/.test(name)) yield p;
  }
}

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Every 429 site under `srcDir`: [{ file, line, text, ok, allowed }]. */
export function scan429(srcDir, root = srcDir) {
  const out = [];
  for (const file of files(srcDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (isComment(text) || !SITE.test(text.replace(/\/\/.*$/, ""))) continue;
      const rel = relative(root, file);
      const path = [text];
      for (let j = i - 1; j >= Math.max(0, i - LOOK_BACK); j--) {
        if (BLOCK_END.test(lines[j])) break;
        path.push(lines[j]);
      }
      if (!/\b(return|throw)\b/.test(text)) {
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + LOOK_AHEAD); j++) {
          if (BLOCK_END.test(lines[j])) break;
          path.push(lines[j]);
          if (/\b(return|throw)\b/.test(lines[j])) break;
        }
      }
      const evidence = path.some((l) => !isComment(l) && EVIDENCE.test(l));
      const allowed = ALLOW.find((a) => rel.endsWith(a.file) && text.includes(a.text)) || null;
      const notAnswer = NOT_ANSWERS.find((a) => rel.endsWith(a.file) && text.includes(a.text)) || null;
      out.push({ file: rel, line: i + 1, text: text.trim().slice(0, 160), ok: evidence, allowed, notAnswer });
    }
  }
  return out;
}
