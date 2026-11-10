// Preload for a server under test: measures, from inside the server's own
// process, the longest time one event-loop turn held the thread, on the clock
// a busy host does not inflate (scripts/lib/ours-clock.js gapMeter). The
// parent drives it over the IPC channel:
//   child.send({ loopGap: "start", id })  -> { loopGap: "started", id }
//   child.send({ loopGap: "stop", id })   -> { loopGap: "result", id, worst, worstWall, reading }
// Loaded with `node --import ./scripts/lib/loop-gap-preload.js src/server.js`
// by a boot that opens the channel (bootServer({ ipc: true })).
import { gapMeter, OURS_READING } from "./ours-clock.js";

let meter = null;
if (typeof process.send === "function") {
  process.on("message", (m) => {
    if (!m || typeof m !== "object") return;
    if (m.loopGap === "start") {
      if (meter) meter.stop();
      meter = gapMeter(2);
      process.send({ loopGap: "started", id: m.id });
    } else if (m.loopGap === "stop") {
      const r = meter ? meter.stop() : { worst: -1, worstWall: -1 };
      meter = null;
      process.send({ loopGap: "result", id: m.id, worst: r.worst, worstWall: r.worstWall, reading: OURS_READING });
    }
  });
  // The channel must not keep a server alive that is shutting down.
  process.channel?.unref?.();
}
