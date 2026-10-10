// A TCP relay in front of a test Postgres that a test can cut and heal: point
// STATE_DATABASE_URL at relay.url, call cut() to drop every live connection
// and refuse new ones (an outage), heal() to let them through again.
import { createServer, connect } from "node:net";

export async function startPgRelay(url) {
  const target = new URL(url);
  let cut = false;
  const live = new Set();
  const server = createServer((client) => {
    if (cut) { client.destroy(); return; }
    const up = connect({ host: target.hostname, port: Number(target.port || 5432) });
    live.add(client); live.add(up);
    client.pipe(up); up.pipe(client);
    const drop = () => { client.destroy(); up.destroy(); live.delete(client); live.delete(up); };
    client.on("error", drop); up.on("error", drop); client.on("close", drop); up.on("close", drop);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const auth = target.username ? `${target.username}${target.password ? ":" + target.password : ""}@` : "";
  return {
    url: `${target.protocol}//${auth}127.0.0.1:${port}${target.pathname}${target.search}`,
    cut() { cut = true; for (const s of live) s.destroy(); live.clear(); },
    heal() { cut = false; },
    close() { for (const s of live) s.destroy(); live.clear(); return new Promise((r) => server.close(() => r())); },
  };
}
