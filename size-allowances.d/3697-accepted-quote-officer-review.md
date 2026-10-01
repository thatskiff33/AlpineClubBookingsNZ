# File-size allowances for #3415 (PR #3697)

The accepted-quote state changes small branches in several existing request and
booking lifecycle modules. Keeping each status fence beside its counterpart
writer makes the lock and hold rules easier to check in one place. A broader
module split belongs in a separate review because it would move established
money and capacity paths while this issue changes their shared state.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2707
reason: #3414's shared money fields, #3415's accepted request action and
  #3416's truthful school approval toast sit in the existing request panel's
  status-specific controls; extracting those states would duplicate its
  fetch and permission state.

file: src/lib/booking-request.ts
lines: 3054
reason: #3415's accepted status and #3416's portable booking-policy setting
  join the established request queue and settings updater; moving those small
  branches would split their atomic persistence and audit rules.

file: src/lib/booking-cancel.ts
lines: 2554
reason: #3415's accepted-quote cancellation fence belongs beside the existing
  booking status and refund counterparts in this transaction.

file: src/lib/booking-request-quotes.ts
lines: 2191
reason: #3415's accepted-quote transition shares the existing quote claim and
  payment state checks; splitting it would separate one lifecycle rule.

file: src/lib/school-booking-request.ts
lines: 2969
reason: #3415's accepted status and #3416's optional teacher assignment share
  the existing school conversion claim and contact reconciliation; moving
  either branch would split its organisation, booking and bed-allocation
  transaction.
