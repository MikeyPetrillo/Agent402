// Onchain identity kit — resolve an Ethereum address (or handle) to a human
// across the four largest onchain identity surfaces: ENS, Farcaster, Lens,
// and EAS (Ethereum Attestation Service).
//
// Why this kit: agents that read blockchain data need to know *who* an
// address belongs to. The chain-kit family answers "what is this address
// holding/doing?"; this kit answers "who is this address?" with the same
// pay-per-call envelope.
//
// Honest scoping: read-only metadata. We don't mint ENS subnames, don't post
// Lens publications, don't sign EAS attestations. All five tools surface
// public profile data that the underlying protocol publishes.
//
// Upstreams (all keyless):
//   • ensideas.com    — community-maintained ENS reverse + avatar API
//                       (used by Rainbow, Coinbase Wallet, etc.)
//   • api.warpcast.com — Warpcast public Farcaster API (read endpoints
//                       don't require auth)
//   • api-v2.lens.dev — Lens v2 public GraphQL (read endpoints keyless)
//   • easscan.org     — EAS-funded GraphQL indexer for mainnet/Base/Optimism
//
// All 5 tools are wallet-only — every handler reaches external HTTP and
// shares a per-IP rate limit with the public pool.
//
// Covered by scripts/test-onchain-identity-kit.js (offline + opt-in live).

const TIMEOUT_MS = 12_000;

// Endpoints. Keep them at the top so a swap (e.g. Warpcast → Snapchain hub
// post-migration) is a one-line change.
const ENS_API = "https://api.ensideas.com/ens";
const WARPCAST_API = "https://api.warpcast.com/v2";
const LENS_API = "https://api-v2.lens.dev";
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

// ----------------------------------------------------------------------------
// 2. farcaster-profile — lookup by FID or username via Warpcast public API
// ----------------------------------------------------------------------------
async function farcasterProfile({ fid, username } = {}) {
  const f = Number.parseInt(fid, 10);
  const u = typeof username === "string" ? username.trim().replace(/^@/, "") : "";
  if (!Number.isFinite(f) && !u) {
    throw bad('"fid" (integer) or "username" (string) is required');
  }
  const url = Number.isFinite(f)
    ? `${WARPCAST_API}/user?fid=${f}`
    : `${WARPCAST_API}/user-by-username?username=${encodeURIComponent(u)}`;
  const json = await fetchJson(url, "Warpcast");
  const user = json.result?.user;
  if (!user) {
    throw bad(`Farcaster user not found for ${Number.isFinite(f) ? `fid=${f}` : `username=${u}`}`, 404);
  }
  return {
    fid: user.fid,
    username: user.username,
    displayName: user.displayName ?? null,
    pfpUrl: user.pfp?.url ?? null,
    bio: user.profile?.bio?.text ?? null,
    location: user.profile?.location?.placeId ?? user.profile?.location?.description ?? null,
    followerCount: user.followerCount ?? null,
    followingCount: user.followingCount ?? null,
    activeOnFcNetwork: !!user.activeOnFcNetwork,
    powerBadge: !!user.viewerContext?.followedBy ? null : (user.activeOnFcNetwork || null),
    venueUrl: user.username ? `https://warpcast.com/${user.username}` : null,
    source: "warpcast",
  };
}

// ----------------------------------------------------------------------------
// 3. farcaster-by-address — given an Ethereum address, find their Farcaster
// ----------------------------------------------------------------------------
async function farcasterByAddress({ address } = {}) {
  const addr = takeAddress(address);
  // Warpcast's `user-by-verification` returns the Farcaster account that has
  // verified this address. Addresses without a verification return 404 — we
  // surface that as { found: false } so the agent doesn't have to handle 404.
  let json;
  try {
    json = await fetchJson(`${WARPCAST_API}/user-by-verification?address=${addr}`, "Warpcast");
  } catch (e) {
    if (e.statusCode === 404) {
      return { found: false, address: addr, source: "warpcast" };
    }
    throw e;
  }
  const user = json.result?.user;
  if (!user) return { found: false, address: addr, source: "warpcast" };
  return {
    found: true,
    address: addr,
    fid: user.fid,
    username: user.username,
    displayName: user.displayName ?? null,
    pfpUrl: user.pfp?.url ?? null,
    bio: user.profile?.bio?.text ?? null,
    followerCount: user.followerCount ?? null,
    followingCount: user.followingCount ?? null,
    venueUrl: user.username ? `https://warpcast.com/${user.username}` : null,
    source: "warpcast",
  };
}

