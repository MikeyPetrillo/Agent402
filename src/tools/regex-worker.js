// Worker that runs a user-supplied regex against user-supplied text in an
// isolated thread. The main thread enforces a wall-clock timeout via
// worker.terminate(), so a catastrophic-backtracking pattern (ReDoS) can never
// block the server's event loop — the worst case is one terminated worker and
// an HTTP 400 to the caller.
import { parentPort, workerData } from "node:worker_threads";

const { pattern, flags, text, maxMatches } = workerData;

let re;
try {
  re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
} catch (e) {
  parentPort.postMessage({ error: `Invalid regex: ${e.message}` });
  process.exit(0);
}

const matches = [];
let m;
while ((m = re.exec(text)) && matches.length < maxMatches) {
  matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
  if (m.index === re.lastIndex) re.lastIndex++;
}
parentPort.postMessage({ matchCount: matches.length, matches });
