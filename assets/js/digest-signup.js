// Weekly digest signup (src/digest-page.js). External file: the site CSP has
// no 'unsafe-inline' for scripts. Wallet mode asks the injected EVM provider to
// personal_sign the exact message the server expects (no transaction, no gas),
// then POSTs /api/digest; credits mode POSTs the key once over HTTPS.
(function () {
  function msgFor(address, email, ts) {
    return "Agent402 weekly digest: send the spend digest for " + address.toLowerCase() + " to " + email.trim().toLowerCase() + " (" + ts + ")";
  }
  function toHex(str) { var out = "0x"; for (var i = 0; i < str.length; i++) out += str.charCodeAt(i).toString(16).padStart(2, "0"); return out; }
  document.querySelectorAll("form.dg-form").forEach(function (form) {
    var mode = form.dataset.mode;
    var msg = form.querySelector(".dg-msg");
    var btn = form.querySelector(".dg-submit");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = (form.querySelector(".dg-email").value || "").trim();
      if (!email) { msg.textContent = "Enter your email address."; return; }
      var label = btn.textContent; btn.disabled = true; msg.textContent = "";
      var body = { email: email, website: (form.querySelector(".dg-hp") || {}).value || "", source: "digest-page" };
      try {
        if (mode === "wallet") {
          var address = (form.querySelector(".dg-wallet").value || "").trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { msg.textContent = "Enter the EVM address you pay from."; btn.disabled = false; return; }
          if (!window.ethereum || !window.ethereum.request) { msg.textContent = "No wallet found in this browser. Open this page in a browser with your wallet extension, or subscribe with a credits key."; btn.disabled = false; return; }
          btn.textContent = "Check your wallet…";
          var accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
          if (!accounts || !accounts.some(function (a) { return String(a).toLowerCase() === address.toLowerCase(); })) { msg.textContent = "The connected wallet is not " + address + ". Switch accounts and try again."; btn.disabled = false; btn.textContent = label; return; }
          var ts = Date.now();
          var message = msgFor(address, email, ts);
          var signature = await window.ethereum.request({ method: "personal_sign", params: [toHex(message), address] });
          body.wallet = address; body.message = message; body.signature = signature;
        } else {
          var key = (form.querySelector(".dg-key").value || "").trim();
          if (!key) { msg.textContent = "Paste your credits key."; btn.disabled = false; return; }
          body.creditsKey = key;
        }
        btn.textContent = "Sending…";
        var r = await fetch("/api/digest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        var j = await r.json();
        if (j && j.ok) {
          msg.textContent = j.status === "active" ? "That digest is already active." : "Check your inbox and click the confirmation link. Nothing is sent until you do.";
          btn.textContent = "Sent";
          form.querySelectorAll("input").forEach(function (i) { if (!/dg-hp/.test(i.className)) i.value = ""; });
          return;
        }
        msg.textContent = (j && j.error) || "Could not subscribe. Please try again.";
      } catch (err) {
        msg.textContent = (err && err.code === 4001) ? "Signature request declined." : "Something went wrong. Please try again.";
      }
      btn.disabled = false; btn.textContent = label;
    });
  });
})();
