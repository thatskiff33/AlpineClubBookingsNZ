# Privacy retention integration allowances (#4457)

New retention logic is in bounded modules. These additions connect it to existing
registries and keep departure fields inside the lifecycle writes they describe.

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1309
reason: The leaving-date write belongs in the existing atomic account deactivation payload; extracting two lines would separate it from active=false.

file: src/app/api/admin/members/bulk-update/route.ts
lines: 749
reason: Departure stamping and the guarded update predicate must remain alongside the bulk mutation; the date-preservation helper is already shared.

file: src/app/api/admin/members/import/route.ts
lines: 814
reason: The explicit imported cancellation day belongs alongside the cancellation fields in the existing create payload.

file: src/components/admin-sidebar.tsx
lines: 1211
reason: The privacy route must be registered in the single navigation registry so sidebar and command palette share visibility.

file: src/instrumentation.node.ts
lines: 1723
reason: Only registration is added beside existing nightly retention tasks; job implementations live in separate bounded modules.

file: src/lib/admin-cron-health.ts
lines: 945
reason: The new job definitions belong in the existing health registry so scheduling and health reporting remain consistent.

file: src/lib/admin-member-detail-service.ts
lines: 1769
reason: Leaving-date validation and stamping belong beside lifecycle validation and the single atomic update; the shared departure rule is extracted.

file: src/lib/admin-members-service.ts
lines: 1782
reason: The create payload must stamp explicit deactivation alongside active=false; the shared departure helper is already extracted.

file: src/lib/admin-permissions.ts
lines: 1008
reason: Route-area classification belongs in the canonical route permission registry, rather than a second privacy-specific map.

file: src/lib/member-lifecycle-actions.ts
lines: 1757
reason: Archive approval must stamp the departure in its existing atomic lifecycle update; the shared departure helper is already extracted.

file: src/lib/membership-cancellation-admin.ts
lines: 1159
reason: Cancellation approval must stamp the departure in its existing atomic lifecycle update; the shared departure helper is already extracted.

