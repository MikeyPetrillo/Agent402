import { houseStyleText } from "./house-style.js";

// The one sentence a person reads wherever a model-written report reaches
// them: the /reports storefront, the delivered, sample and public report
// pages (assets/js/report-view.js reads it from the page's data attribute),
// the sample and public report JSON, and the report-ready and monitor emails.
// Defined once so every surface says the same thing.
export const REPORT_MODEL_NOTE = "Written by a language model from live data and public sources. Information only, not investment, medical or legal advice.";

// Report kinds whose text is assembled by code from the data itself (the IPO
// pipeline digest is built from the EDGAR filing index). Every other report
// kind is synthesized by a model and carries REPORT_MODEL_NOTE.
export const CODE_WRITTEN_REPORT_KINDS = Object.freeze(["ipo"]);

/** True when a report of this kind is written by a model. An unknown or
 *  missing kind counts as model-written, so a new kind is labeled by default. */
export function reportIsModelWritten(kind) {
  return !CODE_WRITTEN_REPORT_KINDS.includes(String(kind || ""));
}

/** A kit's own disclaimer (meta.disclaimer) as a short display string in
 *  house style, or null. */
export function kitDisclaimer(out) {
  const d = out?.meta?.disclaimer ?? out?.disclaimer;
  return typeof d === "string" && d.trim() ? houseStyleText(d.trim()).slice(0, 400) : null;
}
