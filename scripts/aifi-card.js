// Renders the Agentic Finance (AIFI) card (src/aifi-card.js - the same SVG
// served as /og/agentic-finance.png) to a PNG for announcements.
//   node scripts/aifi-card.js --out docs/announcements/media/2026-08-18-aifi-card.png
import { writeFileSync } from "node:fs";
import { rasterizeSvg } from "../src/tools/render.js";
import { aifiCardSvg } from "../src/aifi-card.js";
const args = process.argv.slice(2);
const i = args.indexOf("--out");
const OUT = i >= 0 ? args[i + 1] : "aifi-card.png";
try {
  const png = await rasterizeSvg(aifiCardSvg(), { width: 1200, height: 630 });
  writeFileSync(OUT, png);
  console.log(`wrote ${OUT} (${png.length} bytes)`);
  // The shared headless browser rasterizeSvg opens keeps the process alive.
  process.exit(0);
} catch (e) { console.error(`render failed: ${e?.message || e}`); process.exit(2); }
