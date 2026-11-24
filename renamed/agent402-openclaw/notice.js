// The one-time notice this forwarding release prints.
const KEY = Symbol.for("agent402.renamed.agent402-openclaw");
if (!globalThis[KEY]) {
  globalThis[KEY] = true;
  try {
    process.emitWarning("agent402-openclaw is renamed to agent402-model-provider (same API): npm i agent402-model-provider, then import from \"agent402-model-provider\". This name gets no further releases.", { type: "DeprecationWarning", code: "AGENT402_PACKAGE_RENAMED" });
  } catch { /* a host without process.emitWarning still gets the forwarded API */ }
}
