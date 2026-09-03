// House style for everything a person reads: no em dashes, no en dashes.
//
// Every report body is model-written, and the models reach for "—" in
// headings and prose no matter what the prompt says. This is the one place
// the rule is enforced, applied to every report tier's output at the catalog
// (server.js wraps each REPORT_TIERS handler), so agents, card buyers,
// monitors and the sample pages all read the same style. A heading's dash
// becomes a colon ("NVIDIA CORP (NVDA): Company Due-Diligence Dossier"),
// prose gets a spaced hyphen, a bare range "2024–2026" a plain hyphen.
const DASH = /[—–\u2212]/;
const RANGE = /(\d)\s*[—–]\s*(\d)/g;

export function houseStyleText(s, { heading = false } = {}) {
  if (typeof s !== "string" || !DASH.test(s)) return s;
  let out = s.replace(/\u2212/g, "-").replace(RANGE, "$1-$2");
  out = out.replace(/\s*[—–]+\s*/g, heading ? ": " : " - ");
  return out.replace(/ {2,}/g, " ");
}

export function houseStyleMarkdown(md) {
  if (typeof md !== "string") return md;
  const deduped = dropModelTitle(md);
  if (!DASH.test(deduped)) return deduped;
  return deduped.split("\n").map((line) => houseStyleText(line, { heading: /^#{1,6}\s/.test(line) })).join("\n");
}

// Every report kit writes its own H1 header and then the model writes ANOTHER
// H1 (and often a subtitle H2) at the top of its prose - the AAPL filing and
// JUP token samples both opened with two titles (2026-08-28). A second H1
// inside the first 1,500 characters is that re-title: drop it, and drop an H2
// that immediately follows it before any body text (the model's subtitle).
// Anything later in the document is content and is never touched. Exported
// for tests.
export function dropModelTitle(md) {
  if (typeof md !== "string" || !md.startsWith("# ")) return md;
  const lines = md.split("\n");
  let seenH1 = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lines.slice(0, i).join("\n").length > 1500) break;
    if (!/^#\s/.test(line)) continue;
    if (!seenH1) { seenH1 = true; continue; }
    // second H1: remove it and a directly following subtitle H2 (blank lines between allowed)
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const end = j < lines.length && /^##\s/.test(lines[j]) ? j + 1 : i + 1;
    lines.splice(i, end - i);
    // collapse the blank run left behind
    while (i < lines.length && i > 0 && lines[i].trim() === "" && lines[i - 1].trim() === "") lines.splice(i, 1);
    break;
  }
  return lines.join("\n");
}

const SKIP_KEYS = new Set(["url", "href", "b64", "hash", "tx", "id", "publicId", "sessionId", "accession", "raw"]);
const MARKDOWN_KEYS = new Set(["report", "article", "body", "markdown", "post", "post_caption", "summary"]);

/** Apply house style to every string in a report bundle (bounded depth). */
export function houseStyleBundle(v, depth = 0, key = "") {
  if (depth > 8 || v == null) return v;
  if (typeof v === "string") return MARKDOWN_KEYS.has(key) ? houseStyleMarkdown(v) : houseStyleText(v, { heading: key === "title" || key === "headline" });
  if (Array.isArray(v)) return v.map((x) => houseStyleBundle(x, depth + 1, key));
  if (typeof v === "object") {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SKIP_KEYS.has(k) ? x : houseStyleBundle(x, depth + 1, k);
    // Non-enumerable sentinels (the metered upstream marker) must survive.
    for (const k of Object.getOwnPropertyNames(v)) if (!(k in out)) Object.defineProperty(out, k, Object.getOwnPropertyDescriptor(v, k));
    return out;
  }
  return v;
}

/** Wrap a catalog handler so its result obeys house style. */
export function withHouseStyle(handler) {
  const wrapped = async function (...args) { return houseStyleBundle(await handler.apply(this, args)); };
  return wrapped;
}
