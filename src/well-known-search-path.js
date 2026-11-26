// The site search endpoint's address and methods, with no imports, so the
// page shell can advertise it without loading the search module
// (src/well-known-search.js serves it).
export const WELL_KNOWN_SEARCH_PATH = "/.well-known/search";
export const SEARCH_ALLOW = "GET, HEAD, QUERY, OPTIONS";
/** The methods the page head advertises (HEAD and OPTIONS go without saying). */
export const SEARCH_ADVERTISED_METHODS = "GET, QUERY";
