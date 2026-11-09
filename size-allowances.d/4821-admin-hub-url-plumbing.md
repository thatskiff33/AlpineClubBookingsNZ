# File-size allowances for #4821

Each file was already over its budget. This change adds one import so the
existing handler can call `revalidateAdminPage` or `samePage`. Splitting the
route or the sidebar to absorb that import would move the call away from the
handler it refreshes.

file: src/app/api/admin/bookings/[id]/mark-paid/route.ts
lines: 257
reason: one import of revalidateAdminPage beside the mark-paid handler that
  already refreshes the bookings and payments pages after it succeeds.

file: src/app/api/admin/subscription-billing/route.ts
lines: 363
reason: one import of revalidateAdminPage beside invalidate(), which already
  refreshes the subscriptions and stuck-states pages after a billing change.

file: src/components/admin-sidebar.tsx
lines: 1217
reason: one import of samePage beside the sidebar's existing active-link
  comparison. The highlight rule stays in the component that renders the link.
