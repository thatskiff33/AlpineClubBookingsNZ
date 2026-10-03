# #3679 third-main sync preflight

Source-only independent delta inventory, not an integration verdict or child re-review.

## Exact inputs and finding

Previous main: `546c2ebb04443e5f3a4b8fadca5e370929993248`. Incoming origin/main: `0678af38bf5947faca72111fdf4b08af27b75158`. Prepared compose reviewed: `ed4e23be496a6cbb715890d7e1b7c5c52f6b7e21`. First-parent incoming PRs are #3831 (`b4f406a65`, security epic3795), #3832 (`983ba8e38`, issue3825 UTC bed-move stamp), #3833 (`54f88e57e`, issue3824 migrate build options), #3834 (`0678af38b`, issue3793 paid cancel read under row lock). Exact origin/main was rechecked at the end and still0678af38bf5947faca72111fdf4b08af27b75158. Read full source threads through repository `node scripts/issue-thread.mjs` for3795,3793,3824,3825; no gh issue view. Reopened core/routed invariant, locking, security/credential, date and deployment contracts; compared previous second-main and whole-diff inventory checkpoints only as historical evidence.

No confirmed runtime incompatibility established before merging. Concrete reconciliation defect to address: incoming audit test explicitly pins128 covered sites/367 unpinned, while incoming operations prose still says other355; prepared compose says other361. Both prose literals are stale relative to their source pins. Remeasure the merged census and update its published figures; do not preserve either prose number as authority.

## Exact overlap (151 incoming paths; 136 epic paths; 10 overlap)

CONFIGURATION.md; docs/CONCURRENCY_AND_LOCKING.md; docs/UX_FLOW_MAP.md; docs/invariants/additional-payment-chasing.md; docs/invariants/operations.md; scripts/audit/audit-writer-census-manifest.ts; src/lib/__tests__/audit-writer-census.test.ts; src/lib/__tests__/booking-owner-census.test.ts; src/lib/__tests__/school-booking-request.test.ts; src/lib/booking-cancel.ts.

This intersection is git-diff path evidence, not a prediction that all ten produce textual conflicts. Root owns resolutions. Preserve both branches' entries in docs/manifest/test; do not take one complete file wholesale.

## What sync must retain

