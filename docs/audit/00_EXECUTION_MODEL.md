# TACBookings Audit Execution Model

This directory is the canonical pre-go-live audit plan for TACBookings.

It consolidates the intent from:
- `docs/autonomous-best-practice-review-plan.md`
- `docs/claude-code-review-plan.md`
- `docs/ARCHITECTURE.md`
- `docs/CODEBASE_REVIEW_2026-04-07.md`
- `docs/DEVELOPMENT_WORKFLOW.md`

It also reflects the current repo shape as of 2026-04-15:
- `146` API route handlers
- `57` `page.tsx` files
- `223` `src/lib/*.ts` modules
- `127` test files

## Operating Decision

Use a stage-gated `audit -> remediate -> verify -> deploy` workflow.

This resolves the mismatch between the older source plans:
- The Claude review plan remains the evidence-gathering model for Phases 1-4.
- The autonomous review plan governs Phases 5-6 once findings are ranked.
- No merge or deploy happens until remediation and full verification are complete.

## Phase Map

| Phase | Doc | Purpose | Concurrency |
|---|---|---|---|
| 1 | `01_BASELINE_AND_PRIOR_REVIEW.md` | Establish ground truth, verify old findings, map hotspots | Mostly serial, read-only helpers allowed |
| 2 | `02_SECURITY_AND_BOUNDARY_AUDIT.md` | Review auth, route guards, validation, headers, exposure | Parallel lanes |
| 3 | `03_DATA_LOGIC_AND_INTEGRATIONS_AUDIT.md` | Review schema, transactions, booking logic, payments, integrations | Parallel lanes |
| 4 | `04_UI_TESTS_OPS_AND_DOCS_AUDIT.md` | Review UI flows, tests, performance, docs, deployment readiness | Parallel lanes |
| 5 | `05_REMEDIATION_AND_VERIFICATION.md` | Fix safe findings, add regression coverage, rerun checks | Parallel fixes with disjoint write sets |
| 6 | `06_GO_LIVE_AND_DEPLOY.md` | Publish, deploy, smoke test, and close the audit | Single release lead |

## Concurrency Model

### Wave 0: Baseline

Run Phase 1 first. Do not fan out broad audit work until the repo baseline, prior-finding ledger, and hotspot map exist.

### Wave 1: Audit

Run Phases 2-4 in parallel. Each phase document defines lanes so multiple agents can work without duplicating coverage.

### Wave 2: Remediation

Only start Phase 5 once the audit findings are consolidated. Fix work must be split into disjoint write sets owned by named agents.

### Wave 3: Release

Run Phase 6 with one release owner. Deployment, merge, and smoke testing should not be parallelized.

## Global Rules

- Read the relevant Next.js 16 guidance under `node_modules/next/dist/docs/` before changing framework-sensitive code.
- Prefer repo evidence over assumptions. Cite exact `file:line` references in findings.
- Safe fixes are allowed, but only after the finding is understood and ranked. Do not mix speculative refactors into audit work.
- If a critical security, auth, or data-loss issue is proven during Phases 1-4, it can be hot-fixed immediately if the change is clearly bounded and validated.
- Do not use destructive git commands.
- Do not revert unrelated worktree changes.
- Every agent output must state:
  - scope reviewed
  - findings with severity
  - evidence
  - recommended or applied fix
  - validation run
  - residual risks or blockers

## Finding Format

Use this structure for every finding:

```text
[severity] short title
- Evidence: path:line[, path:line]
- Impact: what can fail in production
- Recommendation: minimal safe fix or explicit follow-up
- Validation: test/build/lint/manual proof, or "not yet run"
```

## Severity Policy

- `Critical`: auth bypass, payment corruption, destructive data-loss risk, deploy blocker
- `High`: likely production incident, financial mismatch, broken admin safety, missing verification on sensitive flows
- `Medium`: correctness gaps with bounded blast radius, weak tests, stale docs that mislead operators
- `Low`: maintainability, ergonomics, minor UX gaps, non-blocking cleanup

## Required Outputs Before Go-Live

- Prior-review ledger updated to `FIXED`, `OPEN`, or `PARTIALLY FIXED`
- New findings list with severity and file references
- Deferred-items list with owner and reason
- Verification log for lint, tests, build, and any targeted checks
- Deployment outcome with exact commit hash and smoke-test result

## Recommended Execution Order

1. Complete Phase 1.
2. Run Phases 2-4 concurrently.
3. Consolidate findings and freeze the remediation backlog.
4. Run Phase 5 until the release candidate is green.
5. Run Phase 6 and record the final go-live decision.
