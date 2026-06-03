# Agent Guidelines

These instructions apply to automated coding agents working in this repository.

## Next.js Version Rule

This project uses a current Next.js release with APIs and conventions that may
not match older examples. Before changing framework behaviour, read the
relevant guide in `node_modules/next/dist/docs/` and follow deprecation notices.

## Local Safety

- Do not start local development servers in a shared, staging, or production
  checkout unless the repository owner explicitly asks for one.
- Do not use live Stripe, Xero, SES, Sentry, or production database credentials
  for tests or exploratory work.
- Do not run browser automation, DAST, load tests, or broad endpoint scanning
  against a live production deployment without a written test window.
- Prefer local PostgreSQL, staging Compose, Stripe test mode, and Xero demo
  tenants for validation.

## Validation Policy

This repository is now normally worked on from the home Ubuntu development
server, which has enough CPU, memory, and disk for routine local validation.

- Run relevant local validation before opening or updating PRs. Acceptable
  checks include targeted tests, `npm run lint`, `npx tsc --noEmit`,
  `npx prisma validate`, `npx prisma generate`, `npm test`, `npm run build`,
  Docker image builds, and `git diff --check` when they match the change.
- Use GitHub-hosted Actions as the external CI source of truth for build,
  image, and full CI validation. This is a public repository, so standard
  GitHub-hosted runner minutes are not the constraint.
- Do not attach a persistent self-hosted runner to this public repository.
  Public pull requests can execute untrusted workflow code on self-hosted
  runner machines.
- After opening a PR, monitor GitHub checks with `gh pr checks <pr>` and inspect
  failed Actions logs with `gh run view --log`.

## External Connectors

Before using any external connector, MCP tool, or third-party account, verify
that it belongs to the repository owner or was explicitly identified by the user
for the task. If the connector identity is unclear, do not call it.

## Change Discipline

- Keep money values in integer cents.
- Keep booking dates as New Zealand date-only values unless a feature explicitly
  requires time-of-day semantics.
- Keep external network calls outside long database transactions where possible.
- Do not add plaintext bearer-token storage.
- Update public docs when setup, architecture, deployment, or environment
  contracts change.
