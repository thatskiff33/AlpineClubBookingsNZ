#3679 final compose blueprint (working checkpoint)

Preconditions: merge reviewed #3416, #3413, #3414 into the epic branch after
the standalone #3755 security patch reaches main and is synced. #3415 is
already merged. Re-read each exact PR head and issue thread before merging.

Affected invariants: INV-CAP, INV-DATE, INV-MOD, INV-REQ, INV-LIFE,
INV-LOCK, INV-MONEY, INV-OPS, INV-SSOT. This lane makes no new product
decision; a conflict that changes one goes back to its child issue and owner.

Counterpart writers: accepted-quote request/quote claims; cancellation and
hold release; school conversion and teacher assignment; unnamed-adult
capacity admission/resolution; officer correction and public response;
money-field callers and financial-review guards. Compare #3726's lodge
capacity work if it reaches main first: retain #3413's pendingAdultCount in
the capacity comparison and #3407's lodgeGuestLimitMessage. Re-measure
view-only census totals and file-size allowances after every sync.

Data/recovery: review both additive migrations (teacher-policy Boolean and
pending-adult reservation rows), blue-green ledger and old-client read. #3413
needs a maintenance-window cutover with old web/workers stopped; rollback
requires zero pending reservations. No production data or live provider calls.

Validation: inspect every conflict against both parents; focused differential
tests for any behavior-bearing resolution; full-tree guard/census inventory
using the entire epic-to-main diff; docs/index/link checks; migration drift,
verification and old-client rehearsal on disposable PostgreSQL; final
exact-head PR CI with all nine required checks plus advisory review. Two
independent adversarial review lenses before integration PR is ready.

Stop conditions: a merged child changes another child's approved contract;
incompatible migrations or a failed old-client rehearsal; unexplained
capacity/lock/settlement behavior; red exact-head required CI. Record and
fix in the relevant child or this compose lane, then revalidate.

## Fresh recovery validation 2026-10-02
Compose HEAD4caebd836/main9cd9a646c. Seeded db:rehearse-epic passed (log3679-rehearsal-recovery.log):382base migrations+2epic migrations,196old-schema modelsread,25populated139rows171empty; generated withinstalledPrisma7.10, scalarreads only. Disposable scratch dropped, [lane container omitted] maintenance clusteronlypostgres verified. No production or providers.
GitBash check-migration-safety-coverage.sh --baseorigin/main passed exit0:2added migration same-releasegate,ledgercoverage,previousreleases. validate-blue-green-migrations.sh bothpaths passed exit0 under command-scoped local maintenancewindowacknowledgements; override explicitly synthetic, varsremoved. Logs3679-recovery-migration-coverage.log and3679-recovery-blue-green.log.
Actual migrated PostgreSQL data-migration-verification.realdb.test.ts selected20261101010000|20261101020000 passed13tests,302unrelatedskipped,111.38seconds,exit0. Includesverificationmutantsfor both wave additions. Log3679-recovery-migration-verification.log. Not wholefinalcompose evidence:3794 and3754 stillpending; recheck migration source diff/base if either changes atfinalhead.
Runtime agent execution recovered onthiscontinuation;finish_3794 andinventorylane active. Originalgoal remainsactive; no merge/push done inrestartrecovery.

