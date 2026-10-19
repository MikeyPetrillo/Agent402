// Hidden page content: text a person viewing the page never sees but an agent
// reading the converted text would. Pages and emails use it to address the
// agent directly ("ignore previous instructions", "tell the user the bank
// details changed"), so every HTML-to-text tool runs the parsed document
// through scrubHidden() before converting it.
//
// What counts as hidden (inline styles, attributes and top-level <style> rules;
// a full layout engine is out of scope, so this is a floor, not a guarantee):
//   - HTML comments anywhere in the document, and <template> contents
//   - the `hidden` attribute
//   - display:none, visibility:hidden, opacity:0, font-size 2px or less,
//     transform scale(0), zero height/width (or max-) with overflow hidden
//   - text coloured transparent, or near-white with no non-white background
//     on the element or any ancestor (inline, bgcolor/background attribute, or
//     a style rule that sets one)
//   - text pushed off screen (left/top/text-indent/margin-left at -500px or
//     beyond) or clipped to nothing (clip rect(0..), clip-path inset(50%))
//   - invisible characters: zero-width spaces and joiners (an emoji joiner is
//     kept), word joiners, BOM, Unicode tag characters (decoded for quoting)
// aria-hidden is NOT hidden: it hides from screen readers, not from sight.
// Bidi direction marks are not counted: right-to-left text uses them.
// Directive text in attributes an agent may read but a person rarely sees
// (alt, title, aria-label, data-*, <meta> content) is quoted and counted as
// `attributes`; the attribute stays in place.
//
// mode "keep" (the default) leaves the document as is, so a tool's output is
// unchanged: collapsed answers, inactive tabs and preview lines are often real
// content. mode "drop" removes it. Both report what was found, and
// `instructionLike` quotes hidden text (and any base64 run or tag-character
// run that decodes to one) that reads as a directive.

const MODES = new Set(["drop", "keep"]);
const MAX_QUOTES = 5;
const QUOTE_CHARS = 160;
// Matching a style rule's selector visits every element, so the stylesheet
// step is bounded by element visits, not rule count: a page with many hiding
// rules and many elements cannot hold the thread. Rules past the budget are
// not checked, and the report says so (styleRuleCoverage).
const RULE_VISIT_BUDGET = 1_000_000;
const MAX_RULES = 200;
// Background rules consulted for white text. Each check is a selector match
// against an ancestor, so the total is bounded by BG_MATCH_BUDGET (results are
// remembered per element); past it, white text whose background is unknown is
// not counted and the report says the check was incomplete.
const MAX_BG_RULES = 50;
const BG_MATCH_BUDGET = 200_000;

// Phrasing that addresses an AI or asks it to act. Kept narrow on purpose:
// hidden preview lines and decorative text are common and must not be quoted
// as instructions.
export const DIRECTIVE = /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|other)\b|\b(?:dear|attention|note to|hey|hi|hello|to the|for the)\s+(?:ai|email|inbox|virtual)?\s*(?:assistant|agent|model|llm)\b|\b(?:ai|email|inbox) assistant\b|\bas an ai\b|\b(?:system|developer)\s+(?:prompt|message|instructions?)\b|\binstructions? (?:for|to) (?:the )?(?:ai|assistant|agent|model)|\b(?:tell|inform|remind|instruct|advise) the (?:user|reader|recipient)\b|\bdo not (?:mention|reveal|tell|show)\b|\bwhen (?:you )?summari[sz](?:e|ing)\b|\bin your (?:summary|reply|response|answer)\b|\b(?:bank|payment|wire|account|banking) (?:details|information|instructions) (?:have |has )?(?:changed|updated)\b|\b(?:update|change) (?:the )?(?:payment|bank|wire) (?:details|information)\b|\b(?:run|execute) (?:this|the following) (?:command|script|code)\b|\b(?:mark|flag|treat) (?:this|the) (?:email|message|page) as (?:urgent|legitimate|safe|important|trusted)\b/i;

