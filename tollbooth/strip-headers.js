// Inbound headers the tollbooth never forwards to the origin. Shared by the
// Node reverse proxy (index.js) and the edge Worker (worker.js) so both strip
// the same client-forgeable set. No node:* imports: the Worker loads this too.

// The gate's own trust signals, forwarding headers, and client-IP / scheme
// headers an origin might honor. A client can send any of these, so none of
// them is passed through.
export const CLIENT_TRUST_HEADERS = Object.freeze([
  "x-tollbooth-paid", "x-tollbooth-error", "x-pow-error", "x-forwarded-host", "forwarded",
  "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-client-ip", "fastly-client-ip",
  "x-forwarded-proto", "x-forwarded-port", "via",
]);

// Hop-by-hop and framing headers the Node proxy rebuilds itself. The Worker's
// fetch manages these on its own, so the Worker does not strip them.
export const HOP_BY_HOP_HEADERS = Object.freeze([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
]);
