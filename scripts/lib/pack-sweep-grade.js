// How the skill-pack sweep (scripts/test-pack-examples.js) grades one pack's
// answer to its own published example. Kept here so the rule is driven
// offline with stub tools and a stub upstream (scripts/test-upstream-outage.js).
//
// A step whose source refused (or whose allowance this server spent) answers
// a fixed sentence (us-macro-series' BLS sentences). It is excused by the SAME
// rule the shared lib states (sourceAllowanceVerdict, scripts/lib/upstream-outage.js):
// the step's tool declares the source's host and the runner's own direct read
// of that host is refused too. A step so excused is reported and named; a pack
// whose every step is so excused is reported "blocked by upstream, not ours"
// and named; the same failure while the runner's read succeeds is ours and fails.
//
// A step whose tool declares sources the runner reads for itself
// (declaredSourceVerdict) is graded by that read alone: its words never
// decide, so the same source state gets the same verdict in every pack that
// runs the step. A step whose tool declares no host at all is never excused.
// Every other step keeps the sweep's wording rules (a missing key on the
// keyless boot, a transport failure): no runner read exists for its source.
import { sourceAllowanceVerdict, declaredSourceVerdict, upstreamHostsForSlug, directReadAnswer } from "./upstream-outage.js";

// A pack none of whose steps succeeded answers one error naming each step's
// (src/tools/skill-runner.js): its first step, the one the rest read from,
// is judged like any step. Only that first step is read out of the text.
const NO_STEP = /^No step in the "[^"]+" pack succeeded, so there is nothing to return\.(?: Nothing was charged\.)? ([a-z0-9-]+): ([^]*)$/;

/** The first step { slug, error } of a pack's no-step answer, else null. */
export function firstStepOf(why, toolSlugs) {
  const m = NO_STEP.exec(String(why || ""));
  if (!m) return null;
  const ends = (toolSlugs || []).map((t) => m[2].indexOf(`; ${t}: `)).filter((i) => i >= 0);
  return { slug: m[1], error: ends.length ? m[2].slice(0, Math.min(...ends)) : m[2] };
}

/**
 * A grader for one sweep run. `read` is the runner's direct read (one read of
 * each source URL a run, kept for every step); `root` is the tree whose
 * src/tools/ declares each tool's hosts; `log` takes the evidence lines.
 */
