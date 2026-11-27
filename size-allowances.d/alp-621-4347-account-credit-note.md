# File-size allowances for the voided account-credit note fix (#4347)

The reading helpers live in the new `src/lib/xero-account-credit-note-reading.ts`.
What is left in each file below is the one call or branch that must sit where
it is: inside the link funnel's normaliser, the recount's Payment-locked
transaction, the allocation repair's member-locked transaction, the inbound
reconcile between its link writes and its stamp and mirror, and the outbound
create's completion links.

file: src/lib/xero-sync.ts
lines: 1221
reason: the account-credit branch must run in the link normaliser, before the
  refund-note branches that read or lock the Payment row, so the account-credit
  write locks only its own row (INV-LOCK-002); moving it out would split the
  normaliser's one ordering.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 994
reason: the recount reads both roles' rows under its Payment row lock, and the
  allocation repair re-judges the reading under the member's credit lock; each
  is a call inside a transaction that already lives in this file, which was
  over its limit before this change.

function: src/lib/xero-inbound/credit-note-repairs.ts#repairAccountCreditAllocationBusinessState
lines: 394
reason: the gate must run inside the per-target transaction, after
  lockMemberCreditLedger and before the first ledger read; splitting the
  function is a refactor of its own, not part of this fix.

file: src/lib/xero-credit-notes.ts
lines: 1350
reason: the outbound create's completion link records Xero's own answer with
  its UpdatedDateUTC, a field on the link literal already in this file.

function: src/lib/xero-credit-notes.ts#createUnappliedXeroCreditNote
lines: 319
reason: the same completion link literal, inside this function, which was
  already over its limit before this change.

function: src/lib/xero-inbound/credit-note.ts#reconcileXeroCreditNote
lines: 530
reason: the stamp and mirror gates must read the account-credit row after this
  function's own link writes and before its stamp and mirror calls; splitting
  the reconcile is a refactor of its own, not part of this fix.
