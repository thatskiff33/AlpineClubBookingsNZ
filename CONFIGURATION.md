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

| Field                                              | Required | Description                                                                                                      |
| -------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`                                             | yes      | Full public club name.                                                                                           |
| `shortName`                                        | no       | Short label used where space is limited.                                                                         |
| `supportEmail`                                     | yes      | Main support address and default sender fallback.                                                                |
| `contactEmail`                                     | no       | Contact-form recipient; falls back to `supportEmail`.                                                            |
| `publicUrl`                                        | yes      | Canonical public origin with no trailing slash.                                                                  |
| `emailFromName`                                    | yes      | Display name for outbound email sender headers.                                                                  |
| `lodgeTravelNote`                                  | no       | Email reminder travel/location note.                                                                             |
| `socialLinks.facebook`                             | no       | Facebook URL used by public pages/footer.                                                                        |
| `beds[].id`                                        | yes      | Stable bed or lodge identifier.                                                                                  |
| `beds[].name`                                      | yes      | User-facing bed/lodge name.                                                                                      |
| `beds[].capacity`                                  | yes      | Positive integer fallback/import capacity.                                                                       |
| `beds[].type`                                      | yes      | One of `dormitory`, `private`, or `shared`.                                                                      |
| `ageTiers[].id`                                    | yes      | One of `INFANT`, `CHILD`, `YOUTH`, or `ADULT`.                                                                   |
| `ageTiers[].label`                                 | yes      | User-facing age-tier label.                                                                                      |
| `ageTiers[].minAge`                                | yes      | Minimum age, inclusive.                                                                                          |
| `ageTiers[].maxAge`                                | yes      | Maximum age, inclusive, or `null` for no upper bound.                                                            |
| `ageTiers[].subscriptionRequiredForBooking`        | yes      | Whether the tier must hold a subscription to book as a member.                                                   |
| `ageTiers[].familyGroupRequestCreateMemberAllowed` | yes      | Whether admins may create a non-login dependant from a pending family group request whose DOB maps to this tier. |
| `ageTiers[].nightlyRates.winter.memberCents`       | yes      | Winter member nightly rate in integer cents.                                                                     |
| `ageTiers[].nightlyRates.winter.nonMemberCents`    | yes      | Winter non-member nightly rate in integer cents.                                                                 |
| `ageTiers[].nightlyRates.summer.memberCents`       | yes      | Summer member nightly rate in integer cents.                                                                     |
| `ageTiers[].nightlyRates.summer.nonMemberCents`    | yes      | Summer non-member nightly rate in integer cents.                                                                 |

When the bed allocation module is effectively enabled and at least one active
bed exists in Admin -> Configuration -> Rooms & Beds, booking capacity is the
active bed count from that configurator. If the module is disabled, or the
module is enabled but no active beds exist yet, the system falls back to the
`beds[].capacity` total in `config/club.json`. Use the Rooms & Beds import
action to seed the configurator from `config/club.json` during transition.

Keep all money values in integer cents.

## Branding Assets

Public website colours, fonts, and the logo are managed by administrators at
`/admin/site-style`. Fresh deployments show a neutral setup holding page until
an admin finishes that wizard. The logo is stored in the database as a validated
image data URL; there is no runtime upload directory to preserve.

The remaining public image assets are still file-based. Replace the default
assets in `public/branding/`:

- `favicon.ico`
- `favicon.png`
- `og-image.png`
- `lodge.jpg`
- `ski-field.jpg`
- `snowboarder.jpg`
- `sunset.jpg`

The matching `*.example.*` files are placeholders for forks and public docs.

Existing Tokoroa deployments can preserve the former look during the transition
by running the seed with `SEED_TOKOROA_THEME_COMPLETE=1`. That path records the
current palette (`#ffcb05`, `#4d4d46`, `#2f2f2b`, `#6a6a63`, `#d9d5c2`,
`#f7f5ed`, `#ff7c12`), marks site style setup complete, and stores
`public/branding/logo.png` as the database logo when that file exists and is
900KB or smaller.

## Website Page Content

Public website pages are database-backed (`PageContent`) and edited in
Admin > Page Content. The website header menu is generated from each page's
menu title and menu order; pages with an empty menu title stay out of the
menu.

