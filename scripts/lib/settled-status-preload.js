// Test-only preload (node --import): rewrites the status of a response that
// already carries a settle receipt, for a request that asks for it, so a
// booted test can drive the charged-failure path (settled, then a non-200)
// end to end. The paid middleware settles only a response under 400, so no
// real handler reaches that path on demand; this stands in for the failure
// that happens after the settle, and every book the server keeps on the
// finished response runs as it would.
//
// A request opts in with `x-test-settled-status: <status>` (400-599); only a
// response whose PAYMENT-RESPONSE header is set when its head is written is
// changed. Everything else passes straight through.
//
// It refuses to load unless SETTLED_STATUS_TEST=1, so it can never ride a
// real boot by accident.
import { ServerResponse } from "node:http";

if (process.env.SETTLED_STATUS_TEST !== "1") {
  throw new Error("settled-status preload: refusing to load outside its test (set SETTLED_STATUS_TEST=1)");
}

const realWriteHead = ServerResponse.prototype.writeHead;
ServerResponse.prototype.writeHead = function settledStatus(status, ...rest) {
  const want = Number(this.req?.headers?.["x-test-settled-status"]);
  if (want >= 400 && want < 600 && this.getHeader("payment-response")) {
    process.stderr.write(`[settled-status] ${this.req.method} ${this.req.path || this.req.url} answers ${want} after its settle\n`);
    return realWriteHead.call(this, want, ...rest);
  }
  return realWriteHead.call(this, status, ...rest);
};
