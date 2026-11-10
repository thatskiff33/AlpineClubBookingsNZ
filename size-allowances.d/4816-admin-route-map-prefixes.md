# File-size allowances for #4816

file: src/lib/admin-permissions.ts
lines: 1027
reason: ADMIN_ROUTE_MAP_PREFIXES is a frozen read-only view of
  ROUTE_AREA_PREFIXES, which is module-private; it has to be derived beside
  the map it copies, or it becomes a second hand-kept list. The file shrinks
  once C2 (#4799) generates the map's page half from the hub registry.
