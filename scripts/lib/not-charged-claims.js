// The phrasings of "a failed call is not charged" (CLAUDE.md, "x402
// settlement ordering"): every surface that makes the claim carries the shared
// settle-first sentence (src/settle-first-copy.js) beside it. Read by the
// source guard (scripts/test-copy-absolutes.js) and the rendered-page guard
// (scripts/test-not-charged-rendered.js), so a phrasing added here is held on
// both. A refusal of the payment itself ("refusals are free") is not this claim.

/** A fresh global, case-blind matcher of every phrasing of the claim. */
export function notChargedClaims() {
  return new RegExp('\\bfailed x402 (?:call|run|request)s? (?:is|are) not charged|\\b(?:response|answer)s? of 400 or above (?:is|are) not (?:settled|charged)|\\bfailed run is not charged|\\berror status cancels\\b|\\b4xx\\b[^.;|]{0,20}\\b5xx\\b[^.;|]{0,120}\\b(?:cancels settlement|not charged|never settled)|\\bonly (?:for a response )?under 400 \\| not charged|\\bany status of 400 or above is not charged|\\ba 4xx or 5xx\\b[^.;]{0,200}?\\b(?:cancels settlement|is not charged|is never charged)|\\ban? (?:error|failed) (?:answer|call|response)s? (?:is|are) not (?:charged|settled)|\\b(?:calls?|requests?) (?:that|which) fails? (?:is|are) not charged|\\bsettles? only after\\b[^.;]{0,80}\\bsuccess|\\bnot settled and you are not charged|\\bnever pays? for a failed\\b|\\bfailed calls? (?:is|are) (?:never|not) charged|\\berrors? (?:is|are) (?:never|not) charged|\\b(?:fail\\w*|errors?|upstream|outage|5\\d\\d|timed[- ]out|cut off)\\b[^.\\n]{0,300}?\\bnot charged on x402\\b|\\bfailed (?:call|run)s?\\b[^.;]{0,200}?\\b(?:is|are) not charged|\\ba call the tool fails is not charged|\\bfailure case costs nothing|\\ban? error cancels settlement|\\bnot charged for a failure|\\b(?:answer|response)s? with an error status (?:is|are) not (?:settled|charged)|\\bnot charged: the (?:error|same settlement path|credential)|\\bsettles only (?:on a delivered result|when the result is ready)|\\bon x402,? (?:that|the|this|a|any) (?:failure|failed (?:call|run|request)|error)s? (?:is|are) not charged', "gi");
}

/** Whether a stretch of copy carries the family's words (or interpolates them). */
export function carriesSettleFirst(near, mark) {
  return near.includes(mark) || /\$\{(?:SETTLE_FIRST_|FAILED_CALL_SENTENCE)/.test(near);
}
