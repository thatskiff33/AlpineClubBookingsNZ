# File-size allowances for fork #121 (food orders)

Each of these files is a registry a new module must be listed in, already over
its budget before this change. The food-order logic itself lives in new files
(`src/lib/food-order*.ts`, `src/lib/food-orders.ts`, the routes and components);
only the registration lines land here, with their comments trimmed to one or two
lines.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 980
reason: the Order food card is its own component (food-order-dashboard-card.tsx);
  the page only gains the two imports and the module- and organisation-gated
  render beside "Report an issue", which has to sit with the other module cards.

file: src/components/admin-sidebar.tsx
lines: 1086
reason: the Food Orders entry in the Lodge Operations section; the sidebar's
  items are one list and an entry cannot live elsewhere.

file: src/lib/admin-permissions.ts
lines: 952
reason: the `/api/admin/food-orders` prefix in the lodge area's route map, which
  is the one place an admin API prefix gets its permission area.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1198
reason: the `foodOrders` module flag's travel classification, which every module
  flag must carry in this one list.

file: src/lib/email-message-registry.ts
lines: 2481
reason: the `food-order-placed` template's audience, trigger metadata, required
  token and six approved tokens; each is one entry in a registry table that has
  to name every template.

file: src/proxy.ts
lines: 1217
reason: the `/api/food-orders/:path*` matcher entry; Next requires the matcher
  as a static literal in this file, or the module gate never runs on the API.
