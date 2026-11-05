// Keeps every tool of every seller a suite seeds.
//
// The index cache keeps at most INDEX_SELLER_TOOL_CAP tools per seller
// (src/seller-tool-cap.js, default 5000), read once at import. A suite about
// large catalogues (a 77,000-tool seller stored in parts, a 120,000-tool row,
// an 80,000-tool seller indexed in the background) imports this BEFORE any
// src/ module, so the cache keeps what the suite seeds; children the suite
// spawns inherit it. scripts/test-seller-tool-cap.js covers the cap itself.
if (!String(process.env.INDEX_SELLER_TOOL_CAP || "").trim()) process.env.INDEX_SELLER_TOOL_CAP = "1000000000";
