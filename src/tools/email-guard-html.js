// HTML side of email-guard (./email-guard-kit.js), run inside the HTML worker
// (./html-worker-ops.js "emailHtml"): one parse of the message's HTML part
// gives the text a reader sees, the text an agent would also read (hidden
// elements included), every comment, every link, and the base64 runs that
// decode to readable text. Plain data in and out. The hidden-element checks
// are the same scrubHidden() the hidden-text-scan tool runs.
import { loadJsdom } from "./lazy-deps.js";
import { scrubHidden } from "./hidden-content.js";

const MAX_COMMENTS = 50;
const MAX_LINKS = 500;
const MAX_BASE64 = 20;
const BLOCK = "ARTICLE,SECTION,HEADER,FOOTER,NAV,ASIDE,MAIN,DIV,P,H1,H2,H3,H4,H5,H6,UL,OL,LI,BLOCKQUOTE,PRE,HR,TR,BR,TABLE,FIGURE,FIGCAPTION,DT,DD,DETAILS,SUMMARY,ADDRESS,FORM,FIELDSET,TD,TH";
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;

function blockText(doc, root) {
  if (!root) return "";
  // A line break at both ends of every block, so an inline run before a block
  // and the block's own first sentence never read as one sentence.
  for (const el of root.querySelectorAll(BLOCK)) {
    const first = el.firstChild;
    const last = el.lastChild;
    if (!(first && first.nodeType === 3 && first.data === "\n")) el.insertBefore(doc.createTextNode("\n"), first);
    if (!(last && last.nodeType === 3 && last.data === "\n") || first === last) el.appendChild(doc.createTextNode("\n"));
  }
  return (root.textContent || "").replace(/ /g, " ").replace(/[ \t]+/g, " ").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

/** A base64 run that decodes to text a person could read: mostly printable,
 *  and either a URL or at least three words. */
export function readableBase64(run) {
  let dec = "";
  try { dec = Buffer.from(run, "base64").toString("utf8"); } catch { return null; }
  if (!dec) return null;
  const printable = (dec.match(/[\x20-\x7e\t\n\r]/g) || []).length;
  if (printable / dec.length < 0.95) return null;
  const words = (dec.match(/[A-Za-z]{2,}/g) || []).length;
  if (!/https?:\/\//i.test(dec) && words < 3) return null;
  return dec;
}

export async function emailHtmlReport(html) {
  const JSDOM = await loadJsdom();
  const doc = new JSDOM(String(html), { contentType: "text/html" }).window.document;
  const win = doc.defaultView;
  const title = doc.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 300) || null;

  // Comments are read before anything is removed, with their position in the source.
  const comments = [];
  let commentsTotal = 0;
  const tw = doc.createTreeWalker(doc, win.NodeFilter.SHOW_COMMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    commentsTotal++;
    if (comments.length >= MAX_COMMENTS) continue;
    const data = String(n.data || "");
    const at = html.indexOf("<!--" + data);
    comments.push({ text: data.replace(/\s+/g, " ").trim().slice(0, 500), offset: at >= 0 ? at : null });
  }

  // Scripts are never text. Styles stay until scrubHidden has read their rules.
  doc.querySelectorAll("script, noscript").forEach((el) => el.remove());

  // Every link, before hidden elements go, so a link inside one is still listed.
  const anchors = Array.from(doc.querySelectorAll("a[href]")).slice(0, MAX_LINKS);
  const linksTotal = doc.querySelectorAll("a[href]").length;

  const fullText = blockText(doc, doc.body || doc.documentElement);
  const hiddenContent = scrubHidden(doc, { mode: "drop" });
  doc.querySelectorAll("style, template").forEach((el) => el.remove());
  const visibleText = blockText(doc, doc.body || doc.documentElement);

  const links = anchors.map((a) => {
    const href = String(a.getAttribute("href") || "").trim();
    const at = html.indexOf(href);
    return {
      href: href.slice(0, 2000),
      text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      title: a.getAttribute("title") ? String(a.getAttribute("title")).slice(0, 300) : null,
      hidden: !a.isConnected,
      offset: at >= 0 ? at : null,
    };
  });

  // Base64 runs in text and comments that decode to readable text or a URL
  // (attribute values are left alone: an inline image is base64 by design).
  const base64 = [];
  const seen = new Set();
  const scan = (s, where) => {
    for (const m of String(s).matchAll(BASE64_RUN)) {
      if (base64.length >= MAX_BASE64) return;
      const dec = readableBase64(m[0]);
      if (!dec || seen.has(m[0])) continue;
      seen.add(m[0]);
      const at = html.indexOf(m[0]);
      base64.push({ where, encoded: m[0].slice(0, 60) + (m[0].length > 60 ? "..." : ""), decoded: dec.replace(/\s+/g, " ").trim().slice(0, 500), offset: at >= 0 ? at : null });
    }
  };
  scan(fullText, "html");
  for (const c of comments) scan(c.text, "comment");

  return { title, fullText, visibleText, comments, commentsTotal, hiddenContent, links, linksTotal, base64 };
}