// ----------------------------------------------------------------------------
// 4. lens-profile — lookup by Lens handle or owner address (Lens v2 GraphQL)
// ----------------------------------------------------------------------------
async function lensProfile({ handle, address } = {}) {
  const h = typeof handle === "string" ? handle.trim().replace(/\.lens$/, "").replace(/^lens\//, "") : "";
  const a = typeof address === "string" ? address.trim() : "";
  if (!h && !a) throw bad('"handle" or "address" is required');
  if (a && !ADDR_RE.test(a)) throw bad('"address" must be a 0x-prefixed 40-char hex Ethereum address');
  // Lens v2 schema: Profile { handle, metadata { displayName, bio, picture { ... } }, stats { ... }, ownedBy }
  // Query by handle uses ProfileRequest with handle filter; by address uses ownedBy.
  let query, variables;
  if (h) {
    query = `
      query ProfileByHandle($req: ProfileRequest!) {
        profile(request: $req) {
          id
          handle { fullHandle localName }
          ownedBy { address }
          metadata { displayName bio picture { ... on ImageSet { optimized { uri } } } }
          stats { followers following posts }
        }
      }`;
    variables = { req: { forHandle: `lens/${h}` } };
  } else {
    query = `
      query ProfilesByOwner($req: ProfilesRequest!) {
        profiles(request: $req) {
          items {
            id
            handle { fullHandle localName }
            ownedBy { address }
            metadata { displayName bio picture { ... on ImageSet { optimized { uri } } } }
            stats { followers following posts }
          }
        }
      }`;
    variables = { req: { where: { ownedBy: [a.toLowerCase()] } } };
  }
  const data = await gqlFetch(LENS_API, query, variables, "Lens");
  const profile = h ? data.profile : data.profiles?.items?.[0];
  if (!profile) {
    throw bad(`Lens profile not found for ${h ? `handle=${h}` : `address=${a}`}`, 404);
  }
  return {
    profileId: profile.id,
    handle: profile.handle?.localName ?? null,
    fullHandle: profile.handle?.fullHandle ?? null,
    ownedBy: profile.ownedBy?.address ?? null,
    displayName: profile.metadata?.displayName ?? null,
    bio: profile.metadata?.bio ?? null,
    pictureUrl: profile.metadata?.picture?.optimized?.uri ?? null,
    followers: profile.stats?.followers ?? null,
    following: profile.stats?.following ?? null,
    posts: profile.stats?.posts ?? null,
    venueUrl: profile.handle?.localName ? `https://hey.xyz/u/${profile.handle.localName}` : null,
    source: "lens-v2",
  };
}

// ----------------------------------------------------------------------------
// 5. eas-attestations — list EAS attestations (recipient or attester) on chain
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
          location: null,
          followerCount: 500000,
          followingCount: 1000,
          activeOnFcNetwork: true,
          powerBadge: true,
          venueUrl: "https://warpcast.com/dwr.eth",
          source: "warpcast",
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
          source: "warpcast",
        },
      },
    },
    handler: farcasterByAddress,
  },
  {
    route: "POST /api/lens-profile",
    name: "Lens profile",
    slug: "lens-profile",
    category: "crypto",
    price: "$0.002",
    description:
      "Lookup a Lens Protocol v2 profile by handle (e.g. stani.lens) or owner address. Returns profile id, handle, owner, display name, bio, picture, and follower/following/posts counts. Use to label authors of Lens publications or validate a creator's Lens identity.",
    tags: ["lens", "identity", "profile", "social", "creator"],
    discovery: {
      bodyType: "json",
      input: { handle: "stani" },
      inputSchema: {
        type: "object",
        properties: {
          handle: { type: "string", description: 'Lens localName (e.g. "stani") or "stani.lens"; one of handle/address required.' },
          address: { type: "string", description: "Owner Ethereum address (one of handle/address required)." },
        },
      },
      output: {
        example: {
          profileId: "0x05",
          handle: "stani",
          fullHandle: "lens/stani",
          ownedBy: "0x7241dddec3a6af367882eaf9651b87e1c7549dff",
          displayName: "Stani",
          bio: "Founder Lens & Aave",
          pictureUrl: "https://...",
          followers: 200000,
          following: 1000,
          posts: 500,
          venueUrl: "https://hey.xyz/u/stani",
          source: "lens-v2",
        },
      },
    },
    handler: lensProfile,
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
  WARPCAST_API,
  LENS_API,
  EAS_INDEXERS,
};
