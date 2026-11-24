"""agent402-langchain - turn Agent402 into LangChain tools a Python agent can
pick up directly.

Four meta-tools, all free to discover (the same design as the JS adapter):

    agent402_find:    resolve a plain-language task to the best tool  (/api/find)
    agent402_route:   cross-seller x402 router                       (/api/route)
    agent402_call:    call a tool by slug, auto-pays (PoW free / x402 paid)
    agent402_about:   service manifest                     (/.well-known/x402)

Why four and not one-tool-per-slug? Frameworks balk at registering 500+ tools
at once and an LLM can't reason over that many. The agent picks a task, `find`/
`route` picks the tool, and `call` handles payment.

    from agent402_langchain import Agent402Toolkit
    toolkit = Agent402Toolkit(base_url="https://agent402.tools")
    tools = toolkit.get_tools()          # free tier (proof-of-work), no wallet

Pure-CPU tools settle for free via built-in proof-of-work. Wallet-only tools
(live data, egress) need payment: pass `x402_fetch=<callable>`: a function with
the `requests`-style signature `(method, url, **kwargs) -> requests.Response`
that signs the x402 payment (e.g. wrapping a funded wallet). Without it, calling
a wallet-only tool raises a clear error naming what's needed. This mirrors the
JS adapter's `payFetch` exactly.

Spending caps: a paid call is refused before `x402_fetch` is used when the
tool's listed price is above `max_per_call_usd` (5 by default, the same default
as agent402-client; 0 or "off" turns it off) or would bring the rolling 24-hour
total above `daily_limit_usd` (opt-in). Every call sent through `x402_fetch`
counts its list price against that total, whatever its outcome, since this
package cannot see what the fetch signed. A proof-of-work challenge above
MAX_POW_DIFFICULTY bits is refused rather than solved.

`agent402_tool_specs()` returns the same four entries as framework-agnostic
dicts (name, description, JSON Schema, and a plain `execute` callable) if you'd
rather not depend on langchain-core.
"""
from __future__ import annotations

import hashlib
import re
import time
from urllib.parse import urljoin, urlsplit
import json as _json
from typing import Any, Callable, Optional

import requests

__version__ = "0.1.7"
DEFAULT_BASE = "https://agent402.tools"
# The User-Agent product token that names this package on every request.
_USER_AGENT = f"agent402-langchain-py/{__version__}"
_TIMEOUT = 60
# The per-call ceiling a toolkit gets when none is given (agent402-client's
# default, which covers every fixed price in the catalog).
DEFAULT_MAX_PER_CALL_USD = 5.0
# The most proof-of-work an Agent402 server asks; a larger difficulty is
# refused, and the search stops after _MAX_POW_TRIES_FACTOR times the
# expected count of hashes.
MAX_POW_DIFFICULTY = 28
_MAX_POW_TRIES_FACTOR = 64
_DAY_SECONDS = 24 * 60 * 60


class SpendingLimitError(RuntimeError):
    """A paid call refused before anything was paid. `limit` names the cap."""

    def __init__(self, message: str, limit: str, slug: str, price_usd: Optional[float] = None, cap: Optional[float] = None):
        super().__init__(message)
        self.limit = limit
        self.slug = slug
        self.price_usd = price_usd
        self.cap = cap


def _per_call_ceiling(value: Any) -> Optional[float]:
    if value is None:
        return DEFAULT_MAX_PER_CALL_USD
    raw = value.strip().lower() if isinstance(value, str) else value
    if raw in ("off", 0, "0"):
        return None
    try:
        n = float(raw)
    except (TypeError, ValueError):
        n = float("nan")
    if n == n and n >= 0 and n != float("inf") and not isinstance(raw, bool):
        return n
    raise ValueError(f'max_per_call_usd {value!r} is not a USD amount, 0 or "off"')


def _daily_limit(value: Any) -> Optional[float]:
    if value is None or value == "off":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise ValueError(f'daily_limit_usd {value!r} is not a USD amount or "off"')
    if not (n == n and n >= 0) or isinstance(value, bool):
        raise ValueError(f'daily_limit_usd {value!r} is not a USD amount or "off"')
    return n


def _usd(n: float) -> str:
    return f"${n:g}"


def _listed_usd(price: Any) -> Optional[float]:
    m = re.fullmatch(r"\$(\d+(?:\.\d+)?)", str(price if price is not None else "").strip())
    return float(m.group(1)) if m else None


