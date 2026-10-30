// Text helpers for outbound mail, in a module with no state: the senders
// (email.js) and the modules that only build mail (followups, free alerts)
// share them without loading the sender, which reads its status file path at
// import.

// Header material: no control characters (header injection) and a hard length.
export const headerText = (s, n = 100) => String(s ?? "").replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, n);

// Escapes quotes too: these values are text nodes today, but one move into an
// attribute would otherwise be an injection.
export function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
