# Implementation Guide

This guide is the practical path for adapting AlpineClubBookingsNZ for another
club. Keep live provider credentials and real member data out of public forks,
CI, and local experiments.

## 1. Fork And Install

```bash
git clone https://github.com/<owner>/AlpineClubBookingsNZ.git
cd AlpineClubBookingsNZ
cp .env.example .env
cp config/club.example.json config/club.json
npm ci
npx prisma generate
npm run setup:check
```

Use Node.js 24 LTS and npm 11 or newer.

## 2. Configure Club Identity

Edit `config/club.json` first. This file controls:

- club name, short name, public URL, and support/contact emails
- sender display name and public social links
- bed or lodge capacity
- age tiers and integer-cent nightly rates

Keep all money values in cents. Keep booking dates as New Zealand date-only
lodge nights unless you intentionally rework the booking model.

The seeded starter pages (privacy policy, booking terms, FAQ) are fully generic
and token-driven — they carry no club-specific name or geography, filling in your
club and lodge automatically via `{{club-name}}` / `{{lodge-name}}` /
`{{lodge-capacity}}` (#1945). A guard test keeps club-specific names out of the
seeded content; edit the rendered pages under Admin > Site Contents after setup.

For a guided config pass, run:

```bash
npm run setup:wizard
```

The wizard writes `config/club.json` only. Keep provider keys, OAuth secrets,
SMTP credentials, and deployment secrets in environment variables or your
deployment secret store.

After the first administrator can sign in, the club name, short name, and
hut-leader label can also be overridden at runtime (without editing
`config/club.json`) from Admin > Appearance > Club Identity — cross-linked from
Admin > Setup > Initial Setup as "Club Identity". A blank field falls back to
the configured default, and the change reaches the public site and emails within
a few seconds.

Configure public website colours, fonts, and the logo from the admin
`/admin/site-style` wizard after the first administrator can sign in. The public
website shows a neutral setup holding page until that wizard is finished. The
logo is stored in the database as a validated image data URL, so it survives
container rebuilds without a writable upload volume.

Replace the remaining deployment branding files in `public/branding/`:

- `favicon.ico`
- `favicon.png`
- `og-image.png`
- `lodge.jpg`
- `ski-field.jpg`
- `snowboarder.jpg`
- `sunset.jpg`

The public `*.example.*` files are placeholders for forks and documentation.

The public seed provisions **only** the generic default site style — the three
brand **seed** colours of the #2181 3-seed model (an accent plus an optional
neutral character and support accent, from which the generator derives the full
light/dark palette). A deployment fork that wants its own brand palette carries
it in that fork's own `ClubTheme` database row and provisions it from its own
seed override; per standing directive D15, no fork's brand colours (or a
fork-specific seed path) live in this public repository. Setting a club's palette
in a fresh install is done through the Site Style admin wizard, which stores the
three seeds and marks setup complete.

## 3. Configure Local Environment

Set at least these values in `.env` before running a database-backed app:

- `DATABASE_URL`
- `DB_PASSWORD`
- `AUTH_SECRET`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `AUTH_TRUST_HOST`
- `CRON_SECRET`
- `SEED_ADMIN_EMAIL`
- `SEED_ADMIN_PASSWORD`
- `SEED_LODGE_PASSWORD`

External integrations can stay disabled or use test/demo credentials while you
bring up the core app.

After migrations and seed data run, admins activate or deactivate optional
modules at `/admin/modules`. Kiosk, chores, finance dashboard, waitlist, Xero,
bed allocation, Internet Banking payments, address autocomplete, lobby
display, two-factor authentication, email sign-in link (a passwordless magic
link, additive to password login), Google sign-in (profile-initiated Google
account linking, additive to password login; credentials entered in-app at
Admin → Integrations → Google sign-in), and Google Analytics (the measurement id
and the visitor consent settings are entered in-app at Admin → Integrations →
Google Analytics; #2573 removed `NEXT_PUBLIC_GA_MEASUREMENT_ID` from runtime, so
analytics stays off until they are saved) default off until an admin
enables them. General-purpose modules default on and can be disabled there.
Internet Banking payments also require operational Xero to be enabled,
configured, and connected because invoice issuing and settlement reconciliation
run through that integration.

Internet Banking payment policy is configured at `/admin/internet-banking`.
The default policy preserves the historical behavior: Internet Banking bookings
do not hold beds and there is no minimum lead time before check-in. Admins can
switch on bed-slot holding, set the hold duration, and set a minimum
date-only lead time. When holding is enabled, the payment cron releases unpaid
holds after expiry by cancelling the booking, marking the pending payment
failed, and queueing Xero invoice-clearing credit-note work.

