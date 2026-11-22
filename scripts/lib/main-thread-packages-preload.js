// Preload for a server under test: records which of the lazy packages
// (src/tools/lazy-deps.js LAZY_PACKAGES) the server's MAIN thread resolves,
// in order. A worker thread's own loads are not seen (the hook is registered
// on the main thread only), so a package that a tool loads inside its worker
// pool never shows here. The parent asks over the IPC channel:
//   child.send({ mainPackages: "read", id })  -> { mainPackages: "result", id, seen: [...] }
// Loaded with `node --import ./scripts/lib/main-thread-packages-preload.js src/server.js`
// by a boot that opens the channel.
import module from "node:module";
import { isMainThread } from "node:worker_threads";
import { LAZY_PACKAGES } from "../../src/tools/lazy-deps.js";

const seen = [];
if (isMainThread && typeof process.send === "function") {
  module.registerHooks({
    resolve(specifier, context, next) {
      if (LAZY_PACKAGES.includes(specifier) && !seen.includes(specifier)) seen.push(specifier);
      return next(specifier, context);
    },
  });
  process.on("message", (m) => {
    if (m && typeof m === "object" && m.mainPackages === "read") process.send({ mainPackages: "result", id: m.id, seen: [...seen] });
  });
  process.channel?.unref?.();
}
