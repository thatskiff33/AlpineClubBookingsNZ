# Phase 4: UI, Tests, Ops, And Docs Audit

## Goal

Close the gaps that often block a real launch after core logic looks correct.

## Scope

- Member, admin, and public page flows
- Accessibility, mobile behavior, loading/error states, client/server boundaries
- Test coverage quality and missing regression protection
- Performance hotspots and heavy server/client paths
- Docker, Caddy, cron, backups, Sentry, health checks, CI/CD, and release readiness
- Documentation accuracy for setup, operations, incident response, and deployment

## Steps

1. Audit critical page flows.
   - Booking, booking detail, admin management pages, auth pages, lodge/kiosk flows.
   - Check user-visible failure states and fallback behavior.
2. Audit test quality.
   - Map important modules and routes to existing tests.
   - Call out missing coverage for sensitive paths and outdated mocks.
3. Audit performance and observability.
   - Check bundle split risks, expensive queries, cron batching, health checks, and Sentry coverage.
4. Audit deployment and operations.
   - Check Docker and compose contracts, migration safety, backup/restore posture, and rollback clarity.
   - Confirm the repo's lack or presence of CI gates and note required compensating controls.
5. Audit documentation.
   - Confirm docs match the current code and environment.
   - Flag stale operational guidance that would mislead a launch-day operator.

## Suggested Lanes

- Lane A: pages, components, UX, accessibility, client/server boundaries
- Lane B: tests, mocks, performance, observability
- Lane C: Docker, deployment, backups, CI/CD, and documentation

## Required Outputs

- Launch-blocking UX or operator-facing findings
- Coverage gap list tied to business-critical flows
- Performance and observability risks by severity
- Documentation corrections needed before go-live

## Exit Criteria

- Critical user journeys have been reviewed
- Missing regression coverage is explicitly tracked
- Deployment and rollback paths are understood
- Docs that materially affect launch safety are either corrected or queued for Phase 5

## Validation Expectations

- Run targeted tests for any UI or ops fix that changes behavior
- Use `npm run build` as the minimum proof for framework-sensitive changes
