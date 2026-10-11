(function(){
  // Shared self-serve seller registration handler - was duplicated
  // byte-for-byte-ish between sell.js and market-page.js's per-chain pages
  // (CSP hardening, 2026-08-16). The two copies had drifted slightly: only
  // the market-page.js version pluralized "tool"/"tools" correctly, so that
  // behavior now applies everywhere rather than only on chain pages. The
  // trailing "appears on..." sentence differs by page (a chain page names
  // itself, /sell doesn't), so it rides a data-listed-note attribute on
  // #reg-out instead of being baked into the script per page.
  //
  // Extended for the MPP marketplace (2026-08-17) rather than forking a near-
  // duplicate script - the exact anti-pattern the header above already
  // warns about. data-endpoint picks the API (default /api/index/register,
  // the original x402 behavior); the success message reads whichever fields
  // the response actually carries (x402's seller.toolCount vs MPP's
  // seller.verified/categories) instead of assuming one shape.
  var btn = document.getElementById("reg-go");
  if (!btn) return;
  var out = document.getElementById("reg-out");
  var endpoint = btn.getAttribute("data-endpoint") || "/api/index/register";
  btn.addEventListener("click", async function(){
    if (btn.disabled) return;
    btn.disabled = true;
    out.style.color = "var(--muted)";
    out.textContent = "probing…";
    var note = out.getAttribute("data-listed-note") || "Appears on /marketplace and any chain page it advertises.";
    try {
      // Optional probe hint (MPP page only): the priced path the seller's 402
      // lives on. Sent only when the input exists and is non-empty.
      var payload = { origin: document.getElementById("reg-origin").value };
      var pathEl = document.getElementById("reg-path");
      if (pathEl && pathEl.value.trim()) payload.path = pathEl.value.trim();
      var r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      var j = await r.json();
      var s = j.seller || {};
      var name = s.displayName || s.name || j.origin;
      var detail;
      if (typeof s.toolCount === "number") {
        detail = s.toolCount + " tool" + (s.toolCount === 1 ? "" : "s");
      } else if (s.verified != null) {
        detail = "verified" + (Array.isArray(s.categories) && s.categories.length ? " - " + s.categories.join(", ") : "");
      } else {
        detail = "";
      }
      out.style.color = j.listed ? "var(--ok)" : "var(--warn)";
      out.textContent = j.listed
        ? ("Listed - " + name + (detail ? " (" + detail + ")" : "") + ". " + note)
        : ("Not listed: " + (j.error || "unknown error"));
    } catch (e) {
      out.style.color = "var(--bad)";
      out.textContent = "submission failed - try again";
    } finally {
      btn.disabled = false;
    }
  });
})();
