"""Offline-ish test for agent402-langchain (Python).

Mirrors the JS adapters' test.js: boots nothing itself — point it at a running
FREE_MODE server via AGENT402_BASE_URL (default http://localhost:3091), then
exercises the spec path (no framework deps) and the free proof-of-work call path
end to end. The LangChain-native path is checked only if langchain-core is
installed, so the core test runs with just `requests`.

    AGENT402_BASE_URL=http://localhost:3091 python adapters/langchain-py/test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from agent402_langchain import agent402_tool_specs, Agent402Toolkit  # noqa: E402

BASE = os.environ.get("AGENT402_BASE_URL", "http://localhost:3091")
passed = failed = 0


def ok(cond, msg):
    global passed, failed
    if cond:
        passed += 1
        print(f"ok - {msg}")
    else:
        failed += 1
        print(f"FAIL - {msg}", file=sys.stderr)


specs = agent402_tool_specs(base_url=BASE)
ok(len(specs) == 4, f"four meta-tools ({len(specs)})")
names = {s["name"] for s in specs}
ok(names == {"agent402_find", "agent402_route", "agent402_call", "agent402_about"},
   f"names are find/route/call/about ({sorted(names)})")

by = {s["name"]: s for s in specs}

# find — resolve a task to a tool
res = by["agent402_find"]["execute"](task="sha256 hash of some text", limit=3)
results = res.get("results") or res.get("tools") or []
ok(isinstance(results, list) and len(results) >= 1, f"find returns results ({len(results)})")

# about — service manifest
about = by["agent402_about"]["execute"]()
ok(isinstance(about, dict) and ("x402Version" in about or "payment" in about or "name" in about),
   "about returns the service manifest")

# call — free pure-CPU tool settles via built-in proof-of-work, no wallet
h = by["agent402_call"]["execute"](slug="hash", params={"text": "hello world"})
ok(isinstance(h, dict) and str(h.get("hex", "")).startswith("b94d27b9"),
   f"free PoW call to hash settles and returns the digest ({str(h.get('hex',''))[:12]}…)")

# unknown slug raises a clear, actionable error (not a raw HTTP failure)
try:
    by["agent402_call"]["execute"](slug="no-such-tool-xyz", params={})
    ok(False, "unknown slug should raise")
except ValueError as e:
    ok("unknown tool" in str(e), "unknown slug raises a clear 'unknown tool' error")
except Exception as e:  # noqa: BLE001
    ok(False, f"unknown slug raised the wrong error type: {type(e).__name__}: {e}")

# LangChain-native path — only if the optional dep is installed
try:
    import langchain_core  # noqa: F401
    tools = Agent402Toolkit(base_url=BASE).get_tools()
    ok(len(tools) == 4 and hasattr(tools[0], "name"),
       f"get_tools() returns 4 LangChain StructuredTools ({[t.name for t in tools]})")
except ImportError:
    print("skip - langchain-core not installed; spec path already verified")

# Offline: a paid call never follows a redirect. Two loopback origins; the
# seller redirects the paid route to the other one, which counts what reaches
# it. x402_fetch is plain requests.request: what is proven is that the call it
# is handed does not follow the redirect, and that the redirect is refused.
# The control: the same client pays a route that does not redirect.
import json as _json_t  # noqa: E402
import threading  # noqa: E402
from http.server import BaseHTTPRequestHandler, HTTPServer  # noqa: E402

import requests as _requests  # noqa: E402
from agent402_langchain import _Client  # noqa: E402

_elsewhere_hits = []


class _Elsewhere(BaseHTTPRequestHandler):
    def do_POST(self):
        _elsewhere_hits.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"from":"elsewhere"}')

    def log_message(self, *a):
        pass


_other = HTTPServer(("127.0.0.1", 0), _Elsewhere)
_OTHER = f"http://127.0.0.1:{_other.server_address[1]}"


class _Seller(BaseHTTPRequestHandler):
    def _json(self, status, obj):
        body = _json_t.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/pricing"):
            return self._json(200, {"endpoints": [
                {"slug": "moved", "method": "POST", "path": "/api/moved", "computePayable": False, "price": "$0.001"},
                {"slug": "here", "method": "POST", "path": "/api/here", "computePayable": False, "price": "$0.001"},
                {"slug": "dear", "method": "POST", "path": "/api/here", "computePayable": False, "price": "$6"},
                {"slug": "dollar", "method": "POST", "path": "/api/here", "computePayable": False, "price": "$1"},
                {"slug": "unpriced", "method": "POST", "path": "/api/here", "computePayable": False, "price": "quoted"},
                {"slug": "hard", "method": "POST", "path": "/api/pow-only", "computePayable": True, "price": "$0.001"},
            ]})
        if self.path.startswith("/api/pow/challenge"):
            return self._json(200, {"challenge": "c", "difficulty": 60, "token": "t"})
        self._json(404, {})

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/api/here":
            return self._json(200, {"from": "seller"})
        if self.path == "/api/pow-only":
            return self._json(402, {"error": "Payment Required"})
        self.send_response(307)
        self.send_header("Location", f"{_OTHER}{self.path}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


_seller = HTTPServer(("127.0.0.1", 0), _Seller)
for _srv in (_other, _seller):
    threading.Thread(target=_srv.serve_forever, daemon=True).start()
try:
    _c = _Client(base_url=f"http://127.0.0.1:{_seller.server_address[1]}", x402_fetch=_requests.request)
    ok(_c.call("here", {"q": 1}).get("from") == "seller", "control: a paid route that does not redirect answers")
    _err = None
    try:
        _c.call("moved", {"q": 1})
    except RuntimeError as e:
        _err = str(e)
    ok(_err is not None and "never follow redirects" in _err and f"{_OTHER}/api/moved" in _err,
       f"a redirected paid call is refused, naming where it pointed ({_err})")
    ok(not _elsewhere_hits, f"the other origin got no request ({_elsewhere_hits})")

    # Spending caps: checked against the listed price before x402_fetch runs.
    from agent402_langchain import SpendingLimitError, DEFAULT_MAX_PER_CALL_USD, MAX_POW_DIFFICULTY  # noqa: E402
    _sent = []

    def _counting(method, url, **kw):
        _sent.append(url)
        return _requests.request(method, url, **kw)

    _seller_url = f"http://127.0.0.1:{_seller.server_address[1]}"
    _d = _Client(base_url=_seller_url, x402_fetch=_counting)
    ok(_d.max_per_call == DEFAULT_MAX_PER_CALL_USD == 5.0 and _d.daily is None, "the per-call ceiling is on by default at $5; the daily limit is opt-in")
    _err = None
    try:
        _d.call("dear", {})
    except SpendingLimitError as e:
        _err = e
    ok(_err is not None and _err.limit == "max_per_call_usd" and _err.price_usd == 6 and not _sent, f"a $6 tool is refused by the default ceiling before the fetch runs ({_err})")
    ok(_d.call("dollar", {}).get("from") == "seller" and len(_sent) == 1, "control: a $1 tool under the ceiling is paid")
    _off = _Client(base_url=_seller_url, x402_fetch=_counting, max_per_call_usd="off")
    ok(_off.call("dear", {}).get("from") == "seller" and len(_sent) == 2, 'max_per_call_usd="off" pays the $6 tool')
    _day = _Client(base_url=_seller_url, x402_fetch=_counting, daily_limit_usd=1.5)
    _day.call("dollar", {})
    _err = None
    try:
        _day.call("dollar", {})
    except SpendingLimitError as e:
        _err = e
    ok(_err is not None and _err.limit == "daily_limit_usd" and len(_sent) == 3, f"daily_limit_usd refuses the call that would pass it ({_err})")
    _err = None
    try:
        _d.call("unpriced", {})
    except SpendingLimitError as e:
        _err = e
    ok(_err is not None and len(_sent) == 3, "a price that does not read as USD is refused while a cap is set")
    try:
        Agent402Toolkit(max_per_call_usd="five")
        ok(False, "a malformed max_per_call_usd should raise")
    except ValueError:
        ok(True, "a malformed max_per_call_usd raises at construction")

    # Proof of work: a difficulty above the bound is refused at once.
    import time as _time_t  # noqa: E402
    _t0 = _time_t.monotonic()
    _err = None
    try:
        _Client(base_url=_seller_url).call("hard", {})
    except ValueError as e:
        _err = str(e)
    ok(_err is not None and "difficulty 60 is refused" in _err and str(MAX_POW_DIFFICULTY) in _err and _time_t.monotonic() - _t0 < 5,
       f"a 60-bit challenge is refused without a search ({_err})")
finally:
    _seller.shutdown()
    _other.shutdown()

print(f"\n{'FAILED' if failed else 'OK'}: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
