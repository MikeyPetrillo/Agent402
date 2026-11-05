# Batch findings log: template

The `/batch` skill keeps one findings log per batch in the private memory folder, outside the
repository; this file is only its shape. Nothing below the header row is ever committed.

After each gate, append one row per finding. Name the class (the shape of the defect, reusable
across batches), not only the instance. When a class appears a second time in any batch, add a
guard test or a skill step and fill the last column.

| date | batch | lens | class | finding | fixed-by (commit) | guard added (test) |
|---|---|---|---|---|---|---|
| YYYY-MM-DD | batch-name | money-security, copy-rules, perf-ops, batch-reviewer, suite, CI or prod | short class name | file:line and the failing scenario, one line | short SHA | `scripts/test-*.js` or skill step; blank on first sight |
