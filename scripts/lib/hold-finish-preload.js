// Test-only preload (node --import): holds back a response's "finish" and
// "close" events, as a socket write that completes late holds them, so a
// booted test can send its next request in the window between the answer
// being ended and "finish". scripts/test-replay-release-at-end.js uses it to
// show which payment claims are released at end and which wait for "finish".
//
// A request opts in with `x-test-hold-finish: <id>`; its response's "finish"
// and "close" are queued, not emitted. Any later request carrying
// `x-test-flush-held: <id>` emits the queued events in order (a safety
// timer flushes them after 60 s). The bytes of the answer go out as usual:
// only the two events are held.
//
// It refuses to load unless HOLD_FINISH_TEST=1, so it can never ride a real
// boot by accident.
import http from "node:http";

if (process.env.HOLD_FINISH_TEST !== "1") {
  throw new Error("hold-finish preload: refusing to load outside its test (set HOLD_FINISH_TEST=1)");
}

const held = new Map(); // id -> [{ res, ev, args }]
const flush = (id) => {
  const queue = held.get(id);
  if (!queue) return;
  held.delete(id);
  for (const { res, ev, args } of queue) realEmit.call(res, ev, ...args);
};

const realEmit = http.ServerResponse.prototype.emit;
http.ServerResponse.prototype.emit = function heldEmit(ev, ...args) {
  const id = (ev === "finish" || ev === "close") ? this.req?.headers?.["x-test-hold-finish"] : undefined;
  if (typeof id !== "string" || !id) return realEmit.call(this, ev, ...args);
  if (!held.has(id)) {
    held.set(id, []);
    setTimeout(() => flush(id), 60_000).unref();
    process.stderr.write(`[hold-finish] holding ${this.req.method} ${this.req.path ?? this.req.url} (${id}) at ${this.statusCode}\n`);
  }
  held.get(id).push({ res: this, ev, args });
  return true;
};

const realServerEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function flushOnRequest(ev, req, ...rest) {
  if (ev === "request") {
    const id = req?.headers?.["x-test-flush-held"];
    if (typeof id === "string" && id) flush(id);
  }
  return realServerEmit.call(this, ev, req, ...rest);
};
