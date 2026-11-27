// A Tempo PUSH transfer is final before the handler runs, so the server marks
// its request's scope where the claimed credential is let through, and the
// SEC pace (src/tools/sec-rate.js) never answers such a run its own 503. This
// drives that through the real gate: one PAID-mode server
// (scripts/lib/paid-wires-rig.js) on stub chains, the SEC's host a local stub,
// the pace at one start a second (RATE_LIMIT_REPLICAS), and an EDGAR route
// whose every call makes one read of the source.
//
//   - a missing, forged or already-claimed credential never reaches the
//     handler (no read of the source is made for it);
//   - PULL credentials (charged after the handler) read unpaid: sent together
//     from one wallet, the ones the pace cannot start in time are answered
//     503 and are not charged;
//   - PUSH credentials sent together, more of them than the pace can start
//     inside the longest wait, are every one served;
//   - the mark is the request's own: a pull request on the keep-alive socket
//     that just carried a served push request reads unpaid.
// Without the mark the push burst is answered the unpaid 503s.
//
//   node scripts/test-tempo-push-pace.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { bootPaidWires, sleep } from "./lib/paid-wires-rig.js";

let pass = 0, fail = 0, rig = null;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
// More reads from one caller than one start a second clears inside the
// pace's longest wait (ten seconds).
const BURST = 13;
let cikSeq = 1000;
const route = () => ({ method: "GET", path: `/api/edgar-filings?cik=${++cikSeq}&limit=1` });
const SUBMISSIONS = { name: "Example Co", tickers: ["EXM"], exchanges: ["NYSE"], filings: { recent: { form: ["10-K"], filingDate: ["2026-01-02"], reportDate: ["2025-12-31"], accessionNumber: ["0000000000-26-000001"], primaryDocument: ["a.htm"], primaryDocDescription: ["10-K"] } } };

