# Production Re-Review Operational Watch Evidence

This document is the P10 operational-watch evidence for review issues
[#205](https://github.com/thatskiff33/TACBookings/issues/205) and
[#194](https://github.com/thatskiff33/TACBookings/issues/194).

It uses the evidence path allowed by `#205`: operator runbook links, log
queries, scheduled-query references, Sentry monitor slugs, and branch-gate
evidence. It does not claim that Sentry alert IDs were created from this
workspace, because this workspace does not expose Sentry alert-routing
configuration.

## Closeout Basis

- All 28 review findings are closed/remediated in GitHub.
- The final report is `docs/audit/07_RE_REVIEW_2026_04.md`.
- No active critical, high, or medium review finding is accepted as residual
  risk in `docs/audit/07_RE_REVIEW_RISK_ACCEPTANCE.md`.
- Runtime cron evidence is available through `CronJobRun` rows and Sentry
  check-ins in `src/instrumentation.ts` and `src/lib/finance-sync-cron.ts`.
- Webhook error evidence is available through `WebhookLog` rows written by
  `src/app/api/webhooks/stripe/route.ts` via `src/lib/webhook-log.ts`.
- Xero API status-code evidence is available through `XeroApiUsageEvent` and
  `FinanceXeroApiUsageEvent` rows written by `src/lib/xero-api-usage.ts` and
  `src/lib/finance-xero-api-usage.ts`.

## Branch Protection And Gate Evidence

Authenticated branch-protection check, run on 2026-05-09:

```bash
gh api repos/thatskiff33/TACBookings/branches/main/protection --jq .
```

Result:

```text
HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.
```

Closure decision: the private repository cannot use GitHub branch protection
under the current GitHub plan. The accepted alternate controls are documented in
`docs/CI_SECURITY_GATES.md` and enforced by `.github/workflows/ci.yml`:

- `dependency-review` runs `npm audit --audit-level=high --package-lock-only`
  for pull requests.
- `verify` runs installed dependency audit, lint, tests, and build.
- `static-analysis` runs Semgrep blocking rules.
- `gitleaks-full-repo` scans repository history.
- `gitleaks-pr-diff` scans pull request commit ranges.
- `docker-image-security` builds the image and fails on critical Trivy findings.

If GitHub Pro or GitHub Advanced Security becomes available later, restore
native branch protection and GHAS-backed controls and update
`docs/CI_SECURITY_GATES.md`.

## Payment Intent Webhook Error Watch

Purpose: alert when Stripe `payment_intent.*` webhook handling fails.

Backing implementation:

- `src/app/api/webhooks/stripe/route.ts` records failed Stripe webhook handling.
- `src/lib/webhook-log.ts` writes `WebhookLog` rows.
- `prisma/schema.prisma` defines `WebhookLog`.

Production-safe query:

```sql
SELECT
  count(*) AS failure_count,
  max("createdAt") AS latest_failure_at
FROM "WebhookLog"
WHERE "source" = 'stripe'
  AND "status" = 'failure'
  AND "eventType" LIKE 'payment_intent.%'
  AND "createdAt" >= now() - interval '24 hours';
```

Pass condition: `failure_count = 0`.

Alert condition: `failure_count > 0`. Triage the matching `WebhookLog.error`
values, Stripe dashboard event IDs, and application logs for the same
`eventId`.

## Xero API 401 Watch

Purpose: alert when either the operational Xero boundary or finance Xero
boundary receives API `401` responses.

Backing implementation:

- Operational Xero calls go through `callXeroApi` in `src/lib/xero.ts`.
- Operational usage rows are written by `src/lib/xero-api-usage.ts`.
- Finance Xero usage rows are written by `src/lib/finance-xero-api-usage.ts`.
- `src/lib/xero-api-errors.ts` maps `401` and `403` to reconnect guidance.

Production-safe query:

```sql
WITH failures AS (
  SELECT
    'operational-xero' AS boundary,
    count(*) AS failure_count,
    max("createdAt") AS latest_failure_at
  FROM "XeroApiUsageEvent"
  WHERE "statusCode" = 401
    AND "createdAt" >= now() - interval '24 hours'

  UNION ALL

  SELECT
    'finance-xero' AS boundary,
    count(*) AS failure_count,
    max("createdAt") AS latest_failure_at
  FROM "FinanceXeroApiUsageEvent"
  WHERE "statusCode" = 401
    AND "createdAt" >= now() - interval '24 hours'
)
SELECT *
FROM failures
WHERE failure_count > 0;
```

Pass condition: the query returns no rows.

Alert condition: any returned row. Reconnect the affected Xero boundary from
the relevant admin or finance manager surface, then verify the next usage event
is successful.

## Stripe Idempotency Violation Watch

Purpose: alert when Stripe reports `idempotency_violation`, which indicates a
payment or refund path reused an idempotency key with different request
parameters.

Backing implementation:

- Stripe payment/refund helpers accept explicit idempotency keys in
  `src/lib/stripe.ts`.
- Payment and refund routes log Stripe errors with structured `err` fields.
- Relevant paths include primary payment intents, saved-method charges,
  booking modifications, cancellation refunds, and refund appeals.

Log-platform query:

```text
("idempotency_violation" OR "Keys for idempotent requests can only be used with the same parameters")
AND
("Stripe" OR "PaymentIntent" OR "refund" OR "charge")
```

If the log platform exposes structured Stripe fields, use this stricter query:

```text
err.code:idempotency_violation OR error.code:idempotency_violation
```

Pass condition: zero matches in the last 24 hours.

Alert condition: any match. Triage the route log message, booking ID,
idempotency key, Stripe request ID, and local `PaymentTransaction` or refund
ledger state before retrying.

## Plaintext Token Regression Watch

Purpose: prove the migrated action-token tables did not regain plaintext token
columns or malformed token hashes.

Backing implementation:

- `prisma/migrations/20260426131500_hash_action_tokens_at_rest/migration.sql`
  migrated action tokens to `tokenHash`.
- Runtime writes use `issueActionToken()` and persist `tokenHash`.
- `prisma/schema.prisma` models `PasswordResetToken`,
  `EmailVerificationToken`, `EmailChangeToken`, and `GuestChoreToken` with
  `tokenHash`.

Schema regression query:

```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'PasswordResetToken',
    'EmailVerificationToken',
    'EmailChangeToken',
    'GuestChoreToken'
  )
  AND column_name = 'token';
```

Hash-shape query:

```sql
SELECT 'PasswordResetToken' AS table_name, count(*) AS malformed_rows
FROM "PasswordResetToken"
WHERE "tokenHash" !~ '^[0-9a-f]{64}$'

UNION ALL

SELECT 'EmailVerificationToken' AS table_name, count(*) AS malformed_rows
FROM "EmailVerificationToken"
WHERE "tokenHash" !~ '^[0-9a-f]{64}$'

UNION ALL

SELECT 'EmailChangeToken' AS table_name, count(*) AS malformed_rows
FROM "EmailChangeToken"
WHERE "tokenHash" !~ '^[0-9a-f]{64}$'

UNION ALL

SELECT 'GuestChoreToken' AS table_name, count(*) AS malformed_rows
FROM "GuestChoreToken"
WHERE "tokenHash" !~ '^[0-9a-f]{64}$';
```

Pass condition: schema query returns no rows and every hash-shape row has
`malformed_rows = 0`.

Alert condition: any plaintext `token` column appears in the listed action-token
tables, or any malformed hash row appears. Stop token-bearing email/link flows
until the regression is understood.

## Cron Leader Count Watch

Purpose: prove exactly one production app instance is allowed to schedule cron
jobs.

Backing implementation:

- `docker-compose.yml` sets `APP_RUNTIME_ROLE=cron-leader` and
  `CRON_ENABLED=true` for `app`.
- `docker-compose.yml` sets `CRON_ENABLED=false` for `app_blue` and
  `app_green`.
- `src/instrumentation.ts` exits before scheduling jobs when
  `CRON_ENABLED=false`.
- `/api/health/ready` exposes only readiness status for load-balancer probes.
- `/api/admin/runtime-status` exposes runtime role and cron-enabled state to
  authenticated admin sessions.

Deploy-time check:

```bash
docker compose ps --services --filter status=running
docker compose exec app /bin/sh -lc 'printf "%s %s\n" "$APP_RUNTIME_ROLE" "$CRON_ENABLED"'
docker compose exec app_blue /bin/sh -lc 'printf "%s %s\n" "$APP_RUNTIME_ROLE" "$CRON_ENABLED"'
docker compose exec app_green /bin/sh -lc 'printf "%s %s\n" "$APP_RUNTIME_ROLE" "$CRON_ENABLED"'
```

Expected result:

```text
cron-leader true
web-blue false
web-green false
```

Pass condition: exactly one running production service reports
`CRON_ENABLED=true`, and that service reports `APP_RUNTIME_ROLE=cron-leader`.

Alert condition: zero cron leaders or more than one cron-enabled service. Stop
deploy/cutover activity until the Compose environment is corrected.

## Missed Scheduled Job Watch

Purpose: alert when required scheduled jobs have not recorded a run inside the
allowed window.

Backing implementation:

- `src/instrumentation.ts` records `CronJobRun` rows for core scheduled jobs.
- `src/lib/finance-sync-cron.ts` records `CronJobRun` rows for
  `finance-daily-sync`.
- Sentry check-in monitor slugs exist for the jobs listed below where the code
  calls `Sentry.captureCheckIn`.

Sentry monitor slugs:

| Job | Monitor slug |
| --- | --- |
| `confirm-pending` | `confirm-pending-bookings` |
| `xero-membership-refresh` | `xero-membership-refresh` |
| `xero-link-backfill` | `xero-link-backfill` |
| `xero-reconciliation-report` | `xero-reconciliation-report` |
| `xero-operation-replay` | `xero-operation-replay` |
| `xero-inbound-reconcile` | `xero-inbound-reconcile` |
| `backup` | `database-backup` |
| `pending-deadline-alerts` | `pending-deadline-alerts` |
| `checkin-reminders` | `checkin-reminders` |
| `capacity-warnings` | `capacity-warnings` |
| `email-retry` | `email-retry` |
| `waitlist-processor` | `waitlist-processor` |
| `finance-daily-sync` | `finance-daily-sync` |

Production-safe query:

```sql
WITH required_jobs(job_name, max_age_hours) AS (
  VALUES
    ('confirm-pending', 6),
    ('xero-link-backfill', 26),
    ('xero-reconciliation-report', 26),
    ('xero-operation-replay', 2),
    ('xero-inbound-reconcile', 2),
    ('backup', 26),
    ('data-pruning', 26),
    ('pending-deadline-alerts', 26),
    ('checkin-reminders', 26),
    ('capacity-warnings', 26),
    ('admin-digest', 26),
    ('email-retry', 2),
    ('complete-bookings', 26),
    ('hut-leader-auto-assign', 26),
    ('age-up', 26),
    ('credit-reconciliation', 26),
    ('waitlist-processor', 2),
    ('finance-daily-sync', 26)
),
latest AS (
  SELECT
    r.job_name,
    r.max_age_hours,
    max(c."startedAt") AS latest_started_at
  FROM required_jobs r
  LEFT JOIN "CronJobRun" c ON c."jobName" = r.job_name
  GROUP BY r.job_name, r.max_age_hours
)
SELECT *
FROM latest
WHERE latest_started_at IS NULL
   OR latest_started_at < now() - (max_age_hours || ' hours')::interval
ORDER BY job_name;
```

Pass condition: the query returns no rows.

Alert condition: any returned row. Check `CronJobRun.error`, application logs,
and the matching Sentry monitor if the job has a monitor slug.

`xero-membership-refresh` is intentionally not in the required SQL set because
it is feature-flagged by `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`. When that flag
is enabled in production, add it to the query with a `26` hour window.

## Closure Record

This document is sufficient P10 operational-watch evidence for the
`GO-WITH-CAVEATS` sign-off because it provides concrete operator queries,
scheduled-check references, Sentry monitor slugs, and branch-gate evidence
without requiring secret-bearing Sentry or production database output to be
posted in GitHub.

The caveats are:

- Operators must keep these queries or equivalent alerts wired into the actual
  production monitoring platform.
- Native GitHub branch protection is unavailable under the current private-repo
  plan; the documented CI gates are the accepted alternate control.
- Finance rollout and legacy-dashboard retirement remain separately tracked by
  finance issues and are not part of review `#194`/`#205` closure.
