# #3679 recovered named validation inventory

Read-only preparation on 2026-10-02. This is path selection and counterpart reconciliation, NOT exact-final-head review or test evidence. No installs, tests, commits, pushes or GitHub writes occurred. One read-only `pnpm run issue 3679` ran after Node24.15.0/pnpm11.27.1 and physical node_modules preflight.

Compose HEAD: `4caebd836312d777b8ef90b95fe336654235c7fe`. origin/main: `9cd9a646cc4e96261e56676b81fc00d73e0aff1d`. Whole epic diff: 96 paths. The anticipated #3754 tree contributes its WHOLE diff (129 paths), including fees, payments, refunds, member credit/Xero entry, promo, AI budget forms and manual refund task queue. #3794 is still being changed; its final price-plan helper and approval/name writes require rerunning selection over their final delta.

## Fail-closed execution

Every path below is unique, tracked and present on the compose tree when selected (135 total, including focused behavior). The wrapper accepts PATHS ONLY; do not add --maxWorkers, --run or --passWithNoTests. Run groups serially. It verifies disk presence and Vitest collection before execution. Capture full SHA before and after; rerun affected groups after any integration/main sync. Use final worktree cwd and its own generated client. CI owns full suite/build/E2E; do not replace this with all 186 guards or a full local suite.

Three prerequisite paths are tracked and present ONLY in child3414 now. They must be integrated then run fail-closed; do not silently drop them or claim current-compose existence.


### core

```powershell
$core = @(
  'src/lib/__tests__/advisory-lock-guard.test.ts',
  'src/lib/__tests__/raw-sql-shape-guard.test.ts',
  'src/lib/__tests__/client-server-boundary-census.test.ts',
  'src/lib/__tests__/cli-server-only-reach-census.test.ts',
  'src/lib/__tests__/ssot-authority-default-guard.test.ts',
  'src/lib/__tests__/ssot-comment-stripper-guard.test.ts',
  'src/lib/__tests__/date-only-encoding-guard.test.ts',
  'src/lib/__tests__/club-time-escape-hatch-census.test.ts',
  'src/lib/__tests__/club-time-boundary-guard.test.ts',
  'src/lib/__tests__/club-format-required-guard.test.ts',
  'src/lib/__tests__/club-module-settings-select-guard.test.ts',
  'src/lib/__tests__/app-currency-import-census.test.ts',
  'src/lib/__tests__/money-seam-mock-census.test.ts',
  'src/lib/__tests__/lock-bound-club-zone-outside-transaction.test.ts',
  'src/lib/__tests__/identity-ordering-census.test.ts',
  'src/lib/__tests__/codeowners-census.test.ts',
  'src/lib/__tests__/semgrep-suppression-census.test.ts',
  'src/lib/__tests__/package-manager-command-census.test.ts',
)
pnpm run test:named @core
```

### booking

```powershell
$booking = @(
  'src/lib/__tests__/booking-request-version-fence-contracts.test.ts',
  'src/lib/__tests__/lodge-admission-lock-contract.test.ts',
  'src/lib/__tests__/bed-allocation-lock-topology-contract.test.ts',
  'src/lib/__tests__/adult-member-hosting-call-sites.test.ts',
  'src/lib/__tests__/adult-member-hosting-deletion-barrier.test.ts',
  'src/lib/__tests__/adult-member-hosting-retry-boundaries.test.ts',
  'src/lib/__tests__/booking-owner-census.test.ts',
  'src/lib/__tests__/organisation-reader-contract.test.ts',
  'src/lib/__tests__/member-dietary-access-census.test.ts',
  'src/lib/__tests__/night-occupancy-census.test.ts',
  'src/lib/__tests__/guest-stay-expansion-census.test.ts',
  'src/lib/__tests__/booking-guest-night-price-source-census.test.ts',
  'src/lib/__tests__/booking-guest-night-adjustment-census.test.ts',
  'src/lib/__tests__/booking-money-writer-census.test.ts',
  'src/lib/__tests__/booking-money-build-up-reader-census.test.ts',
  'src/lib/__tests__/booking-ledger-census.test.ts',
  'src/lib/__tests__/booking-ledger-append-only-census.test.ts',
  'src/lib/__tests__/hut-leader-assignment-source-immutability-census.test.ts',
  'src/lib/__tests__/custodian-write-path-contract.test.ts',
  'src/lib/__tests__/lodge-booking-readiness.test.ts',
  'src/lib/__tests__/group-discount-edit-switch-census.test.ts',
  'src/lib/__tests__/subscription-lockout-call-sites.test.ts',
  'src/lib/__tests__/awaiting-review-release-one-writer.test.ts',
  'src/lib/__tests__/booking-edit-eligibility-one-home.test.ts',
  'src/lib/__tests__/booking-final-price-one-home.test.ts',
  'src/lib/__tests__/booking-guest-stay-ranges-contract.test.ts',
  'src/lib/__tests__/captured-status-inline-list-guard.test.ts',
  'src/lib/__tests__/in-progress-edit-sold-price-census.test.ts',
  'src/lib/__tests__/stored-night-price-repair-census.test.ts',
  'src/lib/__tests__/roster-lock-contract.test.ts',
  'src/lib/__tests__/issued-primary-xero-invoice-one-home.test.ts',
  'src/lib/__tests__/booking-ledger-credit-writers.test.ts',
)
pnpm run test:named @booking
```

