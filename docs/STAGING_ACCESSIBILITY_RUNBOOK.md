# Staging Accessibility Verification Runbook

Issue: [#259](https://github.com/thatskiff33/TACBookings/issues/259)

This runbook makes the non-production target and evidence path explicit for P7 accessibility verification. Do not run Lighthouse or authenticated browser checks against production unless an incident lead explicitly approves it.

## Staging Target Contract

| Item | Value |
| --- | --- |
| GitHub environment | `staging` |
| Public URL variable | `STAGING_APP_URL` |
| Canonical URL | `https://staging.tokoroa.org.nz` |
| Auth path | `/login` |
| Health check | `/api/health/ready` |
| Compose env file | `.env.staging` from `.env.staging.example` |
| Compose override | `docker-compose.staging.yml` |
| Caddy config | `Caddyfile.staging` |
| Lighthouse output | `reports/lighthouse/staging/` |

If DNS or hosting changes, update `.env.staging.example`, this table, and the GitHub `staging` environment variable `STAGING_APP_URL` in the same PR. The resolved `NEXTAUTH_URL`, `XERO_REDIRECT_URI`, and `FINANCE_XERO_REDIRECT_URI` must use the same staging origin.

## Staging Data Rules

- Use Stripe test-mode keys, Xero demo or staging credentials, and SES sandbox or non-production email credentials.
- Keep `CRON_ENABLED=false` by default. Enable cron only for a planned staging job test.
- Do not copy production database dumps into staging unless personal data handling has been approved for the test window.
- Store real staging secrets in the password manager and GitHub `staging` environment secrets, not in the repository.

## Provision Or Refresh Staging

1. Confirm DNS for `staging.tokoroa.org.nz` points at the staging host.
2. Copy the template and fill every staging-only secret:

   ```bash
   cp .env.staging.example .env.staging
   nano .env.staging
   ```

3. Validate the Compose model:

   ```bash
   docker compose --env-file .env.staging \
     -f docker-compose.yml -f docker-compose.staging.yml config
   ```

4. Start Postgres:

   ```bash
   docker compose --env-file .env.staging \
     -f docker-compose.yml -f docker-compose.staging.yml up -d postgres
   ```

5. Apply migrations:

   ```bash
   docker compose --env-file .env.staging \
     -f docker-compose.yml -f docker-compose.staging.yml \
     --profile migrate run --rm migrate
   ```

6. Build and start the app and staging reverse proxy:

   ```bash
   docker compose --env-file .env.staging \
     -f docker-compose.yml -f docker-compose.staging.yml up -d --build app caddy
   ```

7. Verify readiness:

   ```bash
   set -a
   . ./.env.staging
   set +a
   curl -fsS "$STAGING_APP_URL/api/health/ready"
   ```

8. Create or confirm a staging admin account. Record the login owner in the staging password manager entry.

## Accessibility Baseline

Run the committed helper against the staging URL:

```bash
STAGING_APP_URL=https://staging.tokoroa.org.nz npm run review:staging:a11y
```

The default path set is:

```text
/,/login,/register,/forgot-password,/faq,/contact
```

To include authenticated pages, first sign in to staging in the same browser profile used for testing, then run Lighthouse from that authenticated profile or use the GitHub workflow with an approved authenticated test setup. Minimum authenticated coverage for release sign-off:

```text
/dashboard,/bookings,/book,/profile,/admin/dashboard,/admin/bookings,/admin/roster,/admin/reports
```

For route-specific checks:

```bash
STAGING_APP_URL=https://staging.tokoroa.org.nz \
STAGING_A11Y_PATHS="/,/login,/dashboard,/admin/reports" \
npm run review:staging:a11y
```

Attach the generated HTML reports from `reports/lighthouse/staging/` to the review issue, PR, or release sign-off.

## Print Contrast Verification

Run print checks on staging after the Lighthouse baseline:

1. Sign in at `/login` with the staging admin account.
2. Open `/admin/roster/<YYYY-MM-DD>/print` for a populated roster date.
3. Open `/admin/reports` and select a representative date range with visible charts and tables.
4. Use browser print preview to inspect text, chart labels, table borders, and hidden navigation.
5. Save PDFs or screenshots and attach them next to the Lighthouse reports.

Record pass or fail notes with the staging URL, commit SHA, browser version, viewport, date, and tester.

## GitHub Actions Workflow

The manual workflow `.github/workflows/staging-accessibility.yml` runs the same helper and uploads the Lighthouse reports as an artifact. Configure these on the GitHub `staging` environment before running it:

| Name | Type | Required | Purpose |
| --- | --- | --- | --- |
| `STAGING_APP_URL` | Environment variable | Yes | Base URL for staging checks |
| `STAGING_A11Y_PATHS` | Environment variable | No | Comma-separated path override |

Use the workflow input `base_url` only for a temporary staging URL. Do not use a production origin.
