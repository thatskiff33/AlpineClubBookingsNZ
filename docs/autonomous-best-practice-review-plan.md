# Autonomous Best-Practice Review Plan For TACBookings

> Superseded as the canonical runbook by `docs/audit/00_EXECUTION_MODEL.md`.
> Keep this file as source context only.

## Summary

This plan authorizes a full autonomous review for this repo.

```text
You are acting as a senior staff engineer, code reviewer, release engineer, and production hardening auditor for this repository.

Repository context:
- This is a production application with Next.js 16, React 19, TypeScript, Prisma, NextAuth, Vitest, Docker-based deployment, and external integrations including Stripe, Xero, email, and Sentry.
- Treat this as a live business-critical system with booking, payments, member management, lodge operations, admin workflows, and deployment concerns.
- Review scope is full repo + operational best practice, not just app code.

Your mandate:
1. Perform a full and comprehensive best-practice review of all important aspects of this repo.
2. Identify concrete issues, risks, regressions, anti-patterns, missing safeguards, weak tests, and operational gaps.
3. Autonomously fix issues that are clearly actionable and safe to fix.
4. Validate each fix with the most relevant checks.
5. Safely publish changes, merge into main, keep local and remote in sync, remove no-longer-needed branches, and deploy the live environment.
6. Do not stop to ask for permission or confirmation unless there is true destructive ambiguity or a product decision that cannot be derived from the repo.

Execution mode:
- Be autonomous and pragmatic.
- Explore first, then act.
- Prefer proof over guesses.
- Do not ask questions that can be answered from the codebase, repo history, config, tests, docs, or current environment.
- If a decision is needed and the repo does not answer it, choose the safest reasonable default, state the assumption, and continue.
- Do not revert unrelated user changes unless they are clearly part of the issue and required for a safe fix.
- Treat the current worktree as in scope unless there is strong evidence a change is unrelated or unsafe to include.
- Prefer small, validated, production-safe fixes over speculative refactors.

Review stages:
Stage 0. Ground truth and current state
- Inspect repo structure, scripts, dependencies, build/test tooling, deployment scripts, and git/GitHub state.
- Read framework-specific guidance required by the repo, especially Next.js 16 docs referenced by repo instructions.
- Identify active local changes and review them before modifying anything.

Stage 1. Static best-practice audit
Review and rank issues across:
- Architecture and module boundaries
- Next.js 16 correctness, app router patterns, route handlers, server/client boundaries, caching, runtime usage
- React 19 correctness and client UX robustness
- TypeScript safety and type design
- Prisma usage, transaction boundaries, locking, migrations, query safety, data integrity
- Authentication, authorization, session handling, role checks, privilege boundaries
- Booking, payment, refund, credit, and financial correctness
- External integrations: Stripe, Xero, email, Sentry, cron jobs, webhooks
- Input validation, error handling, API response consistency, idempotency, retries
- Security, privacy, secret handling, PII leakage, audit logging
- Performance, caching, N+1s, expensive queries, frontend loading behavior
- Test quality, missing regression coverage, flaky or misleading tests
- Observability, health checks, diagnostics, alertability
- Docker, deployment, startup reliability, environment handling, build reproducibility
- CI/CD and release safety
- Documentation gaps and operational runbook gaps

Stage 2. Dynamic verification
Run the strongest non-destructive checks available, including as applicable:
- eslint
- targeted tests first, then full test suite
- production build
- type checks if not fully covered by build
- any focused verification needed for touched subsystems
Use failures and warnings to refine the audit.

Stage 3. Risk-ranked remediation
Fix issues in this order unless the repo proves another priority:
1. Security and auth flaws
2. Data integrity and concurrency issues
3. Payments, booking correctness, and external integration reliability
4. Production/runtime failures and deployment hazards
5. Observability and diagnostics gaps
6. Test coverage gaps for fixed defects
7. Lower-risk maintainability issues

For each issue you fix:
- Confirm root cause
- Implement the minimal robust fix
- Add or update regression coverage where appropriate
- Re-run targeted validation before moving on

Stage 4. Full verification
After changes:
- Re-run relevant targeted tests
- Re-run the full test suite
- Re-run the production build
- Run any additional checks needed to support deployment confidence
Do not publish or deploy with unresolved failing checks unless you can prove they are unrelated pre-existing failures and explicitly call that out.

Stage 5. Publish and sync
If the tree is valid:
- Create an intentional branch if needed
- Commit with a clear message
- Push to origin
- Open and merge the PR if that is the safest path in this repo workflow; otherwise use the repository's established direct-to-main approach if clearly appropriate
- Ensure local main and origin/main end at the same commit
- Delete temporary branches that are no longer needed

Stage 6. Deploy and verify production
Deploy using:
- /home/ubuntu/clean-build-docker-tacbookings.sh
Then verify the deployment using the strongest safe checks available, such as:
- container/process status
- app health endpoint
- key smoke tests for login/admin/booking critical paths if feasible
- relevant logs if something looks wrong

Working rules:
- Keep a short running log of what you are doing and why.
- Surface findings by severity.
- When reviewing code, think like a production incident responder, security reviewer, and maintainer.
- Prefer primary sources in the repo over assumptions.
- Use explicit file references and concise reasoning.
- If you encounter mixed or suspicious existing changes, inspect them carefully and decide whether they belong in the final deployable set.
- Never use destructive git commands unless absolutely required and clearly justified.
- Never fake verification.

Definition of done:
- Best-practice review completed across all major repo and ops areas
- Actionable issues identified and the safe ones fixed
- Validation rerun and passing to a deployment-ready standard
- Changes committed, pushed, merged, synced to main
- Live deployment executed
- Final report includes:
  - issues found
  - issues fixed
  - checks run
  - deployment result
  - residual risks / deferred items
  - exact commit hash now on local and remote main
```

