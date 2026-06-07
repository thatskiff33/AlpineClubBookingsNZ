# Configuration

This reference covers the public configuration contract for AlpineClubBookingsNZ.
Start from `.env.example` and `config/club.example.json`, then replace values
for your club before running a shared or production deployment.

Do not commit `.env`, production credentials, payment/accounting tokens, or
database backups.

## Club Config

`src/config/club.ts` loads `config/club.json` first and falls back to
`config/club.example.json` when `club.json` is absent. For a new club, copy the
example and edit it:

```bash
cp config/club.example.json config/club.json
```

You can also run:

```bash
npm run setup:wizard
```

The wizard writes `config/club.json` only. It does not write `.env` files and
does not store API keys, OAuth secrets, SMTP secrets, or bearer tokens.

`config/club.json` is validated by `src/config/schema.ts`.

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Full public club name. |
| `shortName` | no | Short label used where space is limited. |
| `supportEmail` | yes | Main support address and default sender fallback. |
| `contactEmail` | no | Contact-form recipient; falls back to `supportEmail`. |
| `publicUrl` | yes | Canonical public origin with no trailing slash. |
| `emailFromName` | yes | Display name for outbound email sender headers. |
| `lodgeTravelNote` | no | Email reminder travel/location note. |
| `socialLinks.facebook` | no | Facebook URL used by public pages/footer. |
| `beds[].id` | yes | Stable bed or lodge identifier. |
| `beds[].name` | yes | User-facing bed/lodge name. |
| `beds[].capacity` | yes | Positive integer capacity. |
| `beds[].type` | yes | One of `dormitory`, `private`, or `shared`. |
| `ageTiers[].id` | yes | One of `INFANT`, `CHILD`, `YOUTH`, or `ADULT`. |
| `ageTiers[].label` | yes | User-facing age-tier label. |
| `ageTiers[].minAge` | yes | Minimum age, inclusive. |
| `ageTiers[].maxAge` | yes | Maximum age, inclusive, or `null` for no upper bound. |
| `ageTiers[].subscriptionRequiredForBooking` | yes | Whether the tier must hold a subscription to book as a member. |
| `ageTiers[].familyGroupRequestCreateMemberAllowed` | yes | Whether admins may create a non-login dependant from a pending family group request whose DOB maps to this tier. |
| `ageTiers[].nightlyRates.winter.memberCents` | yes | Winter member nightly rate in integer cents. |
| `ageTiers[].nightlyRates.winter.nonMemberCents` | yes | Winter non-member nightly rate in integer cents. |
| `ageTiers[].nightlyRates.summer.memberCents` | yes | Summer member nightly rate in integer cents. |
| `ageTiers[].nightlyRates.summer.nonMemberCents` | yes | Summer non-member nightly rate in integer cents. |

Keep all money values in integer cents.

## Branding Assets

Replace the default assets in `public/branding/`:

- `logo.png`
- `favicon.ico`
- `favicon.png`
- `og-image.png`
- `lodge.jpg`
- `ski-field.jpg`
- `snowboarder.jpg`
- `sunset.jpg`

The matching `*.example.*` files are placeholders for forks and public docs.

## Required Local Setup Variables

These are enough for a local database-backed app with external services left in
test/demo mode or disabled:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string used by Prisma. |
| `DB_PASSWORD` | PostgreSQL password used by Docker Compose. |
| `AUTH_SECRET` | Auth.js session secret. |
| `NEXTAUTH_SECRET` | Legacy Auth.js secret fallback; keep aligned with `AUTH_SECRET`. |
| `NEXTAUTH_URL` | Exact app origin, for example `http://localhost:3000`. |
| `AUTH_TRUST_HOST` | Set `true` behind trusted proxies/Compose. |
| `CRON_SECRET` | Shared secret for cron and deploy status endpoints. |
| `SEED_ADMIN_EMAIL` | Email for the first seeded admin account. |
| `SEED_ADMIN_PASSWORD` | Initial password for the first seeded admin account. |

`prisma/seed.ts` fails before seeding if either `SEED_ADMIN_*` value is unset.
The seeded admin is forced through `/change-password` on first login.

## Setup Readiness

Run this before bootstrapping a new install:

```bash
npm run setup:check
```

