// The one-time notice this forwarding release prints.
const KEY = Symbol.for("agent402.renamed.agent402-llamaindex");
if (!globalThis[KEY]) {
  globalThis[KEY] = true;
  try {
    process.emitWarning("agent402-llamaindex is renamed to agent402-function-tools (same API): npm i agent402-function-tools, then import from \"agent402-function-tools\". This name gets no further releases.", { type: "DeprecationWarning", code: "AGENT402_PACKAGE_RENAMED" });
  } catch { /* a host without process.emitWarning still gets the forwarded API */ }
}
