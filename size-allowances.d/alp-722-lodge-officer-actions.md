# Size allowances for ALP-722 (Lodge Operations AI app actions)

file: src/app/api/admin/hut-leaders/eligible-members/route.ts
lines: 287
reason: the route is now also a Lodge Operations AI app action (ALP-722).
  It gains the imports of its shared query schema and connection shape and
  answers through `connectionJson`, so a connection receives each candidate
  without their email address (`INV-MCP-006`). The route was already over its
  limit; splitting its candidate builder is a refactor of its own, not part of
  this change.
