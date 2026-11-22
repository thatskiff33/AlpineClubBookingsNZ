# File-size allowances for #5399 (caller IP by one rule)

Twenty route files stopped reading `X-Forwarded-For` themselves and call
`getClientIp()`. Across them the change removes 10 lines net. In these two the
replaced read was already one line, so the import of the helper is the only
growth: one line each. Both files already import from `@/lib/audit`, so reading
the address as `getAuditRequestContext(req)?.ipAddress` through that import
would not have grown them. The growth is a trade-off taken on purpose.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 750
reason: one import line keeps one form, getClientIp(req), across all twenty
  routes, which the #5399 route table test checks; reaching the address
  through the existing audit import would make this route the one exception
  to that form. Splitting the refund decision route is a refactor of its
  own, outside this issue.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 307
reason: one import line keeps one form, getClientIp(req), across all twenty
  routes, which the #5399 route table test checks; reaching the address
  through the existing audit import would make this route the one exception
  to that form. Splitting the refund request route is a refactor of its
  own, outside this issue.
