// agent402-openai-tools is renamed to agent402-function-calling. This last release forwards to it:
// change the dependency and the import specifier; nothing else changes.
import "./notice.js";
export * from "agent402-function-calling";
export { default } from "agent402-function-calling";
