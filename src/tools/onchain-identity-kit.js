// Onchain identity kit — resolve an Ethereum address to a human across the
// three most reliable onchain identity surfaces: ENS, Farcaster, and EAS
// (Ethereum Attestation Service).
//
// Why this kit: agents that read blockchain data need to know *who* an
// address belongs to. The chain-kit family answers "what is this address
// holding/doing?"; this kit answers "who is this address?" with the same
// pay-per-call envelope.
//
// Honest scoping: read-only metadata. We don't mint ENS subnames and don't
// sign EAS attestations. All four tools surface public profile data that
// the underlying protocol publishes.
//
// Upstreams:
//   • ensideas.com    — community-maintained ENS reverse + avatar API
//                       (used by Rainbow, Coinbase Wallet, etc.) [keyless]
//   • api.neynar.com  — Neynar Farcaster API (requires API key —
//                       set NEYNAR_API_KEY or WARPCAST_API_KEY to enable)
//   • easscan.org     — EAS-funded GraphQL indexer for mainnet/Base/Optimism [keyless]
//
// All 4 tools are wallet-only — every handler reaches external HTTP and
// shares a per-IP rate limit with the public pool.
//
// Covered by scripts/test-onchain-identity-kit.js (offline + opt-in live).

const TIMEOUT_MS = 12_000;

// Endpoints. Keep them at the top so a swap is a one-line change.
const ENS_API = "https://api.ensideas.com/ens";
const NEYNAR_API = "https://api.neynar.com/v2/farcaster";
const EAS_INDEXERS = {
  mainnet:  "https://easscan.org/graphql",
  base:     "https://base.easscan.org/graphql",
  optimism: "https://optimism.easscan.org/graphql",
  arbitrum: "https://arbitrum.easscan.org/graphql",
  sepolia:  "https://sepolia.easscan.org/graphql",
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function takeAddress(raw, field = "address") {
  if (typeof raw !== "string" || !ADDR_RE.test(raw.trim())) {
    throw bad(`"${field}" must be a 0x-prefixed 40-char hex Ethereum address`);
  }
  return raw.trim().toLowerCase();
}

async function fetchJson(url, label, init) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { accept: "application/json", "user-agent": "agent402/onchain-identity-kit", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || /aborted/i.test(e.message)) {
      throw bad(`${label} upstream timed out after ${TIMEOUT_MS}ms`, 504);
    }
    throw bad(`${label} upstream unreachable: ${e.message}`, 502);
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    const body = ct.includes("json")
      ? JSON.stringify(await res.json().catch(() => null)).slice(0, 240)
      : (await res.text().catch(() => "")).slice(0, 240);
    throw bad(`${label} upstream returned HTTP ${res.status}${body ? ": " + body : ""}`, res.status >= 500 ? 502 : res.status);
  }
  return res.json();
}

async function gqlFetch(url, query, variables, label) {
  const json = await fetchJson(url, label, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (json.errors) {
    const msg = json.errors.map((e) => e.message).join("; ").slice(0, 240);
    throw bad(`${label} GraphQL errors: ${msg}`, 502);
  }
  return json.data;
}

function pickEasNetwork(value) {
  const n = typeof value === "string" ? value.toLowerCase().trim() : "mainnet";
  if (!EAS_INDEXERS[n]) {
    throw bad(`Unsupported network "${value}" for EAS — supported: ${Object.keys(EAS_INDEXERS).join(", ")}`);
  }
  return { name: n, url: EAS_INDEXERS[n] };
}

// ----------------------------------------------------------------------------
// 1. ens-bulk-resolve — resolve N addresses to primary ENS names + avatars
// ----------------------------------------------------------------------------
async function ensBulkResolve({ addresses } = {}) {
  if (!Array.isArray(addresses) || !addresses.length) {
    throw bad('"addresses" must be a non-empty array of 0x-prefixed Ethereum addresses');
  }
  if (addresses.length > 50) {
    throw bad('"addresses" max length is 50 per call (rate limit on shared per-IP pool)');
  }
  // Validate up-front so we never spawn fetches for malformed input — much
  // better failure mode than partial results with bad inputs intermixed.
  const normalized = addresses.map((a, i) => takeAddress(a, `addresses[${i}]`));
  // ensideas API is single-address; fan out sequentially with a small concurrency
  // cap so we don't hammer the upstream. The pool's per-IP rate limit is shared.
  const results = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < normalized.length; i += CONCURRENCY) {
    const batch = normalized.slice(i, i + CONCURRENCY);
    const batchRes = await Promise.allSettled(
      batch.map((a) => fetchJson(`${ENS_API}/resolve/${a}`, "ENS resolver")),
    );
    batch.forEach((addr, idx) => {
      const r = batchRes[idx];
      if (r.status === "fulfilled") {
        results.push({
          address: addr,
          name: r.value.name ?? null,
          displayName: r.value.displayName ?? null,
          avatar: r.value.avatar ?? null,
        });
      } else {
        results.push({ address: addr, name: null, displayName: null, avatar: null, error: r.reason?.message || "lookup-failed" });
      }
    });
  }
  const named = results.filter((r) => r.name).length;
  return {
    count: results.length,
    namedCount: named,
    namedPct: results.length ? Math.round((named / results.length) * 10000) / 100 : 0,
    results,
    source: "ensideas",
  };
}

