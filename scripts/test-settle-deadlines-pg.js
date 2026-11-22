// A payment cut at its network's settle deadline, sent again once its
// transfer landed and was booked owed, against a REAL Postgres
// (STATE_DATABASE_URL; CI fails without it) and, when REDIS_URL is set, a
// real Redis for the settlement claims and the kept answers:
//   - the cut answers settlement-unconfirmed and the transfer that lands
//     later is booked owed once;
//   - the same payment for the same call sent again is served the route's
//     kept answer with nothing run, the debt is void in the database (its
//     evidence marked void, so no later owed insert lands), the sale is
//     booked once on usdc/x402 on celo and the served-call counter moves by
//     one; a further resend is served again and books nothing more;
//   - the same payment for another call keeps the 402.
//
//   STATE_DATABASE_URL=postgres://... [REDIS_URL=redis://...] node scripts/test-settle-deadlines-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
import { startSettleDeadlineHarness, CELO, CELO_ROW } from "./lib/settle-deadlines-harness.js";

const { url, schema } = requireTestPg({ label: "test-settle-deadlines-pg" });
let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async (sql, params) => { try { return (await db.query(sql, params)).rows; } catch { return []; } };

let H = null;
try {
  H = await startSettleDeadlineHarness({
    stores: "settle-deadlines-pg",
    env: {
      SETTLE_DEADLINES: JSON.stringify({ celo: CELO_ROW }),
      STATE_DATABASE_URL: url, STATE_DB_SCHEMA: schema, DATABASE_URL: "", ANALYTICS_DATABASE_URL: "",
      REDIS_URL: process.env.REDIS_URL || "", LEDGER_JOURNAL_REDIS: process.env.REDIS_URL ? (process.env.LEDGER_JOURNAL_REDIS || "") : "",
    },
  });
  const { srv, B, send, pay, snap, asked, waitFor, refundOf, owedLines, st, counts, releases, land } = H;
  const celoServed = async () => { try { return Number((await (await fetch(`${B}/api/stats`)).json())?.toolCallsServed?.viaUSDCByNetwork?.celo) || 0; } catch { return -1; } };
  const salesFor = (tx) => q(`SELECT rail, wire, network, payer FROM "${schema}".sales WHERE lower(tx) = $1`, [tx]);

  // Control: a Celo call settled the normal way moves the same counter by one.
  const n0 = await celoServed();
  const normal = await pay(CELO);
  await sleep(300);
  ok(normal.status === 200 && (await celoServed()) === n0 + 1, `control: a normal Celo sale moves the served-call counter by one (${n0} -> ${await celoServed()})`);
  st.celo = "hold30";
  const h = await pay(CELO);
  ok(h.status === 402 && h.body?.reason === "settlement-unconfirmed", `the 30 s settle is cut at Celo's cap (${h.status}, ${h.ms} ms)`);
  const T = land(h);
  ok(await waitFor(() => owedLines(T) === 1, 50_000), "the transfer that landed after the cut is booked owed");
  ok(/"owed"/.test(JSON.stringify(await refundOf(T))), "the debt reads owed");
  const served0 = await celoServed();
  const c0 = snap();
  const again = await send(h.header);
  ok(again.status === 200 && again.replayed === "1" && again.body && !again.body.reason && String(again.receipt?.transaction || "").toLowerCase() === T,
    `the same payment for the same call sent again: the route's kept answer, the transfer named (${again.status} ${again.text.slice(0, 120)})`);
  ok(counts.verify === c0.verify && asked(c0) === "0/0", "nothing verified, run or settled for it");
  const row = (await q(`SELECT status FROM "${schema}".refunds WHERE lower(evidence) = $1`, [T]))[0];
  const mark = (await q(`SELECT state FROM "${schema}".refund_marks WHERE lower(evidence) = $1`, [T]))[0];
  ok(row?.status === "void" && mark?.state === "void", `the debt is void in the database and its evidence marked void (${row?.status}/${mark?.state})`);
  await waitFor(async () => (await salesFor(T)).length > 0, 5000);
  const sales = await salesFor(T);
  ok(sales.length === 1 && sales[0].rail === "usdc" && sales[0].wire === "x402" && sales[0].network === "celo" && String(sales[0].payer).toLowerCase() === h.payer.toLowerCase(),
    `the sale is booked once on its real rail and wire (${JSON.stringify(sales)})`);
  await sleep(300);
  ok((await celoServed()) === served0 + 1, `the served-call counter moved by one (${served0} -> ${await celoServed()})`);
  const third = await send(h.header);
  await sleep(500);
  ok(third.status === 200 && (await salesFor(T)).length === 1 && (await celoServed()) === served0 + 1 && owedLines(T) === 1,
    `sent once more: served again, still one sale, one served call and one debt (${third.status})`);
  const other = await send(h.header, JSON.stringify({ text: "another input" }));
  ok(other.status === 402 && other.replayed === "1" && other.body?.reason === "settlement-unconfirmed", `the same payment for another call: the kept 402 (${other.status})`);
  for (const rel of [...releases]) rel();
  ok(/served the kept answer/.test(srv.log()), "the log names the resend served");
} catch (e) {
  ok(false, e?.stack || String(e));
} finally {
  if (failed && H) console.error(H.srv.log().split("\n").filter((l) => /\[payments\]|late-settle|settle-deadlines|settle|refund/i.test(l)).slice(-40).join("\n"));
  await H?.stop();
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  await db.end().catch(() => {});
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
