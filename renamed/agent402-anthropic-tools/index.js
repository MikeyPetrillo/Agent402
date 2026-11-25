// agent402-anthropic-tools is renamed to agent402-messages-tools. This last release forwards to it:
// change the dependency and the import specifier; nothing else changes.
import "./notice.js";
export * from "agent402-messages-tools";
export { default } from "agent402-messages-tools";
