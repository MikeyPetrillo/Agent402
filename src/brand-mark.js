// The brand mark (black ground, "402", red dot) as a vector: assets/brand/logo.svg,
// drawn from the same art as assets/brand/logo.png (docs/logo-current.png) with
// the glyph outlines as paths, so no renderer needs a font. /logo.svg serves it;
// the favicon, the page chrome's nav and footer mark and the 512px icon PNG
// (/favicon.png, the x402 listing icon) are the same art cropped to the mark.
//
// The file is read here, at import, like the fonts the brand images embed:
// every page's chrome and four routes draw it, so a tree without it is a
// build that must not start (the deploy keeps the previous one) rather than
// one that answers pages 500. The error names the file, so a copy of the
// tree made without assets/ reads as that, not as a fault of the importer.
import { readFileSync } from "node:fs";

const LOGO_FILE = new URL("../assets/brand/logo.svg", import.meta.url);
function readLogo() {
  try { return readFileSync(LOGO_FILE, "utf8").trim(); }
  catch (e) { throw new Error(`brand mark: assets/brand/logo.svg could not be read (${e.code || e.message}). src/brand-mark.js reads it when imported; an image or a copy of the tree must carry assets/ beside src/.`, { cause: e }); }
}
export const LOGO_SVG = readLogo();

// The square around the glyphs and the dot, so the mark fills a small icon.
export const MARK_VIEWBOX = "75 85 340 340";
const inner = LOGO_SVG.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");

/** The favicon: the logo cropped to the mark, 512 by 512. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="${MARK_VIEWBOX}">${inner}</svg>`;

/** The mark inline at nav or footer size (no request, no font). */
export function brandMarkSvg(size) {
  return `<svg aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="${MARK_VIEWBOX}" style="display:block;flex:none;">${inner}</svg>`;
}

/** The cache-bust the page head links the favicon files with; only those
 *  versioned URLs are cached as immutable. Bump it when the art changes. */
export const FAVICON_VERSION = "4";

/** The mark as a tile on a social card (a 1200 by 630 SVG that is rasterized):
 *  the logo's own black ground, white 402 and red dot, cropped to the mark,
 *  corners rounded. `stroke` draws a hairline around it, so the black tile
 *  reads on a card whose own ground is near black. No font: the glyphs are
 *  the logo file's paths. */
export function brandMarkTile(x, y, size, { stroke = "" } = {}) {
  const r = +(size * 0.25).toFixed(2);
  const id = `brand-mark-${x}-${y}-${size}`;
  const box = `x="${x}" y="${y}" width="${size}" height="${size}"`;
  return `<g data-brand-mark="402"><clipPath id="${id}"><rect ${box} rx="${r}"/></clipPath><g clip-path="url(#${id})"><svg ${box} viewBox="${MARK_VIEWBOX}">${inner}</svg></g>${stroke ? `<rect ${box} rx="${r}" fill="none" stroke="${stroke}" stroke-width="1.5"/>` : ""}</g>`;
}

/** The cache-bust on the card URLs that carry no version of their own (a tool
 *  page's card, a shared answer's card, the Agentic Finance card). The home
 *  and section cards are versioned by a hash of the home card instead. Bump
 *  it when the art on those cards changes. */
export const CARD_ART_VERSION = "2";
