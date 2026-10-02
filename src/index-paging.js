// The paging contract of GET /api/index, as a pure function.
//
// It lives here rather than inline in the handler for one reason: a CI boot
// indexes ONE seller (the host's own row), so every multi-page branch -
// complete=false, rel="next", rel="prev", the PARTIAL note - is unreachable
// from a booted test. A guard that can only exercise the single-page case is a
// certificate for the half that never broke. The handler's wiring is pinned
// from source; the arithmetic is pinned here with real totals.
//
// Why it exists at all: the envelope has carried page/pages/sellerCount and a
// prose note since the zero-based fix of 2026-09-13, and on 2026-09-22 a
// seller's automated checker still reported their origin "missing from the
// current Agent402 index". It had fetched the default page, searched 250 rows
// of 4,473 and not found them; they were on page 15 of 18. Our own llms.txt
// had called the endpoint a "snapshot of every seller indexed", so the reading
// was one we invited. Prose does not reach a machine. These do.

/** Clamp a requested page size. `perPage` is honoured as an alias for `limit`
 *  because two consumers in a row guessed that name, and a guessed parameter
 *  that is silently ignored returns the DEFAULT page while looking obeyed. */
export function pageSizeOf(limit, perPage, { def = 100, max = 250 } = {}) {
  const n = parseInt(limit ?? perPage, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : def, 1), max);
}

/** Everything the response needs to say it is one page of many.
 *  `complete` is false whenever a seller is absent from THIS response but
 *  present in the index - the one boolean a checker needs before it concludes
 *  an origin is missing. */
export function pagingEnvelope({ total, page, perPage, path = "/api/index" }) {
  const count = Math.max(Number(total) || 0, 0);
  const size = Math.max(Number(perPage) || 1, 1);
  const pages = Math.ceil(count / size);
  const lastPage = Math.max(pages - 1, 0);
  const here = Math.max(Number(page) || 0, 0);
  // `here === 0 &&` is load-bearing: without it an OUT-OF-RANGE page on a
  // one-page index (?page=3 with 10 sellers) returns zero rows and calls itself
  // complete, which is the same lie in miniature. Completeness is a property of
  // THIS response, not of the index.
  const complete = here === 0 && count <= size;

  const range = `pages are ZERO-BASED: ?page=0 .. ?page=${lastPage}`;

  const qs = (n) => `${path}?page=${n}&limit=${size}`;
  const links = [`<${qs(0)}>; rel="first"`, `<${qs(lastPage)}>; rel="last"`];
  if (here > 0 && here <= lastPage) links.push(`<${qs(here - 1)}>; rel="prev"`);
  if (here < lastPage) links.push(`<${qs(here + 1)}>; rel="next"`);

  return { pages, lastPage, complete, range, link: links.join(", ") };
}

/** The note. Leads with PARTIAL when it is partial, because the first word is
 *  the only part of a sentence a hurried reader keeps. */
export function pagingNote({ total, page, perPage, shown, pages, lastPage, complete, range }) {
  if (page > lastPage) {
    return `No sellers at page ${page}: ${range}. ${total} sellers total. Page 0 is the first page, not page 1.`;
  }
  if (complete) return `All ${total} sellers in one page (${range}).`;
  return `PARTIAL: this is page ${page} of ${pages} and holds ${shown} of ${total} sellers (${range}). `
    + `A seller absent HERE may still be indexed - check one origin with ?seller=<host>, which pages nothing `
    + `and returns its full row. Follow rel="next" in the Link header, or ?page=N&limit=<=250.`;
}