try {
  rig = await bootPaidWires({ label: "push-pace", env: { RATE_LIMIT_REPLICAS: "8", UPSTREAM_STUB_HOSTS: "data.sec.gov,www.sec.gov" } });
  rig.st.upHook = async ({ host, reply }) => {
    if (host !== "data.sec.gov") return false;
    reply(200, SUBMISSIONS);
    return true;
  };
  const reads = () => rig.st.events.filter((e) => e.t === "upstream" && e.path.startsWith("data.sec.gov/")).length;
  const busy = (r) => r.status === 503 && /EDGAR is busy/.test(r.json?.error || r.text || "");
  const say = (rs) => rs.map((r) => r.status).join(",");

  const first = route();
  const offer = await rig.offerOf(first);
  const seen = offer.challenges.find((c) => c.method === "tempo" && c.intent === "charge");
  ok(offer.status === 402 && !!seen, `the EDGAR route answers 402 with a Tempo charge challenge (${offer.status})`);
  if (!seen) throw new Error("no Tempo challenge on the route");
  let seq = 0;
  const push = (secretKey = rig.secret) => {
    const hash = "0x" + randomBytes(32).toString("hex");
    const ch = rig.Challenge.from({ realm: seen.realm, method: "tempo", intent: "charge", expires: new Date(Date.now() + 120_000 + (seq++) * 1000), request: { amount: seen.request.amount, currency: seen.request.currency, decimals: 6, recipient: seen.request.recipient, methodDetails: { chainId: 4217 } }, secretKey });
    return { Authorization: rig.Credential.serialize({ challenge: ch, payload: { hash, type: "hash" }, source: "did:pkh:eip155:4217:0x1111111111111111111111111111111111111111" }) };
  };
  // One request on a given agent, so two can share a keep-alive socket.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const onSocket = (r, headers) => new Promise((resolve, reject) => {
    const u = new URL(`${rig.url}${r.path}`);
    const req = http.request({ agent, host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, text, reused: req.reusedSocket === true }); });
    });
    req.on("error", reject);
    req.end();
  });

  // ---- what never reaches the handler ----
  const r0 = reads();
  const pushed = push();
  const onS = await onSocket(first, pushed);
  ok(onS.status === 200 && onS.json?.name === "Example Co" && reads() === r0 + 1, `control: a claimed push credential reaches the handler and is served (${onS.status}, ${reads() - r0} read)`);
  const r1 = reads();
  const missing = await rig.send(route());
  const forged = await rig.send(route(), push("not-the-server-secret"));
  const again = await rig.send(first, pushed);
  ok(missing.status === 402 && forged.status === 402 && again.status >= 400 && again.status !== 503 && reads() === r1, `a missing, a forged and an already-claimed push credential never reach the handler (${missing.status}, ${forged.status}, ${again.status}; ${reads() - r1} reads)`);

  // ---- pull credentials read unpaid ----
  const w = await rig.wallet("tempo");
  const pullCreds = [];
  for (let i = 0; i < BURST + 2; i++) { const r = route(); pullCreds.push({ r, h: await rig.credentialFor(w, r) }); }
  const sat = pullCreds.slice(0, BURST).map(({ r, h }) => rig.send(r, h));
  await sleep(400);
  // The line is now full of this wallet's reads. One more from it is an
  // unpaid read: answered 503 at once, or (a place having opened meanwhile)
  // admitted behind the wallet's own waiting reads, seconds away. A paid read
  // would start at the next place, about a second away. Read on a socket of
  // its own, then on the socket the served push request used.
  const UNPAID_WAIT_MS = 5_000;
  const timed = async (go) => { const t = Date.now(); const r = await go(); return { ...r, ms: Date.now() - t }; };
  const unpaid = (r) => busy(r) || (r.status === 200 && r.ms >= UNPAID_WAIT_MS);
  const [own, sameSocket] = await Promise.all([
    timed(() => rig.send(pullCreds[BURST].r, pullCreds[BURST].h)),
    sleep(50).then(() => timed(() => onSocket(pullCreds[BURST + 1].r, pullCreds[BURST + 1].h))),
  ]);
  ok(unpaid(own), `CONTROL: with the line full, one more pull request from the same wallet is an unpaid read (${own.status} after ${own.ms} ms)`);
  ok(sameSocket.reused === true && unpaid(sameSocket), `a pull request on the keep-alive socket that carried the served push request reads unpaid: the mark is not kept by the socket (reused ${sameSocket.reused}, ${sameSocket.status} after ${sameSocket.ms} ms)`);

  // ---- push credentials read paid ----
  const t0 = Date.now();
  const pushes = await Promise.all(Array.from({ length: BURST }, () => rig.send(route(), push())));
  const took = Date.now() - t0;
  ok(pushes.every((r) => r.status === 200 && r.json?.name === "Example Co"), `${BURST} push requests sent together, more than the pace starts inside its longest wait, are every one served (${say(pushes)})`);
  ok(took >= 9_000, `and they waited their turn at the same pace (${took} ms)`);

  const pulls = await Promise.all(sat);
  const served = pulls.filter((r) => r.status === 200).length, refused = pulls.filter(busy).length;
  const paidFor = served + [own, sameSocket].filter((r) => r.status === 200).length;
  await sleep(600);
  const out = rig.outcomesOf(w);
  ok(refused >= 1 && served + refused === BURST && served >= 1, `the same number of pull requests sent together are not all served: the ones the pace could not start in time are answered 503 (${say(pulls)})`);
  ok(out.settled === paidFor && pulls.filter(busy).every((r) => r.json?.charged !== true), `and only the served ones were charged (${out.settled} settled, ${paidFor} served)`);
  agent.destroy();
} catch (e) {
  fail++;
  console.error(`FAIL - the suite threw: ${e?.stack || e}`);
  if (rig) console.error(rig.log().slice(-3000));
} finally {
  if (rig) { try { await rig.stop(); } catch (e) { fail++; console.error(`FAIL - ${e.message}`); } }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