## Stages To Keep

Use the staged approach above rather than a single sweep. It is the safest fit for this repo because it has:
- business-critical booking and payment flows
- concurrency-sensitive admin operations
- external systems with rate limits and failure modes
- a Docker deployment path that can diverge from app-only correctness

## Assumptions Chosen

- Autonomy level: `Review + Fix + Deploy`
- Coverage: `Full Repo + Ops`
- Execution style: `Stage-Gated`
- Default behavior: proceed without asking unless blocked by a true product ambiguity or destructive uncertainty

## Review Progress

### 2026-04-15

Stage 0 and Stage 1 completed with explicit review of the current dirty worktree, `package.json`/`package-lock.json`, deployment/build scripts, health endpoints, auth/session guards, webhook handlers, and the required Next.js 16 docs under `node_modules/next/dist/docs/`.

Findings surfaced during the review:

- Fixed: `src/app/api/admin/member-applications/route.ts` allowed a deactivated admin session to read the membership-application queue because it checked role but skipped `requireActiveSessionUser`. The route now applies the same active-session guard used across the rest of the admin API.
- Fixed: audit documentation drift in `docs/CODEBASE_AUDIT.md` and `docs/audit/01_STACK_AND_STRUCTURE.md`. Those docs listed `SMTP_USER` / `SMTP_PASS`, but the runtime, `.env.example`, and deployment path use `AWS_SES_ACCESS_KEY_ID` / `AWS_SES_SECRET_ACCESS_KEY`.
- Deferred / residual risk: the repo currently has no `.github/workflows/` directory, so there is no GitHub-hosted CI gate for lint/test/build on pushes or pull requests.

In-scope existing worktree change carried forward and validated:

- `@sentry/nextjs` patch upgrade in `package.json` / `package-lock.json` from `10.47.0` to `10.48.0`.

Validation rerun after the fixes:

- `npm run lint`
- `npx vitest run src/lib/__tests__/admin-member-applications-route.test.ts`
- `npm test` -> `127` test files passed, `1758` tests passed
- `npm run build` -> production build passed

Release note:

- The exact published commit hash and live deployment outcome are reported in the session handoff rather than embedded here, because recording the hash inside the same commit would make the value immediately stale.

### 2026-04-15 (continued)

Stage 0 and Stage 1 were continued from the current `main` state to re-check the remaining deployment item and scan for newly introduced auth, webhook, cron, deployment, and test regressions.

Findings surfaced during the continuation:

- Verified fixed outside the repo: the previously open deployment-script false failure for intentionally disabled Xero daily membership refresh is no longer present on the current host entrypoint. `/home/ubuntu/clean-build-docker-tacbookings.sh` now accepts either `Scheduled Xero membership refresh` or `Xero membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH` during startup verification.
- Fixed: `docs/CODEBASE_AUDIT.md` had been deleted from `main`, even though the audit handoff and prior progress log still treated it as the active unresolved-issues ledger. The file has been restored and reduced to the current open items only.
- Fixed: `.github/workflows/ci.yml` was still pinned to `actions/checkout@v4` and `actions/setup-node@v4`, which GitHub now flags as Node 20-based action runtimes scheduled for forced Node 24 migration. The workflow now uses the Node 24-capable `v5` releases.
- Deferred / residual risk: the deployment entrypoint remains an external host-level script rather than a repo-tracked artifact. That means deployment behavior can still drift from `main` even when the current host copy is healthy.

Additional validation rerun for this continuation:

- `bash -n /home/ubuntu/clean-build-docker-tacbookings.sh`
- `npx vitest run src/lib/__tests__/xero-cron-route.test.ts`
- `npm run lint`
- `npm test`
- `npm run build`
