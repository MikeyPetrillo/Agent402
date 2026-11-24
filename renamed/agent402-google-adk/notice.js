// The one-time notice this forwarding release prints.
const KEY = Symbol.for("agent402.renamed.agent402-google-adk");
if (!globalThis[KEY]) {
  globalThis[KEY] = true;
  try {
    process.emitWarning("agent402-google-adk is renamed to agent402-dev-kit-tools (same API): npm i agent402-dev-kit-tools, then import from \"agent402-dev-kit-tools\". This name gets no further releases.", { type: "DeprecationWarning", code: "AGENT402_PACKAGE_RENAMED" });
  } catch { /* a host without process.emitWarning still gets the forwarded API */ }
}
