// The one-time notice this forwarding release prints.
const KEY = Symbol.for("agent402.renamed.agent402-anthropic-tools");
if (!globalThis[KEY]) {
  globalThis[KEY] = true;
  try {
    process.emitWarning("agent402-anthropic-tools is renamed to agent402-messages-tools (same API): npm i agent402-messages-tools, then import from \"agent402-messages-tools\". This name gets no further releases.", { type: "DeprecationWarning", code: "AGENT402_PACKAGE_RENAMED" });
  } catch { /* a host without process.emitWarning still gets the forwarded API */ }
}
