# File-size allowance for the admin hub URL plumbing (#4800)

file: src/app/api/admin/bookings/[id]/mark-paid/route.ts
lines: 257
reason: one import line, `revalidateAdminPage`, which replaces two literal
  `revalidatePath("/admin…")` calls so the admin pages this write refreshes
  follow the hub registry when they move (epic #4468). The route still
  revalidates the member-side booking page by its pattern, so both imports are
  needed; splitting the handler to recover one line would move its money path
  away from the refreshes that follow it.
