// Single source of truth for the per-slug marketplace bridge token, shared by
// the server (which validates it) and the registration/verify scripts (which
// generate it) so the two sides can never drift out of sync.
//
// The token in a /mkt/<token>/<slug> URL is HMAC(masterToken, slug) — so a
// leaked endpoint exposes only its one tool, and the master secret never
// appears in a URL.
import { createHmac } from "node:crypto";

/** HMAC(masterToken, slug) → hex, truncated to 32 chars. "" when no master. */
export function marketplaceSlugToken(masterToken, slug) {
  if (!masterToken) return "";
  return createHmac("sha256", masterToken).update(String(slug)).digest("hex").slice(0, 32);
}
