# Phase 5: Remediation And Verification

## Goal

Turn the consolidated audit findings into a release candidate that is safe to deploy.

## Prerequisite

Phases 2-4 must be complete enough to freeze a ranked remediation backlog.

## Fix Order

1. Security and authorization flaws
2. Data integrity and concurrency issues
3. Booking, payment, refund, and integration correctness
4. Production/runtime and deployment hazards
5. Observability and diagnostic gaps
6. Missing regression coverage for corrected defects
7. Lower-risk maintainability or documentation cleanups

## Remediation Rules

- Split work by disjoint write set. One agent owns one file family at a time.
- Keep fixes minimal and production-safe.
- Add or update regression tests when behavior changes.
- Do not combine cleanup refactors with risk fixes unless required to make the fix safe.
- Re-run targeted validation before handing a fix back for integration.

## Steps

1. Consolidate and deduplicate findings from Phases 2-4.
2. Create remediation batches by subsystem and file ownership.
3. Assign parallel fix agents to non-overlapping batches.
4. Merge batches in severity order.
5. Run targeted validation after each batch.
6. Run full repo verification once all blocking fixes are merged.
7. Record any deferred items with explicit rationale and owner.

## Required Validation

At minimum, the release candidate should pass:

```bash
npm run lint
npm test
npm run build
```

Add targeted validation for touched subsystems, for example:

```bash
npx vitest run path/to/relevant.test.ts
docker compose config
```

## Required Outputs

- Ranked remediation ledger
- Validation log per fix batch
- Final deferred-items list
- Release-candidate summary with remaining risks

## Exit Criteria

- No unresolved `Critical` findings remain
- No unresolved `High` finding remains without an explicit go-live waiver
- Lint, tests, and build are green, or any pre-existing unrelated failure is proven and documented
- The repo is ready for final release handling
