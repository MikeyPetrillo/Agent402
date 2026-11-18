// Proof-of-work solving for a seller's challenge: find a nonce such that
// sha256("<challenge>:<nonce>") has at least `difficulty` leading zero bits.
//
// Two bounds keep a hostile or broken server from hanging the caller:
//   - the difficulty is refused above MAX_POW_DIFFICULTY (28 bits, the most an
//     Agent402 server can be configured to ask for: src/pow.js clamps
//     POW_DIFFICULTY to 8..28), so a challenge asking for 60 bits is an error,
//     not a search that never ends;
//   - the search stops after MAX_POW_TRIES_FACTOR times the expected number of
//     hashes (2^difficulty). The search is memoryless, so running past 64 times
//     the expectation has a chance of about e^-64: a stop there is a broken
//     challenge, never bad luck.
// solvePowAsync runs the search on a worker thread, so the event loop of the
// process that asked keeps serving while it runs. Where worker threads are not
// available it searches in slices on the main thread, yielding between them.
//
// This file is shipped byte-identical in agent402-client and agent402-mcp
// (scripts/test-known-assets.js checks the copies).
import { createHash } from "node:crypto";

export const MAX_POW_DIFFICULTY = 28;
export const MAX_POW_TRIES_FACTOR = 64;
const MAX_CHALLENGE_CHARS = 512;
const MAX_TOKEN_CHARS = 4096;
const SLICE = 4096;

export function leadingZeroBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}

/** The checked challenge ({ challenge, difficulty, maxTries }), or a thrown
 *  Error naming what is wrong with it. `token` is checked only when `needToken`. */
export function checkPowChallenge(pow, { needToken = false } = {}) {
  if (!pow || typeof pow !== "object") throw new Error("proof-of-work challenge is not an object");
  const challenge = pow.challenge;
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > MAX_CHALLENGE_CHARS) {
    throw new Error(`proof-of-work challenge must be a string of 1 to ${MAX_CHALLENGE_CHARS} characters`);
  }
  const difficulty = pow.difficulty;
  if (typeof difficulty !== "number" || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_POW_DIFFICULTY) {
    throw new Error(`proof-of-work difficulty ${JSON.stringify(pow.difficulty)} is refused: this solver accepts a whole number of bits from 0 to ${MAX_POW_DIFFICULTY}`);
  }
  if (needToken && (typeof pow.token !== "string" || pow.token.length === 0 || pow.token.length > MAX_TOKEN_CHARS)) {
    throw new Error(`proof-of-work token must be a string of 1 to ${MAX_TOKEN_CHARS} characters`);
  }
  return { challenge, difficulty, maxTries: MAX_POW_TRIES_FACTOR * 2 ** difficulty };
}

const exhausted = (difficulty, maxTries) => new Error(`proof-of-work search stopped after ${maxTries} hashes without a ${difficulty}-bit solution (${MAX_POW_TRIES_FACTOR} times the expected count): the challenge is not solvable as stated`);

/** Solve on the calling thread. Returns the nonce. Blocks the event loop for
 *  the whole search; solvePowAsync does not. */
export function solvePowSync(pow) {
  const { challenge, difficulty, maxTries } = checkPowChallenge(pow);
  for (let n = 0; n < maxTries; n++) {
    if (leadingZeroBits(createHash("sha256").update(`${challenge}:${n}`).digest()) >= difficulty) return n;
  }
  throw exhausted(difficulty, maxTries);
}

// The worker's own source: CommonJS, evaluated by worker_threads, so no file
// path has to resolve inside a bundle.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { challenge, difficulty, maxTries } = workerData;
const lzb = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
let found = -1;
for (let n = 0; n < maxTries; n++) {
  if (lzb(createHash("sha256").update(challenge + ":" + n).digest()) >= difficulty) { found = n; break; }
}
parentPort.postMessage(found);
`;

let workerCtor; // undefined = not looked up yet, null = unavailable
async function loadWorker() {
  if (workerCtor !== undefined) return workerCtor;
  try { workerCtor = (await import("node:worker_threads")).Worker || null; } catch { workerCtor = null; }
  return workerCtor;
}

async function solveInSlices({ challenge, difficulty, maxTries }) {
  for (let n = 0; n < maxTries;) {
    const end = Math.min(n + SLICE, maxTries);
    for (; n < end; n++) {
      if (leadingZeroBits(createHash("sha256").update(`${challenge}:${n}`).digest()) >= difficulty) return n;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw exhausted(difficulty, maxTries);
}

/** Solve off the event loop. Resolves to the nonce. `useWorker: false` forces
 *  the sliced main-thread search (tests use it). */
export async function solvePowAsync(pow, { useWorker = true } = {}) {
  const checked = checkPowChallenge(pow);
  const Worker = useWorker ? await loadWorker() : null;
  if (!Worker) return solveInSlices(checked);
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(WORKER_SOURCE, { eval: true, workerData: checked }); } catch { solveInSlices(checked).then(resolve, reject); return; }
    let settled = false;
    worker.once("message", (n) => {
      settled = true;
      worker.terminate().catch(() => {});
      if (Number.isInteger(n) && n >= 0) resolve(n);
      else reject(exhausted(checked.difficulty, checked.maxTries));
    });
    worker.once("error", (e) => { if (!settled) { settled = true; reject(e); } });
    worker.once("exit", (code) => { if (!settled) { settled = true; reject(new Error(`proof-of-work worker exited (code ${code}) before answering`)); } });
  });
}
