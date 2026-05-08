# Staging And Accessibility Verification

This is the repo-visible non-production target for accessibility and other web verification. Use it whenever an audit, release review, or manual QA step says not to run browser checks against production.

## Target

Default local staging origin:

```text
http://localhost:3001
```

For shared staging, set `NEXTAUTH_URL` in `.env.staging` to the exact HTTPS origin users will open, for example:

```text
https://staging.tokoroa.org.nz
```

Record the actual origin used in the issue or PR that requested verification. Do not infer a staging host from production DNS guesses.

## Auth Path

- Sign-in path: `/login`
- Seeded admin account after `prisma/seed.ts`: `support@tokoroa.org.nz` / `admin123`
- Required post-seed action for shared staging: change that password before sharing the environment.

For role-specific checks, create or update test members through `Admin > Members` after signing in as the staging admin. Do not copy production user credentials into staging.

## Start Local Staging

From a clean checkout:

```bash
cp .env.staging.example .env.staging
```

Edit `.env.staging` and replace the placeholder secrets:

```bash
openssl rand -base64 48   # AUTH_SECRET and NEXTAUTH_SECRET
openssl rand -base64 24   # CRON_SECRET
openssl rand -base64 24   # DB_PASSWORD
```

Start the non-production app and database:

```bash
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  up -d --build postgres app
```

Apply migrations and seed test data:

```bash
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  run --rm migrate

docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  exec app npx tsx prisma/seed.ts
```

Verify the target:

```bash
curl -fsS http://localhost:3001/api/health
curl -fsS http://localhost:3001/api/health/ready
```

Stop it when finished:

```bash
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  down
```

Add `-v` to the final command only when you intentionally want to delete the staging database volume.

## Accessibility Run

Run checks against the staging origin, not production. The minimum release-review sweep is:

```bash
STAGING_BASE_URL=http://localhost:3001

npx --yes lighthouse "$STAGING_BASE_URL" --only-categories=accessibility --chrome-flags="--headless"
npx --yes lighthouse "$STAGING_BASE_URL/login" --only-categories=accessibility --chrome-flags="--headless"
```

For authenticated pages:

1. Sign in at `/login`.
2. Open each target page manually in the same browser profile.
3. Run Lighthouse or the browser accessibility tool against that staging URL.
4. Record the page URL, user role, tool, result, and any exception in the linked issue or PR.

Recommended route set for formal review:

- `/`
- `/login`
- `/book`
- `/dashboard`
- `/bookings`
- `/profile`
- `/admin/dashboard`
- `/admin/bookings`
- `/admin/members`
- `/lodge`
- `/finance`

Only include authenticated routes that the staging test account is allowed to access. If a page depends on Stripe, Xero, SES, or finance data that is not configured in staging, record the dependency and use seeded or demo data instead of production credentials.

## Shared Staging Notes

When promoting this target from local staging to a shared host:

1. Use a non-production domain and set `NEXTAUTH_URL` to that exact origin.
2. Use test-mode Stripe keys only.
3. Use Xero demo org credentials only when a test explicitly needs Xero.
4. Keep `CRON_ENABLED=false` unless the test explicitly needs scheduled jobs.
5. Keep `BACKUP_ENABLED=false` unless the test explicitly covers backup behavior.
6. Verify `/api/health` and `/api/health/ready` before starting browser checks.
7. Record the staging origin and auth path in the review issue before closing the finding.
