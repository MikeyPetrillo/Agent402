// The strings a workflow hands to `gh issue create/comment/close`, directly or
// through a BODY/HEAD variable (plain or printf). Each is public the moment it
// is posted, so the copy guards read them as public text.
export function issueBodyTexts(yml) {
  const out = [];
  const grab = (re) => { for (const m of yml.matchAll(re)) out.push(m[1]); };
  grab(/--(?:body|comment)\s+"((?:[^"\\]|\\.)*)"/gs);                 // --body "..."
  grab(/--(?:body|comment)\s+"\$\(printf\s+'((?:[^'\\]|\\.)*)'/gs);    // --body "$(printf '...' ...)"
  grab(/\b[A-Z_]*(?:BODY|HEAD)=\s*"((?:[^"\\]|\\.)*)"/gs);               // BODY="..."
  grab(/\b[A-Z_]*(?:BODY|HEAD)=\$\(printf\s+'((?:[^'\\]|\\.)*)'/gs);    // BODY=$(printf '...')
  return out;
}
