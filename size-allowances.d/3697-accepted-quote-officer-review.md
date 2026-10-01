# File-size allowances for #3415 (PR #3697)

The accepted-quote state changes small branches in several existing request and
booking lifecycle modules. Keeping each status fence beside its counterpart
writer makes the lock and hold rules easier to check in one place. A broader
module split belongs in a separate review because it would move established
money and capacity paths while this issue changes their shared state.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2704
reason: the accepted request action and confirmation sit in the existing
  request panel's status-specific controls; extracting this one state would
  duplicate its fetch, permission and toast state.

file: src/lib/booking-cancel.ts
lines: 2554
reason: the accepted-hold cancellation guard belongs with the existing
  cancellation lock and hold-release branch it fences.

file: src/lib/booking-request-quotes.ts
lines: 2191
reason: the accepted-quote claim, hold retention and response state share the
  existing quote transaction; extracting only this claim would split one
  global-to-lodge lock protocol across modules.

file: src/lib/booking-request.ts
lines: 3045
reason: the accepted status joins the established request queue and approval
  predicates; the two added lines belong with those predicates.

file: src/lib/school-booking-request.ts
lines: 2944
reason: the accepted status is another legal input to the existing school
  conversion claim; moving that claim to a new module would split its
  organisation, booking and bed-allocation transaction.
