// Frame check for html-frames: how alike two stills are, and where they differ.
//
// Each still is reduced to one grayscale mean per cell of a coarse grid
// (FRAME_DIFF.columns x FRAME_DIFF.rows, laid over the still whatever its
// pixel size). Similarity is one minus the mean absolute difference of those
// cell means, on a 0..1 scale: identical stills score exactly 1. A cell whose
// means differ by more than `changedCellDelta` (on the 0..255 gray scale) is
// changed, and the changed cells are grouped into 4-connected regions, each
// reported as a bounding box in the candidate still's pixels.
//
// Pure arithmetic on decoded RGBA: no model, no network, no new dependency
// (pngjs already decodes barcodes here). The grid makes the check tolerant of
// anti-aliasing and of a baseline captured at another size, and it makes the
// cost of a compare a fixed few hundred thousand byte reads per still.
import { PNG } from "pngjs";
import { partialFields } from "../partial-answer.js";
import { declaredDimensions, sniffFormat } from "./image-ops.js";

export const FRAME_DIFF = Object.freeze({
  columns: 32,
  rows: 18,
  // Gray-level difference (0..255) a cell's mean must move before the cell
  // counts as changed: above JPEG-free anti-aliasing jitter, below any visible
  // shift of a shape or a color.
  changedCellDelta: 12,
  maxRegions: 16,
  decimals: 4,
});

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * The PNG header check: the IHDR is read before any pixel memory is
 * allocated, so a header that declares a canvas over the cap is refused
 * without decoding it. Pure; the input validator runs it before a browser
 * slot is held. Returns the declared { width, height }.
 */
export function assertPngWithin(buf, { maxWidth, maxHeight, label = "png" } = {}) {
  if (!Buffer.isBuffer(buf) || sniffFormat(buf) !== "png") throw bad(`${label} is not a PNG`);
  const dims = declaredDimensions(buf);
  if (!dims || !(dims.width >= 1) || !(dims.height >= 1)) throw bad(`${label} has no readable PNG header`);
  // IHDR byte 28 is the interlace method. The decoder bounds its inflate by
  // the image size only for non-interlaced images, so an interlaced one is
  // refused rather than inflated without a bound.
  if (buf.length < 29 || buf[28] !== 0) throw bad(`${label} is an interlaced PNG; send a non-interlaced one`);
  if ((maxWidth && dims.width > maxWidth) || (maxHeight && dims.height > maxHeight)) {
    throw bad(`${label} is ${dims.width}x${dims.height}; the cap is ${maxWidth}x${maxHeight}`, 413);
  }
  return dims;
}

/** Decode a PNG (a buyer's baseline or one we captured) under the header cap. */
export function decodePng(buf, opts = {}) {
  const label = opts.label || "png";
  assertPngWithin(buf, opts);
  let png;
  try { png = PNG.sync.read(buf); } catch (e) { throw bad(`${label} could not be decoded: ${String(e?.message || e).slice(0, 120)}`); }
  return { width: png.width, height: png.height, data: png.data };
}

/** Grayscale mean per cell of the grid, row-major, as a Float64Array. */
export function gridMeans({ width, height, data }, columns = FRAME_DIFF.columns, rows = FRAME_DIFF.rows) {
  const cols = Math.max(1, Math.min(columns, width));
  const rws = Math.max(1, Math.min(rows, height));
  const sum = new Float64Array(cols * rws);
  const n = new Uint32Array(cols * rws);
  // Column and row of every x and y, computed once each (not per pixel).
  const colOf = new Uint16Array(width);
  for (let x = 0; x < width; x++) colOf[x] = Math.min(cols - 1, Math.floor((x * cols) / width));
  for (let y = 0; y < height; y++) {
    const row = Math.min(rws - 1, Math.floor((y * rws) / height)) * cols;
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      // Rec. 601 luma; alpha is composited over white, the sheet's own backing.
      const a = data[i + 3] / 255;
      const gray = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a);
      const c = row + colOf[x];
      sum[c] += gray;
      n[c]++;
    }
  }
  const means = new Float64Array(cols * rws);
  for (let c = 0; c < means.length; c++) means[c] = n[c] ? sum[c] / n[c] : 255;
  return { columns: cols, rows: rws, means };
}

/**
 * Compare a candidate still with a baseline still of the same or another size.
 * Returns { similarity, changedCells, changedRegions, changedRegionsPartial }.
 */
export function compareStills(candidate, baseline, D = FRAME_DIFF) {
  const a = gridMeans(candidate, D.columns, D.rows);
  const b = gridMeans(baseline, a.columns, a.rows);
  const cols = a.columns, rws = a.rows;
  if (b.columns !== cols || b.rows !== rws) {
    // The baseline is smaller than the grid in one direction: its cells are
    // coarser, so each candidate cell reads the baseline cell that covers it.
    const re = new Float64Array(cols * rws);
    for (let r = 0; r < rws; r++) {
      const br = Math.min(b.rows - 1, Math.floor((r * b.rows) / rws)) * b.columns;
      for (let c = 0; c < cols; c++) re[r * cols + c] = b.means[br + Math.min(b.columns - 1, Math.floor((c * b.columns) / cols))];
    }
    b.means = re;
  }
  let total = 0;
  const changed = new Uint8Array(cols * rws);
  const delta = new Float64Array(cols * rws);
  for (let c = 0; c < changed.length; c++) {
    const d = Math.abs(a.means[c] - b.means[c]);
    delta[c] = d;
    total += d;
    if (d > D.changedCellDelta) changed[c] = 1;
  }
  const similarity = Number((1 - total / (changed.length * 255)).toFixed(D.decimals));
  // Changed cells grouped into 4-connected regions, each a bounding box in
  // candidate pixels. Largest first; the list is capped and says so.
  const cellW = candidate.width / cols, cellH = candidate.height / rws;
  const seen = new Uint8Array(cols * rws);
  const regions = [];
  let changedCells = 0;
  for (let start = 0; start < changed.length; start++) {
    if (!changed[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let minC = cols, maxC = -1, minR = rws, maxR = -1, cells = 0, sumDelta = 0;
    while (stack.length) {
      const i = stack.pop();
      const r = Math.floor(i / cols), c = i % cols;
      cells++; sumDelta += delta[i];
      if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r;
      for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rws - 1 ? i + cols : -1]) {
        if (j >= 0 && changed[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    changedCells += cells;
    const x = Math.floor(minC * cellW), y = Math.floor(minR * cellH);
    regions.push({
      x, y,
      width: Math.min(candidate.width, Math.ceil((maxC + 1) * cellW)) - x,
      height: Math.min(candidate.height, Math.ceil((maxR + 1) * cellH)) - y,
      cells,
      meanDelta: Number((sumDelta / cells / 255).toFixed(D.decimals)),
    });
  }
  regions.sort((p, q) => q.width * q.height - p.width * p.height || p.y - q.y || p.x - q.x);
  const changedRegions = regions.slice(0, D.maxRegions);
  return {
    similarity: Math.max(0, Math.min(1, similarity)),
    changedCells,
    grid: { columns: cols, rows: rws },
    changedRegions,
    changedRegionsPartial: partialFields(regions.length, changedRegions.length),
  };
}
