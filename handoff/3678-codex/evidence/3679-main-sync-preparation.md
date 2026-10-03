# #3679 current-main sync preparation

Read-only source comparison; not final review or measured merged-tree approval.
Refs read: main 9cd9a646cc4e96261e56676b81fc00d73e0aff1d; epic
50e461ca2acb133dd97ff23fbadad2eb7f1c7bcd. #3794 thread read at source (one
CLAIM comment); approved scope is held-price reconciliation during naming,
canonical member policy, no new migrations or payment/provider effects.

## Precise resolution guidance

### View-only figures: three conflicting homes and a new assertion

Main adds the Xero operations panel Mark failed action, static opt-out in its
existing banner. Epic adds teacher policy Edit and Save, both static opt-outs
under the existing policy section banner. Both additions must remain. Neither
adds a banner component or vouch. Current parents are main 368/313/279 and epic
369/314/280; their two distinct source additions predict 370 call sites,
315 opt-outs, 281 static opt-outs. **These are prospective expectations, not a
remeasurement.** Run the canonical census on the composed tree and use what it
reports before committing those figures. Banner components should remain 98,
vouched opt-outs34 (29 JSX+5 shell), exception categories unchanged.

Resolve the FIGURES block by retaining BOTH history entries. Update all three
homes together: test, ARCHITECTURE current-tree paragraph including `Those N
split by WHICH rule`, and ViewOnlyActionButton JSDoc. Main newly asserts that
`Those N split by WHICH rule` phrase; preserve the assertion and update its
prose home. Do not resolve by choosing either complete parent figure block.
#3414 UI migration may add/retire controls; remeasure after its merge too.

### Audit manifest/test: combine semantics, not both numbers

Epic removes the accept-time capacity-block/revert booking/logAudit site
(#3415) and adds pending-adult naming booking/logAudit site (#3413): net zero.
Main adds xero.operation.marked_failed createAuditLog and changes bulk stale
reset from logAudit to transactional createAuditLog. Preserve every writer
change and BOTH history explanations.

Main's additional **classified**, unpinned Xero site predicts composed totals
494 writers, pinned128/unpinned366, logAudit270/createAuditLog137, booking105,
xero38; other producer/category totals retain the actual main declarations.
Again, predictions await `pnpm run audit:census` and the canonical test on the
final tree. #3794 must not be presumed to leave these stable if it moves or
adds an audit call. Do not replace producer counts by the epic's old271/135.

Keep main's reset site key rename in BOTH APPLIED_AUDIT_CATEGORIES and
AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER:
`src/app/api/admin/xero/operations/reset-stale-running/route.ts::POST.count#0`.
The record moved into the `count` callback and old POST#0 would lose its
classification. Keep new charge writer comment source filename
`edit-financial-review-charge-sync.ts` in manifest AND test; main split the
actual writer there. Do not reintroduce stale charge.ts descriptions.

Audit counts are published beyond the two conflicts: main's operations
invariant already says 128 of494. Re-run audit-writer-census to reconcile its
docs assertions rather than updating just conflict hunks. Existing epic
booking105 is correct because the removed booking writer and added naming
writer compensate; its lone comment `105 ->104` needs #3413's restoring entry
if history is retained. Never label a prediction RE-MEASURED.

### Booking-owner census: preserve three independent edits

- Epic booking-cancel.ts comparison shifts 513 to514 due early pending-night
  release. Main does not change that module in the recent delta; keep epic514.
- Main date-modification-service comparison shifts392 to393; keep main393.
- Main payment-recovery optional reads shift2558/2610 to2624/2676; keep main.
- Main newly enumerates `manual-refund-task-resolution-select.ts:54` in
  UNROOTED_ORGANISATION_SELECTIONS. Keep entry and explanation: actual source
  uses Prisma.validator<Prisma.ManualRefundTaskSelect>(), organisation is nested
  under booking and names `{name,email}`. The extraction did not invent a new
  untyped owner projection. Keep all existing enumerated entries.

These are source-derived locations at the refs above. Final source census
must rederive if either child/main adds lines. Do not edit literals to match a
summary without reading the actual referenced expression.

## New counterpart compatibility to inspect on final tree

#3740/#3582 adds global lock(1) as first transaction lock for EDIT_FINANCIAL_REVIEW
manual-refund completion, before task/booking/payment reads and narrowed locks;
provider execution stays post-commit. New ledger rebase/share posters ask
bookingHasConfirmationLines under that cohort. #3413 naming requires its held
booking AWAITING_REVIEW, therefore must remain provisional: never emit paid
settlement/confirmation/credit lines merely because its guest cents reconcile.
Review #3794 reprice helpers for ledger side effects and approval handoff.

#3788/#3402 adds a separate single-flight raise lease, not an advisory key,
on EditReviewChargeRaiseClaim; no provider round trip holds a DB lock. New
charge/recovery split must remain intact. Accepted school-name reconciliation
cannot reach this charge path, rewrite accepted terms, mint an additional ask,
or treat claim metadata as money. The added table/defaults do not change the
old-schema SCHOOL request inserts used by the seed.

## Additional selected checks after sync

Keep all named groups in3679-validation-inventory.md. Add these meaningful
counterpart assertions where final integration touches/reaches them (serial,
maxWorkers1, no local full suite):

```powershell
pnpm exec vitest run src/lib/__tests__/booking-ledger-modification-posting.test.ts src/lib/__tests__/booking-ledger-modification-sync.test.ts src/lib/__tests__/booking-ledger-posting-keys.test.ts src/lib/__tests__/booking-ledger-realdb-wiring.test.ts src/lib/__tests__/booking-review-price-rebase.test.ts src/lib/__tests__/manual-refund-task.test.ts src/lib/__tests__/lock-bound-club-zone-outside-transaction.test.ts --maxWorkers=1
pnpm exec vitest run src/lib/__tests__/edit-financial-review-charge-claim.test.ts src/lib/__tests__/edit-financial-review-charge.test.ts src/lib/__tests__/payment-recovery.test.ts src/lib/__tests__/xero-operation-routes.test.ts src/lib/__tests__/xero-operation-retry.test.ts src/lib/__tests__/xero-operation-queue.test.ts src/lib/__tests__/finance-support-comms-action-route-guards.test.ts --maxWorkers=1
```

Fresh final schema client generated before any of these. Root should decide
whether full counterpart unit groups add evidence beyond their exact-main CI;
mandatory merge-conflict census set is audit-writer, booking-owner, banner,
plus advisory-lock and ssot-comment-stripper (main's canonical importer figure
moved108->109, and residual3794 may introduce more imports). Do not increment
that figure: guard remeasures published docs and helper together.

Canonical child realDB proof and both wave migration fixtures remain required;
PR CI also owns the newly landed ledger and raise-claim realDB harnesses. A
separate disposable run of ledger-modification and raise-claim races is useful
only if final school/resolution code actually composes these writers. Generic
old-client read rehearsal is never their concurrency proof.

## Seed/rehearsal status

3679-rehearsal-seed.sql statically revalidated against9cd9 main: all10 INSERT
model/column lists and eight JSON literals valid; underlying seeded model
scalars unchanged by the new claim migration. No runtime SQL/constraint test.
The header records both original and current checked SHA. Existing no-new-field
seed remains valid; final base migrations will create the new claim table
before seeding, while wave's two20261101 migrations stay the added set.
No PostgreSQL/Docker/installed dependency/tracked/GitHub changes performed.

Prerequisites: #3414 plus #3794 merged, last main sync, final census measurement,
fresh labelled cluster, old-client rehearsal, formal final independent lenses,
exact integrated-head CI and owner comment. This preparation is not closure.