// Neynar API auth — Farcaster lookups go through Neynar (api.neynar.com).
// Accepts NEYNAR_API_KEY or legacy WARPCAST_API_KEY env var.
function neynarInit() {
  const key = process.env.NEYNAR_API_KEY || process.env.WARPCAST_API_KEY;
  if (!key) throw bad("Farcaster lookups require NEYNAR_API_KEY (Neynar Farcaster API key)", 503);
  return { headers: { "x-api-key": key } };
}

// ----------------------------------------------------------------------------
// 2. farcaster-profile — lookup by FID or username via Neynar API
// ----------------------------------------------------------------------------
async function farcasterProfile({ fid, username } = {}) {
  const f = Number.parseInt(fid, 10);
  const u = typeof username === "string" ? username.trim().replace(/^@/, "") : "";
  if (!Number.isFinite(f) && !u) {
    throw bad('"fid" (integer) or "username" (string) is required');
  }
  const init = neynarInit();
  let user;
  if (Number.isFinite(f)) {
    const json = await fetchJson(`${NEYNAR_API}/user/bulk?fids=${f}`, "Neynar", init);
    user = json.users?.[0];
  } else {
    const json = await fetchJson(`${NEYNAR_API}/user/by_username?username=${encodeURIComponent(u)}`, "Neynar", init);
    user = json.user;
  }
  if (!user) {
    throw bad(`Farcaster user not found for ${Number.isFinite(f) ? `fid=${f}` : `username=${u}`}`, 404);
  }
  return {
    fid: user.fid,
    username: user.username,
    displayName: user.display_name ?? null,
    pfpUrl: user.pfp_url ?? null,
    bio: user.profile?.bio?.text ?? null,
    followerCount: user.follower_count ?? null,
    followingCount: user.following_count ?? null,
    activeOnFcNetwork: user.active_status === "active",
    powerBadge: !!user.power_badge,
    venueUrl: user.username ? `https://warpcast.com/${user.username}` : null,
    source: "neynar",
  };
}

// ----------------------------------------------------------------------------
// 3. farcaster-by-address — given an Ethereum address, find their Farcaster
// ----------------------------------------------------------------------------
async function farcasterByAddress({ address } = {}) {
  const addr = takeAddress(address);
  // Neynar's bulk-by-address returns { "0x…": [user, …] } keyed by address.
  // An address with no Farcaster verification comes back as an empty array or
  // missing key — we surface that as { found: false }.
  const json = await fetchJson(
    `${NEYNAR_API}/user/bulk-by-address?addresses=${addr}`,
    "Neynar",
    neynarInit(),
  );
  const users = json[addr] || json[addr.toLowerCase()] || [];
  const user = users[0];
  if (!user) return { found: false, address: addr, source: "neynar" };
  return {
    found: true,
    address: addr,
    fid: user.fid,
    username: user.username,
    displayName: user.display_name ?? null,
    pfpUrl: user.pfp_url ?? null,
    bio: user.profile?.bio?.text ?? null,
    followerCount: user.follower_count ?? null,
    followingCount: user.following_count ?? null,
    venueUrl: user.username ? `https://warpcast.com/${user.username}` : null,
    source: "neynar",
  };
}

