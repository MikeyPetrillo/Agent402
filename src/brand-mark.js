// The brand mark (black ground, "402", red dot) as a vector: assets/brand/logo.svg,
// drawn from the same art as assets/brand/logo.png (docs/logo-current.png) with
// the glyph outlines as paths, so no renderer needs a font. /logo.svg serves it;
// the favicon, the page chrome's nav and footer mark and the 512px icon PNG
// (/favicon.png, the x402 listing icon) are the same art cropped to the mark.
import { readFileSync } from "node:fs";

export const LOGO_SVG = readFileSync(new URL("../assets/brand/logo.svg", import.meta.url), "utf8").trim();

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
