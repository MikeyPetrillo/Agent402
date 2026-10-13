// --import preload: records every script compiled before the first macrotask,
// which is the synchronous boot graph of the entry module. Written as JSON to
// BOOT_GRAPH_OUT: { scripts: <count>, bytes: <sum>, packages: { "<name>": <count> } }.
// Used by scripts/test-lazy-deps.js to prove the lazy tool dependencies stay out
// of that graph. The inspector session is closed again once the snapshot is taken.
import inspector from "node:inspector";
import { writeFileSync } from "node:fs";

const out = process.env.BOOT_GRAPH_OUT;
if (out) {
  const session = new inspector.Session();
  session.connect();
  const scripts = [];
  session.on("Debugger.scriptParsed", (m) => { if (m.params.url) scripts.push({ url: m.params.url, length: m.params.length || 0 }); });
  session.post("Debugger.enable");
  setTimeout(() => {
    session.post("Debugger.disable");
    session.disconnect();
    const packages = {};
    let bytes = 0;
    for (const s of scripts) {
      bytes += s.length;
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;
      let last = null, r;
      while ((r = m.exec(s.url))) last = r[1];
      if (last) packages[last] = (packages[last] || 0) + 1;
    }
    writeFileSync(out, JSON.stringify({ scripts: scripts.length, bytes, packages }));
  }, 0);
}
