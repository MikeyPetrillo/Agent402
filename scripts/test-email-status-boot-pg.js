// With the state database, the email status row is read at module load and
// the boot awaits it: a container that starts after another one recorded an
// outcome reports that outcome on its first status read, not "unknown".
// Two child processes stand in for the two containers (one records, one boots).
import { spawnSync } from "node:child_process";
import { childJson } from "./lib/child-json.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";

const { schema } = requireTestPg({ label: "test-email-status-boot-pg" });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const DIR = mkdtempSync(join(tmpdir(), "email-boot-"));
const env = {
  ...process.env, STATE_DB_SCHEMA: schema, EMAIL_STATUS_FILE: join(DIR, "email-status.json"),
  EMAIL_FROM: "reports@example.test", RESEND_API_KEY: "test-key-not-used", ZEPTOMAIL_TOKEN: "",
};
const email = new URL("../src/email.js", import.meta.url).href;
const stateDb = new URL("../src/state-db.js", import.meta.url).href;
const node = (code) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 60_000 });

try {
  const w = node(`
    const e = await import(${JSON.stringify(email)});
    const s = await import(${JSON.stringify(stateDb)});
    await s.stateStoresReady();
    e.noteEmailOutcome(false, { status: 429, code: "LE_102", provider: "p" });
    await new Promise((r) => setTimeout(r, 1500));
    await s.closeStateDb();
    console.log("written");
  `);
  ok(/written/.test(w.stdout), `the first container records a refusal (${(w.stderr || "").trim().slice(0, 200)})`);

  const r = node(`
    const e = await import(${JSON.stringify(email)});
    const s = await import(${JSON.stringify(stateDb)});
    await s.stateStoresReady();
    console.log(JSON.stringify(e.emailSendStatus({ full: true })));
    await s.closeStateDb();
  `);
  let st = null;
  try { st = childJson(r.stdout); } catch { /* reported below */ }
  ok(st && st.status === "exhausted" && st.lastCode === "LE_102", `a container that boots later reports it on its first read (got ${r.stdout.trim().slice(0, 200)} ${(r.stderr || "").trim().slice(0, 200)})`);
} finally {
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
