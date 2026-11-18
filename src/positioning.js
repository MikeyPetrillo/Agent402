// What Agent402 is, in one sentence, and the category line the home page sets
// as its h1. Every first-contact surface reads the sentence from here (the
// home hero, /llms.txt, the hosted MCP instructions, server description and
// server.describe), and the surfaces that cannot import it (the README, the
// stdio MCP package, the package READMEs and descriptions) carry it verbatim:
// scripts/test-positioning.js fails when any of them drifts.
//
// Two clauses follow switches where a surface reads them: the wires follow the
// MPP switch, so a server without MPP never offers it, and the signed-receipt
// clause follows receiptsServed() (src/receipt-signing.js), so a server with
// no signing key loaded never promises one. The published sentence is the one
// with both wires and the receipt clause.
//
// The catalog's size is a supporting line, never the lead: SUPPORT_LINE.

/** The home page h1: the category, in the words a stranger uses. */
export const CATEGORY_LINE = "Payments and trust for AI agents.";

/** The lead sentence, with the wires this server offers and, when it signs
 *  them, the receipt clause. */
export function leadSentence({ mpp = true, receipts = true } = {}) {
  return `Agent402 is the payment and trust layer for agent commerce: agents find, pay for and verify paid calls across ${mpp ? "x402 and MPP" : "x402"}${receipts ? ", backed by signed receipts" : ""}.`;
}

/** The published lead sentence (both wires, receipts on). */
export const LEAD_SENTENCE = leadSentence();

/** The catalog, as a supporting line: evergreen count, never an exact one. */
export const SUPPORT_LINE = "500+ ready tools on the same rails.";
