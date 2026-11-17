// A busy disk for a test: every synchronous write or rename under `dirs` holds
// the thread `ms` (a runner whose disk was busy with other writes held one
// such write for a 97 ms turn). The node:fs exports are swapped and synced to
// every module's named imports; node:fs/promises is left alone, so a store
// that writes off the loop never waits on it. `stalls` counts the synchronous
// writes that hit; restore() puts the real functions back.
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";

export function stallSyncWrites(dirs, ms) {
  const orig = { writeFileSync: fsModule.writeFileSync, renameSync: fsModule.renameSync };
  let stalls = 0;
  const hit = (p) => dirs.some((d) => String(p).startsWith(d));
  const spin = () => { stalls++; const t = performance.now(); while (performance.now() - t < ms); };
  fsModule.writeFileSync = function (p, ...a) { if (hit(p)) spin(); return orig.writeFileSync.call(this, p, ...a); };
  fsModule.renameSync = function (p, ...a) { if (hit(p)) spin(); return orig.renameSync.call(this, p, ...a); };
  syncBuiltinESMExports();
  return { get stalls() { return stalls; }, restore() { Object.assign(fsModule, orig); syncBuiltinESMExports(); } };
}