# --- proof-of-work (free tier) ------------------------------------------------
def _leading_zero_bits(digest: bytes) -> int:
    n = 0
    for b in digest:
        if b == 0:
            n += 8
            continue
        n += 8 - b.bit_length()
        break
    return n


def _solve_pow(challenge: Any, difficulty: Any, token: Any) -> str:
    """Solve a /api/pow/challenge into the X-Pow-Solution header value. A
    difficulty above MAX_POW_DIFFICULTY is refused before any work."""
    if not isinstance(challenge, str) or not 0 < len(challenge) <= 512:
        raise ValueError("proof-of-work challenge must be a string of 1 to 512 characters")
    if isinstance(difficulty, bool) or not isinstance(difficulty, int) or not 0 <= difficulty <= MAX_POW_DIFFICULTY:
        raise ValueError(f"proof-of-work difficulty {difficulty!r} is refused: this package solves a whole number of bits from 0 to {MAX_POW_DIFFICULTY}")
    if not isinstance(token, str) or not 0 < len(token) <= 4096:
        raise ValueError("proof-of-work token must be a string of 1 to 4096 characters")
    max_tries = _MAX_POW_TRIES_FACTOR * 2 ** difficulty
    for n in range(max_tries):
        if _leading_zero_bits(hashlib.sha256(f"{challenge}:{n}".encode()).digest()) >= difficulty:
            return f"{token}:{n}"
    raise RuntimeError(f"proof-of-work search stopped after {max_tries} hashes without a {difficulty}-bit solution: the challenge is not solvable as stated")


