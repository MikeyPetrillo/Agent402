// A catalog tool call is always answered in full.
//
// Express turns a 2xx into a bodiless 304 when the request carries a
// conditional header that matches (If-None-Match: * matches any answer), and
// that happens inside res.send, after the handler ran. A tool answer is paid
// for or computed per call, never a revalidation of something the caller
// holds, so the conditional and range request headers are removed before any
// gate, replay or handler reads the request. The answer is then the same full
// body on every rail (x402, Tempo, card, credits, proof-of-work, free mode),
// and every book that keys on a final 200 sees one. The response keeps its
// ETag. Free documents (openapi, llms.txt, pages, sitemap) are not tool
// routes and keep their 304.
export const CONDITIONAL_REQUEST_HEADERS = Object.freeze([
  "if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range", "range",
]);

// isToolPath(path, req) -> true for a route that must answer in full.
export function fullAnswerMiddleware(isToolPath) {
  return function fullAnswer(req, res, next) {
    let tool = false;
    try { tool = isToolPath(req.path, req) === true; } catch { tool = false; }
    if (tool) for (const name of CONDITIONAL_REQUEST_HEADERS) if (req.headers[name] !== undefined) delete req.headers[name];
    next();
  };
}