### route_comms

```powershell
$route_comms = @(
  'src/lib/__tests__/audit-writer-census.test.ts',
  'src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts',
  'src/lib/__tests__/email-delivery-boundary-census.test.ts',
  'src/lib/__tests__/env-delivery-census.test.ts',
  'src/lib/__tests__/email-message-token-contract.test.ts',
  'src/lib/__tests__/email-render-gate-contract.test.ts',
  'src/lib/__tests__/environment-role-inference-census.test.ts',
  'src/lib/__tests__/ordinary-admin-lodge-scope-contract.test.ts',
  'src/lib/__tests__/admin-route-area-matrix.test.ts',
  'src/lib/__tests__/rate-bearing-membership-type-census.test.ts',
  'src/lib/__tests__/unverified-write-copy-contract.test.ts',
  'src/lib/__tests__/require-admin-mock-forwarding-contract.test.ts',
  'src/lib/__tests__/booking-message-render-surfaces-contract.test.ts',
  'src/lib/__tests__/api-error-message-census.test.ts',
  'src/lib/__tests__/api-error-response-contract.test.ts',
  'src/lib/__tests__/api-route-boundaries.test.ts',
  'src/lib/__tests__/payment-recovery-terminal-failure-census.test.ts',
  'src/lib/__tests__/xero-contact-containment-census.test.ts',
  'src/lib/__tests__/xero-environment-write-gate.test.ts',
  'src/lib/__tests__/xero-provider-date-boundary-census.test.ts',
  'src/lib/__tests__/xero-links-guard.test.ts',
  'src/lib/__tests__/xero-object-url-write-guard.test.ts',
)
pnpm run test:named @route_comms
```

### ui_lib

```powershell
$ui_lib = @(
  'src/lib/__tests__/app-theme-layout-contract.test.ts',
  'src/lib/__tests__/admin-attention-primitive-contract.test.ts',
  'src/lib/__tests__/brand-color-source-contract.test.ts',
  'src/lib/__tests__/print-light-palette-contract.test.ts',
  'src/lib/__tests__/jsx-text-escape-guard.test.ts',
  'src/lib/__tests__/money-number-input-guard.test.ts',
  'src/lib/__tests__/money-cents-guard.test.ts',
  'src/lib/__tests__/cents-display-guard.test.ts',
  'src/lib/__tests__/cents-in-prose-guard.test.ts',
  'src/lib/__tests__/cancellation-policy-client-contract.test.ts',
  'src/lib/__tests__/lodge-option-consumer-census.test.ts',
  'src/lib/__tests__/final-a11y-presentation-contract.test.ts',
  'src/lib/__tests__/raw-css-secret-input-census.test.ts',
)
pnpm run test:named @ui_lib
```

### schema_ci

```powershell
$schema_ci = @(
  'src/lib/__tests__/review-findings-contracts.test.ts',
  'src/lib/__tests__/blue-green-ledger-lint.test.ts',
  'src/lib/__tests__/blue-green-ledger-named-controls.test.ts',
  'src/lib/__tests__/data-migration-verification-gate.test.ts',
  'src/lib/__tests__/migration-sql-transaction-control.test.ts',
  'src/lib/__tests__/config-transfer-singleton-models.test.ts',
  'src/lib/__tests__/additive-artifact-fragments.test.ts',
  'src/lib/__tests__/agent-workflow-contract.test.ts',
  'src/lib/__tests__/deployment-image-contracts.test.ts',
  'src/lib/__tests__/semgrep-policy-single-source.test.ts',
  'src/lib/__tests__/semgrep-rule-fixtures.test.ts',
)
pnpm run test:named @schema_ci
```