export function createPackGrader({ read = directReadAnswer, root, log = console.log } = {}) {
  const reads = new Map();
  const memoRead = (url) => { if (!reads.has(url)) reads.set(url, read(url)); return reads.get(url); };
  const excused = new Set();
  const keyOf = (s) => `${s.slug}\n${s.error}`;
  // slug -> true (excused) / false (ours): the declared-source verdict, read once a run.
  const decided = new Map();
  const opts = root ? { root } : {};
  const hasHost = (slug) => upstreamHostsForSlug(slug, ...(root ? [root] : [])).size > 0;

  /** Read the source for each failed step that answered a source's fixed
   *  sentence, and note the steps the verdict excuses. */
  async function judge(json, toolSlugs) {
    const first = json?.steps ? null : firstStepOf(json?.error, toolSlugs);
    for (const s of json?.steps || (first ? [first] : [])) {
      if (s.ok || excused.has(keyOf(s)) || decided.has(s.slug)) continue;
      const d = await declaredSourceVerdict({ slug: s.slug, read: memoRead, ...opts });
      if (d) {
        decided.set(s.slug, d.verdict === "upstream");
        log(d.verdict === "upstream" ? `report - ${s.slug}: source refused excused: ${d.evidence}` : `         ${s.slug}: source refusal not excused: ${d.reason}`);
        continue;
      }
      const v = await sourceAllowanceVerdict({ slug: s.slug, error: s.error, read: memoRead, ...opts });
      if (v?.verdict === "upstream") { excused.add(keyOf(s)); log(`report - ${s.slug}: spent allowance excused: ${v.evidence}`); }
      else if (v) log(`         ${s.slug}: spent allowance not excused: ${v.reason}`);
    }
  }
  /** A failed step the source refuses the runner too (judged above). */
  const sourceBlocked = (s) => decided.get(s.slug) === true || excused.has(keyOf(s));
  /** A failed step that is not ours: decided by the declared source's read
   *  where there is one, never for a tool with no host, else a not-ours error
   *  or a source-blocked step. */
  const stepNotOurs = (s, notOurs) => {
    if (decided.has(s.slug)) return decided.get(s.slug);
    if (!hasHost(s.slug)) return false;
    return notOurs.test(String(s.error || "")) || sourceBlocked(s);
  };

  /** True when the answer has no step outside `expectedMisses` that is ours to fail. */
  const isClean = ({ status, json, expectedMisses = [], notOurs }) => status === 200 && !(json?.steps || []).some(
    (s) => !s.ok && !expectedMisses.includes(s.slug) && !stepNotOurs(s, notOurs)
  );

  /**
   * Grade one pack's (judged) answer. Returns { lines, reported, failed }:
   * each line is printed as is, `reported` counts the report-only lines and
   * `failed` is true when the pack fails the sweep.
   */
  function grade({ slug, status, json, toolSlugs, expectedMisses = [], notOurs }) {
    const lines = [];
    let reported = 0;
    if (status !== 200) {
      const why = String(json?.error || "");
      const f = firstStepOf(why, toolSlugs);
      // A no-step answer is its first step's: graded by the step rule above.
      if (f ? !sourceBlocked(f) && stepNotOurs(f, notOurs) : notOurs.test(why)) return { lines: [`report - ${slug}: ${status} upstream/key, not ours`], reported: 1, failed: false };
      if (f && sourceBlocked(f)) return { lines: [`report - ${slug}: blocked by upstream, not ours (no step ran; ${f.slug}: its source refuses the runner's direct read too)`], reported: 1, failed: false };
      return { lines: [`FAIL - ${slug}: HTTP ${status} on its OWN published example - ${why.slice(0, 160)}`], reported: 0, failed: true };
    }
    const steps = json?.steps || [];
    // A step can only be judged on its own merits if what it depends on ran.
    // When an earlier step was blocked by a missing key or an upstream, the
    // steps downstream of it fail for that reason and not for ours.
    const allowed = new Set(expectedMisses);
    const upstream = steps.filter((s) => !s.ok && stepNotOurs(s, notOurs));
    const bad = steps.filter((s) => !s.ok && !allowed.has(s.slug) && !stepNotOurs(s, notOurs));
    if (upstream.length) { lines.push(`report - ${slug}: ${upstream.length} step(s) blocked by a key/upstream, not ours: ${upstream.map((s) => s.slug).join(", ")}`); reported++; }
    if (bad.length && upstream.length) {
      lines.push(`report - ${slug}: ${bad.length} step(s) downstream of an upstream/key failure`);
      return { lines, reported: reported + 1, failed: false };
    }
    if (bad.length) {
      lines.push(`FAIL - ${slug}: ${bad.length} step(s) fail on its OWN published example:`);
      for (const s of bad) lines.push(`         ${s.slug}: ${String(s.error || "").slice(0, 140)}`);
      return { lines, reported, failed: true };
    }
    if (!steps.some((s) => s.ok)) {
      // A pack whose every step is excused is not a working pack, unless every
      // failed step is one the source refuses the runner too: then it is the
      // source's, reported and named, never passed.
      const failedSteps = steps.filter((s) => !s.ok);
      if (failedSteps.length && failedSteps.every(sourceBlocked)) {
        lines.push(`report - ${slug}: blocked by upstream, not ours (every step: ${failedSteps.map((s) => s.slug).join(", ")})`);
        return { lines, reported: reported + 1, failed: false };
      }
      lines.push(`FAIL - ${slug}: no step succeeded on its own example`);
      return { lines, reported, failed: true };
    }
    lines.push(`ok - ${slug}: ${json.summary}`);
    return { lines, reported, failed: false };
  }

  return { judge, isClean, grade, stepNotOurs, sourceBlocked };
}
