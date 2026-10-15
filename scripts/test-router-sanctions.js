#!/usr/bin/env node
// The router must never sign a payment to a sanctioned address.
//
// We buy from external sellers with our own wallet to resell, and until
// now nothing asked where that money was going. This is the check, placed
// against the ONE accept about to be signed rather than against an origin's
// advertised address - the 402 is the instruction, the listing is a claim.
//
// The interesting half is what it does when it does NOT know. A list that
// failed to load must not stop every external payment this host makes: that is
// an outage wearing compliance clothes, and a screening gate that takes the
// router down when Treasury changes a URL is worse than one honest about its
// gaps. So a MATCH refuses and everything else proceeds, loudly. Both halves
// are pinned here, because the second is the one somebody will later mistake
// for a bug and "fix".
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
const kit = readFileSync(new URL("../src/tools/sanctions-kit.js", import.meta.url), "utf8");

// --- placement: what we verify must be what we sign -------------------------
{
  const i = buyer.indexOf("screenAddressForPayment(payable.payTo)");
  ok(i > 0, "the screen runs against `payable.payTo` - the single accept about to be signed, not an origin's advertised address");
  ok(i < buyer.indexOf("const signable ="), "...and BEFORE anything is signed");
  ok(i > buyer.indexOf("provenPayToMatches({ provenPayTo"), "beside the other pay-time gates, which all key off the same pinned accept");
}

// --- a match refuses, and the refusal is not swallowed -----------------------
{
  const blk = buyer.slice(buyer.indexOf("SANCTIONS: never sign"), buyer.indexOf("SOLANA PROVEN-SELLER GATE"));
  ok(/e\.sanctioned = true;/.test(blk) && /if \(e\?\.sanctioned\) throw e;/.test(blk),
     "the refusal is re-thrown from the catch: a try/catch around a security check that swallows its own refusal is the defect this shape invites");
  ok(/403/.test(blk), "a sanctioned payee is a 403, distinct from the 502s that mean a seller misbehaved");
  ok(/Nothing was signed/.test(blk), "and the message says plainly that no payment went out");
  ok(/String\(payable\.payTo\)\.slice\(0, 64\)/.test(blk) && /slice\(0, 80\)/.test(blk),
     "every interpolated value is length-bounded - this message is relayed to buyers and read by operators, and the entity name comes from a third-party file");
}

// --- UNKNOWN proceeds, loudly, and is never a clearance ---------------------
{
  const blk = buyer.slice(buyer.indexOf("SANCTIONS: never sign"), buyer.indexOf("SOLANA PROVEN-SELLER GATE"));
  ok(/FAILS OPEN ON UNKNOWN/.test(blk), "the source states the choice rather than leaving it to be inferred from a catch block");
  ok(/outage disguised as compliance|outage wearing compliance/i.test(blk),
     "...and says WHY: failing closed would stop every external payment when a download fails");
  ok(/console\.warn/.test(blk) && /proceeding unscreened/.test(blk),
     "an unscreened payment says so in the log - a screening gate that has quietly stopped screening must be visible");
  ok(!/verdict|clearance|clean/i.test(blk.split("console.warn")[1] || ""), "and the unknown path claims nothing about the address");
}

// --- the router-facing primitive throws where the TOOL returns a verdict ----
{
  ok(/export async function screenAddressForPayment/.test(kit), "the router has its own entry point rather than reusing the tool handler");
  const fn = kit.slice(kit.indexOf("export async function screenAddressForPayment"), kit.indexOf("/** Warm the list at boot"));
  ok(/if \(!state\.fetchedAt\) throw new Error/.test(fn),
     "it THROWS when the list is not loaded: the router cannot be handed a null meaning both 'not listed' and 'we have no list', because those lead to opposite actions");
  ok(!/await loadSanctions/.test(fn),
     "and it never fetches - a payment path must not wait on a ~30MB download; it reads the copy the boot warmer maintains");
  ok(/state\.addresses\.get\(key\) \|\| null/.test(fn), "a match returns the SDN entry so the refusal can name who it belongs to");
  ok(/normalizeAddress\(address\)/.test(fn), "the address is normalised first, so a checksummed payTo matches a lowercase listing");
}

// --- driven: the router's screen against the XML list, every address ---------
// The long fixture entry carries 60 Digital Currency Addresses, the shape the
// CSV export cut short; the router must refuse every one of them, including
// the base58 ones listed under a ticker outside CASE_SENSITIVE (a Tron address
// under USDT), which it looks up with no asset hint.
{
  const K = await import("../src/tools/sanctions-kit.js");
  const { parseSdnXml } = await import("../src/ofac-sdn.js");
  const LONG = readFileSync(new URL("./fixtures/ofac-sdn-long-entry.xml", import.meta.url), "utf8");
  let threw = false;
  try { await K.screenAddressForPayment("0x1234567890123456789012345678901234567890"); } catch { threw = true; }
  ok(threw, "before the list loads the screen throws (unknown), never answers null");
  await K.loadSanctions({ force: true, fetchImpl: async () => new Response(LONG, { status: 200 }) });
  const big = parseSdnXml(LONG).entries.find((e) => e.uid === "910001");
  const missed = [];
  for (const a of big.addresses) if ((await K.screenAddressForPayment(a.address))?.sdnId !== "910001") missed.push(a.address);
  eq(missed, [], `every one of the ${big.addresses.length} addresses on one long entry is refused`);
  ok((await K.screenAddressForPayment(big.addresses[0].address.toUpperCase().replace(/^0X/, "0x")))?.sdnId === "910001", "a checksummed or upper-case EVM payTo still matches");
  for (const w of ["0x902dCf34E53695bDEA2fFB354b1a2e58bD598256", "0xaF13AA07E7360cC56B3dAbf649fFeF087c0cD5A6", "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0"])
    eq(await K.screenAddressForPayment(w), null, `an unlisted address answers null (${w.slice(0, 6)})`);
}

console.log(`test-router-sanctions: ${n} assertions OK`);