# --- core client --------------------------------------------------------------
class _Client:
    def __init__(self, base_url: str = DEFAULT_BASE, x402_fetch: Optional[Callable] = None,
                 max_per_call_usd: Any = None, daily_limit_usd: Any = None):
        self.base = str(base_url).rstrip("/")
        self.x402_fetch = x402_fetch
        self.max_per_call = _per_call_ceiling(max_per_call_usd)
        self.daily = _daily_limit(daily_limit_usd)
        self._paid: list[tuple[float, float]] = []  # (monotonic time, list price)

    def _check_spend(self, slug: str, price: Any) -> None:
        """Refuse a paid call the caps do not allow, before x402_fetch is used;
        otherwise count its list price against the rolling 24 hours."""
        if self.max_per_call is None and self.daily is None:
            return
        usd = _listed_usd(price)
        if usd is None:
            raise SpendingLimitError(f'refusing to pay for "{slug}": its listed price {price!r} does not read as a USD amount, and a spending cap is set',
                                     "max_per_call_usd" if self.max_per_call is not None else "daily_limit_usd", slug)
        if self.max_per_call is not None and usd > self.max_per_call + 1e-9:
            raise SpendingLimitError(f'refusing to pay {_usd(usd)} for "{slug}": over max_per_call_usd {_usd(self.max_per_call)}. Nothing was paid; raise max_per_call_usd (0 or "off" turns it off) to allow it.',
                                     "max_per_call_usd", slug, usd, self.max_per_call)
        now = time.monotonic()
        self._paid = [p for p in self._paid if now - p[0] < _DAY_SECONDS]
        spent = sum(p[1] for p in self._paid)
        if self.daily is not None and spent + usd > self.daily + 1e-9:
            raise SpendingLimitError(f'refusing to pay {_usd(usd)} for "{slug}": would bring 24h spend to ${spent + usd:.6f}, over daily_limit_usd {_usd(self.daily)}. Nothing was paid.',
                                     "daily_limit_usd", slug, usd, self.daily)
        self._paid.append((now, usd))

    def _get(self, path: str, params: Optional[dict] = None) -> Any:
        r = requests.get(f"{self.base}{path}", params=params, timeout=_TIMEOUT,
                         headers={"Accept": "application/json", "User-Agent": _USER_AGENT})
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, body: dict) -> Any:
        r = requests.post(f"{self.base}{path}", json=body, timeout=_TIMEOUT,
                          headers={"Accept": "application/json", "User-Agent": _USER_AGENT})
        r.raise_for_status()
        return r.json()

    def find(self, task: str, limit: int = 5) -> Any:
        return self._get("/api/find", {"q": task, "k": limit})

    def route(self, query: str, top: int = 5, include: str = "all") -> Any:
        return self._post("/api/route", {"query": query, "top": top, "include": include})

    def about(self) -> Any:
        return self._get("/.well-known/x402")

    def call(self, slug: str, params: Optional[dict] = None) -> Any:
        params = params or {}
        pricing = self._get("/api/pricing")
        entry = next((e for e in pricing.get("endpoints", []) if e.get("slug") == slug), None)
        if not entry:
            raise ValueError(f'unknown tool "{slug}": use agent402_find or agent402_route to discover one')

        method, path = entry["method"], entry["path"]
        idem = "a402lcpy-" + hashlib.sha256(
            f"{slug}:{_json.dumps(params, sort_keys=True)}".encode()
        ).hexdigest()[:24]

        def send(extra_headers: Optional[dict] = None, fetch: Optional[Callable] = None):
            headers = {"Idempotency-Key": idem, "Accept": "application/json", "User-Agent": _USER_AGENT}
            if extra_headers:
                headers.update(extra_headers)
            url = f"{self.base}{path}"
            if fetch is not None:
                # user-supplied x402 fetch: (method, url, **kwargs) -> Response.
                # A paid request never follows a redirect: followed, it would pay
                # another origin's 402 or carry a signature to another host.
                if method == "GET":
                    r = fetch("GET", url, params=_flatten(params), headers=headers, timeout=_TIMEOUT, allow_redirects=False)
                else:
                    r = fetch("POST", url, json=params, headers={**headers, "Content-Type": "application/json"}, timeout=_TIMEOUT, allow_redirects=False)
                if 300 <= r.status_code < 400:
                    loc = r.headers.get("Location")
                    to = urljoin(url, loc) if loc else None
                    hint = f"; if that is the address you meant, use {urlsplit(to).scheme}://{urlsplit(to).netloc} as base_url" if to else ""
                    raise RuntimeError(
                        f'refusing to follow a redirect on a paid call to "{slug}": {url} answered HTTP {r.status_code}'
                        f'{" pointing to " + to if to else ""}. Paid requests never follow redirects{hint}.'
                    )
                return r
            if method == "GET":
                return requests.get(url, params=_flatten(params), headers=headers, timeout=_TIMEOUT)
            headers["Content-Type"] = "application/json"
            return requests.post(url, json=params, headers=headers, timeout=_TIMEOUT)

        # Wallet-only tool (live data / egress): route through the user's x402
        # fetch if provided; otherwise try unpaywalled (works on a FREE_MODE
        # instance) and raise a clear, actionable error if it's rejected. Mirrors
        # the JS adapter's payFetch behavior exactly.
        if not entry.get("computePayable"):
            if self.x402_fetch is not None:
                self._check_spend(slug, entry.get("price"))
            r = send(fetch=self.x402_fetch) if self.x402_fetch is not None else send()
            if not r.ok:
                raise RuntimeError(
                    f'tool "{slug}" is wallet-only (live data) and the call was not accepted '
                    f'(HTTP {r.status_code}). Construct the toolkit with x402_fetch=<callable> '
                    f'that signs USDC payment, or pick a free pure-CPU tool (agent402_find '
                    f'shows which are free).'
                )
            return r.json()

        # Compute-payable tool: try unpaywalled (FREE_MODE) first, then pay with
        # server-issued proof-of-work, no wallet required.
        r = send()
        if not r.ok:
            chal = self._get("/api/pow/challenge", {"slug": slug})
            r = send({"X-Pow-Solution": _solve_pow(chal.get("challenge"), chal.get("difficulty"), chal.get("token"))})
        r.raise_for_status()
        return r.json()


