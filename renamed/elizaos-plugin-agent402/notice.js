// The one-time notice this forwarding release prints.
const KEY = Symbol.for("agent402.renamed.elizaos-plugin-agent402");
if (!globalThis[KEY]) {
  globalThis[KEY] = true;
  try {
    process.emitWarning("elizaos-plugin-agent402 is renamed to agent402-actions-plugin (same API): npm i agent402-actions-plugin, then import from \"agent402-actions-plugin\". This name gets no further releases.", { type: "DeprecationWarning", code: "AGENT402_PACKAGE_RENAMED" });
  } catch { /* a host without process.emitWarning still gets the forwarded API */ }
}
