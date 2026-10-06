#!/usr/bin/env node
// The wish board must not record a caller's BUG as market demand.
//
//   node scripts/test-wish-hygiene.js
//
// WHY: this board is the roadmap-steering surface - a cluster that crosses the
// qualification threshold is the argument for building something. A live read
// of it showed clusters for "[object object]", "undefined", "null", and bare
// integers ("18", "0", "30"), all of which are a client that stringified a JS
// value into the query. None of them is a person wanting a tool. Counting them
// is how a board manufactures its own demand.
//
// The filter is deliberately NARROW, and this test pins the narrowness in both
// directions: the artifacts are rejected, and real words that merely LOOK like
// a bug in context ("object", "function", "request") are still recorded,
// because "object" from a broken client and "object" from someone wanting
// object detection cannot be told apart here - and dropping a genuine need is
// the worse failure.
import { isNonQuery, recordWish } from "../src/wish.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- rejected: exactly the shapes observed on the live board ----------------
for (const junk of ["[object object]", "undefined", "null", "nan", "18", "0", "30", "1.5", "-", "?", "a", "true", "false"]) {
  ok(isNonQuery(junk), `rejected as a non-query: ${JSON.stringify(junk)}`);
}

// --- kept: genuine needs, including the real ones seen on the board --------
for (const real of ["captcha", "solidity auditor", "btc mempool backlog", "notary", "gpt55", "sqlwatch",
  "object", "function", "request", "connect", "ready", "a2a", "ocr"]) {
  ok(!isNonQuery(real), `kept as a real need: ${JSON.stringify(real)}`);
}

// --- the guard is wired into recordWish, not just exported -----------------
// An explicit submission gets a 400 it can act on; a find-miss is
// fire-and-forget and its caller swallows the throw, so the same guard serves
// both without a second code path.
{
  let threw = null;
  try { recordWish({ need: "[object Object]", source: "api" }); } catch (e) { threw = e; }
  ok(threw && threw.statusCode === 400, "recordWish rejects a stringified object with 400");

  let threw2 = null;
  try { recordWish({ need: "42", source: "find-miss" }); } catch (e) { threw2 = e; }
  ok(threw2 && threw2.statusCode === 400, "a numeric find-miss is refused too (caller swallows it)");

  // Case and whitespace must not smuggle it past the filter.
  let threw3 = null;
  try { recordWish({ need: "  UNDEFINED  ", source: "api" }); } catch (e) { threw3 = e; }
  ok(threw3 && threw3.statusCode === 400, "normalization runs before the filter (case/space cannot evade it)");

  const good = recordWish({ need: "solidity auditor", source: "find-miss" });
  ok(good && good.recorded === true, "a real find-miss is still recorded");
}

console.log(`\n${failCount()}`);
function failCount() { return `${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`; }
process.exit(fail ? 1 : 0);
