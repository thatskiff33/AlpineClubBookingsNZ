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
