// ONE lever that stops every outbound signature.
//
// Before this, SOR_EXTERNAL_ENABLED gated route-execute alone while three other
// paths signed without consulting it: the paid explorer-data buys (retired
// 2026-09-22), the EAS attest write, and MPP subscription renewals. So the switch an operator reaches
// for during an incident did not stop spending, and would have looked like it
// had. Every signing path now asks this first.
//
// FAILS CLOSED BY CONSTRUCTION. Only an explicit off-value ("", "0", "false",
// "no", "off") permits signing; anything else halts. A typo therefore stops
// spending rather than permitting it, because the cost of a wrong halt is a 503
// and the cost of a wrong open is money.
//
// The refusal is 503, never 4xx: a halt is OUR configuration, not the caller's
// error, and a status >= 400 already cancels settlement, so nobody is charged
// for meeting it.
const OFF = new Set(["", "0", "false", "no", "off"]);

/** True when outbound signing is halted. Call-time read: no restart needed. */
export function signingHalted() {
  const raw = String(process.env.SIGNING_HALTED ?? "").trim().toLowerCase();
  return !OFF.has(raw);
}

/** Throws 503 when signing is halted. The FIRST statement of every signing path. */
export function assertSigningAllowed(what = "this payment") {
  if (!signingHalted()) return;
  const e = new Error(
    `Outbound signing is halted on this server (SIGNING_HALTED), so ${what} was not attempted. `
    + `Nothing was charged. Try again later or contact the operator if this persists.`,
  );
  e.statusCode = 503;
  throw e;
}

/** Counts only, for the public status surface. Never the env value itself. */
export const signingHaltStatus = () => ({ halted: signingHalted() });
