// The tools the crawled seller index keeps per seller.
//
// One seller lists tens of thousands of machine-generated route permutations,
// a quarter of every tool the index holds in memory and the row that had to be
// stored in parts (src/index-parts.js). The index keeps at most SELLER_TOOL_CAP
// of a seller's tools; the seller stays listed and routable on the ones kept.
//
// What is kept is chosen the same way on every read, so the kept set is
// stable across crawls and a save of an unchanged catalogue rewrites no part:
// the tools with a description first, in listing order, then the rest in
// listing order, up to the cap. A list at or under the cap is returned as it
// came (the same array).
//
// The cap is applied in one place, IndexCache.set (src/x402-index.js), which
// every stored entry passes through: the crawl, the registry fallback, a warm
// start, a pull from the other container and the router worker's replica. The
// capped entry carries `toolsTotal` (the count the listing held) and
// `toolsCapped: true`; both are persisted, so an entry stored capped is not cut
// again and keeps its total. An entry whose tools are under the cap carries
// neither (a stale pair, spread from an earlier capped copy by a crawl that
// found fewer tools, is dropped). An entry of exactly the cap that carries the
// pair is one already capped and is kept as it is; after the cap is raised such
// an entry reads as uncapped until its next crawl cuts it at the new cap.
export const SELLER_TOOL_CAP = (() => { const n = Number(process.env.INDEX_SELLER_TOOL_CAP); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5000; })();

/** Whether a tool carries a description a reader would see (text, or a scalar the cleaning turns into text). */
export function isDescribedTool(t) {
  if (!t || typeof t !== "object") return false;
  const d = t.description;
  if (typeof d === "string") return d.trim().length > 0;
  return typeof d === "number" || typeof d === "boolean";
}

/** The tools kept under `cap`: { tools, total, capped }. Under or at the cap the
 *  same array comes back with capped false; past it, the described tools in
 *  listing order, then the rest in listing order, up to the cap. Applying it
 *  to its own result changes nothing. */
export function capSellerTools(tools, cap = SELLER_TOOL_CAP) {
  if (!Array.isArray(tools)) return { tools, total: 0, capped: false };
  const total = tools.length;
  if (!(cap >= 1) || total <= cap) return { tools, total, capped: false };
  const kept = [];
  for (let i = 0; i < total && kept.length < cap; i++) if (isDescribedTool(tools[i])) kept.push(tools[i]);
  for (let i = 0; i < total && kept.length < cap; i++) if (!isDescribedTool(tools[i])) kept.push(tools[i]);
  return { tools: kept, total, capped: true };
}

/** The entry as the cache keeps it: its tools capped, `toolsTotal` and
 *  `toolsCapped` set when cut, kept when it was cut before, dropped when
 *  stale. The same object when nothing needed it. */
export function capSellerEntry(v, cap = SELLER_TOOL_CAP) {
  if (!v || typeof v !== "object" || !Array.isArray(v.tools)) return v;
  const n = v.tools.length;
  const priorTotal = v.toolsCapped === true && Number.isFinite(Number(v.toolsTotal)) ? Number(v.toolsTotal) : 0;
  if (n > cap) {
    const { tools } = capSellerTools(v.tools, cap);
    return { ...v, tools, toolsTotal: Math.max(n, priorTotal), toolsCapped: true };
  }
  if (priorTotal > n && n === cap) return v; // stored capped at this cap: kept as it is
  if ("toolsTotal" in v || "toolsCapped" in v) { const { toolsTotal: _t, toolsCapped: _c, ...rest } = v; return rest; }
  return v;
}

/** The count a seller listed: `toolsTotal` on a capped entry, else the tools held (or `fallback`, the figure a surface shows when it holds none). */
export function sellerToolsTotal(v, fallback = 0) {
  const held = Array.isArray(v?.tools) ? v.tools.length : 0;
  const n = held || fallback;
  return v?.toolsCapped === true && Number(v.toolsTotal) > n ? Number(v.toolsTotal) : n;
}

/** The sentence a surface attaches beside toolCount, toolsTotal and toolsCapped. */
export const toolCapLegend = (cap = SELLER_TOOL_CAP) =>
  `toolCount is the routes this index holds for the seller; toolsTotal is the count its listing held when last read; toolsCapped is true when the listing held more than ${cap} and the index kept ${cap} (the described routes first, then the rest in listing order) and dropped the others.`;
