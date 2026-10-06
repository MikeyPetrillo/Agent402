// Every HTML page names /llms.txt, so an agent that reads only the page it
// landed on (head or response headers) finds the machine-readable site map
// without scraping the footer. Done once at response time rather than in each
// page shell: many pages hand-write their own <head>, and a per-shell copy
// would miss them.
export const LLMS_LINK_TAG = '<link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable site map">';
export const LLMS_LINK_HEADER = '</llms.txt>; rel="alternate"; type="text/plain"';

const isHtml = (res) => /^text\/html/i.test(String(res.getHeader("content-type") || ""));

/** Adds the <link> before </head> once, unless the page already names it. */
export function withLlmsLinkTag(html) {
  const s = String(html);
  if (s.includes('href="/llms.txt" title=') || !/<\/head>/i.test(s)) return s;
  return s.replace(/<\/head>/i, `${LLMS_LINK_TAG}\n</head>`);
}

/** Appends the alternate to any Link header the route already set. */
function addLinkHeader(res) {
  const cur = res.getHeader("link");
  const list = Array.isArray(cur) ? cur.join(", ") : String(cur || "");
  if (list.includes("</llms.txt>")) return;
  res.setHeader("Link", list ? `${list}, ${LLMS_LINK_HEADER}` : LLMS_LINK_HEADER);
}

export function llmsLinkMiddleware() {
  return (req, res, next) => {
    const send = res.send;
    res.send = function (body) {
      // Express defaults an untyped string body to text/html AFTER this runs,
      // so an untyped body that is a document counts as HTML too.
      if (typeof body === "string" && (isHtml(res) || (!res.getHeader("content-type") && /^\s*<(!doctype html|html)/i.test(body)))) body = withLlmsLinkTag(body);
      return send.call(this, body);
    };
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      try { if (isHtml(res)) addLinkHeader(res); } catch { /* headers are best-effort */ }
      return writeHead.apply(this, args);
    };
    next();
  };
}
