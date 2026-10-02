# File-size allowances for #3415 (PR #3697)

The accepted-quote state changes small branches in several existing request and
booking lifecycle modules. Keeping each status fence beside its counterpart
writer makes the lock and hold rules easier to check in one place. A broader
module split belongs in a separate review because it would move established
money and capacity paths while this issue changes their shared state.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2727
reason: #3415's accepted request action and #3416's truthful school approval
  toast and #3413's accepted-adult naming control and pending-adult rates sit
  in this panel's status-specific controls;
  extracting those states would duplicate its fetch and permission state.

file: src/lib/booking-cancel.ts
lines: 2556
reason: the accepted-hold guard and #3413 anonymous-reservation release belong
  with the existing cancellation lock and hold-release branch they fence.

file: src/lib/booking-request-quotes.ts
lines: 2278
reason: the accepted-quote claim, hold retention and response state share the
  existing quote transaction; extracting only this claim would split one
  global-to-lodge lock protocol across modules; #3413's anonymous quote lines
  and held reservations use that same transaction.

file: src/lib/booking-request.ts
lines: 3076
reason: #3415's accepted status and #3416's portable booking-policy setting
  join the established request queue and settings updater; moving those small
  branches would split their atomic persistence and audit rules; #3413 adds a
  conversion gate for unresolved school adults in the same approval claim;
  #3794 exports the held rewrite order for the accepted-party proof.

file: src/lib/school-booking-request.ts
lines: 3047
reason: #3415's accepted status and #3416's optional teacher assignment share
  the existing school conversion claim and contact reconciliation; moving
  either branch would split its organisation, booking and bed-allocation
  transaction; #3413's unresolved-adult guard and #3794's accepted-price and
  guest-identity proof also belong in that conversion transaction.
