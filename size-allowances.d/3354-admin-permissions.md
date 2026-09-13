# File-size allowances for #3354

file: src/lib/admin-permissions.ts
lines: 900
reason: the route-to-area prefix map is the one home for which permission area
  an admin API route resolves to; the new shared /api/admin/ai-spend-currency
  route needs its three lines there, and registering it anywhere else would be a
  second map the census tests could not see.
