// Offline unit tests for the b20-kit log-decoding helpers, pinned to the
// CANONICAL B20 ABI from base/base-std src/interfaces/IB20.sol + IB20Factory.sol:
//   event Transfer(address indexed from, address indexed to, uint256 amount)
//   event Memo(address indexed caller, bytes32 indexed memo)        // BOTH indexed
//   event B20Created(address indexed token, B20Variant indexed variant,
//                    string name, string symbol, uint8 decimals, bytes variantEventParams)
// Non-canonical layouts must be REJECTED (null), never guessed. No network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { B20_INTERNALS } from "../src/tools/b20-kit.js";

const { TOPIC_TRANSFER, TOPIC_MEMO, TOPIC_B20_CREATED, findB20Address, decodeTransfer, memoWord, memoText, logIndexNum } = B20_INTERNALS;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const pad = (hex) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
const B20_ADDR = "0xb200000000000000000000000000000000000abc";
const EOA = "0x1111111111111111111111111111111111111111";
const EOA2 = "0x2222222222222222222222222222222222222222";

// topic constants are 32-byte hashes
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_TRANSFER), "TOPIC_TRANSFER is a 32-byte hash");
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_MEMO), "TOPIC_MEMO is a 32-byte hash");
ok(/^0x[0-9a-f]{64}$/.test(TOPIC_B20_CREATED), "TOPIC_B20_CREATED is a 32-byte hash");
ok(TOPIC_TRANSFER === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "TOPIC_TRANSFER matches the canonical ERC-20 Transfer topic");

// findB20Address: canonical B20Created — token indexed at topics[1]
ok(findB20Address({ topics: [TOPIC_B20_CREATED, pad(B20_ADDR), pad("0x01")], data: "0x" + pad(EOA).slice(2) }) === B20_ADDR,
  "findB20Address reads the token from topics[1] (canonical layout)");
// regression pin: a 0xb200 address hiding in DATA is not the token — reject, don't scan
ok(findB20Address({ topics: [TOPIC_B20_CREATED], data: "0x" + pad(EOA).slice(2) + pad(B20_ADDR).slice(2) }) === null,
  "findB20Address rejects non-canonical layouts instead of scanning data words");
// topics[1] present but not a factory-prefixed address -> null (counted as skipped upstream)
ok(findB20Address({ topics: [TOPIC_B20_CREATED, pad(EOA)], data: "0x" }) === null,
  "findB20Address returns null when topics[1] lacks the 0xb200 prefix");
// topics[1] not address-shaped -> null
ok(findB20Address({ topics: [TOPIC_B20_CREATED, "0x" + "ff".repeat(32)], data: "0x" }) === null,
  "findB20Address returns null when topics[1] is not address-shaped");

// decodeTransfer: canonical (from/to indexed, amount in data) — the only layout
let t = decodeTransfer({ topics: [TOPIC_TRANSFER, pad(EOA), pad(EOA2)], data: pad("0x64") });
ok(t && t.from === EOA && t.to === EOA2 && t.value === "100", "decodeTransfer canonical layout");
// regression pin: non-indexed data-packed transfers are rejected, not guessed
t = decodeTransfer({ topics: [TOPIC_TRANSFER], data: "0x" + pad(EOA).slice(2) + pad(EOA2).slice(2) + pad("0x64").slice(2) });
ok(t === null, "decodeTransfer rejects the non-indexed layout");
ok(decodeTransfer({ topics: [TOPIC_TRANSFER, pad(EOA), pad(EOA2)], data: "0x" }) === null, "decodeTransfer returns null on missing amount");

// memoWord: canonical Memo(address indexed caller, bytes32 indexed memo) — memo at topics[2]
const MEMO_HEX = "0x" + Buffer.from("invoice-42").toString("hex").padEnd(64, "0");
ok(memoWord({ topics: [TOPIC_MEMO, pad(EOA), MEMO_HEX], data: "0x" }) === MEMO_HEX, "memoWord reads the memo from topics[2] (canonical layout)");
// regression pin: a memo-looking DATA word is not a memo — reject, don't guess
ok(memoWord({ topics: [TOPIC_MEMO, pad(EOA)], data: MEMO_HEX }) === null, "memoWord rejects the data-word layout");
ok(memoWord({ topics: [TOPIC_MEMO], data: "0x" }) === null, "memoWord returns null when topics[2] is absent");

// memoText: printable, binary, all-zero
ok(memoText(MEMO_HEX) === "invoice-42", "memoText decodes printable UTF-8 and trims NUL padding");
ok(memoText("0x" + "00".repeat(32)) === null, "memoText returns null for all-zero memo");
ok(memoText("0x" + "fe".repeat(32)) === null, "memoText returns null for non-UTF-8 bytes");

// logIndexNum
ok(logIndexNum("0x1f") === 31, "logIndexNum parses hex quantities");
ok(logIndexNum(undefined) === -1 && logIndexNum("junk") === -1, "logIndexNum returns -1 on malformed input instead of throwing");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
