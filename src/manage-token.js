// Where a wallet subscriber's manage token is read from on the status and
// cancel routes (/api/mpp/monitors/:subId[/cancel], src/server.js): an
// X-Manage-Token header first, then a JSON body {token}, then ?token= (the
// form already in links that were emailed). A header or body keeps the token
// out of URLs, logs and caches; the query form stays so no issued link breaks.

export const MANAGE_TOKEN_HEADER = "x-manage-token";

/** The manage token a request carries, or "" when it carries none. */
export function manageTokenFrom(req) {
  const h = req?.headers?.[MANAGE_TOKEN_HEADER];
  if (typeof h === "string" && h) return h;
  const b = req?.body?.token;
  if (typeof b === "string" && b) return b;
  const q = req?.query?.token;
  return typeof q === "string" ? q : "";
}

/** The headers every answer on those routes carries: never cached, and no
 *  referrer, so a token in the URL is not passed on by a link it leads to. */
export const MANAGE_RESPONSE_HEADERS = Object.freeze({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
