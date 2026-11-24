// Tool definition object literals in a kit's source, found without running
// the kit: every object literal whose own top-level keys include route, slug,
// price and category. String-, template- and comment-aware, so a brace inside
// a description or a comment never moves an object's bounds.
//
//   toolDefObjects(src) -> [{ start, end, text, keys: Set<string> }]
export function toolDefObjects(src) {
  const out = [];
  const stack = []; // { start, keys:Set, depth }
  let i = 0;
  const n = src.length;
  // A template literal's ${ ... } is code: its braces are counted on a
  // separate stack so the template resumes where it stopped.
  const tmpl = [];
  const keyAt = (pos) => {
    // A key at the top level of the innermost object: identifier or quoted, then a colon.
    const m = /^\s*(?:"([A-Za-z_$][\w$]*)"|'([A-Za-z_$][\w$]*)'|([A-Za-z_$][\w$]*))\s*:/.exec(src.slice(pos, pos + 80));
    return m ? (m[1] || m[2] || m[3]) : null;
  };
  let expectKey = false;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") { const e = src.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "/" && c2 === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      i = j + 1; expectKey = false; continue;
    }
    if (c === "`" || (c === "}" && tmpl.length && tmpl[tmpl.length - 1] === 0)) {
      if (c === "}") tmpl.pop();
      let j = i + 1;
      let opened = false;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { tmpl.push(0); j += 2; opened = true; break; }
        j++;
      }
      i = opened ? j : j + 1; expectKey = false; continue;
    }
    if (c === "{") {
      if (tmpl.length) tmpl[tmpl.length - 1]++;
      stack.push({ start: i, keys: new Set() });
      i++; expectKey = true; continue;
    }
    if (c === "}") {
      if (tmpl.length) tmpl[tmpl.length - 1]--;
      const o = stack.pop();
      if (o && ["route", "slug", "price", "category"].every((k) => o.keys.has(k))) out.push({ start: o.start, end: i + 1, text: src.slice(o.start, i + 1), keys: o.keys });
      i++; expectKey = false; continue;
    }
    if (c === ",") { expectKey = true; i++; continue; }
    if (expectKey && stack.length && !/\s/.test(c)) {
      const k = keyAt(i);
      if (k) stack[stack.length - 1].keys.add(k);
      expectKey = false;
    }
    i++;
  }
  return out;
}
