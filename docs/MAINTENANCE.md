# Maintenance

This document describes the public maintenance baseline for AlpineClubBookingsNZ.

## Required Gates

Run these before merging application changes:

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npm test
npm run build
git diff --check
```

CI also runs independent static and container checks:

- `npm audit --audit-level=high --package-lock-only` on pull requests
- Semgrep with Next.js, TypeScript, JavaScript, and React rules
- gitleaks full-history and pull-request diff scans
- Docker image build
- Trivy critical vulnerability gate with high-severity warnings

## Dependency Policy

- Keep `package-lock.json` committed.
- Prefer small dependency update PRs with explicit validation results.
- Keep security overrides documented in `package.json` and remove them when the
  upstream dependency graph no longer needs them.
- Use test or demo credentials for Stripe, Xero, SES, and Sentry in local and
  CI environments.

## Maintainability Budgets

The repo has a handful of oversized files and route surfaces. Future
refactors should keep new code inside soft budgets so reviewers can spot
regressions early. Treat these as review prompts, not hard CI gates:

- Route handlers (`src/app/.../route.ts`) should generally stay under
  roughly 250 LOC.
- App Router page shells (`src/app/.../page.tsx`) should generally stay
  under roughly 500 LOC.
- New domain modules (`src/lib/...`, `src/components/...`) should
  generally stay under roughly 900 LOC.
- No new production `any`, type suppression (`@ts-ignore`,
  `@ts-expect-error`, `@ts-nocheck`), or `eslint-disable` without a
  short inline comment explaining the local justification.

When a file is already over budget, prefer extracting cohesive helpers
into a focused module rather than adding more to the existing surface.

### Quality report

Run the local maintainability report to see current hotspots:

```bash
npm run quality:report
```

The script scans tracked files via `git ls-files` and prints a markdown
summary of:

- largest production files
- largest route handlers and App Router pages
- largest test files
- production `any` / type-suppression hotspots
- production `eslint-disable` hotspots
- test `as any` totals

It uses only existing repo tooling, runs without external service
credentials or network access, and is advisory: it warns and informs
rather than failing the build. Use it before opening a refactor PR to
confirm that the change reduces an oversized surface instead of just
moving lines around.

## Operational Repair Tools

`scripts/xero-booking-repair.ts` is a targeted booking/Xero reconciliation
helper. Keep it out of normal setup and deployment flows. Use it only when an
operator needs to inspect or repair known booking-payment/Xero mismatches after
reviewing the affected bookings.

Always start with a dry run:

```bash
npx tsx scripts/xero-booking-repair.ts --dry-run
npx tsx scripts/xero-booking-repair.ts --booking <bookingId> --dry-run
npx tsx scripts/xero-booking-repair.ts --from <YYYY-MM-DD> --to <YYYY-MM-DD> --dry-run
```

Only use `--apply` after the dry-run report has been reviewed. Do not run it
with live Xero, Stripe, SES, Sentry, or production database credentials during
exploratory work; use a staging database and Xero demo tenant where possible.

## Public Release Checklist

Before changing repository visibility to public:

1. Confirm `main` has a green local validation run and a green GitHub Actions
   run.
2. Run a full-history secret scan.
3. Confirm `.env`, `.env.local`, production logs, generated reports, `.next`,
   and database dumps are not tracked.
4. Enable Dependabot, dependency graph, secret scanning, and branch protection
   options available to the repository.
5. Create a release tag for the public reference snapshot.

## GitHub Actions Availability

If Actions jobs fail before starting, check repository or account billing and
spending limits before treating the failures as code failures.