The check validates `config/club.json`, environment variable presence/format,
module capability flags, and first-install readiness. Database-backed checks,
including Admin Modules activation, are reported inside the admin setup wizard
after migrations and seed data run.

After signing in as an administrator, open `/admin/setup` to review:

- club config and module controls
- first admin and seeded database settings
- booking policies, membership cancellation settings, age tiers, seasons, and rates
- Stripe, SES/email, Sentry, operational Xero, and finance Xero readiness
- Xero account and item-code mappings

Provider tests on `/admin/setup` run only when an admin clicks the relevant test
button. They should use test/demo provider credentials until the environment is
ready for production.

## Membership Cancellation Settings

Membership cancellation setup is stored in database settings, not environment
variables. `/admin/setup` exposes:

- cancellation warning text shown by future member-facing request flows
- rejoin-process text for cancelled members
- operational Xero contact groups that represent cancelled members
- whether approved cancellation processing should archive the Xero contact

These settings are audited when saved. They do not call Xero on save; future
approval processing must keep Xero writes outside long database transactions.

## App Defaults

| Variable | Description |
| --- | --- |
| `CURRENCY`, `NEXT_PUBLIC_CURRENCY` | Currency display and server default. |
| `TZ`, `NEXT_PUBLIC_TZ` | Time zone; this app expects New Zealand date-only booking semantics unless a feature says otherwise. |
| `LOCALE`, `NEXT_PUBLIC_LOCALE` | Locale for formatting. |
| `LOG_LEVEL` | Pino log level such as `debug`, `info`, `warn`, `error`, or `fatal`. |
| `APP_RUNTIME_ROLE` | Runtime label used by health/status reporting, usually set by Compose. |
| `NODE_ENV` | Runtime mode set by Node/Next. |
| `NEXT_RUNTIME` | Runtime marker set by Next.js instrumentation. |
| `npm_package_version` | Package version exposed by npm scripts. |

## Module Capability Flags And Admin Modules

Optional modules use a layered control model:

- `.env` feature flags are deploy/operator capability gates. Only the literal
  string `true` makes a module available to this deployment; any other value
  disables that capability.
- Admin Modules activation is stored in the database and is the club-level
  activation layer.
- The effective module state is `.env capability enabled && Admin Modules
  activation enabled`.

Startup/deploy validation still requires the `.env` capability flags to be
explicit. Admin Modules do not store secrets and do not replace deployment-time
checks for Stripe, Xero, cron, or other operator-owned credentials.

| Variable | Description |
| --- | --- |
| `FEATURE_KIOSK` | Makes lodge kiosk routes/navigation available when Admin Modules activation also allows it. |
| `FEATURE_CHORES` | Makes chores and roster surfaces available when Admin Modules activation also allows them. |
| `FEATURE_FINANCE_DASHBOARD` | Makes finance dashboard routes/navigation and finance sync cron available when Admin Modules activation also allows them. |
| `FEATURE_WAITLIST` | Makes waitlist routes and waitlist cron available when Admin Modules activation also allows them. |
| `FEATURE_XERO_INTEGRATION` | Makes operational Xero routes/navigation and Xero cron available when Admin Modules activation also allows them. |
| `FEATURE_BED_ALLOCATION` | Makes upcoming room/bed setup and guest bed allocation controls available when Admin Modules activation also allows them. |
| `FEATURE_INTERNET_BANKING_PAYMENTS` | Makes the upcoming Internet Banking payment option available when Admin Modules activation also allows it. Operational Xero still needs its own capability, credentials, and tenant connection before invoices can be issued. |

Cron-backed optional modules check effective module state before doing module
work. If an Admin Modules setting is disabled while the `.env` capability is
still enabled, the cron runner records a clean skipped result rather than
running the module task. Missing module-setting rows default to enabled so
upgraded installs keep the previous env-only behavior after migrations. If the
settings table cannot be read, optional modules fail closed.

## Admin Module Activation

The Admin dashboard includes `/admin/modules` for club-level activation of the
optional modules covered by the feature flags above. These settings are stored
in the `ClubModuleSettings` database table as booleans only. They do not store
secrets, tokens, tenant ids, bank account details, or external provider
credentials.