def _flatten(params: dict) -> dict:
    return {k: (_json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items()}


# --- framework-agnostic specs -------------------------------------------------
def agent402_tool_specs(base_url: str = DEFAULT_BASE, x402_fetch: Optional[Callable] = None,
                        max_per_call_usd: Any = None, daily_limit_usd: Any = None) -> list[dict]:
    c = _Client(base_url, x402_fetch, max_per_call_usd, daily_limit_usd)
    return [
        {
            "name": "agent402_find",
            "description": "Resolve a plain-language task to the best Agent402 tool: returns slug, route, price, input schema, and a ready example. Local catalog only; for cross-seller use agent402_route.",
            "schema": {"type": "object", "properties": {
                "task": {"type": "string", "description": 'What you want to do, e.g. "extract the article from this URL"'},
                "limit": {"type": "number", "description": "Max results (default 5)"},
            }, "required": ["task"]},
            "execute": lambda task, limit=5: c.find(task, limit),
        },
        {
            "name": "agent402_route",
            "description": "Cross-seller x402 router: rank matching tools across every x402 seller (Agent402's catalog + others auto-discovered from the Coinbase CDP Bazaar), health- then price-ranked. include='external' excludes Agent402 itself.",
            "schema": {"type": "object", "properties": {
                "query": {"type": "string", "description": 'Task description, e.g. "ocr image to text"'},
                "top": {"type": "number", "description": "Max results (default 5)"},
                "include": {"type": "string", "enum": ["all", "external", "local"], "description": "all (default) | external | local"},
            }, "required": ["query"]},
            "execute": lambda query, top=5, include="all": c.route(query, top, include),
        },
        {
            "name": "agent402_call",
            "description": "Call an Agent402 tool by slug. Pays automatically: pure-CPU tools settle via built-in proof-of-work (no wallet); wallet-only tools settle via the x402 fetch you configured. Returns the parsed JSON result.",
            "schema": {"type": "object", "properties": {
                "slug": {"type": "string", "description": 'Tool slug, e.g. "hash" or "extract"'},
                "params": {"type": "object", "description": "Tool input matching the tool's inputSchema (use agent402_find to discover)"},
            }, "required": ["slug"]},
            "execute": lambda slug, params=None: c.call(slug, params),
        },
        {
            "name": "agent402_about",
            "description": "Return the Agent402 service manifest (/.well-known/x402): identity, payment options, capability map, MCP connector, and trust signals.",
            "schema": {"type": "object", "properties": {}},
            "execute": lambda: c.about(),
        },
    ]


# --- LangChain tools ---------------------------------------------------------
class Agent402Toolkit:
    """LangChain-native toolkit. `get_tools()` returns StructuredTool objects that
    LangChain agents use directly."""

    def __init__(self, base_url: str = DEFAULT_BASE, x402_fetch: Optional[Callable] = None,
                 max_per_call_usd: Any = None, daily_limit_usd: Any = None):
        self.base_url = base_url
        self.x402_fetch = x402_fetch
        self.max_per_call_usd = max_per_call_usd
        self.daily_limit_usd = daily_limit_usd
        # Check the settings now, so a typo is an error at construction.
        _per_call_ceiling(max_per_call_usd)
        _daily_limit(daily_limit_usd)

    def get_tools(self) -> list:
        from langchain_core.tools import StructuredTool
        from pydantic import BaseModel, Field

        c = _Client(self.base_url, self.x402_fetch, self.max_per_call_usd, self.daily_limit_usd)

        class FindArgs(BaseModel):
            task: str = Field(description='What you want to do, e.g. "extract the article from this URL"')
            limit: int = Field(5, description="Max results")

        class RouteArgs(BaseModel):
            query: str = Field(description='Task description, e.g. "ocr image to text"')
            top: int = Field(5, description="Max results")
            include: str = Field("all", description="all (default) | external | local")

        class CallArgs(BaseModel):
            slug: str = Field(description='Tool slug, e.g. "hash" or "extract"')
            params: dict = Field(default_factory=dict, description="Tool input matching the tool's schema")

        class AboutArgs(BaseModel):
            pass

        specs = agent402_tool_specs(self.base_url, self.x402_fetch, self.max_per_call_usd, self.daily_limit_usd)
        desc = {s["name"]: s["description"] for s in specs}
        return [
            StructuredTool.from_function(func=lambda task, limit=5: c.find(task, limit),
                                         name="agent402_find", description=desc["agent402_find"], args_schema=FindArgs),
            StructuredTool.from_function(func=lambda query, top=5, include="all": c.route(query, top, include),
                                         name="agent402_route", description=desc["agent402_route"], args_schema=RouteArgs),
            StructuredTool.from_function(func=lambda slug, params=None: c.call(slug, params),
                                         name="agent402_call", description=desc["agent402_call"], args_schema=CallArgs),
            StructuredTool.from_function(func=lambda: c.about(),
                                         name="agent402_about", description=desc["agent402_about"], args_schema=AboutArgs),
        ]


__all__ = ["Agent402Toolkit", "agent402_tool_specs", "SpendingLimitError", "DEFAULT_MAX_PER_CALL_USD", "MAX_POW_DIFFICULTY", "__version__", "DEFAULT_BASE"]