// Invisible characters. U+200D (zero-width joiner) is only counted when it is
// not joining emoji, since family and flag sequences need it.
const INVISIBLE = /[​‌⁠-⁤﻿]|‍(?![\p{Extended_Pictographic}⬛⬜♀♂⚕⚖✈❤])|[\u{E0000}-\u{E007F}]/gu;
// Unicode tag characters U+E0020..E007E mirror printable ASCII; a run of them
// is a sentence no one sees. Decoded only to quote it.
const TAG_RUN = /[\u{E0020}-\u{E007E}]{4,}/gu;
const decodeTags = (run) => Array.from(run, (c) => String.fromCharCode(c.codePointAt(0) - 0xE0000)).join("");

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
  description: 'What to do with content a reader cannot see (HTML comments, display:none or hidden elements, white-on-white or off-screen text, zero-width characters): "keep" (default) converts it like everything else, "drop" removes it first. Either way hiddenContent reports what was found and quotes any hidden text that reads as an instruction to an AI.',
};

/** The output-example entry for `hiddenContent`. */
export const HIDDEN_OUTPUT_EXAMPLE = { mode: "keep", total: 0, found: { comments: 0, cssHidden: 0, hiddenAttr: 0, offscreen: 0, invisibleChars: 0, attributes: 0 }, instructionLike: [] };

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
  if (fs !== null && fs <= 2) return "cssHidden";
  if (/scale[xy]?\(\s*0(?:\.0*)?\s*[,)]/.test(g("transform"))) return "cssHidden";
  const ov = g("overflow");
  if ([g("max-height"), g("height"), g("max-width"), g("width")].some((v) => px(v) === 0) && /hidden|clip/.test(ov)) return "cssHidden";
  const col = rgb(g("color"));
  if (col && col.a <= 0.05) return "cssHidden";
  for (const p of ["left", "top", "text-indent", "margin-left"]) { const n = px(g(p)); if (n !== null && n <= -500) return "offscreen"; }
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(g("clip")) || /inset\(\s*50%\s*\)/.test(g("clip-path"))) return "offscreen";
  return null;
}

