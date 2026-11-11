// What Agent402 is, in one sentence, and the category line the home page sets
// as its h1. Every first-contact surface reads the sentence from here (the
// home hero, /llms.txt, the hosted MCP instructions, server description and
// server.describe), and the surfaces that cannot import it (the README, the
// stdio MCP package, the package READMEs and descriptions) carry it verbatim:
// scripts/test-positioning.js fails when any of them drifts.
//
// The wires clause follows the MPP switch where a surface reads it, so a
// server without MPP never offers it; the published sentence is the one with
// both wires.

/** The home page h1: the category, in the words a stranger uses. */
export const CATEGORY_LINE = "Pay-per-call tools for AI agents.";

/** The lead sentence, with the wires this server offers. */
export function leadSentence({ mpp = true } = {}) {
  return `Agent402 is a catalog of 500+ tools that AI agents find, pay for per request over ${mpp ? "x402 or MPP" : "x402"}, and call with no account or API key.`;
}

/** The published lead sentence (both wires). */
export const LEAD_SENTENCE = leadSentence();
