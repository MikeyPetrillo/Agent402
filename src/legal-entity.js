// The legal entity that operates the service, in one place. Every page that
// names the contracting party, the copyright agent's principal or the owner of
// the marks reads these values, so a correction to the registered spelling is
// one edit here (scripts/test-legal-entity-name.js fails on any other casing
// of the name in the repository's public text). Files that cannot import a
// module (LICENSE, NOTICE, package.json, markdown) carry the same spelling and
// are read by the same test.
export const LEGAL_ENTITY_NAME = "Cardhavok LLC";
export const TRADE_NAME = "Havok Holdings LLC";
export const LEGAL_ENTITY_SENTENCE = `${LEGAL_ENTITY_NAME} (doing business as ${TRADE_NAME})`;
