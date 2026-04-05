# 04c - Observability Requirements

**Date:** 2026-04-05
**Status:** Draft
**Context:** All errors currently go to Docker container stdout/stderr via `console.*` calls (~85 occurrences across `src/lib/` and `src/app/api/`). No error aggregation, no alerting, no structured logging, no APM. Error boundaries (`error.tsx`, `global-error.tsx`) only `console.error` to the browser. Cron jobs log to stdout with no persistence or failure alerting. The only health check is Docker's `wget` liveness probe on port 3000.

---

## OBS-01: Sentry Server-Side Integration

**Description:** Install `@sentry/nextjs` and configure server-side error capture for all API routes, server components, and library code. Replace bare `console.error` calls in catch blocks with Sentry capture while preserving console output for Docker logs.

**Acceptance Criteria:**
- `@sentry/nextjs` installed and initialised via `sentry.server.config.ts`
- DSN, environment (`production`/`development`), and release version configured via env vars
- Source maps uploaded to Sentry during Docker build
- Unhandled exceptions in API routes and server components automatically reported
- All existing `catch` blocks in `src/app/api/` and `src/lib/` call `Sentry.captureException()` alongside `console.error`
- Sensitive data (passwords, tokens, Stripe keys) scrubbed from Sentry payloads via `beforeSend`
- `instrumentation.ts` calls `Sentry.init()` for the Node runtime

**Dependencies:** Sentry account + DSN
**Complexity:** M

---

## OBS-02: Sentry Client-Side Integration

**Description:** Configure Sentry browser SDK to capture client-side React errors. Wire into Next.js error boundaries so unhandled UI errors are reported with error digest correlation.

**Acceptance Criteria:**
- `sentry.client.config.ts` initialised with DSN and environment
- `global-error.tsx` and `error.tsx` call `Sentry.captureException(error)` instead of only `console.error`
- `error.digest` attached as Sentry tag for server/client error correlation
- Session replay or breadcrumbs enabled for error context
- Client bundle size impact < 30KB gzipped

**Dependencies:** OBS-01 (shared DSN/project)
**Complexity:** S

---

## OBS-03: Sentry Cron Monitoring

**Description:** Register the 3 node-cron jobs (pending booking confirmation, Xero membership refresh, database backup) as Sentry Cron Monitors. Send check-in/check-out signals so Sentry alerts on missed or failed runs.

**Acceptance Criteria:**
- Each cron job in `instrumentation.ts` wrapped with `Sentry.withMonitor(slug, fn, schedule)`
- Monitor slugs: `confirm-pending-bookings`, `xero-membership-refresh`, `database-backup`
- Sentry alerts if a scheduled run is missed (no check-in within expected window)
- Sentry alerts if a run reports failure (exception during execution)
- Check-in includes duration metric

**Dependencies:** OBS-01
**Complexity:** S

---

## OBS-04: Structured Logging

**Description:** Replace raw `console.*` calls with a structured JSON logger (e.g. `pino`) that includes level, timestamp, and contextual metadata. Ensures Docker log aggregation tools can parse and filter logs.

**Acceptance Criteria:**
- Logger instance exported from `src/lib/logger.ts`
- Log levels: `debug`, `info`, `warn`, `error`, `fatal`
- Output format: JSON with `level`, `time`, `msg`, plus arbitrary context fields
- All ~85 existing `console.log`/`console.error`/`console.warn` calls in `src/lib/` and `src/app/api/` replaced with logger calls
- Cron job logs include `job` field (e.g. `{ job: "confirm-pending", confirmed: 3, bumped: 1 }`)
- Log level configurable via `LOG_LEVEL` env var (default: `info` in production, `debug` in development)
- No `console.*` calls remain in `src/lib/` or `src/app/api/` (enforced by lint rule)

**Dependencies:** None
**Complexity:** M

---

## OBS-05: API Route Request Logging

**Description:** Log every API request with method, path, response status, and duration. Provides visibility into traffic patterns and slow endpoints without full APM.

**Acceptance Criteria:**
- Every API response logged as structured JSON: `{ method, path, status, durationMs, ip }`
- Implemented as a shared wrapper or middleware applied to all `src/app/api/` routes
- Auth endpoints log without including credentials
- Webhook endpoints log event type and processing result
- Requests returning 4xx/5xx logged at `warn`/`error` level respectively
- Duration measured from request start to response send

**Dependencies:** OBS-04 (logger)
**Complexity:** M

---

## OBS-06: System Health Endpoint

**Description:** Add `GET /api/health` that checks connectivity to all critical dependencies and returns structured status. Used by uptime monitors and admin dashboard.

**Acceptance Criteria:**
- Returns JSON: `{ status: "healthy"|"degraded"|"unhealthy", version, uptime, checks: {...} }`
- Checks: PostgreSQL (`SELECT 1`), Stripe API (key validation), Xero connection status, SMTP connectivity
- Each check returns `{ status: "ok"|"error", latencyMs, error? }`
- Overall status is `healthy` if all pass, `degraded` if non-critical fail (Xero/SMTP), `unhealthy` if DB or app error
- Responds within 5 seconds (individual check timeouts at 3s)
- No authentication required (for external monitors), but does not expose sensitive details
- Returns HTTP 200 for healthy/degraded, 503 for unhealthy

**Dependencies:** None
**Complexity:** S

---

## OBS-07: Admin Health Dashboard

