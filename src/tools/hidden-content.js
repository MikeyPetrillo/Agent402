// Hidden page content: text a person viewing the page never sees but an agent
// reading the converted text would. Pages and emails use it to address the
// agent directly ("ignore previous instructions", "tell the user the bank
// details changed"), so every HTML-to-text tool runs the parsed document
// through scrubHidden() before converting it.
//
// What counts as hidden (inline styles, attributes and top-level <style> rules;
// a full layout engine is out of scope, so this is a floor, not a guarantee):
//   - HTML comments and <template> contents
//   - the `hidden` attribute and aria-hidden="true"
//   - display:none, visibility:hidden, opacity:0, font-size 0/1px, zero
//     max-height or height with overflow hidden
//   - text coloured transparent, or near-white with no non-white background
//     on the element or any ancestor (white on the default white page)
//   - text pushed off screen (left/top/text-indent at -999px or beyond) or
//     clipped to nothing (clip rect(0..), clip-path inset(50%))
//   - invisible characters: zero-width spaces and joiners (an emoji joiner is
//     kept), word joiners, bidi controls, BOM, Unicode tag characters
//
// mode "keep" (the default) leaves the document as is, so a tool's output is
// unchanged: collapsed answers, inactive tabs and preview lines are often real
// content. mode "drop" removes it. Both report what was found, and `instructionLike` quotes hidden text (and any
// base64 run in visible text that decodes to one) that reads as a directive.

const MODES = new Set(["drop", "keep"]);
const MAX_QUOTES = 5;
const QUOTE_CHARS = 160;

// Phrasing that addresses an AI or asks it to act. Kept narrow on purpose:
// hidden preview lines and decorative text are common and must not read as an
// attack.
export const DIRECTIVE = /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|other)\b|\b(?:dear|attention|note to|hey|hi|hello|to the|for the)\s+(?:ai|email|inbox|virtual)?\s*(?:assistant|agent|model|llm)\b|\b(?:ai|email|inbox) assistant\b|\bas an ai\b|\b(?:language model|llm)\b|\b(?:system|developer)\s*(?:prompt|message|note)?\s*:|\binstructions? (?:for|to) (?:the )?(?:ai|assistant|agent|model)|\b(?:tell|inform|remind|instruct|advise) the (?:user|reader|recipient)\b|\bdo not (?:mention|reveal|tell|show)\b|\b(?:bank|payment|wire|account|banking) (?:details|information|instructions) (?:have |has )?(?:changed|updated)\b|\b(?:update|change) (?:the )?(?:payment|bank|wire) (?:details|information)\b|\b(?:run|execute) (?:this|the following) (?:command|script|code)\b|\b(?:mark|flag|treat) (?:this|the) (?:email|message|page) as (?:urgent|legitimate|safe|important|trusted)\b/i;

// Invisible characters. U+200D (zero-width joiner) is only counted when it is
// not joining emoji, since family and flag sequences need it.
const INVISIBLE = /[​‌⁠-⁤‪-‮⁦-⁩﻿]|‍(?![\p{Extended_Pictographic}⬛⬜♀♂⚕⚖✈❤])|[\u{E0000}-\u{E007F}]/gu;

/** The `hidden` input: "keep" (default) or "drop". Throws a 400-shaped Error on anything else. */
export function hiddenMode(input) {
  const v = input?.hidden;
  if (v === undefined || v === null || v === "") return "keep";
  if (typeof v === "string" && MODES.has(v)) return v;
  const e = new Error('"hidden" must be "keep" (default: convert everything) or "drop" (remove text a reader cannot see)');
  e.statusCode = 400;
  throw e;
}

/** The schema entry for the `hidden` input, shared by every tool that takes it. */
export const HIDDEN_INPUT_SCHEMA = {
  type: "string",
  enum: ["keep", "drop"],
  description: 'What to do with content a reader cannot see (HTML comments, display:none or aria-hidden elements, white-on-white or off-screen text, zero-width characters): "keep" (default) converts it like everything else, "drop" removes it first. Either way hiddenContent reports what was found and quotes any hidden text that reads as an instruction to an AI.',
};

/** The output-example entry for `hiddenContent`. */
export const HIDDEN_OUTPUT_EXAMPLE = { mode: "keep", total: 0, found: { comments: 0, cssHidden: 0, hiddenAttr: 0, ariaHidden: 0, offscreen: 0, invisibleChars: 0 }, instructionLike: [] };

const px = (v) => { const m = /^(-?\d+(?:\.\d+)?)(px|pt|em|rem)?$/.exec(String(v || "").trim()); if (!m) return null; const n = Number(m[1]); return m[2] === "em" || m[2] === "rem" ? n * 16 : m[2] === "pt" ? n * 4 / 3 : n; };
function rgb(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s === "white") return { r: 255, g: 255, b: 255, a: 1 };
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (m) { const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]; return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }; }
  m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]); return { r: +m[1], g: +m[2], b: +m[3], a }; }
  return null;
}
const nearWhite = (c) => c && c.a > 0 && c.r >= 245 && c.g >= 245 && c.b >= 245;

