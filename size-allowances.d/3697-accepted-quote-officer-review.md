# File-size allowances for #3415 (PR #3697)

The accepted-quote state changes small branches in several existing request and
booking lifecycle modules. Keeping each status fence beside its counterpart
writer makes the lock and hold rules easier to check in one place. A broader
module split belongs in a separate review because it would move established
money and capacity paths while this issue changes their shared state.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2708
reason: #3415's accepted request action and #3416's truthful school approval
  toast sit in the existing request panel's status-specific controls;
  extracting those states would duplicate its fetch and permission state.

file: src/lib/booking-cancel.ts
lines: 2532
reason: the accepted-hold cancellation guard belongs with the existing
  cancellation lock and hold-release branch it fences.

file: src/lib/booking-request-quotes.ts
lines: 2191
reason: the accepted-quote claim, hold retention and response state share the
  existing quote transaction; extracting only this claim would split one
  global-to-lodge lock protocol across modules.

file: src/lib/booking-request.ts
lines: 3053
reason: #3415's accepted status and #3416's portable booking-policy setting
  join the established request queue and settings updater; moving those small
  branches would split their atomic persistence and audit rules.

file: src/lib/school-booking-request.ts
lines: 2968
reason: #3415's accepted status and #3416's optional teacher assignment share
  the existing school conversion claim and contact reconciliation; moving
  either branch would split its organisation, booking and bed-allocation
  transaction.
