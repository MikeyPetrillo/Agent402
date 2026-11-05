// heartbeat.yml's tool, upstream and facilitator failure step, run as
// written against stubbed curl and gh (nothing reaches production or GitHub).
//
// Each word must page on its bad words, close on ok and do nothing on
// unknown. The issues are public: a body carries the word and the operator
// endpoint only, never a slug, a count, an upstream, a facilitator or a
// funding reason, and the step never reads the operator endpoint. The status
// Worker carries the same three titles, mapping and bodies.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.error(`FAIL - ${name}: ${e?.stack || e}`); }
}

const wf = yamlLoad(await readFile(new URL("../.github/workflows/heartbeat.yml", import.meta.url), "utf8"));
const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []);
const step = steps.find((s) => String(s.name || "").startsWith("Tool, upstream and facilitator failure checks"));
const TITLES = {
  toolFailures: "toolFailures: a tool is answering 5xx to buyers",
  upstreamHealth: "upstreamHealth: an upstream is timing out or failing",
  facilitatorFunds: "facilitatorFunds: a facilitator refused settlement",
  // facilitatorFunds=low (a settlement signer short of gas) has its own title.
  facilitatorGas: "facilitatorFunds: a facilitator's settlement gas is running low or could not be read",
  buyerRefusals: "buyerRefusals: a paying buyer was refused by the settle breaker",
};
const titleOf = (field, word) => (field === "facilitatorFunds" && word === "low" ? TITLES.facilitatorGas : TITLES[field]);
const fieldOf = (key) => (key === "facilitatorGas" ? "facilitatorFunds" : key);

const dir = await mkdtemp(path.join(tmpdir(), "hb-fail-"));
await writeFile(path.join(dir, "curl"), `#!/usr/bin/env bash
url=""; for a in "$@"; do case "$a" in http*) url="$a";; esac; done
case "$url" in
  */api/gateway-status) cat "$GS_FILE";;
  */__operator/tool-failures.json) cat "$OP_FILE";;
esac
`);
await writeFile(path.join(dir, "gh"), `#!/usr/bin/env bash
if [ "$1 $2" = "issue view" ]; then printf '%s' "$OPEN_BODY"; exit 0; fi
if [ "$1 $2" = "issue list" ] && [ -n "$ISSUES_JSON" ]; then
  # A fixture list of open issues: the step's own --jq runs over it, as gh would.
  jqx=""; prev=""; for a in "$@"; do [ "$prev" = "--jq" ] && jqx="$a"; prev="$a"; done
  printf '%s' "$ISSUES_JSON" | jq -r "$jqx"; exit 0
fi
if [ "$1 $2" = "issue list" ]; then
  for a in "$@"; do case "$a" in *"$OPEN_TITLE"*) [ -n "$OPEN_TITLE" ] && echo "$OPEN_NUM" && exit 0;; esac; done
  exit 0
fi
printf '%s\\x1f' "$@" >> "$GH_LOG"; printf '\\x1e' >> "$GH_LOG"
`);
await chmod(path.join(dir, "curl"), 0o755);
await chmod(path.join(dir, "gh"), 0o755);