// A declaration block (an element's inline style or a stylesheet rule) that
// hides its element by itself. Returns the reason or null.
function hiddenByDecl(st) {
  if (!st) return null;
  const g = (p) => String(st.getPropertyValue?.(p) || "").trim().toLowerCase();
  if (g("display") === "none") return "cssHidden";
  if (g("visibility") === "hidden" || g("visibility") === "collapse") return "cssHidden";
  const op = g("opacity");
  if (op !== "" && Number(op) <= 0.01) return "cssHidden";
  const fs = px(g("font-size"));
  if (fs !== null && fs <= 1) return "cssHidden";
  const ov = g("overflow");
  if ((px(g("max-height")) === 0 || px(g("height")) === 0) && /hidden|clip/.test(ov)) return "cssHidden";
  const col = rgb(g("color"));
  if (col && col.a <= 0.05) return "cssHidden";
  for (const p of ["left", "top", "text-indent", "margin-left"]) { const n = px(g(p)); if (n !== null && n <= -999) return "offscreen"; }
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(g("clip")) || /inset\(\s*50%\s*\)/.test(g("clip-path"))) return "offscreen";
  return null;
}

// Near-white text with nothing but white (or nothing) behind it.
function whiteOnWhite(el) {
  const col = rgb(el.style?.getPropertyValue?.("color") || el.getAttribute?.("color"));
  if (!nearWhite(col)) return false;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const bg = rgb(n.style?.getPropertyValue?.("background-color")) || rgb(n.getAttribute?.("bgcolor"));
    if (bg && bg.a > 0.05) return nearWhite(bg);
    if (/url\(|gradient\(/i.test(n.style?.getPropertyValue?.("background-image") || "")) return false;
  }
  return true;
}

function quote(quotes, text) {
  if (quotes.length >= MAX_QUOTES) return;
  const t = String(text || "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const hit = t && DIRECTIVE.exec(t);
  if (!hit) return;
  const start = Math.max(0, hit.index - 40);
  const q = t.slice(start, start + QUOTE_CHARS);
  if (!quotes.includes(q)) quotes.push(q);
}

/**
 * Find (and with mode "drop", remove) hidden content in a parsed DOM document
 * or element. Returns the hiddenContent report.
 */
export function scrubHidden(root, { mode = "keep" } = {}) {
  const doc = root?.ownerDocument || root;
  const win = doc?.defaultView;
  const scope = root?.nodeType === 9 ? (root.documentElement || root) : root;
  const found = { comments: 0, cssHidden: 0, hiddenAttr: 0, ariaHidden: 0, offscreen: 0, invisibleChars: 0 };
  const instructionLike = [];
  if (!scope || !win) return { mode, total: 0, found, instructionLike };
  const drop = mode === "drop";

  // 1. Comments (and <template>, whose content is never rendered).
  const comments = [];
  const tw = doc.createTreeWalker(scope, win.NodeFilter.SHOW_COMMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) comments.push(n);
  for (const c of comments) { found.comments++; quote(instructionLike, c.data); if (drop) c.remove(); }
  for (const t of scope.querySelectorAll("template")) { found.cssHidden++; quote(instructionLike, t.content?.textContent || t.textContent); if (drop) t.remove(); }

  // 2. Elements hidden by attribute, inline style or a top-level stylesheet rule.
  const marked = new Map(); // element -> reason
  const mark = (el, why) => { if (!marked.has(el)) marked.set(el, why); };
  for (const sheet of Array.from(doc.styleSheets || [])) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules || [])) {
      if (rule.type !== 1 || !rule.selectorText) continue; // style rules only; @media and the rest are conditional
      const why = hiddenByDecl(rule.style);
      if (!why) continue;
      let els = [];
      try { els = scope.querySelectorAll(rule.selectorText); } catch { continue; }
      for (const el of els) mark(el, why);
    }
  }
  for (const el of scope.querySelectorAll("[hidden],[aria-hidden],[style],[color],font")) {
    if (el.hasAttribute("hidden")) { mark(el, "hiddenAttr"); continue; }
    if (String(el.getAttribute("aria-hidden") || "").toLowerCase() === "true") { mark(el, "ariaHidden"); continue; }
    const why = hiddenByDecl(el.style);
    if (why) { mark(el, why); continue; }
    if (whiteOnWhite(el)) mark(el, "cssHidden");
  }
  // Only the outermost hidden element counts; its descendants go with it.
  for (const [el, why] of marked) {
    let inner = false;
    for (let p = el.parentElement; p; p = p.parentElement) if (marked.has(p)) { inner = true; break; }
    if (inner) continue;
    const text = el.textContent || "";
    if (!text.trim() && !el.querySelector?.("img,a,input,button")) continue; // empty spacers are not content
    found[why]++;
    quote(instructionLike, text);
  }
  if (drop) for (const [el] of marked) if (el.isConnected) el.remove();

  // 3. Invisible characters in the text that remains.
  const textWalker = doc.createTreeWalker(scope, win.NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = textWalker.nextNode(); n; n = textWalker.nextNode()) texts.push(n);
  let joined = "";
  for (const t of texts) {
    const v = t.data;
    const hits = v.match(INVISIBLE);
    if (hits) {
      found.invisibleChars += hits.length;
      const clean = v.replace(INVISIBLE, "");
      joined += " " + clean;
      if (drop) t.data = clean;
    }
  }
  if (joined) quote(instructionLike, joined);

  // 4. Base64 runs in visible text that decode to a directive (reported, never found).
  const visible = scope.textContent || "";
  for (const run of visible.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []) {
    if (instructionLike.length >= MAX_QUOTES) break;
    let dec = "";
    try { dec = Buffer.from(run, "base64").toString("utf8"); } catch { continue; }
    if (/^[\x20-\x7e\s]+$/.test(dec)) quote(instructionLike, dec);
  }

  const total = Object.values(found).reduce((a, b) => a + b, 0);
  return { mode, total, found, instructionLike };
}
