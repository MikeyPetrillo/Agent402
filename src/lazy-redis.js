// The redis client package loads when a client is first created, not at
// boot: a server without REDIS_URL never evaluates it, and one with it pays
// the load off the startup path. Cached after the first call; a failed load
// is retried by the next caller (see src/tools/lazy-deps.js).
import { lazyImport } from "./tools/lazy-deps.js";

export const loadRedis = lazyImport(() => import("redis"));
