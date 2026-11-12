// Sharded test lanes in .github/workflows/deploy.yml.
//
// A long lane runs as a matrix of N shards (`strategy.matrix.shard: [1..N]`),
// each on its own runner with its own services. Shard 1 keeps the lane's own
// name, so the check the ruleset requires by name still reports; shard k > 1
// is named "<lane> (k/N)". `needs.<lane>.result` is the matrix's combined
// result, so deploy and publish gate on every shard without naming them.
//
// Which shard runs a script is a fixed rule, never a draw: the lane's `t`
// helper counts its calls across the whole job and shard k runs call i when
// (i - 1) % N + 1 == k (round robin in step order). A step that runs one
// script outside `t` names its shard with `if: matrix.shard == k`. A script
// that shards its own work (scripts/test-redos-free-tier.js) reads the same
// rule from shardFromEnv() and inShard().
//
// scripts/test-ci-shards.js proves on the workflow itself that every script a
// sharded lane names runs in exactly one shard; scripts/ci-tree-gate.js reads
// laneJobNames() so a skipped main run needs every shard green.

/** The job `name:` a sharded lane must carry (shard 1 keeps the lane's name). */
export const shardJobName = (key, n) =>
  `\${{ matrix.shard == 1 && '${key}' || format('${key} ({0}/${n})', matrix.shard) }}`;

/** Shard count of a job: the length of its matrix.shard list, 1 when it has none. */
export function shardCount(job) {
  const m = job?.strategy?.matrix?.shard;
  return Array.isArray(m) ? m.length : 1;
}

/** The job names GitHub reports for one lane: the key, or one name per shard. */
export function laneJobNames(key, job) {
  const n = shardCount(job);
  if (n <= 1) return [key];
  return [key, ...Array.from({ length: n - 1 }, (_, i) => `${key} (${i + 2}/${n})`)];
}

/** Round robin: does the 0-based item `index` belong to 1-based `shard` of `total`? */
export function inShard(index, shard, total) {
  return index % total === shard - 1;
}

/**
 * This process's shard from CI_SHARD / CI_SHARDS (both unset: the whole run,
 * shard 1 of 1). A value that is not a whole number in range throws, so a
 * mistyped matrix never runs nothing and reports green.
 */
export function shardFromEnv(env = process.env) {
  const rawShard = env.CI_SHARD, rawTotal = env.CI_SHARDS;
  if ((rawShard === undefined || rawShard === "") && (rawTotal === undefined || rawTotal === "")) return { shard: 1, total: 1 };
  const shard = Number(rawShard), total = Number(rawTotal);
  if (!Number.isInteger(shard) || !Number.isInteger(total) || total < 1 || shard < 1 || shard > total) {
    throw new Error(`CI_SHARD=${rawShard} CI_SHARDS=${rawTotal} is not a shard in range`);
  }
  return { shard, total };
}

/** The items that belong to this shard (`{ shard, total }`), in their fixed order. */
export function pickShard(items, { shard, total }) {
  return items.filter((_, i) => inShard(i, shard, total));
}

/** Checks that run once per lane, not once per shard, run in the last shard. */
export function runsSoloChecks({ shard, total }) {
  return shard === total;
}