### ui_components

```powershell
$ui_components = @(
  'src/components/admin/__tests__/view-only-banner-contract.test.ts',
  'src/components/admin/__tests__/dataset-reset-contract.test.ts',
  'src/components/__tests__/club-format-provider-mount-census.test.tsx',
  'src/components/__tests__/club-time-provider-mount-census.test.tsx',
  'src/components/__tests__/booking-no-emails-ui-contract.test.ts',
  'src/components/ui/__tests__/placeholder-styling-contract.test.ts',
  'src/components/ui/__tests__/card-title-heading-contract.test.ts',
  'src/components/__tests__/client-server-only-boundary.test.ts',
)
pnpm run test:named @ui_components
```

### migration_scripts

```powershell
$migration_scripts = @(
  'scripts/__tests__/same-release-expand-contract.test.ts',
)
pnpm run test:named @migration_scripts
```

### behavior

```powershell
$behavior = @(
  'src/lib/__tests__/booking-request.test.ts',
  'src/lib/__tests__/booking-request-quotes.test.ts',
  'src/lib/__tests__/school-booking-request.test.ts',
  'src/lib/__tests__/booking-request-corrections.test.ts',
  'src/lib/__tests__/booking-request-malformed-stored-data.test.ts',
  'src/lib/__tests__/booking-request-pending-adult-reservations.test.ts',
  'src/lib/__tests__/school-pending-adult-resolution.test.ts',
  'src/lib/__tests__/pending-school-adults-gate.test.ts',
  'src/lib/__tests__/booking-request-public-routes.test.ts',
  'src/lib/__tests__/admin-booking-request-correction-routes.test.ts',
  'src/lib/__tests__/config-transfer-club-settings.test.ts',
  'src/lib/__tests__/cron-quote-expiry-reminders.test.ts',
  'src/lib/__tests__/booking-exception-reservation-capacity.test.ts',
  'src/lib/__tests__/capacity.test.ts',
  'src/lib/__tests__/admin-pending-counts.test.ts',
  'src/lib/__tests__/public-booking-requests-panel-school-quote-counts.test.tsx',
)
pnpm run test:named @behavior
```

### ui_behavior

```powershell
$ui_behavior = @(
  'src/lib/__tests__/money-input-validation-ui.test.tsx',
  'src/components/admin/booking-requests/__tests__/booking-request-correction-editor.test.tsx',
  'src/components/admin/booking-requests/__tests__/resolve-pending-school-adults.test.tsx',
  'src/components/admin/booking-policies/__tests__/save-view-only-gating.test.tsx',
  'src/components/admin/__tests__/booking-stored-night-price-controls.test.tsx',
  'src/components/admin/__tests__/manual-refund-task-queue-financial-review.test.tsx',
  'src/components/admin/__tests__/manual-refund-task-queue-one-per-edit.test.tsx',
  'src/lib/__tests__/admin-waitlist-refund-pages.test.tsx',
  'src/app/(admin)/admin/fees/_components/__tests__/hut-fees-season-timeline-and-copy.test.tsx',
  'src/lib/__tests__/late-capture-decision-provenance.test.ts',
  'src/lib/__tests__/uncollected-edit-review-share-expand.test.ts',
  'src/lib/__tests__/placeholder-guest-name-reminders.test.ts',
  'src/lib/__tests__/booking-requests-capacity-injection.test.tsx',
  'src/lib/__tests__/lodge-scope-committed-ownership.test.tsx',
)
pnpm run test:named @ui_behavior
```

### Prerequisite #3754 additions

```powershell
$money_prerequisite = @(
  'src/lib/__tests__/money-input-component-guard.test.ts',
  'src/components/ui/money-input.test.tsx',
  'src/lib/__tests__/public-booking-requests-panel-emptied-total.test.tsx',
)
pnpm run test:named @money_prerequisite
```

## Selection relationship evidence

The whole candidate file was read as UTF8 for roots, composed path strings, walker filters, fixed target arrays and assertion names. The per-path evidence below names actual scope; comments mentioning a changed doc are not by themselves selection evidence. Wide walkers are selected because they read changed files directly and/or remeasure tree inventories; bounded selectors must reach a changed source or a component used by the changed surface. `test:related` is additional coverage and cannot replace these groups.

