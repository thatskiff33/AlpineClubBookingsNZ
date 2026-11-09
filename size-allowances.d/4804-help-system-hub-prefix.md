# File-size allowances for the Help & system hub move (#4804)

Each of these files links a Help & system page, and now takes that link from
the hub registry (`adminHref`) instead of writing the URL by hand, so the link
follows the page when the switch goes on. The only growth in each is the one
line that imports `adminHref`; the links themselves stay the same length.

file: src/app/(admin)/admin/system/audit-log/page.tsx
lines: 1098
reason: one import line, so the page's own address, which it replaces into the
  browser on every filter change, comes from the hub registry. Splitting the
  audit console is a refactor of its own and would not shrink this hunk.

file: src/app/(admin)/admin/system/backups/backups-client.tsx
lines: 844
reason: one import line, so the guided backup setup link comes from the hub
  registry. The link sits in the legacy-variables notice it explains.

file: src/app/(admin)/admin/waitlist/page.tsx
lines: 1023
reason: one import line, so the audit-log and email deliverability links come
  from the hub registry. The links sit in the waitlist rows they explain.

file: src/app/api/issue-reports/route.ts
lines: 277
reason: one import line, so the alert email's Issue Reports link comes from the
  hub registry. The link is built where the alert is sent.
