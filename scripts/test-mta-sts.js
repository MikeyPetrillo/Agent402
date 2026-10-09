#!/usr/bin/env node
// The MTA-STS policy text is well-formed for any configuration. Offline.
import { mtaStsPolicy } from "../src/mta-sts.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const lines = (t) => t.split("\r\n").filter(Boolean);
const d = mtaStsPolicy({});
ok(lines(d)[0] === "version: STSv1" && lines(d)[1] === "mode: testing", "defaults: STSv1 in testing mode");
ok(lines(d).filter((l) => l.startsWith("mx: ")).length === 3 && d.includes("mx: mx.zoho.com"), "defaults: the three mail hosts");
ok(/max_age: 86400\r\n$/.test(d), "defaults: one day max_age, CRLF line endings");
ok(lines(mtaStsPolicy({ MTA_STS_MODE: "enforce" }))[1] === "mode: enforce", "mode comes from the environment");
ok(lines(mtaStsPolicy({ MTA_STS_MODE: "bogus" }))[1] === "mode: testing", "an unknown mode falls back to testing, never enforce");
ok(mtaStsPolicy({ MTA_STS_MX: "a.example, B.example ,bad host" }).includes("mx: a.example\r\nmx: b.example\r\n") && !mtaStsPolicy({ MTA_STS_MX: "bad host" }).includes("bad host"), "hosts are trimmed, lowercased, and a malformed one is dropped");
ok(/max_age: 86400\r\n$/.test(mtaStsPolicy({ MTA_STS_MAX_AGE: "60" })) && /max_age: 31557600\r\n$/.test(mtaStsPolicy({ MTA_STS_MAX_AGE: "999999999" })), "max_age is clamped to the RFC range");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