Member-facing booking, payment-link, cancellation/refund appeal, and group
booking payment copy is configured at `/admin/booking-messages` under
Notifications & Email. These messages are plain text with audited changes and
support the documented merge fields; audited email templates stay in the Email
Messages editor.

## 4. Bring Up A Local Database

For a Docker-backed local/staging-style setup:

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml run --rm migrate
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml exec app npx tsx --conditions=react-server prisma/seed.ts
```

The Docker-only app listens on `http://localhost:3001` by default.

For a host-run development app, point `DATABASE_URL` at PostgreSQL and run:

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

For a disposable local showcase database, run `ALLOW_DEMO_SEED=1 npm run
db:seed:demo` only against a development database whose `Member` table is empty
or contains only `demo.alpineclub.test` emails. The demo seed refuses
`NODE_ENV=production`, non-local `DATABASE_URL` hosts, and non-demo member
data, then deletes demo plus transactional rows before rebuilding sample
members, bookings, payments, credits, requests, inductions, and public booking
requests. Demo users sign in with `demo1234` unless `DEMO_SEED_PASSWORD` is
set. It must not be used on deployment hosts or against shared, staging,
or production databases.

Do not start a development server in a shared, staging, or production checkout
unless you own that environment and intend to expose it.

After signing in with the seeded administrator, open `/admin/setup` to finish
the readiness checklist, run explicit provider tests, connect Xero, and review
booking, membership cancellation, rate, and mapping settings.

Admin Setup also exposes email and notification controls. Review the shared
email variables, editable templates, and admin/system delivery policies before
inviting members; cancellation, archive, and safe-delete lifecycle messages are
registered there and can be previewed before go-live. Keep transactional member
emails enabled unless your club has a replacement operational process.

For Xero-backed deployments, complete the operational Xero mappings before
using membership cancellation in production. In `/admin/xero`, set the
`membershipCancellationCredit` account/item mapping and configure the cancelled
member contact groups under `/admin/setup`. Cancellation approval only disables
the local member and queues Xero operations; archive and hard delete do not
remove Xero contacts.

Member cancellation is a member-initiated workflow from the profile page.
Login-capable adults included by another member must confirm their own
inclusion before admin review. Admins review confirmed participants under
`/admin/membership-cancellations`; approval cancels the local membership while
preserving booking, payment, Xero, and audit history.

Archive and hard delete are separate admin lifecycle policies on the member
detail page. Archive is for already-cancelled members and keeps the member row
for historical reporting while hiding it from default operational views. Archive
requests are reviewed under `/admin/membership-cancellations` alongside the
cancellation review queue and require a different admin for approval. Hard
delete is only for records added in error: it requires a clean dependency check,
a reason, second-admin approval, and a retained request snapshot before the row
is removed. If any meaningful history exists, use cancellation and archive
instead of hard delete.

## 5. Configure Providers In Test Mode

Use non-production accounts until your own deployment is ready:

- Stripe test mode for payments and webhooks.
- Xero demo tenants for operational and finance sync flows.
- Internet Banking payment trials only against a Xero demo tenant and
  non-production bank-reference process.
- SES sandbox or another non-production SMTP setup for email.
- A dedicated Sentry project if browser/server error reporting is enabled.

Webhook routes are:

- `/api/webhooks/stripe`
- `/api/webhooks/xero`
- `/api/webhooks/ses-sns`

## 6. Validate Before Sharing

Run the core gates before opening a PR or exposing an environment:

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npm test
npm run build
git diff --check
```

If you change framework behavior, read the relevant Next.js guide in
`node_modules/next/dist/docs/` first.

## 7. Prepare Deployment

Read `DEPLOYMENT.md` before production. At minimum, plan:

- DNS and TLS through Caddy or your equivalent reverse proxy.
- PostgreSQL backups and restore testing.
- GHCR image visibility or a host login with `read:packages`.
- Stripe, Xero, SES, and Sentry credentials owned by your organisation.
- A migration process that follows `BLUE_GREEN_MIGRATION_POLICY.md`.

For forks that publish GHCR images under different names, set repository
variables:

```text
GHCR_APP_IMAGE_REPOSITORY=ghcr.io/<owner>/<image-name>-app
GHCR_MIGRATE_IMAGE_REPOSITORY=ghcr.io/<owner>/<image-name>-migrate
```

The deployment wrapper also supports `GHCR_APP_IMAGE_REPOSITORY` and
`GHCR_MIGRATE_IMAGE_REPOSITORY` environment overrides on the host.

## 8. Keep A Clean Public/Private Split

Generic features, bug fixes, framework upgrades, and adopter documentation
belong in the public upstream. Deployment-specific branding, production
identifiers, service configuration, private data fixes, and real assets belong
in a private fork or deployment environment.
