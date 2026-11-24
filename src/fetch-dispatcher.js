// The one way this server builds a connection pool for Node's built-in fetch.
//
// Built-in fetch carries the undici bundled with Node, which speaks the v1
// dispatcher handler API (onConnect, onHeaders, onData ...). undici 8, the
// package this repo resolves, speaks only the v2 API (onRequestStart,
// onResponseStart ...), so built-in fetch refuses a bare undici 8 Agent passed
// as `dispatcher` with UND_ERR_INVALID_ARG. undici's own Dispatcher1Wrapper is
// the documented bridge: it takes v1 handlers and forwards them to the Agent,
// and it keeps every connection on HTTP/1.1 as undici 7 did.
//
// Every call site keeps calling globalThis.fetch, so the request-timing wrapper
// (src/request-timing.js), the suites' fetch stubs and the global Response type
// all stay as they were. The Agent is built with allowH2: false as well, so a
// caller that hands this pool to undici's own request() (the x402 buyer's
// paid-leg fallback) stays on HTTP/1.1 too.
import { Agent, Dispatcher1Wrapper } from "undici";

/** An undici Agent with `options`, wrapped so built-in fetch accepts it. */
export function fetchAgent(options = {}) {
  return new Dispatcher1Wrapper(new Agent({ ...options, allowH2: false }));
}
