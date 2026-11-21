#!/usr/bin/env node
// The paid-route contract sweep (scripts/test-bazaar-contracts.js) run again
// with the returning-wallet price on (RETURNING_WALLET_PRICE=on,
// src/returning-wallet.js). With the switch on every eligible route's 402 body
// also carries `returningWalletPrice`, and that field once pushed three
// routes' own fields past the sweep's byte bound while every lane was green:
// no lane ran the sweep with the switch on. This is that pass. The sweep
// itself names an unused wallet on every request while the switch is on, so
// the body it measures is the widest the offer takes on an unpaid request,
// and it fails when fewer routes carry the offer than it expects.
//
//   node scripts/test-bazaar-contracts-returning-wallet.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sweep = fileURLToPath(new URL("./test-bazaar-contracts.js", import.meta.url));
const child = spawn(process.execPath, [sweep], { env: { ...process.env, RETURNING_WALLET_PRICE: "on" }, stdio: ["ignore", "pipe", "inherit"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.on("close", (code) => {
  // The pass counts only when the sweep really ran with the offer on its 402s.
  const ran = /^returning-wallet price on: (\d+) routes carry the offer, widest (\d+) bytes$/m.exec(out);
  if (code === 0 && !ran) { console.error("FAIL - the sweep passed without reporting the returning-wallet offer: the switch did not reach it"); process.exit(1); }
  if (code === 0) console.log(`OK: the contract sweep holds with the returning-wallet price on (${ran[1]} routes, offer at most ${ran[2]} bytes)`);
  process.exit(code ?? 1);
});
