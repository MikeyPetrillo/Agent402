#!/usr/bin/env node
// Install the OCR language data image-ocr reads (src/tools/ocr-kit.js) into a
// local directory, so the server never fetches a model at request time.
//
//   node scripts/fetch-tessdata.js [dir] [lang ...]
//
// dir defaults to ./tessdata (the path ocr-kit.js reads unless OCR_TESSDATA_DIR
// is set); with no languages every supported one is installed. Each file comes
// from one pinned package version and must match the SHA-256 below before it
// is written, so a build is reproducible and a changed upstream file fails it.
// The Dockerfile runs this at image build time. Standalone on purpose (node
// built-ins only): the Dockerfile runs it before src/ is copied.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TESSDATA_PACKAGE_VERSION = "1.0.0";
export const TESSDATA_VARIANT = "4.0.0_best_int";
export const TESSDATA_SHA256 = {
  eng: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
  spa: "40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb",
  fra: "d611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255",
  deu: "306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b",
  ita: "f702fcfad297ce028ede3626d1467b67939f23ff23595f9badd54681cf25a4d3",
  por: "dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c",
  nld: "a2d904b6ddc4feb0d31ecfcd7361a554102e7aa2e278c54f4fc029e0d0815571",
  rus: "f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a",
  pol: "a20fdec4ff99d8f8e84c708da3e42a4e935c26863055a0ed88aef5c66a59b91b",
  tur: "384ba0dc28040451b7818d7d60e0a88df0d3003fa5a01d713a468779bc3d8c04",
  chi_sim: "b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c",
  chi_tra: "11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743",
  jpn: "2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88",
  kor: "78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126",
  ara: "f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639",
  hin: "f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07",
  tha: "4550a5505184d1b79cf10416d5b19e643001d95411d5e717954dd26feef3ae74",
  vie: "2284f610f262a1b19ec8df9f196b9ff6ce38ddb4a66329e998941df4b8961c8d",
  ukr: "ea2789a0ad99ff84bfd252a7410a1e8661a7bc5acaa41573d23b54b71446aa4c",
  ell: "e8a293abb398ec479176c1575aef24e2bacb0611c713f3fa996f97f0cd996fb3",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function tessdataUrl(lang) {
  return `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@${TESSDATA_PACKAGE_VERSION}/${TESSDATA_VARIANT}/${lang}.traineddata.gz`;
}

async function install(dir, lang) {
  const want = TESSDATA_SHA256[lang];
  if (!want) throw new Error(`no pinned language data for "${lang}"`);
  const dest = join(dir, `${lang}.traineddata.gz`);
  if (existsSync(dest) && sha256(readFileSync(dest)) === want) return "present";
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(tessdataUrl(lang), { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      // A mismatch is never retried: the pinned file is not what was served.
      if (got !== want) { const e = new Error(`${lang}: SHA-256 ${got} does not match the pin ${want}`); e.fatal = true; throw e; }
      writeFileSync(`${dest}.part`, buf);
      renameSync(`${dest}.part`, dest);
      return "installed";
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
    }
  }
  throw new Error(`${lang}: download failed (${lastErr?.message})`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [dirArg, ...langs] = process.argv.slice(2);
  const dir = resolve(dirArg || "tessdata");
  const list = langs.length ? langs : Object.keys(TESSDATA_SHA256);
  mkdirSync(dir, { recursive: true });
  try {
    for (const lang of list) console.log(`${lang}: ${await install(dir, lang)}`);
    console.log(`tessdata ready in ${dir} (${list.length} language${list.length === 1 ? "" : "s"})`);
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
}
