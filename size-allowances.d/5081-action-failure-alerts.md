# File-size allowances for #5081

The chores and lockers admin pages were already over their page-shell budget
on `origin/main` (705 and 746 lines) and grow by the wiring that moves an
action failure into the focused alert. The lodges page was inside its budget,
so it is not here: its "Lodge properties" card was moved into
`lodges/_components/lodge-properties-card.tsx` and the page is shorter than
the 500-line budget.

file: src/app/(admin)/admin/chores/page.tsx
lines: 747
reason: the growth is the failure wiring inside the handlers that own the
  state it reads: the split between the passive load error and the action
  error, the `failAction` helper with its lodge-scope fence, the attention
  counter the repeat-failure focus depends on, the success signal for a save
  that closes the form, and the permanently mounted alert. The page is one
  component whose form, list and three handlers share about two dozen pieces
  of state, so lifting the form or the table into a child is a refactor with
  a wide prop surface of its own, not a seam this change can use.

file: src/app/(admin)/admin/lockers/page.tsx
lines: 773
reason: the same wiring as the chores page, in the save, delete and bulk
  create handlers (each of which sets and clears the action error), plus the
  load error moving from the form card into the list card. The form, the
  member search combobox and the sortable table read the same eighteen or so
  pieces of state, so the split that would pay for this growth is a separate
  refactor of the page, not a seam this change can use.

function: src/app/(admin)/admin/chores/page.tsx#ChoresPage
lines: 681
reason: focuses action failures on the chores, lockers and lodges pages; those
  lines sit inside the function `ChoresPage`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/app/(admin)/admin/lockers/page.tsx#LockersPage
lines: 695
reason: focuses action failures on the chores, lockers and lodges pages; those
  lines sit inside the function `LockersPage`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.