**Description:** Add `/admin/health` page showing live integration status, recent errors, cron job history, and system metrics. Single pane of glass for the admin.

**Acceptance Criteria:**
- Page at `/admin/health` behind admin auth guard
- Displays results from `/api/health` endpoint with colour-coded status indicators
- Shows last 5 cron job runs with status and duration (from OBS-09 data)
- Shows webhook success/failure counts for last 24h (from OBS-08 data)
- Shows recent Sentry errors (count + link to Sentry dashboard) or last 10 errors from local log
- Auto-refreshes every 60 seconds
- Displays app version, Node version, uptime, memory usage

**Dependencies:** OBS-06, OBS-08, OBS-09
**Complexity:** L

---

## OBS-08: Webhook Delivery Monitoring

**Description:** Track and persist Stripe and Xero webhook processing metrics (success, failure, latency) so issues are visible before they become critical.

**Acceptance Criteria:**
- Each webhook invocation records: `{ source, eventType, eventId, status, durationMs, error?, timestamp }`
- Data stored in a new `WebhookLog` Prisma model (or appended to `ProcessedWebhookEvent`)
- Success/failure counts queryable by source and time range
- Failed webhooks logged at `error` level with event details
- Admin can view webhook history via OBS-07 dashboard
- Old records auto-pruned after 30 days

**Dependencies:** OBS-04 (logger), Prisma schema update
**Complexity:** M

---

## OBS-09: Cron Job Status Tracking

**Description:** Persist execution metadata for each cron job run so admins can see history and detect silent failures.

**Acceptance Criteria:**
- Each cron run records: `{ jobName, startedAt, completedAt, durationMs, status, resultSummary, error? }`
- Data stored in a new `CronJobRun` Prisma model
- `instrumentation.ts` updated to persist records after each run
- Admin dashboard (OBS-07) shows last 5 runs per job
- Old records auto-pruned after 90 days

**Dependencies:** Prisma schema update
**Complexity:** S

---

## OBS-10: Performance Monitoring (Sentry Tracing)

**Description:** Enable Sentry performance tracing to measure API route latency, DB query duration, and external service call times. Identifies bottlenecks without separate APM tooling.

**Acceptance Criteria:**
- `tracesSampleRate` configured (e.g. 0.2 in production, 1.0 in development)
- API routes automatically instrumented (Next.js integration handles this)
- Prisma queries traced via `@sentry/prisma` integration or manual spans
- Stripe and Xero HTTP calls captured as child spans
- Slow transactions (>2s) flagged in Sentry
- No measurable performance degradation (< 5ms overhead per request)

**Dependencies:** OBS-01
**Complexity:** M

---

## OBS-11: Alerting Rules

**Description:** Configure Sentry alert rules so the admin is notified of critical issues via email (and optionally Slack) without needing to check dashboards.

**Acceptance Criteria:**
- Alert: new unhandled exception (first occurrence) -> email to admin
- Alert: error spike (>10 events in 5 minutes) -> email to admin
- Alert: cron monitor missed or failed (from OBS-03) -> email to admin
- Alert: webhook failure rate >20% in 15 minutes -> email to admin
- All alerts include error message, URL/route, and link to Sentry issue
- Alert recipients configurable in Sentry project settings
- Documented in runbook: what each alert means and initial triage steps

**Dependencies:** OBS-01, OBS-03
**Complexity:** S

---

## OBS-12: Uptime Monitoring

**Description:** Configure external uptime monitoring that pings the health endpoint and alerts on downtime. Catches scenarios where the entire container or instance is down (which Sentry cannot detect).

**Acceptance Criteria:**
- External service (UptimeRobot free tier, Sentry Uptime, or similar) pings `GET /api/health` every 60 seconds
- Alert sent if endpoint is unreachable or returns 503 for 2 consecutive checks
- Alert via email to admin
- Public status page optional but not required
- Health endpoint (OBS-06) must be deployed first

**Dependencies:** OBS-06, external monitoring account
**Complexity:** S

---

## OBS-13: Log Retention and Rotation

**Description:** Configure Docker log rotation to prevent disk exhaustion on the single Lightsail instance. Optionally forward logs to CloudWatch or S3 for long-term retention.

**Acceptance Criteria:**
- Docker Compose `logging` config added for all 3 services: `json-file` driver with `max-size: 10m`, `max-file: 5`
- Total log disk usage capped at ~150MB (3 services x 5 files x 10MB)
- Optional: CloudWatch Logs agent or `docker log-driver=awslogs` for production log forwarding
- Optional: log shipping to S3 for archival (reuse existing backup S3 bucket)
- Log format compatible with structured logging from OBS-04

**Dependencies:** None (OBS-04 recommended for structured format)
**Complexity:** S

---

## Complexity Summary

| ID | Feature | Complexity |
|----|---------|-----------|
| OBS-01 | Sentry server-side | M |
| OBS-02 | Sentry client-side | S |
| OBS-03 | Sentry cron monitoring | S |
| OBS-04 | Structured logging | M |
| OBS-05 | API request logging | M |
| OBS-06 | Health endpoint | S |
| OBS-07 | Admin health dashboard | L |
| OBS-08 | Webhook monitoring | M |
| OBS-09 | Cron job tracking | S |
| OBS-10 | Performance monitoring | M |
| OBS-11 | Alerting rules | S |
| OBS-12 | Uptime monitoring | S |
| OBS-13 | Log retention/rotation | S |

**Total:** 1 Large, 4 Medium, 8 Small
