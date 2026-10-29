# File-size allowances for #4432

file: src/app/(admin)/admin/members/[id]/page.tsx
lines: 1353
reason: one callback prop refreshes the existing client-side member snapshot after inbound sync; extracting the existing oversized page is a separate refactor.

file: src/app/api/webhooks/xero/route.ts
lines: 326
reason: validate the complete signed batch before recording the durable receipt, then fail closed if it cannot be stored. This belongs at the existing signature and payload boundary; the storage logic is already in its own module.

file: src/components/admin-sidebar.tsx
lines: 1210
reason: one item in the existing Needs Attention registry and its count mapping must remain beside the other queue entries; the new health calculation lives in its own module.

file: src/lib/stuck-state-dashboard.ts
lines: 1178
reason: one webhook health item belongs in the existing Xero item registry beside its counterpart failures; the shared detection rule remains outside this large registry.
