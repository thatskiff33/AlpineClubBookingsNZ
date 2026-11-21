# File-size allowances for ALP-674 (#5204)

function: src/lib/admin-cron-health.ts#getAdminCronJobDefinitions
lines: 568
reason: the function is the one declarative list of every cron job's health
  definition, and the cron-recording contract requires each recorded job to
  have an entry there. The growth is the new Xero overpayment and prepayment
  refresh's one entry, shaped like its neighbours. Splitting the list to absorb
  one entry would scatter the single place an operator's cron health is defined.

file: src/lib/admin-cron-health.ts
lines: 964
reason: the same one cron-health entry as above, in the file that holds the
  list.

file: src/components/admin-sidebar.tsx
lines: 1041
reason: the Finance menu gains its Xero Unallocated Payments link and that
  link's icon import; the menu is one declarative list, and splitting the
  sidebar to absorb two lines would invent a seam for this change alone.
