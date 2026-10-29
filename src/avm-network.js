// The Algorand mainnet network id, in the two spellings on the wire.
//
// CAIP-2 limits a reference to `[-_a-zA-Z0-9]{1,32}`, and the Algorand
// namespace profile takes the first 32 characters of the base64 genesis hash.
// The full hash (44 characters, trailing `=`) was the id this server advertised
// first and is what the facilitator still lists beside the short form; a
// strict CAIP-2 parser refuses it, so the short form is what every 402 and
// every surface derived from the catalog carries, and the long form is read
// as an alias wherever a buyer or a seller still sends it.
export const ALGORAND_MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k";
export const ALGORAND_MAINNET_LEGACY_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

/** The strict CAIP-2 shape (namespace `[-a-z0-9]{3,8}`, reference `[-_a-zA-Z0-9]{1,32}`). */
export const CAIP2_PATTERN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/** A network id with the legacy Algorand spelling folded to the CAIP-2 one; any other id unchanged. */
export function canonicalAvmNetwork(network) {
  return network === ALGORAND_MAINNET_LEGACY_CAIP2 ? ALGORAND_MAINNET_CAIP2 : network;
}
