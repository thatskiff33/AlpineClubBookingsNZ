# Production Dependency Audit

Last updated: 2026-05-09

Issue `#176` re-triaged production dependencies from the current lockfile and applied the feasible remediations that cleared the active `npm audit --omit=dev` findings.

## Baseline

- `npm audit --omit=dev --json` reported 9 production advisories:
- 7 moderate
- 2 low

## Remediations Applied

- Upgraded `next` from `16.2.3` to `16.2.4`.
- Upgraded `eslint-config-next` from `16.2.3` to `16.2.4`.
- Upgraded `@sentry/nextjs` from `10.48.0` to `10.50.0`.
- Upgraded `next-auth` from `5.0.0-beta.30` to `5.0.0-beta.31`.
- Upgraded `@auth/prisma-adapter` from `2.11.1` to `2.11.2`.
- Upgraded `nodemailer` from `7.0.13` to `8.0.6`.
- Updated the existing `axios` override from `1.15.0` to `1.15.2`.
- Added overrides for:
- `dompurify` `3.4.1`
- `follow-redirects` `1.16.0`
- `postcss` `8.5.10`

## Current State

- `npm audit --omit=dev --json` returns `0` production vulnerabilities on the current lockfile.
- `npm run build` completes successfully on the updated dependency graph.

## Residual Risk / Follow-up

- `npm ls nodemailer next-auth @types/nodemailer --all` still reports an optional peer-range mismatch because `next-auth@5.0.0-beta.31` and `@auth/core@0.41.2` declare `nodemailer@^7.0.7`, while the app now installs `nodemailer@8.0.6`.
- Rechecked the published `next-auth@latest` / `@auth/core@latest` metadata on 2026-05-09; the Nodemailer peer range is still `^7`, so there is no upstream Auth.js package update that resolves the peer range while keeping Nodemailer 8.
- The repo now sets `legacy-peer-deps=true` in `.npmrc` so `npm ci` continues to install the validated dependency graph in local and CI environments while that upstream optional peer range remains stale.
- This app uses `next-auth` credentials auth only and does not use the Auth.js email provider path. Current mail sending goes through the app's own `nodemailer.createTransport(...)` usage in `src/lib/email.ts`, `src/lib/cron-email-retry.ts`, and `src/lib/health-check.ts`.
- Accept this as a temporary compatibility warning unless runtime email regressions appear. Revisit once Auth.js expands its optional peer range to include Nodemailer 8.
