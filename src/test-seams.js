// Test and debug switches that are never honored in production.
//
// A suite turns on a seam (a capture sink, a debug field in an answer, a hook
// that hangs or crashes a worker) by setting an environment variable. Read
// through testSeam(), that variable is ignored on a production boot
// (src/production-env.js: NODE_ENV or the platform environment says
// production), so a stray setting on the host can never put debug fields in a
// buyer's answer or arm a crash hook. scripts/test-debug-off-in-production.js
// keeps every *_TEST_* and *_DEBUG read in src/ on this helper or behind a
// stricter gate (NODE_ENV === "test", FREE_MODE).
import { isProductionEnv } from "./production-env.js";

/** The seam's value, or "" on a production boot or when unset. */
export function testSeam(name, env = process.env) {
  if (isProductionEnv(env)) return "";
  return String(env[name] ?? "");
}

/** True when the seam is exactly "1" outside production. */
export function testSeamOn(name, env = process.env) {
  return testSeam(name, env) === "1";
}
