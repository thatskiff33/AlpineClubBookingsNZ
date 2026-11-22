# File-size allowances for #5399 (caller IP by one rule)

Twenty route files stopped reading `X-Forwarded-For` themselves and call
`getClientIp()`. Across them the change removes 10 lines net. In these two the
replaced read was already one line, so the import of the shared helper is the
only growth: one line each.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 750
reason: the one added line imports the shared caller-IP helper that replaces a
  raw header read; there is no smaller way to call it, and splitting the refund
  decision route is a refactor of its own, outside this issue.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 307
reason: the one added line imports the shared caller-IP helper that replaces a
  raw header read; there is no smaller way to call it, and splitting the refund
  request route is a refactor of its own, outside this issue.
