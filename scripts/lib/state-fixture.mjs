// A volume-shaped fixture for the state scripts' tests: every store's file,
// written in FILE mode by the store modules themselves (their own schema),
// with production-shaped rows: sales and refunds through the ledgers' own
// write calls (refunds in every status), every other SQLite table seeded
// generically by column type, the record directories, the append logs and
// the crawl cache with its header line.
//
//   node scripts/lib/state-fixture.mjs seed <dir> [salesN] [refundsN]
// (run with STATE_DATABASE_URL unset; prints one JSON line of what it wrote)
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootStores, SQLITE_STORES } from "./state-stores.mjs";

const FLAGS = new Set(["settled", "external", "internal", "synthetic", "backfilled", "caught_up", "ok"]);

export async function seedFixture(dir, { salesN = 600, refundsN = 260 } = {}) {
  if (String(process.env.STATE_DATABASE_URL || "").trim()) throw new Error("seed the fixture in file mode (STATE_DATABASE_URL unset)");
  dir = resolve(dir);
  const { modules: m } = await bootStores(dir);
  const out = { sales: 0, feedback: 0, refunds: 0, byStatus: {}, tables: {} };
  for (let i = 1; i <= salesN; i++) {
    m.sales.recordSale({ slug: `tool-${i % 17}`, priceUsd: Number((0.001 + i * 0.0000013).toFixed(9)), rail: ["x402", "mpp", "card", "credits"][i % 4], network: ["base", "solana", "tempo", null][i % 4], payer: `0x${String(i).padStart(40, "a")}`, tx: `0x${i.toString(16).padStart(64, "0")}`, wire: i % 3 ? "x402" : "mpp", quoteUsd: i % 5 ? null : 0.01 });
    out.sales++;
    if (i % 9 === 0) { m.sales.recordSaleFeedback({ tx: `0x${i.toString(16).padStart(64, "0")}`, saleId: i, slug: `tool-${i % 17}`, payer: `0x${String(i).padStart(40, "a")}`, verdict: i % 2 ? "good" : "bad", reason: "fixture" }); out.feedback++; }
  }
  for (let i = 1; i <= refundsN; i++) {
    m.refunds.recordRefundOwed({ slug: `tool-${i % 13}`, network: "base", payer: `0x${String(i).padStart(40, "b")}`, priceUsd: Number((0.002 + i * 0.0000017).toFixed(9)), tx: `0xr${i.toString(16).padStart(63, "0")}`, httpStatus: 500 + (i % 4), wire: "x402" });
    out.refunds++;
  }
  for (const r of m.refunds.listRefunds({ status: "all", limit: 1_000_000 })) {
    if (r.id % 7 === 0) m.refunds.markRefundPaid(r.id, `0xpaid${r.id}`, "fixture paid");
    else if (r.id % 11 === 0) m.refunds.markRefundVoid(r.id, "fixture void");
  }
  for (const r of m.refunds.listRefunds({ status: "all", limit: 1_000_000 })) out.byStatus[r.status] = (out.byStatus[r.status] || 0) + 1;

  // Every other SQLite table: rows by column type, through a second connection.
  const { default: Database } = await import("better-sqlite3");
  for (const s of SQLITE_STORES) {
    if (s.file === "agent402-sales.db" || s.file === "agent402-refunds.db") continue;
    const db = new Database(join(dir, s.file));
    try {
      for (const table of Object.keys(s.tables)) {
        if ((s.transient || []).includes(table)) continue; // expires on its own, never imported
        const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
        if (!cols.length) continue;
        const use = cols.filter((c) => !(c.pk === 1 && /INT/i.test(c.type) && cols.filter((x) => x.pk).length === 1));
        const ins = db.prepare(`INSERT OR IGNORE INTO "${table}" (${use.map((c) => `"${c.name}"`).join(", ")}) VALUES (${use.map(() => "?").join(", ")})`);
        let n = 0;
        db.transaction(() => {
          for (let i = 1; i <= 120; i++) {
            const vals = use.map((c) => {
              if (/_json$/.test(c.name)) return JSON.stringify({ i, big: "9007199254740993", f: 0.1 + i });
              if (c.name === "exp" || /_at$|_ts$|^ts$|expires/.test(c.name)) return Date.now() + 86_400_000 + i;
              if (FLAGS.has(c.name)) return i % 2; // 0/1 flags hold 0 or 1 in real files
              if (/INT/i.test(c.type)) return i;
              if (/REAL|FLOA|DOUB/i.test(c.type)) return 0.1 + i * 0.000001;
              return `${table}-${c.name}-${i}`;
            });
            n += ins.run(...vals).changes;
          }
        })();
        out.tables[`${s.file}:${table}`] = n;
      }
    } finally { db.close(); }
  }

  // Record directories.
  mkdirSync(join(dir, "credits"), { recursive: true });
  for (let i = 1; i <= 25; i++) writeFileSync(join(dir, "credits", `k_${i.toString(16).padStart(64, "c")}.json`), JSON.stringify({ balanceMicro: 1_000_000 + i * 7, created: 1_760_000_000_000 + i, big: 9007199254740993 }));
  writeFileSync(join(dir, "credits", "_sessions.json"), JSON.stringify({ cs_test_1: "k_1" }));
  mkdirSync(join(dir, "human-checkout"), { recursive: true });
  for (let i = 1; i <= 12; i++) writeFileSync(join(dir, "human-checkout", `cs_test_${i}.json`), JSON.stringify({ status: "done", sessionId: `cs_test_${i}`, priceCents: 500 + i, report: `report ${i}` }));
  // Append logs (a malformed line is skipped by both the importer and the verifier).
  for (let i = 1; i <= 30; i++) appendFileSync(join(dir, "outbound-spend.ndjson"), JSON.stringify({ at: 1_760_000_000_000 + i, chain: "base", usd: 0.001 * i, tx: `0xo${i}` }) + "\n");
  for (let i = 1; i <= 8; i++) appendFileSync(join(dir, "wishes.jsonl"), JSON.stringify({ at: 1_760_000_000_000 + i, text: `wish ${i}` }) + "\n");
  // The crawl cache: a header line, then one [origin, entry] per line.
  const entries = Array.from({ length: 5 }, (_, i) => [`https://seller${i}.example`, { origin: `https://seller${i}.example`, n: i }]);
  writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: 1_760_000_000_000, format: "ndjson-v1", origins: entries.length }), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
  out.indexOrigins = entries.length;
  await m.sales.salesLedgerFlush?.();
  await m.refunds.refundLedgerFlush?.();
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain && process.argv[2] === "seed") {
  const out = await seedFixture(process.argv[3], { salesN: Number(process.argv[4]) || 600, refundsN: Number(process.argv[5]) || 260 });
  console.log(JSON.stringify(out));
  process.exit(0);
}
