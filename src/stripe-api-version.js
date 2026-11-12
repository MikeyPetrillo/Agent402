// The Stripe API version every server-side Stripe client sends.
//
// stripe-node sends its own built-in version when none is passed, so an SDK
// bump would otherwise move the API version too (23.1.0 moved it from
// 2026-09-30.endive to 2026-10-28.endive). Pinning it here keeps an SDK update
// a code change only; moving the API version is a separate, deliberate edit of
// this constant after reading Stripe's changelog for the versions in between.
// scripts/test-stripe-api-version.js fails on any `new Stripe(` in src/ that
// does not go through newStripeClient().
import Stripe from "stripe";

export const STRIPE_API_VERSION = "2026-09-30.endive";

/** A Stripe client on the pinned API version. Extra options pass through. */
export function newStripeClient(key, opts = {}) {
  return new Stripe(key, { ...opts, apiVersion: STRIPE_API_VERSION });
}
