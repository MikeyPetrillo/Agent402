// yaml-to-json measures how large its JSON answer becomes once YAML aliases
// are written out, and refuses with a 400 before serializing an answer past
// the cap. A few hundred bytes of nested aliases must not produce a huge
// response or hold the event loop; ordinary anchors and aliases still work.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { KIT } from "../src/tools/kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = KIT.find((t) => t.slug === "yaml-to-json");
const run = (yaml) => { try { return { out: tool.handler({ yaml }) }; } catch (e) { return { err: e }; } };

// Nine levels, nine aliases each: about 9^9 leaves once expanded.
const levels = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
let bomb = 'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n';
for (let i = 1; i < levels.length; i++) {
  const p = levels[i - 1];
  bomb += `${levels[i]}: &${levels[i]} [*${p},*${p},*${p},*${p},*${p},*${p},*${p},*${p},*${p}]\n`;
}
ok(bomb.length < 600, `the bomb is a small body (${bomb.length} bytes)`);
const t0 = Date.now();
const r = run(bomb);
let bytes = 0;
if (r.out) { try { bytes = JSON.stringify(r.out).length; } catch { bytes = Infinity; } }
const ms = Date.now() - t0;
ok(r.err && r.err.statusCode === 400, `the alias bomb answers 400 (got ${r.err ? r.err.statusCode + " " + r.err.message : "200 with " + bytes + " bytes"})`);
ok(r.err && /expands past/.test(r.err.message), "the refusal says the aliases expand past the cap");
ok(ms < 1000, `refused quickly (${ms} ms)`);

// The cap is on the answer's bytes as written: a 3-byte character is 3, a
// control character's escape 6. 20,000 CJK characters aliased 90 times are
// 1.8 million characters but 5.4 MB of JSON, so they are refused.
const cjk = `a: &a "${"\u4e00".repeat(20_000)}"\nb: [${Array(90).fill("*a").join(",")}]\n`;
const rc = run(cjk);
ok(cjk.length < 100_000 && rc.err?.statusCode === 400 && /expands past/.test(rc.err.message), `aliases of a multi-byte string are measured in bytes (${rc.err ? rc.err.statusCode : "served " + Buffer.byteLength(JSON.stringify(rc.out)) + " bytes"})`);
const ctl = `a: &a "${"\\x01".repeat(5_000)}"\nb: [${Array(80).fill("*a").join(",")}]\n`;
const rx = run(ctl);
ok(ctl.length < 100_000 && rx.err?.statusCode === 400, `aliases of a control-character string are measured as their escapes (${rx.err ? rx.err.statusCode : "served " + Buffer.byteLength(JSON.stringify(rx.out)) + " bytes"})`);
const cjkSmall = `a: &a "${"\u4e00".repeat(2_000)}"\nb: [${Array(90).fill("*a").join(",")}]\n`;
ok(run(cjkSmall).out?.json.b.length === 90, "control: the same aliases of a shorter string are served");

// A shallow bomb that stays under the cap is served in full.
const small = 'a: &a [1,2,3]\nb: &b [*a,*a,*a]\nc: [*b,*b]\n';
const s = run(small);
ok(s.out && JSON.stringify(s.out.json.c) === JSON.stringify([[[1, 2, 3], [1, 2, 3], [1, 2, 3]], [[1, 2, 3], [1, 2, 3], [1, 2, 3]]]), "ordinary aliases still expand into the JSON");

// The published example still answers.
const ex = run("name: Ada\ntags:\n  - eng");
ok(ex.out && ex.out.json.name === "Ada" && ex.out.json.tags[0] === "eng", "the published example still answers");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
