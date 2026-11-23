// An EVM private key as people paste it: with or without the 0x prefix, with
// surrounding whitespace or line breaks, or inside one pair of quotes (a value
// copied out of a JSON or .env file). Each is read as the same 32-byte key.
// Anything else is refused with a fixed message that names the variable and
// the expected form and never quotes the value.

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** The expected form, as the refusal words it. */
export const EVM_KEY_FORM = "a 32-byte hex private key (64 hex characters, with or without the 0x prefix)";

/** The error for a value that is not a key: the name and the expected form only. */
export function walletKeyError(name, what = EVM_KEY_FORM) {
  return new Error(`${name} is set but is not ${what}; check the value (it is never printed)`);
}

/** Strip whitespace and one pair of matching surrounding quotes. */
export function unwrapKeyText(raw) {
  let v = String(raw ?? "").trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1).trim();
  return v;
}

/** The key as "0x" + 64 lowercase hex characters, or null when it is not one. */
export function evmKeyOrNull(raw) {
  const v = unwrapKeyText(raw);
  const hex = /^0x/i.test(v) ? v.slice(2) : v;
  return HEX64.test(hex) ? `0x${hex.toLowerCase()}` : null;
}

/** The key as "0x" + 64 hex characters; throws walletKeyError(name) otherwise. */
export function normalizeEvmKey(raw, name = "AGENT_KEY") {
  const k = evmKeyOrNull(raw);
  if (!k) throw walletKeyError(name);
  return k;
}
