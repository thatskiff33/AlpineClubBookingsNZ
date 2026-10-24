# File-size allowance for #4270 — the credit-note mirror's cron-health entry

file: src/lib/admin-cron-health.ts
lines: 939
reason: one more `defineCronJob` entry (the mirror's sweep, recorded as its own job so the health page can show it stale), in the same eleven-line shape as the thirty-odd entries around it. There is no seam: the table is one list, and a job missing from it is reported as untracked.