- Seeding creates starter pages (`home`, `about`, `join`, `join/apply`,
  `rules`, `contact`, `committee`, `privacy`, `terms`, `faq`) only when they
  do not already exist, so re-running the seed never overwrites edited
  content.
- The home route (`/`) renders the `home` page record. `/contact`, `/join`,
  and `/join/apply` are code-backed routes that render their matching record;
  all other records, including `/privacy`, `/terms`, and `/faq`, are served by
  the dynamic catch-all route.
- Admin-created pages can be hidden from the public site with the
  **Hide**/**Publish** toggle in Admin > Page Content (no permanent delete):
  hidden pages drop out of the menu and return a 404 on the catch-all route.
  System pages (`home`, `404`) and the built-in starter pages above cannot be
  hidden, because code routes, the footer, and the sitemap link to them.
- Slugs use lowercase letters, numbers, and hyphens, with optional forward
  slashes between segments (`trip-reports`, `trips/2026`). Application
  route names (`admin`, `api`, `book`, `dashboard`, `login`, and similar)
  are reserved and rejected in every segment position.
- Page HTML supports embed tokens that render interactive sections across
  PageContent-backed public routes, including code-backed starter routes.
  Supported tokens are `{{committee-members-cards}}`,
  `{{member-application-form}}`, `{{join-apply-form}}`, `{{contact-form}}`,
  `{{skifield-whakapapa}}`, `{{skifield-conditions:dataHash}}`,
  `{{photo-gallery}}`, `{{photo-gallery:path}}`, `{{photo-slideshow}}`, and
  `{{photo-slideshow:path}}`. Legal and help-copy pages can also use text
  tokens `{{club-name}}`, `{{currency}}`, and `{{lodge-capacity}}`, which are
  resolved server-side from the current club/runtime settings. The `dataHash`
  parameter is the Snow.nz widget hash. Photo token `path` parameters are
  normalised relative to
  `public/images/` and load images from that shared image-manager storage tree:
  a committed `public/images/` directory in a source checkout, or the mounted
  `public/images` volume in containerised deployments. Without a path, photo
  tokens use inline images already inserted in the page body. Photo tokens
  require double braces. Legacy single-brace syntax remains accepted only for
  non-photo tokens.
- Content and header HTML are sanitised on save and again on render. The
  allowlist lives in `src/lib/page-content-html.ts`.
- The editor's image picker can insert images from three sources:
  database-backed image-library uploads, deployed branding files under
  `public/branding/`, and filesystem/image-manager files under the shared
  `public/images` tree. The root picker view combines the latest database
  uploads, branding images, and root-level filesystem images; choosing another
  Images folder shows filesystem images from that folder only.
- The picker Upload button stores one image at a time in the database-backed
  image library. Those images are served publicly from `/api/images/[id]`; the
  picker can delete those database records, while branding files are managed by
  deployment/repository asset updates and filesystem images are managed through
  Admin > Image Manager.
- Database-backed image-library uploads accept PNG, JPEG, GIF, WebP, AVIF, and
  SVG files up to 2MB. The server validates the stored content type from the
  file bytes rather than trusting the browser-declared type or filename. SVG is
  allowed only through the `/api/images/[id]` serving route, which adds
  `Content-Security-Policy` and `X-Content-Type-Options: nosniff` response
  headers.
- Admin > Image Manager uploads filesystem images into the shared
  `public/images` tree/volume and serves them from `/api/images/uploaded/...`.
  Those uploads accept PNG, JPEG, GIF, WebP, and AVIF files up to 10MB. SVG is
  intentionally rejected there because filesystem uploads are served as static
  image assets without the database image route's restrictive CSP.

## Lodge Instructions

Lodge opening, closing, and day-to-day instructions for hut leaders are
database-backed (`LodgeInstruction`, one row per document) and edited in
Admin > Lodge Instructions. They are protected content, deliberately separate
from `PageContent`: they never appear in the public menu or the dynamic
public page route.

- Readers: admins, plus members with a current or upcoming hut leader
  assignment, at `/lodge-instructions` (printable). The lodge kiosk shows
  the documents to the signed-in hut leader tier.
- HTML is sanitised on save and again on render with the same allowlist as
  page content (`src/lib/page-content-html.ts`).
- The migration backfills the three empty documents, so deploy-only
  environments get editable rows without running the seed.

## Lodge Settings

Admin > Setup includes lodge-wide settings stored in the singleton
`LodgeSettings` row:

- Capacity override: optional. Leave blank to use the bed total from club
  configuration, unless the Bed Allocation module is enabled with active beds.
- Hut-leader lookahead: defaults to 14 days and controls how far ahead
  unassigned hut-leader dates are reported on the admin dashboard, stuck-state
  dashboard, the hut-leader assignment API, and the queue-driven Needs
  Attention sidebar item.

## Required Local Setup Variables

These are enough for a local database-backed app with external services left in
test/demo mode or disabled:

| Variable                | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection string used by Prisma.                     |
| `DB_PASSWORD`           | PostgreSQL password used by Docker Compose.                      |
| `AUTH_SECRET`           | Auth.js session secret.                                          |
| `NEXTAUTH_SECRET`       | Legacy Auth.js secret fallback; keep aligned with `AUTH_SECRET`. |
| `NEXTAUTH_URL`          | Exact app origin, for example `http://localhost:3000`.           |
| `AUTH_TRUST_HOST`       | Set `true` behind trusted proxies/Compose.                       |
| `CRON_SECRET`           | Shared secret for cron and deploy status endpoints.              |
| `SEED_ADMIN_EMAIL`      | Email for the first seeded admin account.                        |
| `SEED_ADMIN_PASSWORD`   | Initial password for the first seeded admin account.             |
| `SEED_ADMIN_FIRST_NAME` | Optional first name for the seeded admin; defaults to `Admin`.   |
| `SEED_ADMIN_LAST_NAME`  | Optional last name for the seeded admin; defaults to `User`.     |
| `SEED_LODGE_PASSWORD`   | Initial password for the seeded shared lodge kiosk account.      |
| `DEMO_SEED_PASSWORD`    | Optional local-only password for `npm run db:seed:demo` users.   |

`prisma/seed.ts` fails before seeding if `SEED_ADMIN_EMAIL` or
`SEED_ADMIN_PASSWORD` is unset, and fails before creating the lodge kiosk
account if `SEED_LODGE_PASSWORD` is unset. The seeded admin is created with
`role: ADMIN`, `canLogin: true`, `emailVerified: true`, and a `NOT_REQUIRED`
membership subscription for the current season, and is forced through
`/change-password` on first login. The seed also writes the normalized
`MemberAccessRole.ADMIN` row for the seeded admin and
`MemberAccessRole.LODGE` row for the seeded lodge kiosk account. Re-running
the seed repairs those missing normalized access-role rows without overwriting
the existing accounts. The seed only creates the admin when no `ADMIN` member
exists yet, so changing `SEED_ADMIN_*` later has no effect on an existing
database.

The whole seed is create-if-missing: re-running it against a populated
database never deletes, overwrites, or duplicates data. Committee entries and
chore templates are seeded as generic placeholders only when their tables are
empty; replace them through the admin screens after first login.

The seed also creates built-in seasonal membership types: Full, Associate,
Life, School, Non-Member, and Family. Associate is the built-in
Associate/Reserve-style type and can be renamed by the club. It backfills the
current membership season from current and historical role values (`USER`,
historical `MEMBER`, `ADMIN`, and `LODGE` to Full, historical `ASSOCIATE` and
legacy `RESERVE` to Associate, historical `LIFE` to Life, `SCHOOL` to School,
and `NON_MEMBER` to Non-Member) using create-if-missing assignments. Re-running
the seed does not overwrite existing seasonal assignments.

`npm run db:seed:demo` is separate from the first-run seed. It is intended only
for disposable local demo databases, refuses to run unless `DATABASE_URL`
points at `localhost`, `127.0.0.1`, or `::1`, and deletes demo plus
transactional rows before rebuilding a broad sample dataset. The demo seed uses
fake emails under `demo.alpineclub.test` and fake provider identifiers only.
Set `DEMO_SEED_PASSWORD` to override the default local demo password.

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
- Stripe, SES/email, Sentry, operational Xero, and finance-dashboard readiness
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

## Membership Type Settings

Seasonal membership type settings are database-backed and managed from
`/admin/membership-types`. Access roles, seasonal membership type, age tier,
Xero contact-group rules, and committee assignment are separate axes:

- `MemberAccessRole` is the normalized access source for login permissions:
  `USER`, `ADMIN`, `LODGE`, `FINANCE_USER`, `FINANCE_ADMIN`, and `ORG`.
  Runtime authorization must read these rows only. `session.user.role` is kept
  only for display and older serialized shapes.
  `Member.role` remains a compatibility/classification field with only
  `USER`, `ADMIN`, `LODGE`, `NON_MEMBER`, and `SCHOOL`; Associate, Life, and
  club-created categories live in `MembershipType`. `financeAccessLevel`
  remains synchronized for compatibility/export visibility, but does not grant
  runtime finance access.
- `MembershipType` stores admin-configurable seasonal categories and policy:
  Full, Associate (renameable, including Reserve naming), Life, School,
  Non-Member, Family, or club-created types. Each type carries booking behavior
  (`MEMBER_RATE`, `NON_MEMBER_RATE`, `BLOCK_BOOKING`), subscription behavior
  (`REQUIRED`, `NOT_REQUIRED`), allowed age tiers, and optional Xero
  contact-group rules.
- `AgeTierSetting` remains separate because a member can be Adult Full, Adult
  Life, Adult Associate, Child Family, Youth School, and so on. Age tiers still
  drive age-based rates and age-based default Xero grouping. Use Age Tier Xero
  groups for broad age cohorts such as Adult or Youth, use Membership Type Xero
  groups for status/policy groups such as Life or Associate, and use both when
  Xero needs both labels.
- `SeasonalMembershipAssignment` records one membership type per member per
  membership `seasonYear`, including the assignment source (`ADMIN`, `IMPORT`,
  `FAMILY_SUBSCRIPTION`, `ROLL_FORWARD`, or `SYSTEM`) and an optional
  date-only `applyFrom` changeover for mid-season moves between membership
  types.
- Admin member detail pages show access roles separately from seasonal
  membership type. The Admin > Members list also shows the current seasonal
  Membership Type beside Access. Changing the seasonal type requires a preview
  and admin reason; the preview counts future confirmed bookings, drafts,
  waitlist records, and subscription history before the save is audited.
  Existing future bookings are not automatically repriced by changing the type
  or `applyFrom` date. Production preview tokens require `AUTH_SECRET` or
  `NEXTAUTH_SECRET`; setup readiness blocks when neither secret is configured.
- `/admin/membership-types` includes an idempotent roll-forward tool that copies
  missing assignments from one season to another while leaving existing target
  assignments unchanged and flagging missing or inactive-type exceptions.
- Committee assignment remains public/contact metadata and does not grant app
  access.

## Committee Settings

Committee settings are database-backed and managed from `/admin/committee`.
`CommitteeRole` stores reusable master roles such as President, Secretary, or
Booking Officer, including the role email alias used for committee contact
delivery. `CommitteeAssignment` links a member to one of those roles and stores
presentation controls: blurb, sort order, published, show-phone, contactable,
and active/deactivated state. Multiple members can hold the same master role.

Committee assignment is separate from `Member.role` and
`SeasonalMembershipAssignment`; it never grants admin, lodge, booking, finance,
or subscription privileges. Member detail pages show committee assignments in
their own card alongside access role and seasonal membership type controls.

Public committee and contact-form recipient data is derived from published,
active `CommitteeAssignment` rows whose master role is also active. The public
API returns the linked member's display name, the role name, the assignment
blurb or role description, and an opaque assignment contact key only when the
assignment is contactable. Member email addresses are never returned to the
browser; `/api/contact` resolves contactable assignment keys server-side and
delivers to the role email alias configured on `CommitteeRole`, falling back to
the configured club contact address when no published, contactable assignment
matches or the role has no alias. Committee-routed contact emails use an opaque
committee-contact marker in EmailLog rows instead of persisting the recipient
address. Linked member email addresses are not used for committee contact
delivery. Phone numbers come from the linked member profile and display only
when the assignment's show-phone flag is enabled.

The legacy `CommitteeMember` table remains editable for historical/public
migration reference, but it no longer powers `/api/committee` or committee
recipient routing. Seed and migration steps create master roles and hidden
member-linked assignments where a legacy committee email exactly matches a
member email, but they do not delete or blank existing legacy rows. Assignment
changes and master role changes are audited with before/after metadata.

Booking and subscription enforcement is season-aware:

- `MEMBER_RATE` keeps normal member pricing for linked member guests.
- `NON_MEMBER_RATE` prices the member at non-member nightly rates while keeping
  the member identity on booking guests, audit records, and promo checks.
- `BLOCK_BOOKING` prevents the member from booking as owner or linked member
  guest and returns a structured policy error with safe member ids/names.
- `NOT_REQUIRED` makes subscription lockout display and booking gates effective
  `NOT_REQUIRED` for that season without deleting or hiding raw Xero invoice or
  subscription history.

`ADMIN` and `LODGE` operational subscription exemptions still come from
`roleNeverRequiresSubscription()`. Seasonal membership type changes do not
automatically reprice existing future bookings, rewrite
subscription/Xero/payment history, or call external providers.

## Member Import And Addresses

Admin member CSV import treats a member identity as the normalized email plus
normalized first and last name. Rows are skipped as duplicates when that same
identity already exists in the database or earlier in the same import, even
when dates of birth differ or one row has a blank date of birth. Date of birth
is not part of the duplicate key; a blank date of birth is unknown and cannot
prove a distinct identity. Different names may share an email address,
including rows with the same or blank date of birth.

Only one login-enabled member can use an email address. If an existing member
with `canLogin: true` already has the email, every new shared-email import is
created with `canLogin: false`. If the email first appears in the CSV, the first
allowed identity can log in and later same-email identities are imported as
non-login members. Setup invite emails and setup/password tokens are created
only for imported rows that can log in.

Address forms default "Postal same as physical" on for new or blank postal
addresses. Existing members keep it off only when a saved postal address has
material postal fields that differ from the physical address. Server routes
remain authoritative: when `postalSameAsPhysical` is submitted, physical address
fields are copied into postal fields before the member or application is saved.

## App Defaults

| Variable                           | Description                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CURRENCY`, `NEXT_PUBLIC_CURRENCY` | Currency display and server default.                                                                 |
| `TZ`, `NEXT_PUBLIC_TZ`             | Time zone; this app expects New Zealand date-only booking semantics unless a feature says otherwise. |
| `LOCALE`, `NEXT_PUBLIC_LOCALE`     | Locale for formatting.                                                                               |
| `LOG_LEVEL`                        | Pino log level such as `debug`, `info`, `warn`, `error`, or `fatal`.                                 |
| `APP_RUNTIME_ROLE`                 | Runtime label used by health/status reporting, usually set by Compose.                               |
| `NODE_ENV`                         | Runtime mode set by Node/Next.                                                                       |
| `NEXT_RUNTIME`                     | Runtime marker set by Next.js instrumentation.                                                       |
| `npm_package_version`              | Package version exposed by npm scripts.                                                              |

## Module Controls And Admin Modules

Optional modules are activated from Admin > Modules and stored in the
`ClubModuleSettings` database table. There are no module `FEATURE_*`
environment variables. Admin Modules do not store secrets, tokens, tenant ids,
bank account details, or provider credentials; Stripe, Xero, email, cron, and
other operator-owned credentials stay in environment variables and provider
setup screens.

The effective module state is the saved Admin Modules value. Missing module
settings use the hardened first-install defaults below. If the settings table
cannot be read, optional modules fail closed.

| Module | Default | Description |
| --- | --- | --- |
| Lodge kiosk | off | Guest arrival, departure, and lodge access screens. |
| Chores and roster | off | Roster generation, chore templates, and guest chore tracking. |
| Finance dashboard | off | Finance reports, sync diagnostics, and finance-only dashboards. |
| Waitlist | off | Waitlist booking state, admin queue, offer handling, and waitlist cron. |
| Xero integration | off | Operational Xero linking, sync actions, reconciliation tools, Xero cron, and Xero webhooks. |
| Bed allocation | off | Room and bed inventory, guest-to-bed allocation, auto-allocation, and allocation approvals. |
| Internet Banking payments | off | Member Internet Banking payment option backed by Xero invoices. Operational Xero still needs credentials and a tenant connection before invoices can be issued and reconciled. |
| Address autocomplete | off | Addy-powered suggestions on address fields. Manual address entry remains available whenever the module is off, credentials are missing, Addy fails, or rate limiting applies. |
| Group bookings | on | Group-booking organiser, join, and settlement surfaces. |
| Lockers | on | Physical locker records and member allocations. |
| Lodge induction | on | Lodge induction templates, self-assessment, and sign-off. |
| Work parties | on | Volunteer work-party events and the internal booking discounts they grant. |
| Promo codes | on | Promo-code administration and promo-aware booking flows. |
| Hut leaders | on | Hut-leader assignments, kiosk access, and auto-assignment. |
| Communications | on | Admin bulk email to members. Transactional notifications are unaffected. |
| Ski-field conditions | on | Live mountain/road status panel, public API routes, and admin cache controls. |

Cron-backed optional module schedules are still registered when
`CRON_ENABLED=true`; each run checks the effective module state before doing
module work. If an Admin Modules setting is disabled, the cron runner records a
clean skipped result rather than running the module task.

## Admin Module Activation

The Admin dashboard includes `/admin/modules` for club-level activation of the
optional modules above. These settings are stored in the `ClubModuleSettings`
database table as booleans only.

## Stripe

| Variable                             | Description                                               |
| ------------------------------------ | --------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                  | Stripe server key; use test mode outside production.      |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe browser publishable key.                           |
| `STRIPE_WEBHOOK_SECRET`              | Stripe webhook signing secret for `/api/webhooks/stripe`. |

## Operational Xero

| Variable                                   | Description                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `XERO_CLIENT_ID`                           | Operational Xero OAuth client id.                                      |
| `XERO_CLIENT_SECRET`                       | Operational Xero OAuth client secret.                                  |
| `XERO_REDIRECT_URI`                        | Must match the deployed `/api/admin/xero/callback` URL.                |
| `XERO_ENCRYPTION_KEY`                      | 64-character hex key for encrypted token storage.                      |
| `XERO_WEBHOOK_KEY`                         | Xero webhook signing key.                                              |
| `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`     | Enables daily membership refresh behavior when operational Xero is on. |
| `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS`    | Enables live Xero member group lookups.                                |
| `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS` | Enables automatic Xero contact-group loading.                          |
| `XERO_INBOUND_FAILED_RETRY_BACKOFF_MS`     | Optional retry backoff for failed inbound Xero reconciliation.         |

## Finance dashboard

The finance dashboard reads its revenue, cost, and balance figures from the
single operational Xero connection configured above. There are no separate
finance Xero credentials. The finance report sync requires these granular Xero
OAuth scopes:

- `accounting.reports.profitandloss.read`
- `accounting.reports.balancesheet.read`
- `accounting.reports.banksummary.read`

Before reconnecting, update the Xero developer app allowed scopes to include the
exact app request, and verify that `XERO_REDIRECT_URI` matches the deployed
`/api/admin/xero/callback` URL. Then reconnect Xero from `/admin/xero` so fresh
tokens carry the current scope set. Access is controlled per member by
`MemberAccessRole` rows. `FINANCE_USER` can read the finance dashboard and
finance viewer APIs; `FINANCE_ADMIN` can also run manager-only finance actions
such as manual sync and report mapping writes. `ADMIN` and `LODGE` do not grant
finance access by themselves, but mixed-role accounts such as `LODGE` plus
`FINANCE_USER` are valid. The legacy `financeAccessLevel` field is kept
synchronized for compatibility only; finance page and API guards ignore it and
read `MemberAccessRole` rows.

## Email Delivery

| Variable                                 | Description                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `USE_AWS_SES`                            | Boolean toggle (`true`/`false`) to use AWS SES SMTP credentials.                                                                                             |
| `USE_SMTP_RELAY`                         | Boolean toggle (`true`/`false`) to use an external SMTP relay. Exactly one provider flag should be `true` (legacy default is AWS SES when both are omitted). |
| `SMTP_HOST`                              | SMTP host for AWS SES SMTP mode (defaults to `email-smtp.ap-southeast-2.amazonaws.com` when unset).                                                          |
| `SMTP_PORT`                              | SMTP port for AWS SES SMTP mode (defaults to `587` when unset).                                                                                              |
| `AWS_SES_ACCESS_KEY_ID`                  | SES SMTP/API access key (required when `USE_AWS_SES=true`).                                                                                                  |
| `AWS_SES_SECRET_ACCESS_KEY`              | SES SMTP/API secret key (required when `USE_AWS_SES=true`).                                                                                                  |
| `EMAIL_SERVER_HOST`                      | SMTP relay host (required when `USE_SMTP_RELAY=true`).                                                                                                       |
| `EMAIL_SERVER_PORT`                      | SMTP relay port (required when `USE_SMTP_RELAY=true`).                                                                                                       |
| `EMAIL_SERVER_USER`                      | SMTP relay username (required when `USE_SMTP_RELAY=true`).                                                                                                   |
| `EMAIL_SERVER_PASSWORD`                  | SMTP relay password (required when `USE_SMTP_RELAY=true`).                                                                                                   |
| `EMAIL_FROM`                             | Sender email address.                                                                                                                                        |
| `EMAIL_FROM_NAME`                        | Optional sender display name override.                                                                                                                       |
| `SUPPORT_EMAIL`                          | Optional support email override.                                                                                                                             |
| `CONTACT_EMAIL`                          | Server-side contact-form recipient override.                                                                                                                 |
| `NEXT_PUBLIC_CONTACT_EMAIL`              | Public contact email displayed in client-rendered UI.                                                                                                        |
| `SES_SNS_TOPIC_ARN`                      | SNS topic ARN for SES bounce/complaint webhooks (required for full SES feedback handling when `USE_AWS_SES=true`).                                           |
| `SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN` | Local/dev escape hatch only; never enable for deployed SES feedback ingestion.                                                                               |
| `SES_SNS_ALLOW_SIGNATURE_V1`             | Temporarily permit legacy SNS SignatureVersion 1 (SHA1). Default rejects v1; enable SignatureVersion 2 on the SNS topic and leave this unset in production.   |

## Address Autocomplete

| Variable          | Description                                     |
| ----------------- | ----------------------------------------------- |
| `ADDY_API_KEY`    | Addy API key for server-side address search.    |
| `ADDY_API_SECRET` | Addy API secret for server-side address search. |

Address autocomplete is also controlled by Admin > Modules and defaults off.
The server-side `/api/address-autocomplete/**` proxy is unavailable while the
module is disabled, before any Addy call can run. If the module is enabled but
either Addy credential is missing, Admin Setup reports the module as blocked.
The credentials stay server-side and are never returned in setup/module JSON
payloads. Address fields remain normal editable inputs in every state, so users
can save a full manual address when autocomplete is disabled, unconfigured,
rate-limited, or temporarily unavailable.

## Sentry

| Variable                 | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| `SENTRY_DSN`             | Server/edge Sentry DSN.                                |
| `NEXT_PUBLIC_SENTRY_DSN` | Browser Sentry DSN.                                    |
| `SENTRY_ORG`             | Sentry organization slug for source map uploads.       |
| `SENTRY_PROJECT`         | Sentry project slug for source map uploads.            |
| `SENTRY_AUTH_TOKEN`      | Sentry auth token for source map uploads during build. |

## Cron, Waitlist, And Backups

| Variable                              | Description                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `CRON_ENABLED`                        | Enables scheduled jobs in a runtime. Blue/green web slots set this `false`. |
| `WAITLIST_OFFER_HOURS`                | Waitlist offer expiry window; defaults to 48 hours.                         |
| `WAITLIST_TRANSACTION_RETRY_ATTEMPTS` | Optional waitlist transaction retry count.                                  |
| `WAITLIST_TRANSACTION_RETRY_DELAY_MS` | Optional waitlist transaction retry delay.                                  |
| `BACKUP_ENABLED`                      | Enables scheduled PostgreSQL backup job.                                    |
| `BACKUP_S3_BUCKET`                    | Optional S3 bucket for backup uploads.                                      |
| `BACKUP_S3_REGION`                    | S3 region, default `ap-southeast-2`.                                        |
| `BACKUP_S3_ACCESS_KEY_ID`             | S3 access key for backup uploads.                                           |
| `BACKUP_S3_SECRET_ACCESS_KEY`         | S3 secret key for backup uploads.                                           |
| `BACKUP_RETENTION_DAYS`               | Local backup retention window in days.                                      |
| `BACKUP_CRON_SCHEDULE`                | Cron expression for backup schedule.                                        |
| `BACKUP_RESTORE_VALIDATION_URL`       | Optional disposable database URL for restore smoke validation.              |
| `AUDIT_ARCHIVE_DATABASE_URL`          | Preferred optional archive database for audit retention.                    |
| `AUDIT_LOG_ARCHIVE_DATABASE_URL`      | Backward-compatible archive database alias.                                 |
| `SHADOW_DATABASE_URL`                 | Optional Prisma shadow database URL for migration validation.               |

## Legacy Finance Bridge

| Variable                        | Description                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LEGACY_DASHBOARD_EXPORT_TOKEN` | Shared bearer token for the legacy dashboard export bridge. Leave empty to disable the export bridge unless you still run it; do not store this token in the database or client-side code. |

## Deployment And Compose

| Variable                               | Description                                                           |
| -------------------------------------- | --------------------------------------------------------------------- |
| `DOMAIN`                               | Public domain used by Caddy.                                          |
| `COMPOSE_PROJECT_NAME`                 | Docker Compose project name; defaults vary by script.                 |
| `APP_IMAGE`                            | Prebuilt app image override for blue/green deployment.                |
| `MIGRATE_IMAGE`                        | Prebuilt migration image override for blue/green deployment.          |
| `GHCR_APP_IMAGE_REPOSITORY`            | App image repository used by the production wrapper.                  |
| `GHCR_MIGRATE_IMAGE_REPOSITORY`        | Migration image repository used by the production wrapper.            |
| `GHCR_READ_TOKEN`                      | Example token name for logging a host into GHCR with `read:packages`. |
| `SOURCE_REPO`                          | Source checkout used by the production wrapper.                       |
| `DEPLOY_REF`                           | Git ref deployed by the production wrapper, default `origin/main`.    |
| `FETCH_LATEST`                         | Whether the wrapper fetches before resolving `DEPLOY_REF`.            |
| `DEPLOY_WORKSPACE_ROOT`                | Parent directory for clean deploy workspaces.                         |
| `SYNC_SOURCE_REPO_AFTER_DEPLOY`        | Whether the wrapper syncs the source checkout after deploy.           |
| `PRUNE_STALE_DEPLOY_WORKSPACES`        | Whether the wrapper removes stale deployment workspaces.              |
| `PROJECT_DIR`                          | Low-level blue/green deploy project directory.                        |
| `HEALTH_TIMEOUT_SECONDS`               | Readiness wait timeout for blue/green deploy.                         |
| `PRUNE_UNTIL`                          | Docker prune age window used by deploy scripts.                       |
| `FORCE_NO_CACHE`                       | Forces local Docker rebuilds without cache.                           |
| `SKIP_APP_IMAGE_BUILD`                 | Skips local app image build when using prebuilt images.               |
| `BLUE_GREEN_DRAIN_SECONDS`             | Drain window for previous blue/green slot.                            |
| `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` | Explicit migration safety override.                                   |
| `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` | Required explanation when allowing a breaking migration.              |
| `MIGRATION_SAFETY_LEDGER`              | Path to the migration safety ledger.                                  |

## Staging And Accessibility

| Variable                | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `STAGING_HTTP_PORT`     | Host port for the staging app.                           |
| `STAGING_POSTGRES_PORT` | Host port for the staging PostgreSQL service.            |
| `STAGING_APP_URL`       | Base URL for staging checks.                             |
| `STAGING_CADDY_SITE`    | Caddy site address for local staging.                    |
| `STAGING_A11Y_PATHS`    | Comma-separated paths for Lighthouse checks.             |
| `STAGING_A11Y_OUT_DIR`  | Output directory for Lighthouse reports.                 |
| `LIGHTHOUSE_BIN`        | Optional Lighthouse command override.                    |
| `PRODUCTION_APP_URL`    | Optional guard URL that staging checks refuse to target. |

## Public CI And Forks

Public forks should keep live provider credentials out of GitHub Actions. Use
Stripe test mode, Xero demo tenants, SES sandbox credentials, and non-production
databases for validation.
