# File-size allowances for #5248 (subscription categories: bulk set, filter, transfer)

Each file and function below was already over its budget on `main`. What each
gains is the call site of something that lives elsewhere: the filter's
where-clause is `src/lib/subscription-category-filter.ts`, the bulk action is
`src/lib/bulk-subscription-category-assignments.ts` and its own dialog, and
the select, label and dialog are their own components. What stays here is the
one line that applies the filter, the one field the list row carries, and the
wiring that opens the dialog.

file: src/app/(admin)/admin/membership/members/page.tsx
lines: 626
reason: the page owns every bulk dialog's open state, its mount and its
  completion toast; the new dialog's state, mount and options hook have to
  sit beside the membership-type dialog's, and the two completion handlers
  were folded into one to keep the growth down.

file: src/app/api/admin/members/export/route.ts
lines: 526
reason: the CSV export must apply the same subscription-category filter as the
  list so the file matches the screen; the clause is one shared helper call
  among this route's other filter clauses.

file: src/lib/admin-members-service.ts
lines: 1736
reason: the list query applies the shared category filter beside the
  membership-type filter it mirrors, selects the current-season category and
  returns it on each row; splitting the list query is a refactor of its own.

function: src/app/(admin)/admin/membership/members/page.tsx#MembersPage
lines: 561
reason: the new bulk dialog's open state, options hook and mount sit beside the
  membership-type dialog's in this page component; splitting the page is its
  own refactor.

function: src/app/(admin)/admin/membership/members/_components/member-filter-toolbar.tsx#MemberFilterToolbar
lines: 323
reason: the category select is its own component; what the toolbar gains is its
  placement in the primary row and the chip label for a category id, both of
  which belong with the other filters' chips and placement.

function: src/app/(admin)/admin/membership/members/_components/member-table.tsx#MemberTable
lines: 309
reason: one line renders the category label component under the Type - Tier
  cell it annotates.

function: src/app/api/admin/members/export/route.ts#GET
lines: 465
reason: the shared category filter is applied among this handler's other
  filter clauses, which is where the export builds its where-clause.

function: src/lib/admin-members-service.ts#listAdminMembers
lines: 931
reason: the shared category filter is applied beside the membership-type filter,
  and the row gains its current-season category beside its membership type;
  both sit where the list query assembles them.
