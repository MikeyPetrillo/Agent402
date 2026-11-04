// Self-serve MPP registration can name the priced path its 402 lives on
// (src/mpp-index.js validateProbeHint / pickProbeTarget / registerMppOrigin
// { path, method }). MPP has no well-known discovery path, so before this a
// seller not yet in the mpp.dev registry could only be probed at "/" and a
// real, working, path-scoped seller failed verification honestly - the
// limitation pickProbeTarget's own comment recorded. Offline: injected
// verifier, scratch seeds file, no network.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mpp-hint-"));
process.env.MPP_SUBMITTED_SEEDS_FILE = join(dir, "seeds.json");
const { validateProbeHint, pickProbeTarget, registerMppOrigin, loadSubmittedSeeds, __testReset, __testResetSubmitted } = await import("../src/mpp-index.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// --- validation -------------------------------------------------------------
ok(!validateProbeHint({}).error && Object.keys(validateProbeHint({})).length === 0, "no hint -> empty, no error (bare-origin registration unchanged)");
ok(validateProbeHint({ path: "/v1/paid" }).path === "/v1/paid", "a plain path is accepted");
ok(validateProbeHint({ path: "/v1/paid", method: "post" }).method === "POST", "method upper-cased, POST allowed");
ok(/start with \//.test(validateProbeHint({ path: "v1/paid" }).error), "path must start with /");
ok(/query|fragment|whitespace/.test(validateProbeHint({ path: "/v1/paid?x=1" }).error), "no query strings");
ok(/\.\./.test(validateProbeHint({ path: "/v1/../admin" }).error) || validateProbeHint({ path: "/v1/../admin" }).error, "no dot-dot segments");
ok(validateProbeHint({ path: "/" + "a".repeat(200) }).error, "path length capped");
ok(/GET or POST/.test(validateProbeHint({ method: "DELETE" }).error), "only GET/POST");
ok(validateProbeHint({ path: "/v1/x y" }).error, "whitespace rejected");

// --- probe target: registry endpoints win, then the hint, then the root ------
const O = "https://newseller.example";
ok(pickProbeTarget(O, null, null).url === O && pickProbeTarget(O, null, null).method === "GET", "no registry row, no hint -> bare origin root, GET");
ok(pickProbeTarget(O, null, { path: "/v1/paid", method: "POST" }).url === `${O}/v1/paid` && pickProbeTarget(O, null, { path: "/v1/paid", method: "POST" }).method === "POST", "no registry row + hint -> the hinted path/method");
ok(pickProbeTarget(O, { endpoints: [{ method: "GET", path: "/from-registry" }] }, { path: "/v1/paid" }).url === `${O}/from-registry`, "a registry row's own endpoints win over the hint");

// --- registration threads the hint to the probe, keeps it only on success ----
__testReset();
const seen = [];
const verifyRecordingTarget = (verified) => async (origin) => {
  const t = pickProbeTarget(origin, null); // what the real verifier would probe
  seen.push(t);
  return { origin, name: "Ext", verified, verifiedAt: verified ? Date.now() : null, lastProbeError: verified ? null : "no WWW-Authenticate: Payment challenge on the probed endpoint" };
};
let r = await registerMppOrigin(O, { verify: verifyRecordingTarget(true), path: "/v1/paid", method: "POST" });
ok(r.listed === true, "registration with a hint lists on a successful probe");
ok(seen.at(-1).url === `${O}/v1/paid` && seen.at(-1).method === "POST", "the probe targeted the hinted path + method (not the root)");
ok(pickProbeTarget(O, null).url === `${O}/v1/paid`, "the hint sticks for the crawler's re-probes after it verified");
r = await registerMppOrigin("https://bad.example", { verify: verifyRecordingTarget(true), path: "no-slash" });
ok(r.listed === false && /start with \//.test(r.error) && seen.length === 1, "an invalid hint is refused BEFORE any probe (verifier not invoked)");
r = await registerMppOrigin("https://dead.example", { verify: verifyRecordingTarget(false), path: "/nope" });
ok(r.listed === false && pickProbeTarget("https://dead.example", null).url === "https://dead.example", "a hint that did not verify is dropped (the crawler will not re-probe a wrong path forever)");

// --- persistence: hints ride the seeds file, both shapes load ---------------
const onDisk = JSON.parse(readFileSync(process.env.MPP_SUBMITTED_SEEDS_FILE, "utf8"));
ok(onDisk.some((row) => row && row.origin === O && row.path === "/v1/paid" && row.method === "POST"), "the verified hint is persisted with its seed");
writeFileSync(process.env.MPP_SUBMITTED_SEEDS_FILE, JSON.stringify(["https://legacy.example", { origin: O, path: "/v1/paid", method: "POST" }, { origin: "https://junk.example", path: "bad path" }]));
__testResetSubmitted();
loadSubmittedSeeds();
ok(pickProbeTarget("https://legacy.example", null).url === "https://legacy.example", "legacy bare-string seeds still load (probe at root)");
ok(pickProbeTarget(O, null).url === `${O}/v1/paid` && pickProbeTarget(O, null).method === "POST", "object seeds restore their hint");
ok(pickProbeTarget("https://junk.example", null).url === "https://junk.example", "an invalid persisted hint is ignored, the seed still loads");

__testReset();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
