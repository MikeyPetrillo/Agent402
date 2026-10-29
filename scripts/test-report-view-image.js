// The report page builds an image preview's src only from an allowlisted
// raster type and a payload that is plain base64 (assets/js/report-view.js
// imageDataUri), so a delivered record can never put markup or another URL
// scheme into the img tag.
//
// Run: node scripts/test-report-view-image.js
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const src = readFileSync(new URL("../assets/js/report-view.js", import.meta.url), "utf8");
const m = src.match(/function imageDataUri\(f\) \{[^\n]*\}/);
ok(!!m, "report-view.js defines imageDataUri on one line");
const imageDataUri = m ? new Function(`${m[0]}; return imageDataUri;`)() : () => "x";

const B64 = Buffer.from("a small jpeg-ish payload!").toString("base64");
ok(imageDataUri({ media_type: "image/jpeg", b64: B64 }) === `data:image/jpeg;base64,${B64}`, "a jpeg with a base64 payload gets a data: URI");
ok(imageDataUri({ b64: B64 }) === `data:image/jpeg;base64,${B64}`, "a missing type defaults to jpeg");
for (const t of ["image/png", "image/webp", "image/gif", "IMAGE/PNG"]) ok(imageDataUri({ media_type: t, b64: B64 }).startsWith(`data:${t.toLowerCase()};base64,`), `allowed type: ${t}`);
for (const t of ["image/svg+xml", "text/html", "image/jpeg;x=1", "image/jpeg\" onerror=\"x", "application/javascript"]) ok(imageDataUri({ media_type: t, b64: B64 }) === "", `refused type: ${t}`);
for (const b of [`${B64}" onerror="alert(1)`, "/9j/4AAQ…", "abc", "", "QUJD\nREVG", "javascript:alert(1)", null, 123]) ok(imageDataUri({ media_type: "image/jpeg", b64: b }) === "", `refused payload: ${JSON.stringify(b)}`);
ok(imageDataUri(null) === "", "no file, no URI");

// The preview uses it, and the button text carries only numbers.
const block = src.slice(src.indexOf("var imgHtml = images.length"), src.indexOf("app.innerHTML = actions"));
ok(/var uri = first \? imageDataUri\(first\) : "";/.test(block) && /'<img src="' \+ esc\(uri\) \+ '"/.test(block), "the image preview's src comes from imageDataUri");
ok(!/first\.b64/.test(block), "the preview never concatenates the raw payload");
ok(/\(Number\(f\.width\) \|\| 0\) \+ "x" \+ \(Number\(f\.height\) \|\| 0\)/.test(block), "the size label is numbers only");

// Links in a report body: anchors only for a cited source's host, and plain
// text whenever there is no allowlist (no sources, or none set yet).
{
  const a = src.indexOf("  var allowedHosts = null;"), b = src.indexOf("  // A markdown pipe table");
  ok(a > 0 && b > a, "report-view.js keeps the link allowlist and inline renderer together");
  const f = new Function(src.slice(a, b) + "; return { setAllowedHosts, inline };")();
  const text = "see https://elsewhere.example/x and [click](https://elsewhere.example/y)";
  ok(!/<a /.test(f.inline(text)), "before any allowlist is set, no link becomes an anchor");
  f.setAllowedHosts(null);
  ok(!/<a /.test(f.inline(text)) && /https:\/\/elsewhere\.example\/x/.test(f.inline(text)), "a report with no sources renders links as plain text");
  f.setAllowedHosts([{ url: "https://cited.example/a" }]);
  const out = f.inline("see https://cited.example/x and https://elsewhere.example/y");
  ok(/<a href="https:\/\/cited\.example\/x"/.test(out) && !/<a href="https:\/\/elsewhere/.test(out), "a cited host links; any other host stays text");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