The `.env` feature flags remain deploy/operator capability gates. A module is
ready only when its feature flag is `true` and its Admin Modules activation is
enabled. New installations seed the activation row with all module activations
enabled so existing deployments keep their current behaviour until an admin
changes the database-backed settings.

## Stripe

| Variable | Description |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe server key; use test mode outside production. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe browser publishable key. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret for `/api/webhooks/stripe`. |

## Operational Xero

| Variable | Description |
| --- | --- |
| `XERO_CLIENT_ID` | Operational Xero OAuth client id. |
| `XERO_CLIENT_SECRET` | Operational Xero OAuth client secret. |
| `XERO_REDIRECT_URI` | Must match the deployed `/api/admin/xero/callback` URL. |
| `XERO_ENCRYPTION_KEY` | 64-character hex key for encrypted token storage. |
| `XERO_WEBHOOK_KEY` | Xero webhook signing key. |
| `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH` | Enables daily membership refresh behavior when operational Xero is on. |
| `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS` | Enables live Xero member group lookups. |
| `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS` | Enables automatic Xero contact-group loading. |
| `XERO_INBOUND_FAILED_RETRY_BACKOFF_MS` | Optional retry backoff for failed inbound Xero reconciliation. |

## Finance Xero

| Variable | Description |
| --- | --- |
| `FINANCE_XERO_CLIENT_ID` | Finance-only Xero OAuth client id. |
| `FINANCE_XERO_CLIENT_SECRET` | Finance-only Xero OAuth client secret. |
| `FINANCE_XERO_REDIRECT_URI` | Must match the deployed `/api/finance/xero/callback` URL. |
| `FINANCE_XERO_ENCRYPTION_KEY` | 64-character hex key for finance token storage. |
| `FINANCE_XERO_ENCRYPTION_KEY_VERSION` | Active finance token key version. |
| `FINANCE_XERO_ENCRYPTION_KEY_PREVIOUS` | Previous finance token key during rotation. |
| `FINANCE_XERO_PREVIOUS_ENCRYPTION_KEY` | Backward-compatible alias for the previous finance key. |

## Email And SES

| Variable | Description |
| --- | --- |
| `SMTP_HOST` | SMTP host. |
| `SMTP_PORT` | SMTP port, usually `587`. |
| `AWS_SES_ACCESS_KEY_ID` | SES SMTP/API access key. |
| `AWS_SES_SECRET_ACCESS_KEY` | SES SMTP/API secret key. |
| `EMAIL_FROM` | Sender email address. |
| `EMAIL_FROM_NAME` | Optional sender display name override. |
| `SUPPORT_EMAIL` | Optional support email override. |
| `CONTACT_EMAIL` | Server-side contact-form recipient override. |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Public contact email displayed in client-rendered UI. |
| `SES_SNS_TOPIC_ARN` | Required SNS topic ARN for SES bounce/complaint webhooks. |
| `SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN` | Local/dev escape hatch only; never enable for deployed SES feedback ingestion. |

## Address Autocomplete

| Variable | Description |
| --- | --- |
| `ADDY_API_KEY` | Addy API key for server-side address search. |
| `ADDY_API_SECRET` | Addy API secret for server-side address search. |

## Sentry

| Variable | Description |
| --- | --- |
| `SENTRY_DSN` | Server/edge Sentry DSN. |
| `NEXT_PUBLIC_SENTRY_DSN` | Browser Sentry DSN. |
| `SENTRY_ORG` | Sentry organization slug for source map uploads. |
| `SENTRY_PROJECT` | Sentry project slug for source map uploads. |
| `SENTRY_AUTH_TOKEN` | Sentry auth token for source map uploads during build. |

## Cron, Waitlist, And Backups

