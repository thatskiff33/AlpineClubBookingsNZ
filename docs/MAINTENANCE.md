# Maintenance

This document describes the public maintenance baseline for AlpineClubBookingsNZ.

## Required Gates

Run lightweight local gates before opening or merging application changes:

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npm run db:generate
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx tsc --noEmit
npm test
npm run quality:report
git diff --check
```

Migration/schema parity is enforced by a dedicated check. The committed
migrations in `prisma/migrations` must reproduce `prisma/schema.prisma` exactly,
or the blue/green deploy migration-safety gate aborts. Run it locally against a
throwaway database (`SHADOW_DATABASE_URL` must point at an empty, existing DB
that Prisma resets):

```bash
SHADOW_DATABASE_URL=postgresql://user:pass@localhost:5432/drift_shadow \
  npm run db:check-drift   # exit 0 = in sync, 2 = drift
```

CI also runs independent static and container checks:

- `npm audit --audit-level=high --package-lock-only` on pull requests
- Semgrep with Next.js, TypeScript, JavaScript, and React rules
- gitleaks full-history and pull-request diff scans
- TypeScript, test, and Docker image build validation
- Migration drift check (`migration-drift` job) running `db:check-drift` against
  a throwaway Postgres, so schema-vs-migration drift fails the PR rather than the
  deploy
- Trivy critical vulnerability gate with high-severity warnings

## Dependency Policy

- Keep `package-lock.json` committed.
- Prefer small dependency update PRs with explicit validation results.
- Keep security overrides documented in `package.json` and remove them when the
  upstream dependency graph no longer needs them.
- Use test or demo credentials for Stripe, Xero, SES, and Sentry in local and
  CI environments.

## Supply-Chain And Deployment Security Policy

- Keep GitHub Actions default permissions at `contents: read`. Grant elevated
  permissions only on the job that needs them, such as `packages: write` for
  GHCR publishing on `main`.
- Do not reference GitHub Actions by default branches such as `master` or
  `main`. Use released major tags for trusted first-party and widely used
  actions that Dependabot can track, and use explicit release tags for scanner
  actions or images where drift would change gate behavior.
- Keep scanner container inputs isolated. Source checkouts mounted into scanner
  containers should be read-only unless the scanner must write to the source
  tree; write artifacts to `$RUNNER_TEMP` or another dedicated output mount.
- Keep production image tags commit-SHA based. Operators should deploy the app
  and migration images that match the resolved `origin/main` commit.
- Keep GHCR host tokens read-only. Production hosts need `read:packages`; CI
  publishing uses the workflow `GITHUB_TOKEN` in the publish job only.
- Treat Docker image security as two gates: CRITICAL Trivy findings fail the PR,
  while HIGH findings are warning-only until reviewed and promoted to a blocking
  policy.

Accepted residual risk:

- Most GitHub Actions remain pinned to released major tags rather than full
  commit SHAs so Dependabot and upstream patch releases can keep routine
  maintenance low-friction.
- The project does not yet publish signed image attestations or SBOM artifacts;
  image provenance is currently the commit-SHA tag, protected PR checks, and the
  GHCR package publish job.
- The `npm audit --audit-level=high` gate keeps high/critical npm advisories
  blocking, while lower severity advisories remain review-driven.

## Image Uploads Storage

Admin Image Manager uploads are written at runtime under `public/images` (served
at `/images/...`). The deployed app runs with a read-only root filesystem and
multiple replicas (blue/green), so this path must be a persistent, writable,
shared volume:

- `docker-compose.yml` mounts the `image_uploads` named volume at
  `/app/public/images` for every app replica, so uploads survive redeploys and
  are visible to all instances.
- The app runs as uid 1001. The `Dockerfile` creates `public/images` owned by
  uid 1001 so a freshly-initialised named volume inherits writable ownership.
- Relocate storage at the deployment layer by bind-mounting your chosen path at
  `/app/public/images`. The application path stays `public/images` (a trusted
  constant), which keeps the upload path-traversal checks statically verifiable.
- When the volume is missing or not writable, upload and create-directory
  requests return a clear "image storage directory is not writable" message
  (with the underlying error code) instead of a generic failure, and the cause
  is logged server-side.

## Maintainability Budgets

The repo has a handful of oversized files and route surfaces. Future
refactors should keep new code inside soft budgets so reviewers can spot
regressions early. Treat these as review prompts, not hard CI gates:

- Route handlers (`src/app/.../route.ts`) should generally stay under
  roughly 250 LOC.
- App Router page shells (`src/app/.../page.tsx`) should generally stay
  under roughly 500 LOC.
- New domain modules (`src/lib/...`, `src/components/...`) should
  generally stay under roughly 700 LOC.
- No new production `any`, type suppression (`@ts-ignore`,
  `@ts-expect-error`, `@ts-nocheck`), or `eslint-disable` without a
  short inline comment explaining the local justification.

When a file is already over budget, prefer extracting cohesive helpers
into a focused module rather than adding more to the existing surface.

### Quality report

Run the local maintainability report before opening broad refactor PRs, after
splitting a large surface, and when reviewing a PR that adds substantial
production code:

```bash
npm run quality:report
```

The script scans tracked files via `git ls-files` and prints a markdown
summary of:

- largest production files
- largest route handlers and App Router pages
- newly oversized files outside the accepted-hotspot allow-list
- largest test files
- production `any` / type-suppression hotspots
- production `eslint-disable` hotspots
- test `as any` totals

It uses only existing repo tooling, runs without external service
credentials or network access, and is advisory: it warns and informs rather
than failing the build. The `Over budget` column is a soft review prompt:
`yes` means the file exceeds the route-handler, page-shell, or new-domain-module
budget. The `Newly oversized files` section is stricter: it lists oversized
production files that are not in the accepted hotspot allow-list below, so
reviewers can spot regressions without making the report a CI gate.

### Known remaining hotspots

These files are intentionally accepted carry-over hotspots in the current
post-refactor baseline. This table is not a blanket allow-list for every file
that may appear in `npm run quality:report`. Feature-heavy releases can leave
additional advisory "newly oversized" entries visible; keep those warnings
visible unless a reviewer explicitly accepts them, and prefer follow-up
extraction over expanding this table casually.

| File | Current LOC | Disposition |
| --- | ---: | --- |
| `src/lib/xero-inbound-reconciliation.ts` | 2926 | Queued for future split when reconciliation classification, repair, or reporting changes next land. |
| `src/lib/xero-booking-repair.ts` | 2682 | Accepted as-is for now: operator repair tool, documented separately, not normal request-path code. |
| `src/lib/xero-operation-outbox.ts` | 2028 | Queued for future split when queue dispatch, release, or retry policy changes next land. |
| `src/lib/email-templates.ts` | 2006 | Accepted as-is for now: central template catalogue; split only with a template-registry change. |
| `src/lib/email.ts` | 1936 | Queued for future split when transport, registry, or recipient-policy work next lands. |
| `src/lib/xero-hardening.ts` | 1606 | Accepted as-is for now: central Xero hardening policy and diagnostics boundary. |
| `src/lib/finance-sync-xero-datasets.ts` | 1573 | Queued for future split by finance snapshot family when finance dataset work resumes. |
| `src/app/(admin)/admin/members/[id]/page.tsx` | 1747 | Queued for future route-shell thinning as member-detail sections continue to move local state out. |
| `src/app/(admin)/admin/family-groups/page.tsx` | 1312 | Queued for future route-shell thinning when family-group workflows are next touched. |

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
`XERO_AMOUNT_MISMATCH` findings are manual-review only: the tool reports stored
Xero operation/link amount evidence that disagrees with local cents, but it
does not auto-adjust financial amounts.

## Public Reference Release Checklist

Before cutting a public reference release:

1. Create a release-prep branch from fresh `origin/main`.
2. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` for the
   release version.
3. Check `README.md`, `DEPLOYMENT.md`, `CONFIGURATION.md`, this maintenance
   guide, and `docs/ARCHITECTURE.md` for dependency, release, GHCR, migration,
   validation, and public/private workflow drift.
4. Confirm any new or changed migrations that touch hot tables or potentially
   breaking SQL are represented in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, or
   document why no ledger entry is needed.
5. Run local release validation without live provider credentials, then rely on
   GitHub Actions for Docker image build, static analysis, secret scanning,
   dependency review, and GHCR publication.
6. After merge, create the annotated release tag on the merged commit and
   publish the GitHub release with validation evidence, migration notes, image
   names, commit SHA, and non-blocking maintainability follow-ups.

## GitHub Actions Availability

If Actions jobs fail before starting, check repository or account billing and
spending limits before treating the failures as code failures.