async function run({ gateway, op = null, token = "t", open = null, body = "", issues = null, script = step.run, extraEnv = {} }) {
  const gs = path.join(dir, "gs.json"), opf = path.join(dir, "op.json"), log = path.join(dir, "gh.log");
  await writeFile(gs, JSON.stringify(gateway));
  await writeFile(opf, JSON.stringify(op || {}));
  await writeFile(log, "");
  const r = spawnSync("bash", ["-e", "-c", script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROD: "https://example.invalid", GITHUB_REPOSITORY: "o/r",
      OP_TOKEN: token || "", GS_FILE: gs, OP_FILE: opf, GH_LOG: log, OPEN_TITLE: open || "", OPEN_NUM: "41", OPEN_BODY: body, ISSUES_JSON: issues ? JSON.stringify(issues) : "", ...extraEnv },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const calls = (await readFile(log, "utf8")).split("\x1e").filter((l) => l.trim()).map((l) => l.split("\x1f").filter((x) => x !== ""));
  return { calls, out: r.stdout };
}
const created = (calls) => calls.filter((c) => c[0] === "issue" && c[1] === "create").map((c) => ({ title: c[c.indexOf("--title") + 1], body: c[c.indexOf("--body") + 1] }));
const closed = (calls) => calls.filter((c) => c[0] === "issue" && c[1] === "close");

try {
  await check("the step exists, reads the public words and holds no operator token", () => {
    assert.ok(step, "heartbeat.yml has the step");
    assert.match(step.run, /\/api\/gateway-status/);
    assert.doesNotMatch(step.run, /curl[^\n]*\/__operator\//, "the step never reads the operator endpoint");
    assert.equal(step.env?.OP_TOKEN, undefined, "no operator token in the step");
  });

  const OK = { toolFailures: { status: "ok" }, upstreamHealth: { status: "ok" }, facilitatorFunds: { status: "ok" }, buyerRefusals: { status: "ok" } };
  await check("all ok: nothing opened", async () => {
    const { calls } = await run({ gateway: OK });
    assert.deepEqual(created(calls), []);
  });

  // The operator endpoint holds slugs, upstreams and facilitator reasons; a
  // public body carries none of them even when the token is in the env.
  const OP = { issueSummary: { tools: ["stock-quote (failing)", "render (degraded)"], upstreams: ["databento (degraded)"], facilitatorNetworks: ["eip155:42220"] },
    tools: [{ slug: "stock-quote", hour: { outside5xx: 7 } }], facilitatorRefusals: [{ network: "eip155:42220", facilitator: "SomeVendor", reason: "insufficient settlement funds" }] };
  const PRIVATE = /stock-quote|render \(|databento|SomeVendor|42220|\b7\b|fund|account|free tier|payment method|Failing slugs/i;
  for (const [field, word] of [["toolFailures", "degraded"], ["toolFailures", "failing"], ["upstreamHealth", "degraded"], ["facilitatorFunds", "refused"], ["facilitatorFunds", "demoted"], ["facilitatorFunds", "low"], ["buyerRefusals", "refusing"]]) {
    await check(`${field} ${word}: one issue, the word and the operator endpoint only`, async () => {
      const { calls } = await run({ gateway: { ...OK, [field]: { status: word } }, op: OP });
      const c = created(calls);
      assert.equal(c.length, 1);
      assert.equal(c[0].title, titleOf(field, word));
      assert.match(c[0].body, new RegExp(`${field}\\.status=${word}\\.`));
      assert.match(c[0].body, /\/__operator\/tool-failures\.json/);
      // The word's own field name is the one place "Funds" may appear.
      assert.doesNotMatch(c[0].body.replace(/facilitatorFunds/g, ""), PRIVATE, `no slug, count, upstream, facilitator or funding detail: ${c[0].body}`);
      assert.doesNotMatch(c[0].title.replace(/facilitatorFunds/g, ""), PRIVATE);
    });
  }

  await check("upstreamHealth failing and facilitatorFunds low / refused / demoted page under their own titles", async () => {
    for (const [gw, title] of [[{ upstreamHealth: { status: "failing" } }, TITLES.upstreamHealth], [{ upstreamHealth: { status: "degraded" } }, TITLES.upstreamHealth], [{ facilitatorFunds: { status: "refused" } }, TITLES.facilitatorFunds], [{ facilitatorFunds: { status: "demoted" } }, TITLES.facilitatorFunds], [{ facilitatorFunds: { status: "low" } }, TITLES.facilitatorGas], [{ buyerRefusals: { status: "refusing" } }, TITLES.buyerRefusals]]) {
      const { calls } = await run({ gateway: { ...OK, ...gw } });
      assert.deepEqual(created(calls).map((c) => c.title), [title], JSON.stringify(gw));
    }
  });

  await check("an open issue gets a comment, not a second issue; ok closes it; unknown does neither", async () => {
    let r = await run({ gateway: { ...OK, upstreamHealth: { status: "degraded" } }, open: TITLES.upstreamHealth });
    assert.deepEqual(created(r.calls), []);
    assert.ok(r.calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "41"));
    r = await run({ gateway: OK, open: TITLES.upstreamHealth });
    assert.equal(closed(r.calls).length, 1);
    assert.equal(closed(r.calls)[0][2], "41");
    r = await run({ gateway: { toolFailures: { status: "unknown" } }, open: TITLES.toolFailures });
    assert.equal(closed(r.calls).length, 0);
    assert.deepEqual(created(r.calls), []);
  });

  // The Gateway pending book (src/gateway-nanopayments.js): its own step and
  // title; unresolved and full page, ok and off close, pending does neither.
  const GP_TITLE = "Gateway pending settlements need attention";
  const gpStep = steps.find((s) => String(s.name || "").startsWith("Gateway pending settlements check"));
  await check("gatewayPending: unresolved and full open one issue, ok and off close it, pending and unknown do neither", async () => {
    assert.ok(gpStep, "heartbeat.yml has the Gateway pending step");
    assert.match(gpStep.run, /\.gatewayPending\.status/);
    assert.doesNotMatch(gpStep.run, /curl[^\n]*\/__operator\//, "the step never reads the operator endpoint");
    for (const w of ["unresolved", "full"]) {
      const { calls } = await run({ gateway: { gatewayPending: { status: w } }, script: gpStep.run });
      const c = created(calls);
      assert.deepEqual(c.map((x) => x.title), [GP_TITLE], w);
      assert.match(c[0].body, new RegExp(`gatewayPending\\.status=${w}\\.`));
    }
    let r = await run({ gateway: { gatewayPending: { status: "full" } }, open: GP_TITLE, script: gpStep.run });
    assert.deepEqual(created(r.calls), [], "an open issue gets a comment, not a second issue");
    assert.ok(r.calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "41"));
    for (const w of ["ok", "off"]) {
      r = await run({ gateway: { gatewayPending: { status: w } }, open: GP_TITLE, script: gpStep.run });
      assert.equal(closed(r.calls).length, 1, w);
    }
    for (const w of ["pending", "near_capacity", "unknown"]) {
      r = await run({ gateway: { gatewayPending: { status: w } }, open: GP_TITLE, script: gpStep.run });
      assert.equal(closed(r.calls).length, 0, w);
      assert.deepEqual(created(r.calls), [], w);
    }
    r = await run({ gateway: {}, script: gpStep.run });
    assert.deepEqual(created(r.calls), [], "an older build without the field opens nothing");
    const { ALARMS } = await import("../workers/status-probe/src/index.js");
    assert.ok(ALARMS.some((a) => a.title === GP_TITLE), "the Worker carries the same title");
  });

  // The CDN origin secret (src/cdn-client-ip.js): its own step and title;
  // unauthenticated pages, ok and off close, unknown and absent do neither,
  // and the body names no address or count.
  const CDN_TITLE = "CDN origin secret: edge traffic reached the origin unauthenticated";
  const cdnStep = steps.find((s) => String(s.name || "").startsWith("CDN origin secret check"));
  await check("cdnOrigin: unauthenticated opens one issue, ok and off close it, unknown and absent do neither", async () => {
    assert.ok(cdnStep, "heartbeat.yml has the CDN origin step");
    assert.match(cdnStep.run, /\.cdnOrigin\.status/);
    assert.doesNotMatch(cdnStep.run, /curl[^\n]*\/__operator\//, "the step never reads the operator endpoint");
    assert.equal(cdnStep.env?.OP_TOKEN, undefined, "no operator token in the step");
    const { calls } = await run({ gateway: { cdnOrigin: { status: "unauthenticated" } }, script: cdnStep.run });
    const c = created(calls);
    assert.deepEqual(c.map((x) => x.title), [CDN_TITLE]);
    assert.match(c[0].body, /cdnOrigin\.status=unauthenticated/);
    assert.match(c[0].body, /CDN_ORIGIN_SECRET/);
    assert.doesNotMatch(c[0].body, /\b\d{1,3}(\.\d{1,3}){3}\b/, "no address in the body");
    let r = await run({ gateway: { cdnOrigin: { status: "unauthenticated" } }, open: CDN_TITLE, script: cdnStep.run });
    assert.deepEqual(created(r.calls), [], "an open issue gets a comment, not a second issue");
    assert.ok(r.calls.some((x) => x[0] === "issue" && x[1] === "comment" && x[2] === "41"));
    for (const w of ["ok", "off"]) {
      r = await run({ gateway: { cdnOrigin: { status: w } }, open: CDN_TITLE, script: cdnStep.run });
      assert.equal(closed(r.calls).length, 1, w);
    }
    r = await run({ gateway: { cdnOrigin: { status: "unknown" } }, open: CDN_TITLE, script: cdnStep.run });
    assert.equal(closed(r.calls).length, 0);
    assert.deepEqual(created(r.calls), []);
    r = await run({ gateway: {}, script: cdnStep.run });
    assert.deepEqual(created(r.calls), [], "an older build without the field opens nothing");
    const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
    assert.ok(ALARMS.some((a) => a.title === CDN_TITLE), "the Worker carries the same title");
    const j = (gw) => judge({ gateway: gw })[CDN_TITLE];
    assert.equal(j({ cdnOrigin: { status: "unauthenticated" } }), "bad");
    assert.equal(j({ cdnOrigin: { status: "ok" } }), "good");
    assert.equal(j({ cdnOrigin: { status: "off" } }), "good");
    assert.equal(j({ cdnOrigin: { status: "unknown" } }), "quiet");
    assert.equal(j({}), "quiet");
    assert.match(ALARMS.find((a) => a.title === CDN_TITLE).body({ gateway: { cdnOrigin: { status: "unauthenticated" } } }), /cdnOrigin\.status=unauthenticated/);
  });

  // Listings failing to read across many origins (src/x402-index.js): its own
  // step and title; widespread pages, ok closes, unknown and absent do
  // neither, and the body names no origin or count.
  const BL_TITLE = "brokenListings: seller listings are failing to read across many origins";
  const blStep = steps.find((s) => String(s.name || "").startsWith("Broken listings check"));
  await check("brokenListings: widespread opens one issue, ok closes it, unknown and absent do neither", async () => {
    assert.ok(blStep, "heartbeat.yml has the broken listings step");
    assert.match(blStep.run, /\.brokenListings\.status/);
    assert.doesNotMatch(blStep.run, /curl[^\n]*\/__operator\//, "the step never reads the operator endpoint");
    assert.equal(blStep.env?.OP_TOKEN, undefined, "no operator token in the step");
    const { calls } = await run({ gateway: { brokenListings: { status: "widespread" } }, script: blStep.run });
    const c = created(calls);
    assert.deepEqual(c.map((x) => x.title), [BL_TITLE]);
    assert.match(c[0].body, /brokenListings\.status=widespread/);
    assert.match(c[0].body, /\/__operator\/perf\.json/);
    assert.doesNotMatch(c[0].body.replace("last 15 minutes", ""), /https?:\/\/|\d/, "no origin or count in the body (the window is the one figure)");
    let r = await run({ gateway: { brokenListings: { status: "widespread" } }, open: BL_TITLE, script: blStep.run });
    assert.deepEqual(created(r.calls), [], "an open issue gets a comment, not a second issue");
    assert.ok(r.calls.some((x) => x[0] === "issue" && x[1] === "comment" && x[2] === "41"));
    for (const gw of [{ brokenListings: { status: "unknown" } }, {}]) {
      r = await run({ gateway: gw, open: BL_TITLE, script: blStep.run });
      assert.equal(closed(r.calls).length, 0, JSON.stringify(gw));
      assert.deepEqual(created(r.calls), [], JSON.stringify(gw));
    }
    const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
    const a = ALARMS.find((x) => x.title === BL_TITLE);
    assert.ok(a, "the Worker carries the same title");
    assert.equal(a.body({}), c[0].body, "the Worker's body is the step's body");
    const j = (gw) => judge({ gateway: gw })[BL_TITLE];
    assert.equal(j({ brokenListings: { status: "widespread" } }), "bad");
    assert.equal(j({ brokenListings: { status: "ok" } }), "good");
    assert.equal(j({ brokenListings: { status: "unknown" } }), "quiet");
    assert.equal(j({}), "quiet");
  });

  // containedTurns and brokenListings close on the second consecutive ok
  // read: their words live in memory, so a restart reads ok at once. The
  // first ok read leaves a mark line in the issue body, a bad read removes
  // it, an ok read that finds it closes.
  const CT_TITLE = "containedTurns: a scheduled turn is throwing every minute";
  const ctStep = steps.find((s) => String(s.name || "").startsWith("Contained turn check"));
  const edited = (calls) => calls.filter((c) => c[0] === "issue" && c[1] === "edit").map((c) => c[c.indexOf("--body") + 1]);
  for (const [field, badWord, title, st] of [["containedTurns", "repeating", CT_TITLE, ctStep], ["brokenListings", "widespread", BL_TITLE, blStep]]) {
    await check(`${field}: closes only on the second ok read in a row; a bad read between starts the count again`, async () => {
      assert.ok(st, `heartbeat.yml has the ${field} step`);
      const ISSUE = `/api/gateway-status reports ${field}.status=${badWord}: details.`;
      // First ok read: marked, not closed.
      let r = await run({ gateway: { [field]: { status: "ok" } }, open: title, body: ISSUE, script: st.run });
      assert.equal(closed(r.calls).length, 0, "one ok read does not close");
      const marked = edited(r.calls);
      assert.equal(marked.length, 1, "the first ok read marks the issue body");
      assert.ok(marked[0].startsWith(ISSUE + "\n\nFirst ok read at "), JSON.stringify(marked[0]));
      // Second ok read: closes.
      r = await run({ gateway: { [field]: { status: "ok" } }, open: title, body: marked[0], script: st.run });
      assert.equal(closed(r.calls).length, 1, "the second ok read in a row closes");
      assert.deepEqual(edited(r.calls), []);
      // ok, bad, ok: the bad read removes the mark, so the next ok only marks again.
      r = await run({ gateway: { [field]: { status: badWord } }, open: title, body: marked[0], script: st.run });
      assert.deepEqual(edited(r.calls), [ISSUE], "a bad read removes the mark line");
      assert.equal(closed(r.calls).length, 0);
      assert.deepEqual(created(r.calls), []);
      r = await run({ gateway: { [field]: { status: badWord } }, open: title, body: ISSUE, script: st.run });
      assert.deepEqual(edited(r.calls), [], "a bad read with no mark edits nothing");
      // unknown neither marks nor closes nor unmarks.
      for (const b of [ISSUE, marked[0]]) {
        r = await run({ gateway: { [field]: { status: "unknown" } }, open: title, body: b, script: st.run });
        assert.equal(closed(r.calls).length + edited(r.calls).length + created(r.calls).length, 0);
      }
      const { CLEARING_MARK } = await import("../workers/status-probe/src/index.js");
      assert.ok(st.run.includes(`MARK="${CLEARING_MARK}"`), "the step's mark is the status Worker's, so either observer's ok read counts");
    });
  }

  // The lookup takes only an issue with exactly the alarm title opened by the
  // workflow bot or the repository owner (the status Worker's rule), and the
  // mark counts only after a blank line (where the Worker writes and reads it).
  for (const [field, badWord, title, st] of [["containedTurns", "repeating", CT_TITLE, ctStep], ["brokenListings", "widespread", BL_TITLE, blStep]]) {
    await check(`${field}: the issue lookup is the alarm author's exact title only; the mark counts only after a blank line`, async () => {
      const ISSUE = `/api/gateway-status reports ${field}.status=${badWord}: details.`;
      const outsider = { number: 7, title, author: { login: "someone-else" } };
      const near = { number: 8, title: `${title} (copy)`, author: { login: "app/github-actions" } };
      // An outsider's issue with the exact title: a bad read still opens ours, an ok read closes nothing.
      let r = await run({ gateway: { [field]: { status: badWord } }, issues: [outsider, near], script: st.run });
      assert.deepEqual(created(r.calls).map((c) => c.title), [title], "an outsider's or a near-title issue does not suppress the alarm");
      r = await run({ gateway: { [field]: { status: "ok" } }, issues: [outsider], body: `${ISSUE}\n\nFirst ok read at x`, script: st.run });
      assert.equal(closed(r.calls).length + edited(r.calls).length, 0, "an outsider's issue is never marked or closed");
      // The workflow bot (either spelling gh may print) and the owner (any case) are the alarm.
      for (const login of ["github-actions[bot]", "app/github-actions", "O"]) {
        r = await run({ gateway: { [field]: { status: "ok" } }, issues: [outsider, { number: 41, title, author: { login } }], body: `${ISSUE}\n\nFirst ok read at x`, script: st.run });
        assert.equal(closed(r.calls).length, 1, login);
        assert.equal(closed(r.calls)[0][2], "41", login);
      }
      // The mark text anywhere but after a blank line is not a first ok read.
      r = await run({ gateway: { [field]: { status: "ok" } }, open: title, body: `${ISSUE} First ok read at x`, script: st.run });
      assert.equal(closed(r.calls).length, 0, "an inline mark does not close");
      assert.equal(edited(r.calls).length, 1, "it marks instead");
      const { WORKFLOW_BOT_LOGIN } = await import("../workers/status-probe/src/index.js");
      assert.equal(WORKFLOW_BOT_LOGIN, "github-actions[bot]");
      assert.ok(st.run.includes(`"${WORKFLOW_BOT_LOGIN}"`), "the step names the Worker's bot login");
    });
  }

  await check("the status Worker maps the same three words under the same titles", async () => {
    const { ALARMS, judge } = await import("../workers/status-probe/src/index.js");
    for (const t of Object.values(TITLES)) assert.ok(ALARMS.some((a) => a.title === t), `Worker has "${t}"`);
    const j = (gw) => judge({ gateway: gw });
    for (const w of ["degraded", "failing"]) {
      assert.equal(j({ toolFailures: { status: w } })[TITLES.toolFailures], "bad");
      assert.equal(j({ upstreamHealth: { status: w } })[TITLES.upstreamHealth], "bad");
    }
    for (const w of ["refused", "demoted"]) {
      assert.equal(j({ facilitatorFunds: { status: w } })[TITLES.facilitatorFunds], "bad");
      assert.equal(j({ facilitatorFunds: { status: w } })[TITLES.facilitatorGas], "quiet", `${w} is not a gas page`);
    }
    assert.equal(j({ facilitatorFunds: { status: "low" } })[TITLES.facilitatorGas], "bad");
    assert.equal(j({ facilitatorFunds: { status: "low" } })[TITLES.facilitatorFunds], "quiet", "low is not a refusal page");
    for (const t of Object.keys(TITLES)) {
      assert.equal(j({ [fieldOf(t)]: { status: "ok" } })[TITLES[t]], "good");
      assert.equal(j({ [fieldOf(t)]: { status: "unknown" } })[TITLES[t]], "quiet");
      assert.equal(j({})[TITLES[t]], "quiet");
    }
    const body = ALARMS.find((a) => a.title === TITLES.toolFailures).body({ gateway: { toolFailures: { status: "<b>" } } });
    assert.match(body, /toolFailures\.status=degraded/, "the body echoes only a known word");
    assert.match(body, /\/__operator\/tool-failures\.json/);
    assert.equal(j({ buyerRefusals: { status: "refusing" } })[TITLES.buyerRefusals], "bad");
    for (const [field, word] of [["toolFailures", "failing"], ["upstreamHealth", "degraded"], ["facilitatorFunds", "refused"], ["facilitatorFunds", "demoted"], ["facilitatorFunds", "low"], ["buyerRefusals", "refusing"]]) {
      const b = ALARMS.find((a) => a.title === titleOf(field, word)).body({ gateway: { [field]: { status: word } } });
      assert.match(b, new RegExp(`${field}\\.status=${word}\\.`));
      assert.doesNotMatch(b.replace(/facilitatorFunds/g, ""), /fund|account|free tier|payment method|slug/i, `the Worker body for ${field} carries no detail: ${b}`);
    }
  });

  // "Paywall not observed": the heartbeat opens it, the status Worker closes
  // it. Run after run of refused reads (a mismatched POW_SECRET) keeps ONE
  // issue: an open alarm (exact title, the workflow bot or the owner) gets a
  // comment; only an outsider's or a near-title issue leaves it to open ours.
  await check("Paywall not observed: an open alarm gets a comment, never a second issue; an outsider's does not suppress it", async () => {
    const pw = steps.find((s) => String(s.name || "").startsWith("Paywall observation check"));
    assert.ok(pw, "heartbeat.yml has the paywall observation step");
    const T = "Paywall not observed";
    const { PAYWALL_UNOBSERVED_TITLE } = await import("../workers/status-probe/src/index.js");
    assert.equal(PAYWALL_UNOBSERVED_TITLE, T, "the step's title is the Worker's");
    const go = (issues, unknown = "1") => run({ gateway: {}, issues, script: pw.run, extraEnv: { PAYWALL_UNKNOWN: unknown } });
    const commented = (calls) => calls.filter((c) => c[0] === "issue" && c[1] === "comment");
    let r = await go([]);
    assert.deepEqual(created(r.calls).map((c) => c.title), [T], "none open: one issue opened");
    for (const login of ["github-actions[bot]", "app/github-actions", "O"]) {
      r = await go([{ number: 41, title: T, author: { login } }]);
      assert.deepEqual(created(r.calls), [], `open by ${login}: no second issue`);
      assert.equal(commented(r.calls).length, 1, `open by ${login}: one comment`);
      assert.equal(commented(r.calls)[0][2], "41", login);
    }
    r = await go([{ number: 7, title: T, author: { login: "someone-else" } }, { number: 8, title: `${T} (copy)`, author: { login: "github-actions[bot]" } }]);
    assert.deepEqual(created(r.calls).map((c) => c.title), [T], "an outsider's or a near-title issue does not suppress the alarm");
    assert.equal(commented(r.calls).length, 0, "and is never commented on");
    r = await go([{ number: 41, title: T, author: { login: "github-actions[bot]" } }], "0");
    assert.equal(created(r.calls).length + commented(r.calls).length, 0, "an observed paywall read does nothing (the Worker closes)");
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\ntest-heartbeat-failure-words: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
