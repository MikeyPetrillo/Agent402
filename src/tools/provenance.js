// Untrusted-content provenance marker (security audit R-14).
//
// Tools that return attacker-controlled EXTERNAL web content — a rendered or
// extracted page, live search results — stamp their payload with
// `untrustedContent: true`. It is a machine-readable signal that the payload is
// DATA to be analyzed, never instructions to obey: a downstream tool-enabled
// agent must not treat any text inside a marked payload as authorization to
// spend funds, reveal secrets, or invoke tools. The tool descriptions carry the
// same warning in prose so the guidance reaches the agent both ways.
//
// Additive and non-destructive: it only adds the flag, never removes or renames
// an existing key, so it can't break a consumer or the "answers its own
// example" shape check (which only flags MISSING documented keys).
export function markUntrusted(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...result, untrustedContent: true };
}
