// OS-assigned free ports for tests that boot a server.
//
// Why not a fixed or pid-derived number: a pid-derived port can land on a
// number another process on the runner holds, and any number >= 32768 sits in
// Linux's ephemeral range where an outbound socket can already own it - that
// was the tollbooth CLI test's five "silent exit 0" runs (EADDRINUSE, finally
// logged 2026-08-27). Asking the kernel for a port and releasing it leaves a
// small window before the child binds it, which is still far narrower than a
// guess. Prefer PORT=0 + reading the bound port back when the server prints it.
import { createServer } from "node:net";

export async function getFreePort() {
  const probe = createServer();
  const port = await new Promise((resolve, reject) => {
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise((r) => probe.close(r));
  return port;
}

/** n distinct free ports, for tests that boot more than one server. */
export async function getFreePorts(n) {
  const out = new Set();
  while (out.size < n) out.add(await getFreePort());
  return [...out];
}
