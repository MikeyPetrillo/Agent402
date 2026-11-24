// A stub JSON-RPC chain holding an EIP-3009 token's state (balances, used
// authorization nonces, a sender's nonce and gas balance), checking every
// signature the way the token does. Offline: it listens on port 0 and is only
// ever reached by the suite that started it. Shared by the own-relayer suites
// (scripts/test-own-relayer.js on Robinhood Chain, scripts/test-ink-relayer.js
// on Ink): each passes its chain id, token and EIP-712 domain.
import { createServer } from "node:http";
import {
  parseAbi, decodeFunctionData, encodeFunctionResult, encodeAbiParameters, parseTransaction, recoverTypedDataAddress,
  serializeSignature, keccak256, isAddressEqual, pad, toHex, encodeEventTopics, getAddress,
} from "viem";

export const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
export const STUB_OTHER = getAddress("0x00000000000000000000000000000000000bEEF1");
export const AUTH_TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
export const TOKEN_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);
const MULTI_ABI = parseAbi(["function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls) returns ((bool success, bytes returnData)[])"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The stub chain for `chainId`, whose token is `token` with EIP-712 `domain`. */
export function stubEip3009Chain({ chainId, token, domain }) {
  const CHAIN_ID = chainId, TOKEN = getAddress(token), DOMAIN = domain, OTHER = STUB_OTHER;
  const st = {
    balances: new Map(), used: new Set(), nonces: new Map(), ethBalance: new Map(), receipts: new Map(),
    gasPrice: 20_000_000n, block: 100n, sendDelayMs: 0, neverMine: false, sends: [], refusedSends: 0,
    // Every eth_sendRawTransaction that reached the node, taken or not.
    sendAttempts: 0,
    // The node takes the transaction, then the connection drops before it answers.
    resetAfterAccept: false,
    // The node takes the transaction, then answers a JSON-RPC internal error
    // (a proxy that forwarded it and timed out upstream).
    errorAfterAccept: false,
    // The node refuses every send with this message (a definite refusal).
    refuseSendWith: null,
    // A direct authorizationState read fails with an RPC error.
    failAuthState: false,
  };
  const lc = (a) => String(a).toLowerCase();
  const bal = (a) => st.balances.get(lc(a)) || 0n;
  async function transferCheck(args, at) {
    const [from, to, value, validAfter, validBefore, nonce, ...sig] = args;
    const now = BigInt(Math.floor(Date.now() / 1000));
    // usedNoop models a token that answers a replayed nonce as a successful
    // no-op (no revert, no Transfer), as USDG did in a live replay.
    if (st.used.has(`${lc(from)}|${nonce}`)) return st.usedNoop ? null : "FiatTokenV2: authorization is used or canceled";
    if (now <= validAfter) return "FiatTokenV2: authorization is not yet valid";
    if (now >= validBefore) return "FiatTokenV2: authorization is expired";
    const signature = sig.length === 3 ? serializeSignature({ v: BigInt(sig[0]), r: sig[1], s: sig[2] }) : sig[0];
    const who = await recoverTypedDataAddress({ domain: DOMAIN, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: { from, to, value, validAfter, validBefore, nonce }, signature }).catch(() => null);
    if (!who || !isAddressEqual(who, from)) return "FiatTokenV2: invalid signature";
    if (bal(from) < value) return "ERC20: transfer amount exceeds balance";
    void at;
    return null;
  }
  async function tokenCall(data) {
    const { functionName, args } = decodeFunctionData({ abi: TOKEN_ABI, data });
    if (functionName === "transferWithAuthorization") {
      const why = await transferCheck(args);
      if (why) return { revert: why };
      return { data: "0x" };
    }
    if (functionName === "balanceOf") return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: bal(args[0]) }) };
    if (functionName === "authorizationState") return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: st.used.has(`${lc(args[0])}|${args[1]}`) }) };
    if (functionName === "name") return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: DOMAIN.name }) };
    if (functionName === "version") return { data: encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: DOMAIN.version }) };
    return { revert: "unknown" };
  }
  const receiptOf = (hash, from, ok, logs) => ({
    transactionHash: hash, blockHash: pad(toHex(st.block), { size: 32 }), blockNumber: toHex(st.block), transactionIndex: "0x0",
    from, to: TOKEN, status: ok ? "0x1" : "0x0", gasUsed: "0x15f90", cumulativeGasUsed: "0x15f90", effectiveGasPrice: toHex(st.gasPrice),
    type: "0x2", contractAddress: null, logsBloom: "0x" + "00".repeat(256),
    logs: logs.map((l, i) => ({ ...l, blockNumber: toHex(st.block), blockHash: pad(toHex(st.block), { size: 32 }), transactionHash: hash, transactionIndex: "0x0", logIndex: toHex(i), removed: false })),
  });
  /** A transfer some other submitter landed for (from, nonce): used, moved, logged. */
  st.landFor = ({ from, to, value, nonce }) => {
    st.block++;
    const hash = keccak256(toHex(`facilitator-${from}-${nonce}`));
    st.used.add(`${lc(from)}|${nonce}`);
    st.balances.set(lc(from), bal(from) - BigInt(value));
    st.balances.set(lc(to), bal(to) + BigInt(value));
    st.receipts.set(hash, receiptOf(hash, OTHER, true, [
      { address: TOKEN, topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: "Transfer", args: { from, to } }), data: encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]) },
      { address: TOKEN, topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: "AuthorizationUsed", args: { authorizer: from, nonce } }), data: "0x" },
    ]));
    return hash;
  };
  async function handle(method, params) {
    switch (method) {
      case "eth_chainId": return toHex(CHAIN_ID);
      case "eth_blockNumber": return toHex(st.block);
      case "eth_gasPrice": return toHex(st.gasPrice);
      case "eth_getBalance": return toHex(st.ethBalance.get(lc(params[0])) || 0n);
      case "eth_getTransactionCount": return toHex(st.nonces.get(lc(params[0])) || 0);
      case "eth_estimateGas": return toHex(90_000);
      case "eth_getCode": return isAddressEqual(params[0], TOKEN) || isAddressEqual(params[0], MULTICALL3) ? "0x6080" : "0x";
      case "eth_call": {
        const { to, data } = params[0];
        if (st.failAuthState && isAddressEqual(to, TOKEN) && decodeFunctionData({ abi: TOKEN_ABI, data }).functionName === "authorizationState") throw Object.assign(new Error("upstream unavailable"), { rpcCode: -32603 });
        if (isAddressEqual(to, MULTICALL3)) {
          const { args } = decodeFunctionData({ abi: MULTI_ABI, data });
          const out = [];
          for (const c of args[1]) { const r = await tokenCall(c.callData); out.push({ success: !r.revert, returnData: r.data || "0x" }); }
          return encodeFunctionResult({ abi: MULTI_ABI, functionName: "tryAggregate", result: out });
        }
        const r = await tokenCall(data);
        if (r.revert) throw Object.assign(new Error(`execution reverted: ${r.revert}`), { rpcCode: 3 });
        return r.data;
      }
      case "eth_sendRawTransaction": {
        st.sendAttempts++;
        if (st.refuseSendWith) throw Object.assign(new Error(st.refuseSendWith), { rpcCode: -32000 });
        const raw = params[0];
        const tx = parseTransaction(raw);
        if (tx.maxFeePerGas < st.gasPrice) throw Object.assign(new Error("max fee per gas less than block base fee"), { rpcCode: -32000 });
        const hash = keccak256(raw);
        const from = await import("viem").then((v) => v.recoverTransactionAddress({ serializedTransaction: raw }));
        const expected = st.nonces.get(lc(from)) || 0;
        if (tx.chainId !== CHAIN_ID) throw Object.assign(new Error("invalid chain id"), { rpcCode: -32000 });
        if (tx.nonce !== expected) { st.refusedSends++; throw Object.assign(new Error(tx.nonce < expected ? "nonce too low" : "nonce too high"), { rpcCode: -32000 }); }
        const gasCost = tx.gas * tx.maxFeePerGas;
        if ((st.ethBalance.get(lc(from)) || 0n) < gasCost) throw Object.assign(new Error("insufficient funds for gas * price + value"), { rpcCode: -32000 });
        st.nonces.set(lc(from), expected + 1);
        st.sends.push({ hash, nonce: tx.nonce, from });
        if (st.sendDelayMs) await sleep(st.sendDelayMs);
        if (st.neverMine) return hash;
        st.block++;
        const { args } = decodeFunctionData({ abi: TOKEN_ABI, data: tx.data });
        const why = await transferCheck(args);
        st.ethBalance.set(lc(from), (st.ethBalance.get(lc(from)) || 0n) - 90_000n * st.gasPrice);
        if (why) { st.receipts.set(hash, receiptOf(hash, from, false, [])); return hash; }
        const [aFrom, aTo, value, , , nonce] = args;
        if (st.used.has(`${lc(aFrom)}|${nonce}`)) { st.receipts.set(hash, receiptOf(hash, from, true, [])); return hash; }
        st.used.add(`${lc(aFrom)}|${nonce}`);
        st.balances.set(lc(aFrom), bal(aFrom) - value);
        st.balances.set(lc(aTo), bal(aTo) + value);
        const topics = encodeEventTopics({ abi: TOKEN_ABI, eventName: "Transfer", args: { from: aFrom, to: aTo } });
        st.receipts.set(hash, receiptOf(hash, from, true, [{ address: TOKEN, topics, data: encodeAbiParameters([{ type: "uint256" }], [value]) },
          { address: TOKEN, topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: "AuthorizationUsed", args: { authorizer: aFrom, nonce } }), data: "0x" }]));
        return hash;
      }
      case "eth_getTransactionReceipt": return st.receipts.get(params[0]) || null;
      case "eth_getBlockByNumber": return { number: params[0], timestamp: toHex(Math.floor(Date.now() / 1000) - Number(st.block - BigInt(params[0]))) };
      case "eth_getLogs": {
        const f = params[0]; const lo = BigInt(f.fromBlock), hi = BigInt(f.toBlock); const out = [];
        for (const r of st.receipts.values()) for (const l of r.logs) {
          const n = BigInt(l.blockNumber);
          if (n < lo || n > hi || !isAddressEqual(l.address, f.address)) continue;
          if ((f.topics || []).every((t, i) => t == null || String(l.topics[i]).toLowerCase() === String(t).toLowerCase())) out.push(l);
        }
        return out;
      }
      case "eth_getTransactionByHash": return null;
      default: throw Object.assign(new Error(`method ${method} not stubbed`), { rpcCode: -32601 });
    }
  }
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(b); } catch { res.writeHead(400).end(); return; }
      const one = async (m) => {
        try { return { jsonrpc: "2.0", id: m.id, result: await handle(m.method, m.params || []) }; }
        catch (e) { return { jsonrpc: "2.0", id: m.id, error: { code: e.rpcCode ?? -32603, message: e.message, ...(e.rpcCode === 3 ? { data: "0x" } : {}) } }; }
      };
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
      if (st.resetAfterAccept && !Array.isArray(body) && body.method === "eth_sendRawTransaction" && out.result) { req.socket.destroy(); return; }
      if (st.errorAfterAccept && !Array.isArray(body) && body.method === "eth_sendRawTransaction" && out.result) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "upstream timeout" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return { st, server };
}
