// The result a child process printed as one JSON line, read from its stdout.
//
// Why not the last line: modules in the child log on their own schedule (a
// Redis connect line, a journal notice), and one can land after the result.
// Reading only the last line then fails a run whose result was correct, and
// passes or fails by timing. This returns the last line that parses as a JSON
// object or array, and throws when there is none.
export function childJson(stdout) {
  const lines = String(stdout).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try { return JSON.parse(line); } catch { /* a log line that only looks like JSON */ }
  }
  throw new Error(`no JSON result line in the child's output: ${String(stdout).slice(-200)}`);
}
