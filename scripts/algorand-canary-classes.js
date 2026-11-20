#!/usr/bin/env node
// The Algorand rail canary's alert text: the failure classes the run's report
// names (scripts/algorand-rail-canary.js writes `failedClasses`), each with
// what it means, so the issue lists only what actually failed. A report that
// cannot be read lists every class, so the alert still says what to look for.
//
//   node scripts/algorand-canary-classes.js rail-report.json
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CLASS_TEXT = {
  "rail-failure": "**rail failure**: we signed a valid AVM payment and still got a 402, so settlement was refused (facilitator, accept, validity window, or USDC opt-in).",
  "tool-failure": "**tool failure**: the payment path was fine but the handler did not deliver a payload. A >=400 cancels settlement, so no buyer was charged.",
  "unexpected-missing-accept": "**unexpected missing accept**: a tool that is not wallet-keyed stopped offering an `algorand:*` accept, meaning the rail silently went away for it.",
  "charged-no-answer": "**charged with no answer**: a paid request got no HTTP answer and its payment landed on chain, or could not be ruled out.",
  "no-answer": "**no answer**: a paid request got no HTTP answer on its last attempt; its payment is not on chain.",
  "charged-empty": "**charged, empty answer**: a 200 with an empty or unreadable body, after settlement.",
  "aborted": "**sweep aborted**: the sweep stopped before measuring every tool.",
};

export function classesText(report) {
  const named = Array.isArray(report?.failedClasses) ? report.failedClasses.filter((c) => CLASS_TEXT[c]) : [];
  const list = named.length ? named : Object.keys(CLASS_TEXT);
  const lead = named.length ? `Failed on this run (${named.length}):` : "The report could not be read; the classes a run can fail on:";
  return [lead, ...list.map((c) => `- ${CLASS_TEXT[c]}`)].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report = null;
  try { report = JSON.parse(readFileSync(process.argv[2] || "rail-report.json", "utf8")); } catch { /* unreadable: every class */ }
  console.log(classesText(report));
}