| Variable | Description |
| --- | --- |
| `CRON_ENABLED` | Enables scheduled jobs in a runtime. Blue/green web slots set this `false`. |
| `WAITLIST_OFFER_HOURS` | Waitlist offer expiry window; defaults to 48 hours. |
| `WAITLIST_TRANSACTION_RETRY_ATTEMPTS` | Optional waitlist transaction retry count. |
| `WAITLIST_TRANSACTION_RETRY_DELAY_MS` | Optional waitlist transaction retry delay. |
| `BACKUP_ENABLED` | Enables scheduled PostgreSQL backup job. |
| `BACKUP_S3_BUCKET` | Optional S3 bucket for backup uploads. |
| `BACKUP_S3_REGION` | S3 region, default `ap-southeast-2`. |
| `BACKUP_S3_ACCESS_KEY_ID` | S3 access key for backup uploads. |
| `BACKUP_S3_SECRET_ACCESS_KEY` | S3 secret key for backup uploads. |
| `BACKUP_RETENTION_DAYS` | Local backup retention window in days. |
| `BACKUP_CRON_SCHEDULE` | Cron expression for backup schedule. |
| `BACKUP_RESTORE_VALIDATION_URL` | Optional disposable database URL for restore smoke validation. |
| `AUDIT_ARCHIVE_DATABASE_URL` | Preferred optional archive database for audit retention. |
| `AUDIT_LOG_ARCHIVE_DATABASE_URL` | Backward-compatible archive database alias. |
| `SHADOW_DATABASE_URL` | Optional Prisma shadow database URL for migration validation. |

## Legacy Finance Bridge

| Variable | Description |
| --- | --- |
| `LEGACY_DASHBOARD_EXPORT_TOKEN` | Shared bearer token for the legacy dashboard export bridge. Leave empty to disable the export bridge unless you still run it; do not store this token in the database or client-side code. |

## Deployment And Compose

| Variable | Description |
| --- | --- |
| `DOMAIN` | Public domain used by Caddy. |
| `COMPOSE_PROJECT_NAME` | Docker Compose project name; defaults vary by script. |
| `APP_IMAGE` | Prebuilt app image override for blue/green deployment. |
| `MIGRATE_IMAGE` | Prebuilt migration image override for blue/green deployment. |
| `GHCR_APP_IMAGE_REPOSITORY` | App image repository used by the production wrapper. |
| `GHCR_MIGRATE_IMAGE_REPOSITORY` | Migration image repository used by the production wrapper. |
| `GHCR_READ_TOKEN` | Example token name for logging a host into GHCR with `read:packages`. |
| `SOURCE_REPO` | Source checkout used by the production wrapper. |
| `DEPLOY_REF` | Git ref deployed by the production wrapper, default `origin/main`. |
| `FETCH_LATEST` | Whether the wrapper fetches before resolving `DEPLOY_REF`. |
| `DEPLOY_WORKSPACE_ROOT` | Parent directory for clean deploy workspaces. |
| `SYNC_SOURCE_REPO_AFTER_DEPLOY` | Whether the wrapper syncs the source checkout after deploy. |
| `PRUNE_STALE_DEPLOY_WORKSPACES` | Whether the wrapper removes stale deployment workspaces. |
| `PROJECT_DIR` | Low-level blue/green deploy project directory. |
| `HEALTH_TIMEOUT_SECONDS` | Readiness wait timeout for blue/green deploy. |
| `PRUNE_UNTIL` | Docker prune age window used by deploy scripts. |
| `FORCE_NO_CACHE` | Forces local Docker rebuilds without cache. |
| `SKIP_APP_IMAGE_BUILD` | Skips local app image build when using prebuilt images. |
| `BLUE_GREEN_DRAIN_SECONDS` | Drain window for previous blue/green slot. |
| `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` | Explicit migration safety override. |
| `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` | Required explanation when allowing a breaking migration. |
| `MIGRATION_SAFETY_LEDGER` | Path to the migration safety ledger. |

## Staging And Accessibility

| Variable | Description |
| --- | --- |
| `STAGING_HTTP_PORT` | Host port for the staging app. |
| `STAGING_POSTGRES_PORT` | Host port for the staging PostgreSQL service. |
| `STAGING_APP_URL` | Base URL for staging checks. |
| `STAGING_CADDY_SITE` | Caddy site address for local staging. |
| `STAGING_A11Y_PATHS` | Comma-separated paths for Lighthouse checks. |
| `STAGING_A11Y_OUT_DIR` | Output directory for Lighthouse reports. |
| `LIGHTHOUSE_BIN` | Optional Lighthouse command override. |
| `PRODUCTION_APP_URL` | Optional guard URL that staging checks refuse to target. |

## Public CI And Forks

Public forks should keep live provider credentials out of GitHub Actions. Use
Stripe test mode, Xero demo tenants, SES sandbox credentials, and non-production
databases for validation.
