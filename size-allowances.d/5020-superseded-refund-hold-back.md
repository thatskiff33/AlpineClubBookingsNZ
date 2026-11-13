# File-size allowances for #5020 (#4872)

Each refund door has to read the live superseded capture's hold-back on its own
transaction, under the Payment row it already holds, and pass it to the
allocation or plan it already makes. Moving that read into another module would
take it away from the lock it depends on.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 757
reason: the approval reads the hold-back on its own locked transaction and nets it from the cap it already computes.

file: src/lib/member-credit.ts
lines: 1150
reason: the modification credit, its ledger lines and the hold-back-aware Payment allocation now commit in one transaction.

file: src/lib/payment-reconciliation.ts
lines: 2899
reason: the capacity race's refund plan reads the hold-back inside the transaction that already plans the refund.

file: src/lib/payment-recovery.ts
lines: 3641
reason: each recovery runner that plans a refund reads the hold-back under the Payment row it already locks.
