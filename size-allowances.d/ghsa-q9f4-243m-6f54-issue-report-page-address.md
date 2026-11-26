# File-size allowance for GHSA-q9f4-243m-6f54

file: src/app/api/admin/issue-reports/[id]/route.ts
lines: 348
reason: one import line, for the single rule that decides which page address an officer is shown for a stored issue report. The rule lives in its own module; splitting this route to absorb one import would be a refactor inside a security fix.
