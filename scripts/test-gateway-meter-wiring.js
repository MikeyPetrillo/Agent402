// The meter must be WIRED, and must fail safe.
//
// The pricing rule is unit-tested in test-gateway-meter.js. This checks the
// half a unit test cannot see: that the sentinel actually leaves the gateway,
// that the binder consumes it, and above all that the sentinel NEVER reaches a
// buyer - it carries our upstream bill, which is the one number the gateway
// strips from every response.
import { readFileSync } from "node:fs";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const kit = readFileSync("src/tools/llm-gateway-kit.js", "utf8");
const server = readFileSync("src/server.js", "utf8");
const meter = readFileSync("src/gateway-meter.js", "utf8");

// The sentinel is set through setMeterSentinel (NON-enumerable, review
// 2026-08-27) - a plain assignment would make our upstream bill serializable
// again wherever the result is nested by an in-process caller.
ok(/setMeterSentinel\(data, upstreamUsd\)/.test(kit) && !/data\.__meterUpstreamUsd = upstreamUsd/.test(kit), "the gateway reports its real upstream cost through the non-enumerable sentinel helper, never a plain assignment");
ok(/enumerable: false/.test(meter) && /export function setMeterSentinel/.test(meter), "setMeterSentinel defines the sentinel non-enumerable");
ok(/typeof upstreamUsd === "number"/.test(kit),
  "and only when upstream actually reported a number: a missing cost must mean 'no meter', never 'free'");

// The decision itself moved OUT of server.js into applyMeteredSettlement, so
// that it could be executed by a test rather than only grepped. It was grepped
// for weeks and shipped twice broken - unable to run at all, then throwing
// ReferenceError with a catch that named the same undefined identifier, so the
// fail-safe raised the error it existed to absorb and a 500 reached the buyer.
// Its BEHAVIOUR is now covered for real in test-gateway-meter.js; what remains
// here is the wiring a unit test cannot see.
const call = server.slice(server.indexOf("applyMeteredSettlement({"), server.indexOf("if (result && result.__binary)"));
ok(/applyMeteredSettlement/.test(server), "the route binder invokes the meter");
ok(/\bresult\b/.test(call) && /\breq\b/.test(call) && /\btool\b/.test(call) && /\bres\b/.test(call),
  "and passes it the result, the request, the tool and the response");
ok(/enabled:\s*GATEWAY_METER_ON/.test(call),
  "it is behind a switch, so changing what buyers are charged is a deliberate act");
ok(/setOverrides:\s*setSettlementOverrides/.test(call),
  "the override is the real @x402/express one, not a stub that would silently never settle");
// `tool` is this loop's variable. Naming anything else here is the exact defect
// that reached production: `def` does not exist in that scope, so the first
// request to reach the branch threw and the buyer got a 500.
ok(!/\bdef\./.test(call), "it names `tool`, the binder's own loop variable, and never an identifier that is not in scope");

ok(/delete result\.__meterUpstreamUsd/.test(meter),
  "the meter DELETES the sentinel before the body is sent: it is our upstream bill, and the gateway strips every other billing field for the same reason");
ok(/isMeterable\(req\)/.test(meter), "it only meters an upto payment (an exact payment fixed its amount at the 402)");
ok(/!enabled/.test(meter), "a disabled meter sets no override");
ok(/headersSent/.test(meter), "it refuses once headers are sent: the override rides a response header and a late write is silently lost");
ok(/catch/.test(meter) && /settling at the ceiling/.test(meter),
  "anything thrown leaves NO override, so the buyer settles at the ceiling they authorized rather than an accidental amount");

// The switch must default OFF. A metering default that flips on with a deploy
// would change every gateway buyer's bill without anyone choosing it.
ok(/GATEWAY_METERED_BILLING \|\| ""\)\.toLowerCase\(\) === "on"/.test(server),
  "metering is OFF unless GATEWAY_METERED_BILLING is explicitly 'on'");

console.log(`\n${pass} passed, 0 failed`);
