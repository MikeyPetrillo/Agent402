// A delivered report drawn on the server, with the viewer's own markup
// function: assets/js/report-view.js defines doneHtml(record, ctx) and, run
// with no DOM, only exposes it. Running that one file here (a VM context
// holding nothing but URL) keeps the server's page and the browser's page one
// renderer, so a sample report reads with no script and no API round trip.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const VIEWER = new URL("../assets/js/report-view.js", import.meta.url);
let viewer = null;
const drawn = new WeakMap();

function load() {
  if (!viewer) {
    const g = { URL };
    runInNewContext(readFileSync(VIEWER, "utf8"), g, { filename: "report-view.js" });
    if (!g.a402ReportView || typeof g.a402ReportView.doneHtml !== "function") throw new Error("report-view.js no longer exposes doneHtml");
    viewer = g.a402ReportView;
  }
  return viewer;
}

/**
 * The finished report's markup, as the viewer draws it.
 * @param {object} record  a done report record (a sample bundle: status "done")
 * @param {object} ctx     { modelNote, codeKinds: string[], monitors: {kind: monitor}, origin }
 * Dates read in en-US, UTC (one reading for every visitor). A record object
 * is drawn once per context (the samples are fixed for the life of the process).
 */
export function reportDoneHtml(record, ctx = {}) {
  const key = JSON.stringify(ctx);
  const hit = record && typeof record === "object" ? drawn.get(record) : null;
  if (hit && hit.key === key) return hit.html;
  const html = load().doneHtml(record, { locale: "en-US", timeZone: "UTC", ...ctx });
  if (record && typeof record === "object") drawn.set(record, { key, html });
  return html;
}
