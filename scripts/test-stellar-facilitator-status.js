// The Stellar facilitator's fee account is the one spending wallet we run
// that had no low-water alarm (found 2026-08-31 at 5.906 XLM, ~250 more
// settlements). This pins the alarm's contract, and in particular the two
// ways a balance alarm fails FLATTERINGLY: reporting "ok" when it could not
// actually read a balance, and reporting "ok" off a stranger's endpoint.
import assert from "node:assert/strict";
import { stellarFacilitatorStatus, readsAsOurFacilitator } from "../src/stellar-facilitator-status.js";

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log("ok -", msg); };

const URL_ENV = process.env.STELLAR_FACILITATOR_URL;
const set = (v) => { if (v === undefined) delete process.env.STELLAR_FACILITATOR_URL; else process.env.STELLAR_FACILITATOR_URL = v; };

const jsonRes = (body, { okFlag = true } = {}) => ({ ok: okFlag, json: async () => body });
const health = (over = {}) => ({ signerAddress: "GD6ZLGJJYRWVZBXTG57YDUBATVKOHACYZYQUKMB6UH4EYYITLRCYZZSD", xlmBalance: 5.9, low: false, ...over });

try {
  // Unconfigured is its own answer, never "ok" and never a false alarm.
  set(undefined);
  ok((await stellarFacilitatorStatus({ fetchImpl: async () => { throw new Error("must not be called"); } })).status === "unconfigured",
    "no STELLAR_FACILITATOR_URL reports unconfigured and makes no request");

  set("https://facilitator.example/");
  let seen = null;
  const capture = async (u) => { seen = u; return jsonRes(health()); };
  ok((await stellarFacilitatorStatus({ fetchImpl: capture })).status === "ok", "a healthy facilitator reports ok");
  ok(seen === "https://facilitator.example/health", `the trailing slash is normalized, /health is what is fetched (got ${seen})`);

  ok((await stellarFacilitatorStatus({ fetchImpl: async () => jsonRes(health({ low: true, xlmBalance: 0.4 })) })).status === "low",
    "the facilitator's own low flag is what raises the alarm");

  // The flattering-failure cases. Each of these once-ok answer must be unknown.
  ok((await stellarFacilitatorStatus({ fetchImpl: async () => jsonRes(health({ low: null, xlmBalance: null })) })).status === "unknown",
    "low:null (the facilitator could not read Horizon) is unknown, never ok");
  ok((await stellarFacilitatorStatus({ fetchImpl: async () => jsonRes({}, { okFlag: false }) })).status === "unknown",
    "a non-2xx /health is unknown, never ok");
  ok((await stellarFacilitatorStatus({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).status === "unknown",
    "an unreachable facilitator is unknown, never ok");
  ok((await stellarFacilitatorStatus({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("not json"); } }) })).status === "unknown",
    "an unparseable body is unknown, never ok");

  // STELLAR_FACILITATOR_URL defaults to a THIRD PARTY's facilitator, whose
  // /health is not this alarm's subject. A 200 from a stranger must not read
  // as our fee account being funded.
  ok((await stellarFacilitatorStatus({ fetchImpl: async () => jsonRes({ status: "healthy", uptime: 1234 }) })).status === "unknown",
    "a foreign /health that does not carry our shape is unknown, never ok");
  ok(readsAsOurFacilitator(health()) === true, "our own /health body is recognized");
  ok(readsAsOurFacilitator({ signerAddress: "0xabc", xlmBalance: 1, low: false }) === false,
    "an EVM-looking signerAddress is not our Stellar facilitator");
  ok(readsAsOurFacilitator({ signerAddress: "GABC", xlmBalance: 1 }) === false, "a body with no low flag is not trusted");
  ok(readsAsOurFacilitator(null) === false && readsAsOurFacilitator("ok") === false, "a null or non-object body is not trusted");

  // Public surface: bucketed only. A number here is a balance disclosure.
  const shape = await stellarFacilitatorStatus({ fetchImpl: async () => jsonRes(health({ xlmBalance: 5.9060224 })) });
  ok(!JSON.stringify(shape).includes("5.906") && !("xlmBalance" in shape) && !("signerAddress" in shape),
    `the public status carries no balance and no address (got ${JSON.stringify(shape)})`);
  ok(shape.asset === "XLM" && shape.chain === "stellar:pubnet", "the status names the asset and chain it watches");
} finally {
  set(URL_ENV);
}

console.log(`\n${passed} passed, 0 failed`);
