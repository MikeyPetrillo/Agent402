// Shared by the report kits: the chat call, a leg runner that never throws,
// and length handling. A synthesis call that stops for length ships a
// report cut mid-sentence. The model is asked once more to finish inside the
// budget; a second long stop is trimmed to its last complete block and says
// so, rather than ending on a half sentence.

import { fetchOpenRouter, throwUpstreamError } from "./tools/llm-gateway-kit.js";

export const stoppedForLength = (d) => String(d?.choices?.[0]?.finish_reason || "").toLowerCase() === "length";
export const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
export const costOf = (d) => Number(d?.usage?.cost) || 0;

/** One chat call for a report kit. usage.include returns `usage.cost`, which
 *  meters the run and never reaches the buyer; `user` scopes upstream abuse
 *  controls to the payer. A non-2xx answer throws the gateway's error. */
export async function reportChat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}

/** Run one data leg without throwing: { ok: true, data } or
 *  { ok: false, error, status }. `work` is a promise or a function returning
 *  one (a function's synchronous throw is a failed leg too). Past `timeoutMs`
 *  the leg fails with a 504 "timeout"; the timer is cleared either way. */
export async function settleWithin(work, timeoutMs) {
  let timer = null;
  try {
    const p = typeof work === "function" ? work() : work;
    const data = timeoutMs
      ? await Promise.race([p, new Promise((_, r) => { timer = setTimeout(() => r(Object.assign(new Error("timeout"), { statusCode: 504 })), timeoutMs); })])
      : await p;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), status: Number.isInteger(e?.statusCode) ? e.statusCode : null };
  } finally {
    clearTimeout(timer);
  }
}

export const lengthRetryNote = (words) =>
  `\n\nYour previous draft ran past the length budget and was cut off before its last section. Write the complete report again${words ? ` in under ${String(words).replace(/^~/, "")} words` : ", shorter"}: finish every numbered item and every section, and leave nothing half-written.`;

/** Drop a trailing block that does not end cleanly (a sentence, a table row,
 *  a list item, a fenced block), so a cut report ends at a boundary. */
export function trimToCompleteBlock(text) {
  const t = String(text || "").replace(/\s+$/, "");
  if (!t) return t;
  const lastLine = t.slice(t.lastIndexOf("\n") + 1).trim();
  if (/[.!?:)"'`|\]]$/.test(lastLine) || /^(```|---|\|.*\|)$/.test(lastLine)) return t;
  const cut = t.lastIndexOf("\n\n");
  return cut > 0 ? t.slice(0, cut).replace(/\s+$/, "") : t;
}

export const SHORTENED_NOTE = "_This report was shortened to fit its length budget; every section above is complete and the data appendix is whole._";

/**
 * run(note) performs the synthesis call with `note` appended to the prompt.
 * Returns { sd, calls, cutShort }: `calls` carries every response (for cost),
 * `cutShort` is true when the final answer still stopped for length.
 */
export async function completeSynthesis(run, words) {
  const first = await run("");
  if (!stoppedForLength(first)) return { sd: first, calls: [first], cutShort: false };
  const again = await run(lengthRetryNote(words));
  const sd = textOf(again) ? again : first;
  return { sd, calls: [first, again], cutShort: stoppedForLength(sd) };
}

/** The prose to ship: trimmed and marked when the final answer was cut. */
export function proseOf(sd, cutShort) {
  const text = textOf(sd);
  if (!cutShort || !text) return text;
  return `${trimToCompleteBlock(text)}\n\n${SHORTENED_NOTE}`;
}