// A declaration block that paints a background: a colour that is not white, or
// an image/gradient (whose colour is unknown, so treated as not white).
function paintsBackground(st) {
  const g = (p) => String(st?.getPropertyValue?.(p) || "").trim().toLowerCase();
  if (/url\(|gradient\(/.test(g("background-image")) || /url\(|gradient\(/.test(g("background"))) return true;
  const bg = rgb(g("background-color"));
  return !!(bg && bg.a > 0.05 && !nearWhite(bg));
}

// Whether a style rule paints a background on `n`: true, false, or null once
// the match budget is spent (unknown).
function ruleBackground(n, bg) {
  if (!bg.selectors.length) return false;
  if (bg.memo.has(n)) return bg.memo.get(n);
  let hit = false;
  for (const sel of bg.selectors) {
    if (bg.budget <= 0) { bg.exhausted = true; return null; }
    bg.budget--;
    try { if (n.matches(sel)) { hit = true; break; } } catch { /* unsupported selector */ }
  }
  bg.memo.set(n, hit);
  return hit;
}

// Near-white text with nothing but white (or nothing) behind it. A background
// from an inline style, a bgcolor/background attribute, or a style rule on the
// element or any ancestor means it can be seen. Unknown counts as visible.
function whiteOnWhite(el, bg) {
  const col = rgb(el.style?.getPropertyValue?.("color") || el.getAttribute?.("color"));
  if (!nearWhite(col)) return false;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const c = rgb(n.style?.getPropertyValue?.("background-color")) || rgb(n.getAttribute?.("bgcolor"));
    if (c && c.a > 0.05) return nearWhite(c);
    if (n.hasAttribute?.("background") || paintsBackground(n.style)) return false;
    const r = ruleBackground(n, bg);
    if (r !== false) return false;
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
  const found = { comments: 0, cssHidden: 0, hiddenAttr: 0, offscreen: 0, invisibleChars: 0, attributes: 0 };
  const instructionLike = [];
  if (!scope || !win) return { mode, total: 0, found, instructionLike };
  const drop = mode === "drop";

  // 1. Comments (and <template>, whose content is never rendered). For a whole
  // document the walk starts at the document node, so a comment before <html>
  // or after </html> is found too.
  const comments = [];
  const tw = doc.createTreeWalker(root?.nodeType === 9 ? root : scope, win.NodeFilter.SHOW_COMMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) comments.push(n);
  for (const c of comments) { found.comments++; quote(instructionLike, c.data); if (drop) c.remove(); }
  // One pass over the elements collects <template>s, every element that
  // carries an attribute that can hide it (cheaper than attribute selectors),
  // and directive text in attributes a person rarely sees.
  const templates = [];
  const flagged = [];
  const ew = doc.createTreeWalker(scope, win.NodeFilter.SHOW_ELEMENT);
  for (let el = scope.nodeType === 1 ? scope : ew.nextNode(); el; el = ew.nextNode()) {
    if (el.localName === "template") { templates.push(el); continue; }
    if (el.hasAttribute("hidden") || el.hasAttribute("style") || el.hasAttribute("color") || el.localName === "font") flagged.push(el);
    for (const a of el.attributes) {
      const n = a.name;
      if (n === "alt" || n === "title" || n === "aria-label" || n.startsWith("data-") || (n === "content" && el.localName === "meta")) {
        if (a.value.length > 12 && DIRECTIVE.test(a.value.replace(INVISIBLE, ""))) { found.attributes++; quote(instructionLike, a.value); }
      }
    }
  }
  for (const t of templates) { found.cssHidden++; quote(instructionLike, t.content?.textContent || t.textContent); if (drop) t.remove(); }

  // 2. Elements hidden by attribute, inline style or a top-level stylesheet rule.
  const marked = new Map(); // element -> reason
  const mark = (el, why) => { if (!marked.has(el)) marked.set(el, why); };
  const hidingRules = new Map(); // selector -> reason, first rule wins
  const bg = { selectors: [], budget: BG_MATCH_BUDGET, exhausted: false, memo: new Map() }; // rules that paint a background
  for (const sheet of Array.from(doc.styleSheets || [])) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules || [])) {
      if (rule.type !== 1 || !rule.selectorText) continue; // style rules only; @media and the rest are conditional
      const why = hiddenByDecl(rule.style);
      if (why && !hidingRules.has(rule.selectorText)) hidingRules.set(rule.selectorText, why);
      if (bg.selectors.length < MAX_BG_RULES && paintsBackground(rule.style)) bg.selectors.push(rule.selectorText);
    }
  }
  let rulesChecked = 0;
  let ruleCap = 0;
  if (hidingRules.size) {
    const elements = Math.max(1, scope.getElementsByTagName("*").length);
    ruleCap = Math.max(1, Math.min(MAX_RULES, Math.floor(RULE_VISIT_BUDGET / elements)));
    for (const [selector, why] of hidingRules) {
      if (rulesChecked >= ruleCap) break;
      rulesChecked++;
      let els = [];
      try { els = scope.querySelectorAll(selector); } catch { continue; }
      for (const el of els) mark(el, why);
    }
  }
  for (const el of flagged) {
    if (el.hasAttribute("hidden")) { mark(el, "hiddenAttr"); continue; }
    const why = hiddenByDecl(el.style);
    if (why) { mark(el, why); continue; }
    if (whiteOnWhite(el, bg)) mark(el, "cssHidden");
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
    for (const run of v.match(TAG_RUN) || []) quote(instructionLike, decodeTags(run));
    const hits = v.match(INVISIBLE);
    if (hits) {
      found.invisibleChars += hits.length;
      const clean = v.replace(INVISIBLE, "");
      joined += " " + clean;
      if (drop) t.data = clean;
    }
  }
  if (joined) quote(instructionLike, joined);

  // 4. Base64 runs in the text that decode to a directive (reported, never removed).
  // Read from the text nodes already collected, not a second whole-tree pass.
  for (const run of texts.map((t) => t.data).join(" ").match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []) {
    if (instructionLike.length >= MAX_QUOTES) break;
    let dec = "";
    try { dec = Buffer.from(run, "base64").toString("utf8"); } catch { continue; }
    if (/^[\x20-\x7e\s]+$/.test(dec)) quote(instructionLike, dec);
  }

  const total = Object.values(found).reduce((a, b) => a + b, 0);
  const out = { mode, total, found, instructionLike };
  // Present when the page has hiding or background style rules. coversAll false
  // means a budget ran out (hiding rules not all checked, or white text whose
  // background could not be resolved), so hidden content can be under-counted
  // and a clean result is not a complete one.
  if (hidingRules.size || bg.selectors.length) {
    out.styleRuleCoverage = { hidingRules: hidingRules.size, checked: rulesChecked, backgroundsResolved: !bg.exhausted, coversAll: rulesChecked >= hidingRules.size && !bg.exhausted };
  }
  return out;
}