// ----------------------------------------------------------------------------
// 4. eas-attestations — list EAS attestations (recipient or attester) on chain
// ----------------------------------------------------------------------------
async function easAttestations({ address, network, role, limit } = {}) {
  const addr = takeAddress(address);
  const net = pickEasNetwork(network);
  const r = typeof role === "string" ? role.toLowerCase().trim() : "recipient";
  if (!["recipient", "attester", "either"].includes(r)) {
    throw bad('"role" must be one of: recipient, attester, either (default recipient)');
  }
  const lim = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
  // EAS schema includes both `recipient` and `attester` as filterable fields.
  // For "either" we run two filtered queries because the EAS GraphQL schema
  // doesn't support OR at the top level of `where`.
  const query = `
    query Attestations($where: AttestationWhereInput, $take: Int!) {
      attestations(where: $where, take: $take, orderBy: { time: desc }) {
        id
        attester
        recipient
        schemaId
        revocable
        revoked
        time
        decodedDataJson
      }
    }`;
  const checksumAddr = addr; // EAS indexer accepts lowercase; the schema is case-insensitive on filter
  let attestations = [];
  if (r === "either") {
    const [asRecipient, asAttester] = await Promise.all([
      gqlFetch(net.url, query, { where: { recipient: { equals: checksumAddr, mode: "insensitive" } }, take: lim }, "EAS"),
      gqlFetch(net.url, query, { where: { attester: { equals: checksumAddr, mode: "insensitive" } }, take: lim }, "EAS"),
    ]);
    // Merge + dedupe by id, sort by time desc, slice.
    const merged = new Map();
    for (const a of [...(asRecipient.attestations || []), ...(asAttester.attestations || [])]) {
      merged.set(a.id, a);
    }
    attestations = [...merged.values()].sort((a, b) => Number(b.time) - Number(a.time)).slice(0, lim);
  } else {
    const where = r === "recipient"
      ? { recipient: { equals: checksumAddr, mode: "insensitive" } }
      : { attester: { equals: checksumAddr, mode: "insensitive" } };
    const data = await gqlFetch(net.url, query, { where, take: lim }, "EAS");
    attestations = data.attestations || [];
  }
  const shaped = attestations.map((a) => ({
    id: a.id,
    attester: a.attester,
    recipient: a.recipient,
    schemaId: a.schemaId,
    revocable: !!a.revocable,
    revoked: !!a.revoked,
    timestamp: Number(a.time),
    decodedData: a.decodedDataJson || null,
  }));
  return {
    address: addr,
    network: net.name,
    role: r,
    count: shaped.length,
    attestations: shaped,
    source: "easscan",
  };
}

