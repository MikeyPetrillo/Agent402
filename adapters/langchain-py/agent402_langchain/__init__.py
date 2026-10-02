"""agent402-langchain - turn Agent402 into LangChain tools a Python agent can
pick up directly.

Four meta-tools, all free to discover — the same design as the JS adapter:

    agent402_find    — resolve a plain-language task to the best tool  (/api/find)
    agent402_route   — cross-seller x402 router                       (/api/route)
    agent402_call    — call a tool by slug, auto-pays (PoW free / x402 paid)
    agent402_about   — service manifest                     (/.well-known/x402)

Why four and not one-tool-per-slug? Frameworks balk at registering 500+ tools
at once and an LLM can't reason over that many. The agent picks a task, `find`/
`route` picks the tool, and `call` handles payment.

    from agent402_langchain import Agent402Toolkit
    toolkit = Agent402Toolkit(base_url="https://agent402.tools")
    tools = toolkit.get_tools()          # free tier (proof-of-work), no wallet

Pure-CPU tools settle for free via built-in proof-of-work. Wallet-only tools
(live data, egress) need payment: pass `x402_fetch=<callable>` — a function with
the `requests`-style signature `(method, url, **kwargs) -> requests.Response`
that signs the x402 payment (e.g. wrapping a funded wallet). Without it, calling
a wallet-only tool raises a clear error naming what's needed. This mirrors the
JS adapter's `payFetch` exactly.

`agent402_tool_specs()` returns the same four entries as framework-agnostic
dicts (name, description, JSON Schema, and a plain `execute` callable) if you'd
rather not depend on langchain-core.
"""
from __future__ import annotations

import hashlib
import json as _json
from typing import Any, Callable, Optional

import requests

__version__ = "0.1.4"
DEFAULT_BASE = "https://agent402.tools"
_TIMEOUT = 60


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


def _solve_pow(challenge: str, difficulty: int, token: str) -> str:
    """Solve a /api/pow/challenge into the X-Pow-Solution header value."""
    n = 0
    while _leading_zero_bits(hashlib.sha256(f"{challenge}:{n}".encode()).digest()) < difficulty:
        n += 1
    return f"{token}:{n}"


# --- core client --------------------------------------------------------------
class _Client:
    def __init__(self, base_url: str = DEFAULT_BASE, x402_fetch: Optional[Callable] = None):
        self.base = str(base_url).rstrip("/")
        self.x402_fetch = x402_fetch

    def _get(self, path: str, params: Optional[dict] = None) -> Any:
        r = requests.get(f"{self.base}{path}", params=params, timeout=_TIMEOUT,
                         headers={"Accept": "application/json"})
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, body: dict) -> Any:
        r = requests.post(f"{self.base}{path}", json=body, timeout=_TIMEOUT,
                          headers={"Accept": "application/json"})
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
            raise ValueError(f'unknown tool "{slug}" — use agent402_find or agent402_route to discover one')

        method, path = entry["method"], entry["path"]
        idem = "a402lcpy-" + hashlib.sha256(
            f"{slug}:{_json.dumps(params, sort_keys=True)}".encode()
        ).hexdigest()[:24]

        def send(extra_headers: Optional[dict] = None, fetch: Optional[Callable] = None):
            headers = {"Idempotency-Key": idem, "Accept": "application/json"}
            if extra_headers:
                headers.update(extra_headers)
            url = f"{self.base}{path}"
            if fetch is not None:
                # user-supplied x402 fetch: (method, url, **kwargs) -> Response
                if method == "GET":
                    return fetch("GET", url, params=_flatten(params), headers=headers, timeout=_TIMEOUT)
                return fetch("POST", url, json=params, headers={**headers, "Content-Type": "application/json"}, timeout=_TIMEOUT)
            if method == "GET":
                return requests.get(url, params=_flatten(params), headers=headers, timeout=_TIMEOUT)
            headers["Content-Type"] = "application/json"
            return requests.post(url, json=params, headers=headers, timeout=_TIMEOUT)

        # Wallet-only tool (live data / egress): route through the user's x402
        # fetch if provided; otherwise try unpaywalled (works on a FREE_MODE
        # instance) and raise a clear, actionable error if it's rejected. Mirrors
        # the JS adapter's payFetch behavior exactly.
        if not entry.get("computePayable"):
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
        # server-issued proof-of-work — no wallet required.
        r = send()
        if not r.ok:
            chal = self._get("/api/pow/challenge", {"slug": slug})
            r = send({"X-Pow-Solution": _solve_pow(chal["challenge"], chal["difficulty"], chal["token"])})
        r.raise_for_status()
        return r.json()


def _flatten(params: dict) -> dict:
    return {k: (_json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in params.items()}


# --- framework-agnostic specs -------------------------------------------------
def agent402_tool_specs(base_url: str = DEFAULT_BASE, x402_fetch: Optional[Callable] = None) -> list[dict]:
    c = _Client(base_url, x402_fetch)
    return [
        {
            "name": "agent402_find",
            "description": "Resolve a plain-language task to the best Agent402 tool — returns slug, route, price, input schema, and a ready example. Local catalog only; for cross-seller use agent402_route.",
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

    def __init__(self, base_url: str = DEFAULT_BASE, x402_fetch: Optional[Callable] = None):
        self.base_url = base_url
        self.x402_fetch = x402_fetch

    def get_tools(self) -> list:
        from langchain_core.tools import StructuredTool
        from pydantic import BaseModel, Field

        c = _Client(self.base_url, self.x402_fetch)

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

        specs = agent402_tool_specs(self.base_url, self.x402_fetch)
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


__all__ = ["Agent402Toolkit", "agent402_tool_specs", "__version__", "DEFAULT_BASE"]
