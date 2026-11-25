// Chain chips: each settlement network named in plain text, never by its
// logo. A network's name identifies where a payment settles (nominative use);
// its logo is the owner's artwork, which several owners allow only unaltered
// or only in partnership content, so no logo is drawn anywhere on the site.
import { RAILS, railKey, countWord } from "./rails.js";

// Canonical display order + labels, read from RAILS (primary rail first), so
// the chip rows cannot list or name a chain differently from the rails list.
export const CHAIN_ORDER = RAILS.map((r) => [railKey(r), r.name]);

/** The rail count in words, derived from RAILS. */
export const RAIL_COUNT_WORD = countWord(CHAIN_ORDER.length);

/** A chip's title: what the linked page holds, with no claim on the network's name. */
export const chainChipTitle = (name) => `${name}: Agent402 sellers and settlements`;

/**
 * The "settles on N networks" strip (N derived from RAILS): one plain-text
 * chip per network, each linking to that chain's page. Used on /sell.
 */
export function chainLogoStrip({ label = `Settles natively on ${countWord(CHAIN_ORDER.length)} networks` } = {}) {
  const chips = CHAIN_ORDER.map(([slug, name]) =>
    `<a href="/${slug}" title="${chainChipTitle(name)}" style="display:inline-flex;align-items:center;text-decoration:none;color:var(--ink);border:1px solid var(--hairline);padding:4px 10px;"><span style="font-family:var(--font-mono);font-size:var(--fs-sm);letter-spacing:.01em;">${name}</span></a>`
  ).join("");
  return `<div class="chain-strip" style="padding:18px 0;">
  <div class="ml-chain-strip-label" style="font-family:var(--font-mono);font-size:var(--fs-2xs);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;">${label}</div>
  <div style="display:flex;flex-wrap:wrap;gap:10px 12px;align-items:center;">${chips}</div>
</div>`;
}