| Suite | Source relationship |
| --- | --- |
| `src/lib/__tests__/advisory-lock-guard.test.ts` | Fixed targets include `src/lib/booking-request.ts`, `src/lib/school-booking-request.ts` |
| `src/lib/__tests__/raw-sql-shape-guard.test.ts` | Fixed targets include `docs/invariants/operations.md` |
| `src/lib/__tests__/client-server-boundary-census.test.ts` | Fixed targets include `docs/invariants/operations.md` |
| `src/lib/__tests__/cli-server-only-reach-census.test.ts` | Source walker/root inventory: `scripts`, `scripts/`, `src`, `src/lib` |
| `src/lib/__tests__/ssot-authority-default-guard.test.ts` | Source walker/root inventory: `prisma`, `prisma/`, `scripts`, `scripts/` |
| `src/lib/__tests__/ssot-comment-stripper-guard.test.ts` | Source walker/root inventory: `src/` |
| `src/lib/__tests__/date-only-encoding-guard.test.ts` | Fixed targets include `docs/invariants/booking-dates-and-capacity.md`, `prisma/schema.prisma` |
| `src/lib/__tests__/club-time-escape-hatch-census.test.ts` | Fixed targets include `src/lib/capacity.ts` |
| `src/lib/__tests__/club-time-boundary-guard.test.ts` | Contract/scan: the host clock-face guard is present at every production path; resolves with all four arms wherever production code lives |
| `src/lib/__tests__/club-format-required-guard.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/club-module-settings-select-guard.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/app-currency-import-census.test.ts` | Source walker/root inventory: `prisma`, `scripts`, `src`, `src/` |
| `src/lib/__tests__/money-seam-mock-census.test.ts` | Fixed targets include `docs/invariants/operations.md` |
| `src/lib/__tests__/lock-bound-club-zone-outside-transaction.test.ts` | Fixed targets include `docs/CONCURRENCY_AND_LOCKING.md`, `src/lib/booking-cancel.ts`, `src/lib/booking-request-quotes.ts` |
| `src/lib/__tests__/identity-ordering-census.test.ts` | Fixed targets include `docs/TESTING.md` |
| `src/lib/__tests__/codeowners-census.test.ts` | Source walker/root inventory: `src`, `src/lib`, `src/lib/` |
| `src/lib/__tests__/semgrep-suppression-census.test.ts` | Source walker/root inventory: `prisma/`, `scripts/`, `src/` |
| `src/lib/__tests__/package-manager-command-census.test.ts` | Fixed targets include `CONFIGURATION.md`, `scripts/audit/audit-writer-census-manifest.ts` |
| `src/lib/__tests__/booking-request-version-fence-contracts.test.ts` | Fixed targets include `src/lib/booking-request.ts`, `src/lib/school-booking-request.ts` |
| `src/lib/__tests__/lodge-admission-lock-contract.test.ts` | Fixed targets include `src/lib/school-booking-request.ts` |
| `src/lib/__tests__/bed-allocation-lock-topology-contract.test.ts` | Fixed targets include `src/lib/school-booking-request.ts` |
| `src/lib/__tests__/adult-member-hosting-call-sites.test.ts` | Fixed targets include `docs/CONCURRENCY_AND_LOCKING.md`, `prisma/schema.prisma`, `src/app/api/admin/booking-requests/[id]/approve/route.ts` |
| `src/lib/__tests__/adult-member-hosting-deletion-barrier.test.ts` | Fixed targets include `src/lib/booking-request-quotes.ts` |
| `src/lib/__tests__/adult-member-hosting-retry-boundaries.test.ts` | Fixed targets include `src/app/api/admin/booking-requests/[id]/approve/route.ts`, `src/app/api/admin/booking-requests/[id]/correct/route.ts` |
| `src/lib/__tests__/booking-owner-census.test.ts` | Contract/scan: \n; #3368: a booking's owner is read in exactly one place |
| `src/lib/__tests__/organisation-reader-contract.test.ts` | Fixed targets include `src/lib/school-booking-request.ts` |
| `src/lib/__tests__/member-dietary-access-census.test.ts` | Fixed targets include `src/lib/booking-request-quotes.ts`, `src/lib/booking-request.ts`, `src/lib/school-booking-request.ts` |
| `src/lib/__tests__/night-occupancy-census.test.ts` | Fixed targets include `src/lib/booking-request-pending-adult-reservations.ts`, `src/lib/booking-request.ts`, `src/lib/capacity.ts` |
| `src/lib/__tests__/guest-stay-expansion-census.test.ts` | Fixed targets include `src/lib/bed-allocation-board.ts` |
| `src/lib/__tests__/booking-guest-night-price-source-census.test.ts` | Fixed targets include `src/lib/booking-request.ts` |
| `src/lib/__tests__/booking-guest-night-adjustment-census.test.ts` | Fixed targets include `prisma/schema.prisma`, `src/lib/booking-request.ts` |
| `src/lib/__tests__/booking-money-writer-census.test.ts` | Source walker/root inventory: `src/` |
| `src/lib/__tests__/booking-money-build-up-reader-census.test.ts` | Contract/scan: #3277 canonical stored-money reader census; declares every production call to the canonical loader or coherent-snapshot projector |
| `src/lib/__tests__/booking-ledger-census.test.ts` | Fixed targets include `docs/TESTING.md` |
| `src/lib/__tests__/booking-ledger-append-only-census.test.ts` | Fixed targets include `docs/TESTING.md` |
| `src/lib/__tests__/hut-leader-assignment-source-immutability-census.test.ts` | Fixed targets include `src/lib/school-booking-request.ts` |
| `src/lib/__tests__/custodian-write-path-contract.test.ts` | Fixed targets include `src/lib/bed-allocation-board.ts`, `src/lib/capacity.ts` |
| `src/lib/__tests__/lodge-booking-readiness.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/group-discount-edit-switch-census.test.ts` | Fixed targets include `src/lib/school-booking-request.ts` |
| `src/lib/__tests__/subscription-lockout-call-sites.test.ts` | Source walker/root inventory: `src`, `src/`, `src/app/api/payments/`, `src/app/api/webhooks/` |
| `src/lib/__tests__/awaiting-review-release-one-writer.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/booking-edit-eligibility-one-home.test.ts` | Fixed targets include `src/lib/booking-cancel.ts` |
| `src/lib/__tests__/booking-final-price-one-home.test.ts` | Source walker/root inventory: `src/` |
| `src/lib/__tests__/booking-guest-stay-ranges-contract.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/captured-status-inline-list-guard.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/in-progress-edit-sold-price-census.test.ts` | Fixed targets include `prisma/schema.prisma`, `src/app/(admin)/admin/fees/_components/hut-fees-section.tsx` |
| `src/lib/__tests__/stored-night-price-repair-census.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/roster-lock-contract.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/issued-primary-xero-invoice-one-home.test.ts` | Source walker/root inventory: `src`, `src/app/api/bookings` |
| `src/lib/__tests__/booking-ledger-credit-writers.test.ts` | Source walker/root inventory: `prisma`, `scripts`, `src` |
| `src/lib/__tests__/audit-writer-census.test.ts` | Source walker/root inventory: `prisma`, `prisma/`, `scripts/`, `scripts/audit/` |
| `src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts` | Source walker/root inventory: `prisma` |
| `src/lib/__tests__/email-delivery-boundary-census.test.ts` | Fixed targets include `docs/TESTING.md`, `src/lib/booking-request-quotes.ts`, `src/lib/cron-quote-expiry-reminders.ts` |
| `src/lib/__tests__/env-delivery-census.test.ts` | Fixed targets include `docs/TESTING.md` |
| `src/lib/__tests__/email-message-token-contract.test.ts` | Message registry/default inventory includes changed booking-request/admin-booking templates. |
| `src/lib/__tests__/email-render-gate-contract.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/environment-role-inference-census.test.ts` | Fixed targets include `docs/TESTING.md`, `src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx` |
| `src/lib/__tests__/ordinary-admin-lodge-scope-contract.test.ts` | Fixed targets include `src/app/(admin)/admin/fees/_components/hut-fees-section.tsx`, `src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx` |
| `src/lib/__tests__/admin-route-area-matrix.test.ts` | Contract/scan: admin route -> area matrix pin (#1548); finds the /api/admin routes to enumerate |
| `src/lib/__tests__/rate-bearing-membership-type-census.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/unverified-write-copy-contract.test.ts` | Fixed targets include `src/components/admin/manual-refund-task-queue.tsx` |
| `src/lib/__tests__/require-admin-mock-forwarding-contract.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/booking-message-render-surfaces-contract.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/api-error-message-census.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/api-error-response-contract.test.ts` | Source walker/root inventory: `src/app/api`, `src/app/api/cron/`, `src/app/api/webhooks/` |
| `src/lib/__tests__/api-route-boundaries.test.ts` | Source walker/root inventory: `src/app/api`, `src/app/api/admin/`, `src/app/api/cron/`, `src/app/api/deploy/` |
| `src/lib/__tests__/payment-recovery-terminal-failure-census.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/xero-contact-containment-census.test.ts` | Fixed targets include `docs/TESTING.md` |
| `src/lib/__tests__/xero-environment-write-gate.test.ts` | Fixed targets include `docs/TESTING.md` |
| `src/lib/__tests__/xero-provider-date-boundary-census.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/xero-links-guard.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/xero-object-url-write-guard.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/lib/__tests__/app-theme-layout-contract.test.ts` | Fixed targets include `docs/ARCHITECTURE.md`, `src/components/admin/booking-policies/public-booking-requests-section.tsx` |
| `src/lib/__tests__/admin-attention-primitive-contract.test.ts` | Source walker/root inventory: `src`, `src/app/(admin)/`, `src/components/admin/`, `src/hooks/` |
| `src/lib/__tests__/brand-color-source-contract.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/print-light-palette-contract.test.ts` | Source walker/root inventory: `src`, `src/app/(admin)/admin/induction`, `src/app/(admin)/admin/reports`, `src/app/(admin)/admin/roster` |
| `src/lib/__tests__/jsx-text-escape-guard.test.ts` | Source walker/root inventory: `src` |
| `src/lib/__tests__/money-number-input-guard.test.ts` | jsxSourceFiles helper recursively parses all non-test src TSX; pending counts remain numeric and MoneyInput controls remain text/decimal. |
| `src/lib/__tests__/money-cents-guard.test.ts` | Fixed targets include `docs/invariants/money.md`, `src/lib/money-input.ts` |
| `src/lib/__tests__/cents-display-guard.test.ts` | Shipping ESLint source/config contract and real-path fixtures; final MoneyInput and price planner must retain canonical cent conversion/display. |
| `src/lib/__tests__/cents-in-prose-guard.test.ts` | Source walker/root inventory: `src/` |
| `src/lib/__tests__/cancellation-policy-client-contract.test.ts` | Fixed targets include `docs/CONCURRENCY_AND_LOCKING.md`, `docs/invariants/operations.md` |
| `src/lib/__tests__/lodge-option-consumer-census.test.ts` | Fixed targets include `src/app/(admin)/admin/bed-allocation/page.tsx`, `src/app/(admin)/admin/fees/_components/hut-fees-section.tsx`, `src/app/(admin)/admin/promo-codes/promo-codes-page-client.tsx` |
| `src/lib/__tests__/final-a11y-presentation-contract.test.ts` | Fixed targets include `src/app/(admin)/admin/payments/page.tsx` |
| `src/lib/__tests__/raw-css-secret-input-census.test.ts` | Source walker/root inventory: `src`, `src/app/(website)`, `src/app/(website-dynamic)`, `src/app/display` |
| `src/lib/__tests__/review-findings-contracts.test.ts` | Fixed targets include `.github/workflows/ci.yml`, `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, `docs/STATE_MACHINES.md` |
| `src/lib/__tests__/blue-green-ledger-lint.test.ts` | Fixed targets include `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` |
| `src/lib/__tests__/blue-green-ledger-named-controls.test.ts` | Fixed targets include `.github/workflows/ci.yml`, `CONFIGURATION.md`, `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` |
| `src/lib/__tests__/data-migration-verification-gate.test.ts` | Source walker/root inventory: `prisma`, `prisma/migrations` |
| `src/lib/__tests__/migration-sql-transaction-control.test.ts` | Source walker/root inventory: `prisma` |
| `src/lib/__tests__/config-transfer-singleton-models.test.ts` | Fixed targets include `prisma/schema.prisma` |
| `src/lib/__tests__/additive-artifact-fragments.test.ts` | Fixed targets include `.github/workflows/ci.yml`, `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, `docs/UX_FLOW_MAP.md` |
| `src/lib/__tests__/agent-workflow-contract.test.ts` | Fixed targets include `.github/workflows/ci.yml`, `docs/CONCURRENCY_AND_LOCKING.md` |
| `src/lib/__tests__/deployment-image-contracts.test.ts` | Fixed targets include `.github/workflows/ci.yml` |
| `src/lib/__tests__/semgrep-policy-single-source.test.ts` | Fixed targets include `.github/workflows/ci.yml` |
| `src/lib/__tests__/semgrep-rule-fixtures.test.ts` | Fixed targets include `.github/workflows/ci.yml` |
| `src/components/admin/__tests__/view-only-banner-contract.test.ts` | Fixed targets include `docs/ARCHITECTURE.md`, `src/components/admin/view-only-action.tsx` |
| `src/components/admin/__tests__/dataset-reset-contract.test.ts` | Fixed targets include `src/app/(admin)/admin/payments/page.tsx`, `src/app/(admin)/admin/refund-requests/page.tsx`, `src/components/admin/booking-requests/public-booking-requests-panel.tsx` |
| `src/components/__tests__/club-format-provider-mount-census.test.tsx` | Source walker/root inventory: `src/app/(group)` |
| `src/components/__tests__/club-time-provider-mount-census.test.tsx` | Source walker/root inventory: `src/app/(group)` |
| `src/components/__tests__/booking-no-emails-ui-contract.test.ts` | Source walker/root inventory: `src` |
| `src/components/ui/__tests__/placeholder-styling-contract.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/components/ui/__tests__/card-title-heading-contract.test.ts` | Source walker/root inventory: `src`, `src/` |
| `src/components/__tests__/client-server-only-boundary.test.ts` | Source walker/root inventory: `src`, `src/` |
| `scripts/__tests__/same-release-expand-contract.test.ts` | Fixed targets include `.github/workflows/ci.yml` |

## Selection corrections and exclusions

- **Add dataset-reset-contract:** its fixed list directly includes public-booking-requests-panel, payments page and refund-requests page.
- **Add app-theme-layout-contract:** direct teacher-policy target plus tree walks across all components and bed-allocation components.
- **Add review-findings-contracts:** direct approval/hold/quote-expiry lock assertions, source-wide person-night caller list, quote-response confirmation-dialog assertion, plus CI/ledger/schema contracts. Run whole suite via wrapper; its shell fixtures must use repository Git Bash helper and disclosed local timeout budgets.
- **Add final-a11y-presentation-contract for the anticipated final tree:** payments/page is changed by #3754 and directly read for semantic payment status; it has no current-compose product-source target until that child integrates.
- **Keep ordinary-admin-lodge-scope-contract:** MoneyInput child edits named hut-fees and promo editor targets.
- **Exclude operator-cents-message-census:** fixed six-source inventory only covers Xero credit allocation/deallocation, entrance-fee invoice, credit-note repair and rate-derived backfill. None is changed by this epic/anticipated children.
- **Exclude additional-payment-card-gate:** joined seven-segment target is bookings/[id] route subtree, which this epic/#3754 do not change; MoneyInput child does not render or change AdditionalPaymentCard.
- **Prerequisite money-input-component-guard:** new child guard uses shared TypeScript scanner; inspect whole helper and floors after integration. New school-pending-adult-price-plan should be included in booking-money writer/night-price/cents and existing request approval/source contracts as appropriate; child tests must prove batching and approval, not only helper arithmetic.
- Bounded school-member-classification-contract only reads its old backfill/fold SQL/scripts; added pending-capacity migrations do not alter those targets.

## Required final differential combinations

Accepted school hold: accepted total equals held total; canonical guest prices and nights agree, with agreedAdjustmentCents explaining any remainder; `guests.length + pendingAdultCount` feeds capacity limit wording. Naming consumes accepted PENDING_ADULT strands in stable order while preserving per-guest/night prices and capacity. Batch final naming must preserve the existing global -> lodge -> version/status claim -> guest/night/reservation transaction and no-provider rule. Policy OFF keeps names/Organisation/Xero contact but creates no teacher assignments/PINs. Blank/zero quote input, 2dp entry and whole-dollar arrows must remain distinct from teacher count controls and public timing controls. Every behavior-bearing hand resolution requires its own differential/mutation proof, restored green.

## Live counterpart reconciliation

Last ten merged PRs observed live (sorted updated, merged rows only): #3802, #3801, #3799, #3790, #3784, #3719, #3788, #3740, #3787, #3786. Main remains9cd9: most recent four outside-main merges are epic/sync changes, not additional main writers. Open list observed: #3808,#3807 (DO NOT MERGE probes), #3805,#3804,#3803,#3800,#3798,#3797,#3754,#3660. Source file lists for all20 PRs read via repository-qualified gh api; lock declarations read for3797,3788,3740,3715,3735,3660,3804. Issue threads3611,3402,3462,3582,3634,3606 fetched through repository thread CLI (bounded excerpts used for relevant assertions).

| PR | Actual composition evidence |
| --- | --- |
| #3715 (baseline) | Main already contains global -> lodge -> member -> payment-row locking. Prior checkpoint correctly found no request/quote/crons/capacity changes and early no-payment hold path unchanged. Source and current main agree. |
| #3735 (now merged main, formerly open) | Keeps global-before-lodge add-guests check; capacity wording adjustment in booking-request-corrections must coexist with pending-adult arithmetic. Current composed school/correction paths use canonical lodgeGuestLimitMessage. No new key; Xero refund-note retry provider calls outside local transaction. |
| #3740 (now merged main, formerly open) | resolveManualRefundTask adds global lock(1) before mutable re-read/claim/narrower rows. Ledger edit posting requires confirmation lines. School naming requires AWAITING_REVIEW and uses existing global -> immutable-lodge lock; no inverted key or new provider call. Both families coexist. New registry and booking-owner line-number changes were preserved by compose sync. |
| #3788 / child #3786 | Review charge raising now uses row lease EditReviewChargeRaiseClaim keyed BookingModification, with token/status guards and no provider in transaction; Xero retry has operation-row status/startedAt fencing. Does not edit request, pending-adult naming or approval code. Main schema migration20261016010000 is BASE, not this wave addition. Shared audit/view-only/admin-route censuses and booking-owner locations require final remeasurement; 4ca sync resolved those surfaces. |
| #3784 | dependency-only fast-uri remediation, no writer/lock surface. |
| #3719 / #3787 | Own wave pending reservations and approval toast are integrated. Current naming source: global then lodge, re-read ACCEPTED/version/heldBookingId and AWAITING_REVIEW, updateMany claim before guest/night/reservation writes, no external provider. Approvals global -> lodge and held status CAS. Re-open after3794 changes because this inventory is not a review of its new code. |
| OPEN #3797 | New cancellation-ledger writes DO reach shared no-payment/AWAITING_REVIEW branch: inserts postCancellationLedgerLines after claim, reservation cleanup and credit restore (main-side patch about702). Keeps global-first, existing under-lock re-read, accepted-request refusal, lodge lock and status claim. Epic adds releasePendingAdultNights before request detachment. If3797 lands during sync, preserve BOTH added ledger posting and reservation release; rerun lock/night/ledger/owner censuses and naming-cancel realdb race. Other ledger calls are linked-child, paid/unpaid/PENDING, IB release/late capacity, group cancel, settle capacity void and confirm-pending; no new advisory key/provider transaction. |
| OPEN #3660 | Read-only captured-status substitutions overlap booking-cancel and owner census. Preserve literal school request ACCEPTED/AWAITING_REVIEW gates and new reservation cleanup; canonical captured list cannot replace those booking statuses. No lock key/order change. |
| OPEN #3754 | Own wave child is prerequisite, broad money-form/census changes must all be integrated. No provider/lock change; final MoneyInput guard paths currently absent on compose. |
| #3790 / OPEN #3804 | Officer net-figure epic and its sync share docs/source censuses and refund queue UI. Broad display wording has no new request admission/hold writer. If its integration reaches main before final review, rerun MoneyInput queue behavior and money/owner/provider/view-only inventories over new delta. |
| #3799 / OPEN #3805,#3800 | Security epic targets credential/PIN paths, not current booking-request conversion/hold/capacity surfaces. Xero token-store writes overlap provider architecture only; no pending-adult lock or row-claim move observed. |
| #3802,#3801,#3803,#3807,#3808 | Syncs and owner-review probes, no novel request writer;3803 is main-to-own-epic sync duplicating4ca base, not a new subsystem contract. |

No new lock conflict was identified from these current source intersections. #3797 presents an actual shared cancellation file and an additional under-lock ledger side effect, not a reason to claim it is outside the hold branch. Pending3414/3794 integrations and any later main advance remain gates; final head source/review/CI must be re-established.

## Limits

No tests or final review performed here. Live GitHub inventories can move; refresh if main advances. Source guard selection is explicit and fail-closed, and a final graph-related pass remains separate. Migration rehearsal success reported by root is not re-claimed as this pass evidence. No public artifact or memory file was edited.