- **Paid cancel (#3834):** the global lifecycle lock, then immutable lodge key, then `lockPaymentForRefundedTotal` on the payment id. The preliminary booking relation reads only `{id:true}` for payment; after the row lock it reads the full Payment. That locked row drives part-payment recognition, paid eligibility, refund source/method forcing, tier calculation, and the fresh audit snapshot. The main delta moves source-forced refundMethod into this claim and returns `fresh:{...fresh,payment}` so downstream audit records the row that decided money. Do not restore a full early payment read or the old pre-lock forced method. The dashboard-refund writers intentionally take no advisory key, hence global/lodge alone are insufficient. Preserve main's #3797 cancellation ledger calls AND epic generic-hold ACCEPTED refusal, request-hold status claim and reservation deletion/pointer version detachment in the no-payment branch. The latter paid-read delta and former no-payment delta are separate hunks. SQL failures must still propagate/rollback; provider delivery remains after commit.
- **Audit/ownership:** prepared manifest494/createAuditLog137/security24; incoming495/138/25. New two-factor mutation is ONE awaited security-category site for three actions (enrolled/recovery codes replaced/cleared); Xero writes reuse the existing credential mutation audit site. Preserve epic accepted/naming changes and all source/category maps; run the real merged census to populate figures. Main's ownership comparison is booking-cancel:512; prepared compose:513. The incoming paid changes occur later than that authorization expression, so513 is the expected composed coordinate if the import hunk stays unchanged; measure source rather than copying main512. Retain main's shifted guest/exception/detail-reader/member-night entries.
- **School test/consent rule (#3831):** new client-safe adult-supervision.ts is canonical, re-exported by booking-review. Only operationally present/confirmed adults count. GuestWithConsent makes consentStatus required. Main adjusts the school party fixture projections with consentStatus:null; preserve those maps alongside all epic acceptance/naming/teacher-policy tests. SCHOOL teacher rows that never need consent state null, not placeholder identities or fabricated approvals. No production booking-request.ts or school-booking-request.ts delta is incoming, but broader guest/approval consumers now use the same consent predicate.
- **Family-first privacy (#3831):** preserve INV-GUEST-020 (the one new index id), member-guest-family-first.ts, family and full-lodge preflight ahead of outsider resolution, collapsed member-owned refusal/floor/audit/throttle, and officer detailed answers. Preserve required planned consent arguments and new shared adult-supervision helpers in create/add/modify/UI callers. Main modifies INV-GUEST-019, INV-ADDPAY-003, INV-EXCEPT-011/014; compose modifies other ADDPAY paragraphs, so retain BOTH authoritative contracts.
- **Xero/2FA/kiosk (#3831):** no schema change or migration. Xero token set uses existing encrypted IntegrationCredential namespace; XeroToken remains the old-colour connection/lease mirror. Lease claim precedes token/store-version read in the same short transaction, with exact row-id read after a won claim. Save takes mirror row first, lease fence then credential ciphertext-version CAS; loss rolls both copies back. Shared lease is refreshInProgressUntil, never a new advisory key. Provider refresh is outside transactions, after assertXeroTokensCanBeStored; every write keeps required actor/cause/request evidence. Store-first uncached reads/fingerprint decide which copy is current, not timestamp guesses. Preserve mirror and newest-row order; #3806 retirement is explicitly future owner-gated work. Existing school contact/Xero calls gain these token boundaries without taking a booking/lodge lock inside the token helper. Two-factor change/audit is on one caller transaction, no secret enters payload, and member actors may act only on themselves. SecretInput retains uncontrolled DOM secrecy, now masked PIN/show toggle.
- **UTC/build (#3832/3833):** retain bed move's one bound `${new Date()}` updatedAt; no DB session-clock expression, same reviewed-row CAS/locks/capacity/audit. Preserve app AND migrate build args `NODE_OPTIONS:${NODE_BUILD_OPTIONS:-}` plus main configuration-row clarification and epic maintenance-window/pending-adults variables. Build option remains empty by default/build-only, with no running-container heap change.

## Schema/deploy and revalidation

`git diff 546c2ebb04443e5f3a4b8fadca5e370929993248 0678af38bf5947faca72111fdf4b08af27b75158 -- prisma docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` is empty. No new migration prefix, enum, column, table, or blue-green rollback requirement. Retain both epic school migrations and stopped-old-web/workers plus zero-pending-count/reservation rollback gates. Original pre-epic migration/schema inputs are byte-identical between these two main SHAs; document that source identity if reusing earlier schema-only rehearsal evidence. That does not prove new runtime token writes or cancellation races. Final CI and current-main reconciliation still belong to root.

After sync: source review every actual conflict against both parents; git diff --check; audit:census; docs:indexcheck/linkcheck, invariant word budgets, size budget (booking-cancel bound may move), generated-client typecheck, exact-head CI. Reconcile operations audit numbers after measuring; rerun affected tree-reading checks by NAME, not only related-import graph. Refresh main counterpart PR numbers3831/3832/3833/3834 in the final concurrency declaration. Previous 105-contract whole-epic inventory remains required for all child scope; groups below are the bounded third-main revalidation subset, with no duplicate paths across these groups.

## Concrete source-check commands used

`git log --first-parent --oneline 546c2ebb04443e5f3a4b8fadca5e370929993248..0678af38bf5947faca72111fdf4b08af27b75158`; `git diff --name-only 546c2ebb04443e5f3a4b8fadca5e370929993248 0678af38bf5947faca72111fdf4b08af27b75158`; intersection with `git diff --name-only 546c2ebb04443e5f3a4b8fadca5e370929993248 ed4e23be496a6cbb715890d7e1b7c5c52f6b7e21`; `git diff 546c2ebb04443e5f3a4b8fadca5e370929993248 0678af38bf5947faca72111fdf4b08af27b75158 -- src/lib/booking-cancel.ts src/lib/bed-allocation-move.ts docker-compose.yml`; exact git-show source/census and migration path reads; complete repository issue-thread CLI reads. No tests/runtime/provider/DB/install/commits/push/GitHub writes performed. Only this private checkpoint was written.

## Fail-closed named selections

All listed paths are tracked and existing on the exact incoming main. Main-only paths below are prospective final-tree requirements; do not silently drop them before they are integrated. Wrapper accepts paths only, not test-runner flags. Root should deduplicate against any same-head whole-epic run rather than repeat an already completed group.

### thirdMainContracts

```powershell
$thirdMainContracts = @(
  'src/lib/__tests__/advisory-lock-guard.test.ts',
  'src/lib/__tests__/raw-sql-shape-guard.test.ts',
  'src/lib/__tests__/bed-allocation-lock-topology-contract.test.ts',
  'src/lib/__tests__/lodge-admission-lock-contract.test.ts',
  'src/lib/__tests__/booking-owner-census.test.ts',
  'src/lib/__tests__/audit-writer-census.test.ts',
  'src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts',
  'src/lib/__tests__/lock-bound-club-zone-outside-transaction.test.ts',
  'src/lib/__tests__/credential-actor-census.test.ts',
  'src/lib/__tests__/credential-actor-census-scanner.test.ts',
  'src/lib/__tests__/credential-write-contract.test.ts',
  'src/lib/__tests__/credential-blast-radius-docs-contract.test.ts',
  'src/lib/__tests__/two-factor-secret-census.test.ts',
  'src/lib/__tests__/raw-css-secret-input-census.test.ts',
  'src/lib/__tests__/member-guest-add-call-sites.test.ts',
  'src/lib/__tests__/adult-member-hosting-call-sites.test.ts',
  'src/lib/__tests__/ssot-comment-stripper-guard.test.ts',
  'src/lib/__tests__/client-server-boundary-census.test.ts',
  'src/lib/__tests__/cli-server-only-reach-census.test.ts',
  'src/lib/__tests__/deployment-image-contracts.test.ts',
  'src/lib/__tests__/card-refund-mirror-realdb-wiring.test.ts',
  'src/lib/__tests__/identity-ordering-census.test.ts',
)
pnpm run test:named @thirdMainContracts
```

### thirdMainBehavior

```powershell
$thirdMainBehavior = @(
  'src/lib/__tests__/booking-cancel.test.ts',
  'src/lib/__tests__/booking-cancel-conservation.test.ts',
  'src/lib/__tests__/bed-allocation-move.test.ts',
  'src/lib/__tests__/prisma-date-column-binding.test.ts',
  'src/lib/__tests__/school-booking-request.test.ts',
  'src/lib/__tests__/booking-review.test.ts',
  'src/lib/__tests__/member-guest-operational-presence.test.ts',
  'src/lib/__tests__/member-guest-cross-family-refusals.test.ts',
  'src/lib/__tests__/member-guest-widening.test.ts',
  'src/lib/__tests__/xero-token-credential-store.test.ts',
  'src/lib/__tests__/xero-api-client-token-refresh.test.ts',
  'src/lib/__tests__/xero-oauth-routes.test.ts',
  'src/lib/__tests__/xero-token-store-reentry.test.ts',
  'src/lib/__tests__/two-factor.test.ts',
  'src/lib/__tests__/two-factor-routes.test.ts',
  'src/lib/__tests__/integration-credentials.test.ts',
)
pnpm run test:named @thirdMainBehavior
```

### thirdMainPg

```powershell
$thirdMainPg = @(
  'src/lib/__tests__/paid-cancel-refunded-total-race.realdb.test.ts',
  'src/lib/__tests__/xero-token-credential-store.realdb.test.ts',
)
if ($env:RUN_CONCURRENCY_RACE_TESTS -ne '1' -or -not $env:CONCURRENCY_RACE_DATABASE_URL) { throw 'Prepare the guarded disposable race database and enable its real-DB lane first' }
pnpm run test:named @thirdMainPg
```

PG note: ordinary runs skip both proofs. Set the guarded disposable URL/RUN flag only in root's isolated DB lane, assert actual non-skipped execution, and preserve concurrency-lock-races.realdb harness imports. Do not interpret mere collection or a skipped suite as race evidence. The focused proof files themselves validate the disposable URL; full harness/runtime is root-owned.

Main-only selected paths (not on prepared ed4):
- src/lib/__tests__/two-factor-secret-census.test.ts
- src/lib/__tests__/xero-token-credential-store.test.ts
- src/lib/__tests__/paid-cancel-refunded-total-race.realdb.test.ts
- src/lib/__tests__/xero-token-credential-store.realdb.test.ts

## Independent post-sync delta verification

Reviewed exact root merge/result `7ce3bb1eaa65e45e32185cefc7af93400ab2d763` versus prior prepared compose `ed4e23be496a6cbb715890d7e1b7c5c52f6b7e21`, after root merged main automatically at262ea61aa954a077706eef09a0782773619255df and fixed the operations audit count. No confirmed remaining compatibility defect in this bounded delta. Not final integration approval and not a review of later heads.

Evidence independently read:

- `git diff 0678af38b 7ce3bb1ea -- src/lib/booking-cancel.ts` contains ONLY epic pending-reservation import, held request status selection/ACCEPTED refusal and anonymous reservation deletion. The WHOLE paid path, including id-only early Payment projection, global/lodge/Payment ordering, locked full reread, forced-source refundMethod and authoritative audit snapshot, is byte-identical to reviewed incoming main. Main #3797 ledger calls also remain. No main paid-input behavior was lost to composition.
- A deterministic path comparison over ALL141 incoming non-overlap files reports ZERO changed blobs after merge. Thus incoming bed UTC stamp, build parity, Xero/token/credential/2FA/secret source and their tests, family-first runtime and shared consent/adult-supervision source arrived intact. All selected paths now exist in the composed tree; four prospective paths no longer require waiting for sync.
- School test's only ed4-to-result changes are the two `consentStatus:null` projection maps required by new main. Existing epic test cases remain. Owner census preserves composed booking-cancel513 while importing main's detail-reader230 and member-night369 shifts.
- Exact source clauses checked in merged configuration/locking/ADDPAY files retain BOTH main build/token/operational-adult/payment-read clauses and epic stopped-worker/pending-adult/accepted-price/accepted-hold clauses. Manifest source pins495, createAuditLog138, security25. Audit test pins128/367. Operations source now says128 of495 and other367: preflight documentation mismatch resolved at7ce3.
- There is no schema, migration SQL/reverse or safety-ledger delta ed4-to7ce3. Main546 and0678 schema object is identically `07cfce5ef4d6c6796468264459cf7ea6c3e6e310`; their migration tree object is identically `2afd3278a372d225c3229f4d8c54b8de17f8aafa`. These are concrete inputs supporting portability of root's existing base546 schema/migration-chain rehearsal evidence. No new rehearsal was run or claimed. This identity does not substitute for runtime race/token proofs.

Root separately reports audit measurement495/zero uncategorised/138 createAuditLog/security25, four named suites179 passing, and actual migration fixtures13 passing. Those were NOT executed by this reviewer and are recorded only as root-owned evidence. This reviewer ran git/source comparisons only; no test, runtime, database/provider, install or external write. Root's final guards, UI review, exact-head CI and owner merge gate remain separate.