// ----------------------------------------------------------------------------
// Catalog
// ----------------------------------------------------------------------------
export const ONCHAIN_IDENTITY_TOOLS = [
  {
    route: "POST /api/ens-bulk-resolve",
    name: "ENS bulk reverse resolver",
    slug: "ens-bulk-resolve",
    category: "crypto",
    price: "$0.002",
    description:
      "Reverse-resolve a batch of Ethereum addresses to ENS primary names + avatar URLs (up to 50 per call). Returns one row per address with name (or null), displayName (with checksum if no name), and avatar URI. Use to label transaction lists, wallet leaderboards, or NFT holder snapshots with human-readable names instead of 0xabc… stubs.",
    tags: ["ens", "identity", "reverse-resolve", "bulk", "label"],
    discovery: {
      bodyType: "json",
      input: { addresses: ["0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "0x000000000000000000000000000000000000dead"] },
      inputSchema: {
        type: "object",
        required: ["addresses"],
        properties: {
          addresses: { type: "array", description: "1-50 Ethereum addresses (0x-prefixed 40-hex)." },
        },
      },
      output: {
        example: {
          count: 2,
          namedCount: 1,
          namedPct: 50.0,
          results: [
            { address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", name: "vitalik.eth", displayName: "vitalik.eth", avatar: "https://..." },
            { address: "0x000000000000000000000000000000000000dead", name: null, displayName: "0x0000…dead", avatar: null },
          ],
          source: "ensideas",
        },
      },
    },
    handler: ensBulkResolve,
  },
  {
    route: "POST /api/farcaster-profile",
    name: "Farcaster profile",
    slug: "farcaster-profile",
    category: "crypto",
    price: "$0.002",
    description:
      "Lookup a Farcaster profile by username or FID. Returns FID, username, display name, bio, profile picture URL, follower/following counts, and the canonical Warpcast URL. Use to label cast authors, validate a Farcaster handle, or fetch a profile for display.",
    tags: ["farcaster", "warpcast", "identity", "profile", "social"],
    discovery: {
      bodyType: "json",
      input: { username: "dwr.eth" },
      inputSchema: {
        type: "object",
        properties: {
          fid: { type: "number", description: "Farcaster ID (integer; one of fid/username required)." },
          username: { type: "string", description: "Farcaster handle, with or without leading @ (one of fid/username required)." },
        },
      },
      output: {
        example: {
          fid: 3,
          username: "dwr.eth",
          displayName: "Dan Romero",
          pfpUrl: "https://...",
          bio: "Working on Farcaster.",
          followerCount: 500000,
          followingCount: 1000,
          activeOnFcNetwork: true,
          powerBadge: true,
          venueUrl: "https://warpcast.com/dwr.eth",
          source: "neynar",
        },
      },
    },
    handler: farcasterProfile,
  },
  {
    route: "POST /api/farcaster-by-address",
    name: "Farcaster by Ethereum address",
    slug: "farcaster-by-address",
    category: "crypto",
    price: "$0.002",
    description:
      "Reverse-lookup an Ethereum address to its Farcaster account (via verified address). Returns FID, username, display name, bio, follower/following counts, and Warpcast URL, or found=false if the address has not verified on Farcaster. Use to label wallet activity with the owner's Farcaster identity when ENS is missing.",
    tags: ["farcaster", "warpcast", "identity", "reverse-lookup", "verification"],
    discovery: {
      bodyType: "json",
      input: { address: "0xd7029bdea1c17493893aafe29aad69ef892b8ff2" },
      inputSchema: {
        type: "object",
        required: ["address"],
        properties: {
          address: { type: "string", description: "Ethereum address (0x-prefixed 40-hex)." },
        },
      },
      output: {
        example: {
          found: true,
          address: "0xd7029bdea1c17493893aafe29aad69ef892b8ff2",
          fid: 3,
          username: "dwr.eth",
          displayName: "Dan Romero",
          pfpUrl: "https://...",
          bio: "Working on Farcaster.",
          followerCount: 500000,
          followingCount: 1000,
          venueUrl: "https://warpcast.com/dwr.eth",
          source: "neynar",
        },
      },
    },
    handler: farcasterByAddress,
  },
  {
    route: "POST /api/eas-attestations",
    name: "EAS attestations",
    slug: "eas-attestations",
    category: "crypto",
    price: "$0.002",
    description:
      "List EAS (Ethereum Attestation Service) attestations for an address as recipient, attester, or either, on mainnet/Base/Optimism/Arbitrum/Sepolia. Returns attestation id, attester, recipient, schema id, revocable/revoked flags, timestamp, and decoded data JSON. Use to verify Gitcoin Passport stamps, Coinbase verifications, KYC attestations, or any other on-chain claim about an address.",
    tags: ["eas", "attestations", "identity", "verification", "credentials"],
    discovery: {
      bodyType: "json",
      input: { address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", network: "mainnet", limit: 5 },
      inputSchema: {
        type: "object",
        required: ["address"],
        properties: {
          address: { type: "string", description: "Ethereum address (0x-prefixed 40-hex)." },
          network: { type: "string", description: "EAS network: mainnet, base, optimism, arbitrum, sepolia (default mainnet)." },
          role: { type: "string", description: "Filter to attestations where the address is the recipient, attester, or either (default recipient)." },
          limit: { type: "number", description: "Max attestations to return (1-100, default 20)." },
        },
      },
      output: {
        example: {
          address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
          network: "mainnet",
          role: "recipient",
          count: 1,
          attestations: [{
            id: "0xabc...",
            attester: "0xdef...",
            recipient: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
            schemaId: "0x123...",
            revocable: true,
            revoked: false,
            timestamp: 1751234567,
            decodedData: '[{"name":"verified","type":"bool","value":{"value":true}}]',
          }],
          source: "easscan",
        },
      },
    },
    handler: easAttestations,
  },
];

// Test-only exports
export const __test = {
  takeAddress,
  pickEasNetwork,
  ENS_API,
  NEYNAR_API,
  EAS_INDEXERS,
};
