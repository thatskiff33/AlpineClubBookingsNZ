# Security Attack Surface Inventory

This inventory was generated from the current repository state on 2026-05-28
and the route-count and guard-gap notes were refreshed on 2026-06-21 during the
issue #812 route-boundary review follow-up. The API count is from:

```bash
rg --files 'src/app/api' -g 'route.ts' | wc -l
```

Current count: 281 `src/app/api/**/route.ts` files.

The issue text for #612 mentioned 216 files. That count is stale; the route tree
has grown since (booking review, group-booking, Internet Banking, and Xero
operational routes). This document treats the route tree as the source of truth.

## Boundary Summary

Authentication and authorization currently use these mechanisms:

| Mechanism | Current implementation | Main route families |
| --- | --- | --- |
| Auth.js session | `src/lib/auth.ts` exposes `auth()` backed by credentials login, JWT sessions, dynamic role refresh, email verification, and session invalidation on password change. | Member, admin, finance, lodge, booking, payment, profile routes. |
| Active-account guard | `requireActiveSessionUser()` in `src/lib/session-guards.ts` checks `Member.active` and `forcePasswordChange`. | Most session-authenticated routes. |
| Shared admin guard | `requireAdmin()` in `src/lib/session-guards.ts` combines Auth.js session, `role === "ADMIN"`, and active-account checks. | Some newer admin routes. |
| Hand-rolled admin checks | Many admin routes still call `auth()` and check role inline, then call `requireActiveSessionUser()`. | Older admin routes. This is the main #613 migration target. |
| Finance API guard | `requireFinanceViewerApiAccess()` and `requireFinanceManagerApiAccess()` in `src/lib/finance-api-auth.ts`. | `/api/finance/**`. |
| Lodge/kiosk guard | `checkLodgeAuth()` in `src/lib/lodge-auth.ts`, including active session and hut-leader PIN session support. | `/api/lodge/**` and lodge roster/guest routes. |
| Cron/deploy secret | Repeated `x-cron-secret` comparison against `CRON_SECRET`, usually with `timingSafeEqual`. | `/api/cron/**`, `/api/deploy/runtime-status`. |
| Provider signature | Stripe signed body, Xero HMAC, SES/SNS signature verification. | `/api/webhooks/**`. |
| Public exception | Explicit route metadata in `src/lib/api-route-security.ts`, backed by static route-boundary tests. | Anonymous health, contact, application, auth token, address autocomplete, committee, age-tier, and public token routes. |

Resolved (was a known guard gap): `src/app/api/admin/runtime-status/route.ts`
now uses the shared `requireAdmin()` guard, and `src/app/api/deploy/runtime-status/route.ts`
now uses the shared `requireCronSecret()` helper. Issue #613 (guard
standardisation and the explicit public-route allowlist) is closed.

## Route And Surface Inventory

`External calls` means direct provider/network interaction or provider-backed
side effects from the route or the service it invokes. Database access is listed
under `Data touched` instead.

| Route or surface | Auth mechanism | Actor | Data touched | External calls | Rate, signature, or boundary controls | Logging and audit | Residual risk or follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `src/proxy.ts` global proxy and module gates | No session auth. Applies CSP/security headers to page requests and selected API matcher paths; returns 404 for disabled module routes. | Anonymous and authenticated browser traffic. | Module settings via `loadEffectiveModuleFlags()`. | None. | CSP nonce, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, module route blocking. | No per-request audit. | API matcher is selective, not global for every API path. Keep route-level auth as the enforcement boundary. |
| `/api/health`, `/api/health/ready` | Public. | Load balancers, operators, anonymous callers. | DB reachability, runtime version/uptime, config readiness. Public responses omit provider error detail. | DB query only. | No rate limit. No secrets in response. | Logger debug/error only. | Anonymous callers can observe availability. #615 can decide whether to add light rate limiting or cache headers. |
| `/api/age-tier-settings`, `/api/committee` | Public read endpoints. | Anonymous website users. | Public age-tier/rate settings and active committee contact records. | None. | No rate limit. Committee query selects explicit public fields. | None beyond DB errors if thrown. | Public PII is intentional for committee contacts, but #615 should re-check whether phone/email exposure is acceptable for each club. |
| `/api/address-autocomplete/search`, `/api/address-autocomplete/details/[id]` | Public server-side proxy to Addy. | Anonymous website users. | Search terms, address suggestion ids, Addy result payloads. | Addy API via `src/lib/addy-api.ts`. | Zod query validation, `rateLimiters.addressAutocomplete` at 90/min/IP. Secrets stay server-side. | Minimal error responses, no audit. | Upstream-cost and enumeration surface remains public. #615 should review result bounds and failure logging. |
| `/api/contact` | Public contact form. | Anonymous website users. | Name, email, message, optional committee recipient key. | SMTP/SES through `sendEmail()`. | Zod validation, CRLF checks, HTML escaping, `rateLimiters.contact` at 10/hour/IP. | Email delivery logs through email layer; no audit log. | Spam and mailbox flooding are bounded but not CAPTCHA-backed. #615 should re-check current spam tolerance. |
| `/api/applications` | Public membership application submission. | Anonymous applicant. | Applicant PII, DOB, family member PII, nominator emails, application rows. | Email notifications through nomination/application service. | Zod validation, max family member count of 10, `rateLimiters.membershipApplication` at 3/hour/IP. | Logger on unexpected errors; application workflow records status in DB. | Public PII collection endpoint. #615 should review enumeration, attachment absence, response detail, and email storm controls. |
| `/api/auth/register` | Public but disabled. | Anonymous caller. | None. | None. | Always returns `410 Gone`; self-service registration replaced by applications. | None. | Low risk. Keep in explicit public allowlist so a future implementation cannot appear silently. |
| `/api/auth/[...nextauth]` | Public Auth.js credentials entrypoint. | Anonymous login attempts. | Member email, bcrypt password hash verification, session JWT, last login timestamp. | None. | `rateLimiters.login`, email verification gate, active-member gate, session invalidation after password changes, lodge extended session age. | Logger warns if last-login update fails. | Brute force is rate-limited in memory only. #615/#616 should revisit if deployment becomes multi-instance. |
| `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/verify-email`, `/api/auth/resend-verification`, `/api/auth/confirm-email-change` | Public token and account recovery routes. | Anonymous user with email or token link. | Password reset/action tokens, verification tokens, member email status, email-change records, password hashes. | Email send; Xero contact update may run after email-change confirmation. | Per-route rate limiters for forgot/reset/resend/verification token; token helpers hash/store tokens and enforce expiry. | Audit logs for password reset and email-change flows where implemented; logger for failures. | Token-bearing URLs and account enumeration behavior need periodic review. #615 covers validation, non-enumerating responses, and token/log redaction. |
| `/api/auth/change-password`, `/api/auth/request-email-change` | Authenticated active member. | Signed-in member. | Password hash, password-changed timestamp, email-change token rows, member email. | Email send for email-change verification. | Auth.js session plus `requireActiveSessionUser()`; change-password can allow forced password-change sessions; email-change request is rate-limited. | Audit log rows for security-sensitive changes; logger on errors. | Current pattern is hand-rolled member guard. #613 should consider a shared active-member API helper. |
| `/api/applications/nominate` | Authenticated active member plus nomination token. | Existing member acting as nominator. | Application nomination token/status and member id. | Email/application workflow side effects in nomination service. | Auth.js session, active-account guard, Zod token validation. | Logger on unexpected errors. | Token is body-provided and session-bound by service logic. #614 should include token ownership/regression coverage if not already covered. |
| `/api/availability`, `/api/availability/check`, `/api/booking-policies/check`, `/api/seasons`, `/api/promo-codes/available`, `/api/promo-codes/validate` | Authenticated active member. `POST /api/seasons` additionally checks admin role inline. | Signed-in member, admin for season creation. | Capacity, seasons/rates, booking policies, promo definitions, age-tier data. | None directly. | Active-session checks; availability and promo validation use `rateLimiters.bookingQuery`. Zod validation on policy, season, and promo inputs. | Logger on season errors. | These are not anonymous in current code despite being booking-discovery shaped. #613 should separate member-read helpers from admin-write helpers. |
| `/api/bookings`, `/api/bookings/quote`, `/api/bookings/drafts` | Authenticated active member. | Signed-in member creating, quoting, or reading draft bookings. | Booking, booking guest, capacity, cancellation, credit, promo, waitlist, payment-target data. | Email sends and Xero outbox queueing through booking services for some transitions. | Auth.js session, active-account guard, booking create/query rate limiters, Zod/date validation in services. | Logger and service-level audit/email side effects. | High-value business logic. #617 should review booking integrity and money/credit invariants. |
| `/api/bookings/[id]/**`, including cancel, modify, guests, payment confirmation, refund request, waitlist confirmation, notes, arrival time, and payment secret routes | Authenticated active member with route/service ownership checks. | Booking owner/member, sometimes admin through service rules. | Booking ownership, guest records, payment transactions, Stripe IDs/client secrets, cancellation/refund/change-request data, notes. | Stripe PaymentIntent/SetupIntent confirmation or retrieval, Xero invoice/credit-note outbox, email notifications. | Auth.js session, active-account guard, rate limits on cancel/change flows, service-level owner checks, Zod/date validation. | Audit logs for payment/guest/refund/change operations where implemented; logger on failures. | IDOR and money-state risk. #614 should include representative owner-boundary tests; #617 should review transaction invariants. |
| `/api/payments/options`, `/api/payments/charge-saved-method`, `/api/payments/create-payment-intent`, `/api/payments/create-setup-intent` | Authenticated active member. | Signed-in member discovering payment options, paying for booking, or saving payment method. | Payment method availability, payment, payment transaction, booking, Stripe customer/payment method/client secret references. | Stripe API for Stripe paths; Xero-backed Internet Banking availability is reported but settlement stays in Xero reconciliation. | Auth.js session, active-account guard, booking/payment service checks, module-state gates for Internet Banking. | Audit/logging around payment reconciliation and failure paths. | Client secret exposure is intentional to the owning member only. Internet Banking bookings must stay out of Stripe-only mutation paths; #617 should verify ownership checks and cents-only money handling. |
| `/api/profile`, `/api/notifications/preferences`, `/api/member/**` | Authenticated active member. | Signed-in member. | Member PII, address/phone/email preferences, audit log, credit balance, subscription status, onboarding, data export, deletion request, membership cancellation request/confirmation. | Email send, Xero contact/group update, export generation where invoked. | Auth.js session, active-account guard, rate limits for data export, deletion request, and cancellation request/confirmation. | Audit log for profile/security/deletion/cancellation operations; logger for Xero/email failures. | Member PII and lifecycle state. #614 should cover inactive/forced-password boundaries; #617 should review lifecycle integrity. |
| `/api/members/family/**` | Authenticated active member, usually family-group owner or adult login holder. | Signed-in member managing family relationships. | Family groups, invitations, child/adult join/removal requests, delegated non-login member details, inherited email, dependent records. | Email notifications and optional Xero contact/group sync. | Auth.js session, active-account guard, family request rate limiter, service-level ownership and adult/login-holder checks. | Audit log, logger, and email logs. | Family IDOR and shared-email risk. #614 should include a representative family-owned-resource boundary test. |
| `/api/issue-reports` | Authenticated active member. | Signed-in member reporting an issue. | Issue report text, screenshot metadata/storage path if captured, member id. | Email notification to admins. | Auth.js session, active-account guard, issue-report retention helpers. | Audit log and logger. | Not anonymous in current code. #615 should only treat it as public if the implementation changes. |
| `/api/chores/[token]` | Public opaque token. | Guest with chore link. | Guest chore assignment for one token/date. | None. | `rateLimiters.guestChoreToken`; token validation; `PUT` explicitly returns 405. | None. | Token URL can be logged or forwarded. Existing mitigation is rate limit and token expiry. Keep in public allowlist. |
| `/api/chores/roster/[date]/print` | Authenticated active member. | Member needing printable roster. | Roster/booking guest data for a date. | None. | Auth.js session, active-account guard, date validation via services. | None. | Data visibility should remain bounded to lodge/booking expectations. #618 can review lodge/roster exposure. |
| `/api/lodge/access`, `/api/lodge/pin-login`, `/api/lodge/guests/[date]/**`, `/api/lodge/roster/[date]/**` | Lodge guard or PIN login flow. `pin-login` starts a hut-leader PIN session behind an authenticated lodge/admin path. | Lodge account, admin, member with kiosk access, hut leader PIN session. | Lodge guest list, arrival/departure, roster chores, PIN session, audit records. | None. | `checkLodgeAuth()` for most routes, active-account guard, `rateLimiters.lodgePinLogin`, date scoping. | Audit log for arrival/departure and roster updates; logger for failures. | Shared lodge devices and PIN sessions have elevated operational risk. #618 should review kiosk session lifetime and device assumptions. |
| `/api/admin/setup/**`, `/api/admin/modules`, `/api/admin/health`, `/api/admin/runtime-status` | Admin session. `runtime-status` now uses the shared `requireAdmin()` guard. | Admin. | Setup progress, provider readiness, module settings, health detail, runtime status. | Provider test route can check Stripe/email/Xero config when admin triggers it; health checks DB/Xero/SMTP/Stripe readiness. | Admin role plus active-account guard via `requireAdmin()`. | Audit logs for setup/progress/module changes; logger for provider/health errors. | Resolved under #613 (closed): `admin/runtime-status` uses `requireAdmin()`. Provider-test/setup guard standardisation is the remaining hardening item. |
| `/api/admin/members/**`, including dependents, family, lifecycle, setup invites, password resets, import/export, credits, Xero link/push/unlink | Admin session. Mixed `requireAdmin()` and hand-rolled admin checks. | Admin. | Member PII, passwords/action tokens, family/dependent links, credits, lifecycle/archive/delete state, Xero contact links, import/export payloads. | Email sends, Xero contact/group sync, password setup/reset email. | Admin role plus active guard in most routes; import has rate limit; some credit/lifecycle routes import rate-limit helpers. | Extensive audit log for member, credit, lifecycle, and Xero actions; logger for failures. | Highest PII/IDOR blast radius. #613 should migrate to shared admin guard; #614 should guard missing admin checks; #617 should review lifecycle integrity. |
| `/api/admin/member-applications/**`, `/api/admin/membership-cancellation-requests/**`, `/api/admin/members/[id]/membership-cancellation`, `/api/admin/membership-cancellation-settings`, `/api/admin/deletion-requests/**` | Admin session. Mixed shared and hand-rolled admin guards. | Admin. | Applications, cancellation requests/participants/settings, deletion request state, member lifecycle action requests. | Email sends; cancellation approval can affect Xero contact groups/archive through services. | Admin role plus active guard; participant resend/approval routes import rate-limit helpers. | Audit log and logger. | Sensitive lifecycle and account deletion operations. #617 should review durable state transitions and external writes outside long transactions. |
| `/api/admin/bookings/**`, `/api/admin/booking-change-requests/**`, `/api/admin/booking-reviews`, `/api/admin/waitlist` | Admin session. Mixed shared and hand-rolled admin guards. | Admin. | Booking list/search/detail, operational payment/Xero/bed/change filters, review/force-confirm state, change requests, waitlist. | Email sends; Xero invoice/outbox; capacity/booking services. | Admin role plus active guard; route/service validation. | Audit logs for booking approvals/force-confirm/change-request decisions; logger. | Financial and reservation integrity surface. #613/#614 should standardize guard markers; #617 should review invariants. |
| `/api/admin/bed-allocation/**` | Admin session plus bed-allocation module capability. | Admin. | Lodge rooms, lodge beds, per-night guest allocations, allocation approvals, booking highlight/date-range filters. | None directly. | `requireBedAllocationAdmin()`, module-state gate, Zod/body validation through bed-allocation route helpers, service-level allocation uniqueness constraints. | Audit logs for room/bed/allocation/settings mutations and approval runs; logger on failures. | Reservation and shared-room integrity surface. Keep allocation writes synchronized with booking lifecycle and preserve per-guest date-only semantics. |
| `/api/admin/booking-policies/**`, `/api/admin/seasons/**`, `/api/admin/age-tier-settings`, `/api/admin/promo-codes/**` | Admin session. Mostly hand-rolled admin role plus active guard. | Admin. | Booking policy settings, seasons/rates, age-tier settings, promo codes, Xero item/account mappings for promos. | Xero mapping reads/writes where promo/account mappings are touched. | Admin role plus active guard; Zod validation in several routes. | Audit logs for policy/rate/promo changes. | Money values must remain integer cents. #617 should review pricing/promo abuse and concurrent updates. |
| `/api/admin/payments/**`, `/api/admin/refund-requests/**`, `/api/admin/credit-approvals` | Admin session, some routes use `requireAdmin()`. | Admin. | Payments, refund requests, member credits, booking/payment reconciliation state. | Stripe refunds/charges as needed, Xero invoice/credit-note work, email notifications. | Admin role plus active guard; service-level validation. | Audit log, logger, email logs. | High money-movement risk. #617 should review cents-only invariants, idempotency, and external call placement. |
| `/api/admin/communications/**`, `/api/admin/email-templates/**`, `/api/admin/email-settings`, `/api/admin/email-suppressions/**`, `/api/admin/email-failures/**`, `/api/admin/notification-delivery-policies`, `/api/admin/notifications` | Admin session. Mixed shared and hand-rolled admin guards. | Admin. | Email templates/settings, send history, suppressions, notification preferences, email failure review. | SES/SMTP email send. | Admin role plus active guard; communications send is rate-limited. | Audit logs for template/settings/suppression/notification changes; logger. | Admin-triggered bulk email and template injection risk. #616 should review SES/email boundaries and redaction. |
| `/api/admin/audit-log`, `/api/admin/reports`, `/api/admin/members/export`, `/api/admin/members/import` | Admin session. | Admin. | Audit log, reports, member import/export data, bookings/payments/report aggregates. | Import may email or sync side effects through services. | Admin role plus active guard; import has API rate limit; exports select broad PII. | Logger and audit rows for import/export where implemented. | Large data extraction surface. #613/#614 should guard missing admin markers; #617/#619 should review export handling and storage. |
| `/api/admin/lodge`, `/api/admin/chores/**`, `/api/admin/committee/**`, `/api/admin/hut-leaders/**`, `/api/admin/roster/**`, `/api/admin/issue-reports/**` | Admin session. | Admin. | Lodge config, chores, committee contacts, hut leader PIN/email data, roster, issue reports. | Email sends for hut-leader PIN/issue report workflows. | Admin role plus active guard, some `requireAdmin()` routes. | Audit log for committee/issue/lodge changes; logger for failures. | Public-facing committee and lodge operational data. #618 should review kiosk and roster assumptions. |
| `/api/admin/xero/**` | Admin session plus Xero OAuth state for connect/callback. | Admin. | Operational Xero tokens, contact groups, account/item mappings, contact links, sync operations, inbound events, duplicate/contact mismatch snapshots, Xero API usage. | Xero API and OAuth. | Admin role plus active guard; OAuth callback validates state cookie; module gates through proxy/module state for many Xero paths. | Audit log for mutating admin Xero actions, Xero operation logs, Xero inbound event records, logger. | Sensitive integration surface. #613 should standardize guards; #616 should review OAuth state, token encryption, retry/replay controls, and webhook reconciliation. |
| `/api/finance/bookings/metrics`, `/api/finance/sync/**`, `/api/finance/legacy-dashboard/**` | Finance viewer or manager guard depending on route. Legacy auth route redirects/204s for viewer access. | Finance viewer/manager; not lodge accounts. | Finance snapshots, booking metrics, and finance sync run state. | Manual finance sync can call Xero through the single operational Xero connection; dashboard reads use stored data. | `requireFinanceViewerApiAccess()` or `requireFinanceManagerApiAccess()`; active and force-password-change checks. | Logger for sync failures; sync status records. | Privileged but not always admin. #618 should review finance role assignment and legacy dashboard bridge; #614 should cover ordinary member/admin-without-finance denial. |
| `/api/cron`, `/api/cron/payments`, `/api/cron/xero`, `/api/cron/issue-reports` | Shared `x-cron-secret` header matching `CRON_SECRET`. | External scheduler or operator with cron secret. | Pending booking confirmation, payment recovery, Xero outbox/retry/inbound reconciliation, issue-report digest, cron run rows. | Stripe through payment recovery, Xero through operational sync, email alerts/digests. | Constant-time compare in each route, task allowlists, module-state gating for Xero tasks. | Logger; `CronJobRun` records for payment recovery; provider/service logs. | Secret helper is duplicated. #613 should centralize cron guard and #614 should test missing/wrong/different-length secrets. |
| `/api/deploy/runtime-status` | Shared `x-cron-secret` header matching `CRON_SECRET`. | Blue/green deploy script or operator with cron secret. | Runtime role and cron-enabled flag only. | None. | Shared `requireCronSecret()` helper (constant-time compare). | None. | Resolved under #613 (closed): now uses the shared cron/deploy guard helper rather than a duplicated local compare. |
| `/api/webhooks/stripe` | Stripe signature. No session auth by design. | Stripe. | Stripe event payload, payment intent/setup intent state through service. | Stripe webhook verification and downstream payment handling. | Requires `STRIPE_WEBHOOK_SECRET` and `stripe-signature`; bounded raw body read before signature verification. | Logger for signature/body-limit errors; service-level records. | Do not add session auth. Event idempotency is handled by `ProcessedWebhookEvent`; keep Stripe event coverage under payment-integrity review. |
| `/api/webhooks/xero` | Xero HMAC signature. No session auth by design. | Xero. | Xero inbound event records, webhook logs, reconciliation queue. | Xero reconciliation cycle after response. | Requires `XERO_WEBHOOK_KEY`, `x-xero-signature`, bounded body read, HMAC with `timingSafeEqual`, object payload, array `events`, and max-event cap; invalid signatures return 401. | `recordWebhookLog()`, Xero inbound event records, logger. | Do not add session auth. Replay/idempotency relies on Xero inbound correlation keys and async reconciliation. |
| `/api/webhooks/ses-sns` | AWS SNS signature verification. No session auth by design. | AWS SNS for SES feedback. | Processed webhook ids, email suppression/failure records, webhook logs. | SNS certificate verification, SES feedback ingestion. | Bounded JSON envelope validation, SNS signature verification, and `SES_SNS_TOPIC_ARN` allowlisting unless a non-production unsafe override is set. | `recordWebhookLog()`, logger; duplicate event ids are idempotent. | `SES_SNS_TOPIC_ARN` must stay configured for deployed environments; unsafe missing-topic override is local-only. |
| GitHub Actions, Dockerfile, Compose, deployment scripts | CI/deployment boundary, not app-session auth. | Maintainer, GitHub Actions, deploy operator. | Repository, package lock, Docker images, GHCR packages, environment variables, migrations. | npm, Docker, GHCR, Semgrep, gitleaks, Trivy, CodeQL if enabled by repo settings. | CI gates: audit, lint, tests, production build in CI only, Semgrep, gitleaks, Docker image security. Compose uses read-only app container, tmpfs cache, no-new-privileges, resource limits. | GitHub logs and deploy logs. | #619 should review workflow permissions, package publishing, secret scopes, image provenance, and deploy env contracts. |

## External Integration Review (#616)

This review covered the current Stripe, operational Xero, finance Xero,
SES/SNS, Sentry, OAuth state, webhook signature, token encryption, and provider
callback logging paths without live provider calls.

Concrete hardening added from the review:

- Stripe, Xero, and SES/SNS webhooks now enforce bounded request bodies before
  provider verification or JSON parsing. Oversized payloads return `413`, while
  malformed signed payloads still return `400`/`401` as appropriate.
- Xero webhook JSON now requires an object payload with an array `events` value
  and caps a single delivery to 100 events before processing any event rows.
- Operational and finance Xero OAuth callbacks still pass the exact registered
  callback URL to the Xero SDK, but logs now record only callback path and
  presence flags for `code`/`state`.
- Shared log/Sentry redaction now scrubs OAuth `code` and `state` query
  parameters, plus Sentry request URLs, query strings, breadcrumbs, exception
  values, and extra data.

Verified controls already present and intentionally preserved:

- Provider webhooks remain unauthenticated by session and rely on Stripe
  signature verification, Xero HMAC verification, and SNS signature plus topic
  allowlisting.
- Stripe and SES/SNS webhook handlers claim event ids before side effects and
  release the claim if downstream processing fails.
- Xero inbound events use correlation keys for replay/idempotency and keep
  reconciliation work outside the initial provider response path.
- Operational and finance Xero token stores encrypt access and refresh tokens
  at rest; finance token loading supports configured previous-key fallback for
  rotation.

Residual risks to keep visible:

- Webhook rate limiting remains provider-signature based rather than IP based.
- Xero webhook reconciliation still depends on stored tenant configuration and
  the async worker succeeding after the provider response.
- `SES_SNS_TOPIC_ARN` must stay configured outside local override scenarios.
- Full CI, production build, and deployed endpoint validation are intentionally
  left to GitHub Actions and approved deployment windows.

## Route Family Coverage

Every `src/app/api/**/route.ts` file is covered by one of these family rules.
The rules are intentionally broad enough to survive routine route additions but
specific enough for #614 to turn into static boundary tests.

### Public or Provider-Signed Exceptions

- `src/app/api/address-autocomplete/**/route.ts`
- `src/app/api/age-tier-settings/route.ts`
- `src/app/api/applications/route.ts`
- `src/app/api/auth/[...nextauth]/route.ts`
- `src/app/api/auth/confirm-email-change/route.ts`
- `src/app/api/auth/forgot-password/route.ts`
- `src/app/api/auth/register/route.ts`
- `src/app/api/auth/resend-verification/route.ts`
- `src/app/api/auth/reset-password/route.ts`
- `src/app/api/auth/verify-email/route.ts`
- `src/app/api/chores/[token]/route.ts`
- `src/app/api/committee/route.ts`
- `src/app/api/contact/route.ts`
- `src/app/api/health/route.ts`
- `src/app/api/health/ready/route.ts`
- `src/app/api/webhooks/**/route.ts`

### Authenticated Member Routes

- `src/app/api/applications/nominate/route.ts`
- `src/app/api/auth/change-password/route.ts`
- `src/app/api/auth/request-email-change/route.ts`
- `src/app/api/availability/**/route.ts`
- `src/app/api/booking-policies/check/route.ts`
- `src/app/api/bookings/**/route.ts`
- `src/app/api/chores/roster/[date]/print/route.ts`
- `src/app/api/issue-reports/route.ts`
- `src/app/api/member/**/route.ts`
- `src/app/api/members/family/**/route.ts`
- `src/app/api/notifications/preferences/route.ts`
- `src/app/api/payments/**/route.ts`
- `src/app/api/profile/route.ts`
- `src/app/api/promo-codes/**/route.ts`
- `src/app/api/seasons/route.ts`

### Lodge And Kiosk Routes

- `src/app/api/lodge/**/route.ts`

### Admin Routes

- `src/app/api/admin/**/route.ts`

Admin route subfamilies are:

- Setup/runtime/modules/health: `admin/setup/**`, `admin/modules`,
  `admin/health`, `admin/runtime-status`
- Members/lifecycle/family/dependents: `admin/members/**`,
  `admin/member-lifecycle-action-requests/**`
- Applications/cancellation/deletion: `admin/member-applications/**`,
  `admin/membership-cancellation-requests/**`,
  `admin/membership-cancellation-settings`,
  `admin/deletion-requests/**`
- Bookings/waitlist/reviews: `admin/bookings/**`, `admin/booking-reviews`,
  `admin/booking-change-requests/**`, `admin/waitlist`
- Bed allocation: `admin/bed-allocation/**`
- Policy/pricing/promo: `admin/booking-policies/**`, `admin/seasons/**`,
  `admin/age-tier-settings`, `admin/promo-codes/**`
- Payments/refunds/credits: `admin/payments/**`, `admin/refund-requests/**`,
  `admin/credit-approvals`
- Communications/email/notifications: `admin/communications/**`,
  `admin/email-*`, `admin/notification-delivery-policies`,
  `admin/notifications`
- Reporting/import/export/audit: `admin/audit-log`, `admin/reports`,
  `admin/members/import`, `admin/members/export`
- Lodge/chores/committee/hut leaders/roster/issues: `admin/lodge`,
  `admin/chores/**`, `admin/committee/**`, `admin/hut-leaders/**`,
  `admin/roster/**`, `admin/issue-reports/**`
- Operational Xero: `admin/xero/**`

### Finance Routes

- `src/app/api/finance/**/route.ts`

### Cron And Deploy Routes

- `src/app/api/cron/**/route.ts`
- `src/app/api/deploy/runtime-status/route.ts`

## Sensitive Data Inventory

| Data store or secret class | Where it appears | Current controls | Follow-up |
| --- | --- | --- | --- |
| Password hashes and session security fields | `Member.passwordHash`, `forcePasswordChange`, `passwordChangedAt`, Auth.js JWT callbacks. | bcrypt, email verification before session, session invalidation on password change. | #615 for account-recovery behavior; #617 for lifecycle interactions. |
| Action and verification tokens | Password reset, setup invite, verification, email change, nomination, chore, cancellation confirmation helpers. | Token helpers store hashes/expiry where implemented; some routes are session-bound in addition to token-bound. | #615 for token URL/log exposure and enumeration. |
| Member PII | Member/profile/family/admin/application routes. | Session/admin guards, audit logs on sensitive changes, scoped selects in public committee route. | #613/#614 for route boundaries; #617 for integrity and lifecycle review. |
| Booking and payment records | Booking, payment, refund, admin booking/payment routes. | Session guards, service-level ownership, Stripe server-side calls, payment transaction records. | #617 for money-state invariants, idempotency, and integer cents. |
| Stripe identifiers and client secrets | Payment routes and webhook/service layers. | Server-side Stripe secret, client secret returned only through authenticated payment routes. | #616/#617 for webhook idempotency and client-secret ownership. |
| Operational Xero tokens and object links | `admin/xero/**`, Xero token store, outbox/inbound reconciliation. | Admin guard, encrypted token store, OAuth state cookie, module gates. | #616 for OAuth/webhook/retry boundaries. |
| Finance Xero tokens and finance snapshots | `finance/xero/**`, finance sync routes and storage. | Finance manager/viewer guards, separate finance encryption key variables. | #618 for finance roles and legacy bridge; #616 for Xero integration controls. |
| Email/SNS data | Contact, application, admin communications, email templates, SES/SNS webhook. | Rate limits for public senders, template escaping, SNS signature verification, email suppression records. | #616 for SES/SNS topic allowlist and outbound email abuse. |
| Audit, webhook, cron, and provider logs | `AuditLog`, `WebhookLog`, `CronJobRun`, Xero operation/inbound records. | Structured logging with redaction helpers for known sensitive URL tokens; webhook logs redact error text. | #615/#616 for callback URL and token redaction review; compromised log reader threat below. |
| CI/deploy secrets | GitHub Actions secrets/vars, `.env`, Compose, GHCR tokens, Sentry token. | CI permission scoping, gitleaks, deployment docs warn not to commit secrets. | #619 for workflow permissions, provenance, and secret-scope review. |

## Threat Model By Actor

### Anonymous Internet User

Main reachable surfaces are public health, public read endpoints, auth/account
recovery, contact/application forms, address autocomplete, public chore tokens,
and provider webhooks. Abuse goals include credential stuffing, account
enumeration, spam, upstream-cost exhaustion, token guessing, and availability
probing. Current mitigations are route-specific rate limits, Zod validation,
non-secret public health responses, token expiry, and provider signatures.

Residual risk: rate limits are in-memory and single-instance. The supported
production topology routes public traffic through Caddy to one active web slot,
so this is acceptable for normal operation, but blue/green drain can temporarily
split counters between the retiring and replacement slots. Public exceptions are
now backed by route metadata and static tests, but #615 should still review the
concrete anonymous endpoint behavior.

### Authenticated Member

Members can manage profile, bookings, payments, family relationships, data
export/deletion/cancellation requests, notifications, and issue reports. Abuse
goals include IDOR against another member's booking/family records, manipulating
payment or refund state, bypassing subscription/age-tier policies, or causing
external provider side effects through profile/booking changes.

Current mitigations are active-session checks, service-level ownership checks,
rate limits on high-risk self-service operations, and audit logs for sensitive
mutations. #614 should add representative IDOR tests; #617 should review money,
booking, and lifecycle integrity.

### Admin

Admins can read and mutate the largest surface: member PII, bookings, payments,
refunds, lifecycle actions, communication templates, setup state, module
controls, operational Xero, reports, imports, exports, and audit logs. Abuse
goals include unauthorized bulk export, account takeover through password/setup
invites, financial manipulation, lifecycle deletion/cancellation abuse, email
template abuse, and Xero data corruption.

Current mitigations are role checks, active-session checks in most routes,
auditing on many sensitive mutations, and provider/service validation. Residual
risk is inconsistent guard shape: some routes use `requireAdmin()` and many
hand-roll the check. #613 should standardize guards and #614 should fail new
admin routes that lack an approved guard marker.

### Finance Manager Or Viewer

Finance actors can view metrics/snapshots and managers can run finance sync or
connect/disconnect finance Xero. Abuse goals include reading sensitive financial
data without club-wide admin rights, triggering expensive syncs, or connecting a
wrong Xero tenant.

Current mitigations are separate finance access levels, active-session checks,
force-password-change checks, finance Xero OAuth state cookies, and route-level
viewer/manager split. #614 should test denial for ordinary members/admins
without finance access; #618 should review finance role assignment and legacy
dashboard behavior.

### Lodge Account Or Hut-Leader PIN Session

Lodge users operate shared-kiosk workflows around guest lists, arrivals,
departures, and chores. Abuse goals include using a shared device after the
intended period, viewing dates outside scope, or modifying roster/arrival state
without an accountable member.

Current mitigations are `checkLodgeAuth()`, active-account checks, date scoping,
PIN rate limits, and audit logs for operational changes. #618 should review PIN
session lifetime, shared-device assumptions, and roster data exposure.

### Cron Caller

Anyone with `CRON_SECRET` can trigger pending booking confirmation, payment
recovery, Xero maintenance, issue-report jobs, and deploy runtime status.
Abuse goals include repeated provider calls, email storms, payment recovery
side effects, and timing operational work.

Current mitigations are `x-cron-secret` checks, mostly constant-time compare,
task allowlists, module-state gates, and cron run logging for payment recovery.
Residual risk is duplicated secret-check code. #613 should centralize it and
#614 should test wrong, missing, and different-length secrets.

### External Integration

Stripe, Xero, and SES/SNS can call webhook endpoints. Abuse goals include
forged events, replayed events, malformed payloads, and high-volume callbacks.
Current mitigations are provider signatures, idempotency records for SES/SNS
processed events, Xero inbound correlation keys, webhook logs, and downstream
service validation.

Do not add session auth to these webhooks. #616 should review body size,
idempotency, replay behavior, topic allowlists, token encryption, and callback
URL redaction.

### Compromised Log Reader

A log reader may see structured app logs, reverse-proxy paths, webhook errors,
cron failures, callback URLs, or admin action metadata. Abuse goals include
recovering action tokens, OAuth codes/states, client secrets, email addresses,
or provider identifiers from logs.

Current mitigations include `redact-sensitive-json` coverage for known token URL
patterns, URL-encoded callback paths, and redaction in webhook error recording.
Residual risk remains for new token patterns and provider payloads that do not
pass through the same redaction path. #616 should include explicit provider
payload log redaction checks.

### Compromised CI Secret Or Deployment Secret

CI and deployment secrets can publish images, access GHCR, upload Sentry source
maps, deploy with environment files, or call cron/deploy endpoints. Abuse goals
include image substitution, secret exfiltration, malicious dependency changes,
and production runtime manipulation.

Current mitigations are GitHub Actions permission scoping, dependency audit,
Semgrep, gitleaks, Trivy, protected PR flow, Compose hardening
(`read_only`, `no-new-privileges`, resource limits), and documentation that
keeps `.env` and provider credentials out of git. #619 should review workflow
permissions, image provenance, package visibility, and deploy secret rotation.

## Public Endpoint Abuse Review - 2026-05-28

Reviewed the explicit public and token-bearing surfaces from this inventory:
Auth.js login, account recovery and verification routes, membership
applications, contact, public committee/age-tier reads, Addy autocomplete,
health/readiness, guest chore tokens, nomination tokens, membership
cancellation confirmation tokens, and group-booking join token flows. Booking
discovery, promo validation, and issue reports are authenticated active-member
routes in the current implementation, so they are not anonymous public
endpoints.

Hardening applied in #615:

- Public JSON routes now return explicit 400s for malformed JSON instead of
  falling into generic server errors for contact, forgot-password, reset-password,
  and resend-verification payloads.
- Action-token consumers now reject non-64-character hex tokens before hashing
  or lookup on password reset, email verification, email-change confirmation,
  guest chore links, nomination confirmation, and membership-cancellation
  confirmation.
- Addy autocomplete keeps session validation explicit and caps returned search
  suggestions to the requested top 10. Malformed detail-session parameters fail
  locally before calling Addy.
- Public committee reads are capped to 50 active records.
- Log redaction covers token-bearing `/membership-cancellation/`, `/chores/`,
  `/nominations/`, `/pay/`, `/booking-requests/verify/`, and
  `/group-bookings/join/verify/` paths, including URL-encoded `callbackUrl`
  values from login redirects.
- The group-booking join-request mutation endpoint returns the same neutral
  success response for account-state and group-state lookup failures; the public
  group summary endpoint remains the intentional limited join-code lookup
  surface.

Accepted residual risk:

- In-memory rate limits remain single-instance only. The supported production
  shape has Caddy as the only public listener and one active web slot; blue/green
  drain can temporarily split counters, and any long-term multi-replica routing
  requires a shared rate-limit store.
- Membership application duplicate-account responses still reveal duplicate
  applicant/pending-application state. That is useful applicant feedback today,
  but should be revisited if public enumeration risk outweighs support value.
- Public health/readiness remain unauthenticated for load balancers and
  deployment checks; responses continue to expose only redacted status, version,
  uptime, and DB/config check state.

## Money, Booking, And Lifecycle Integrity Review - 2026-05-29

Reviewed current money, booking, and lifecycle state-machine paths for #617:
primary and modification PaymentIntent confirmation, saved-card charging,
payment recovery, direct refunds and refund webhooks, booking batch
modification settlement, waitlist force-confirm, cancellation, member
delete/archive lifecycle actions, membership cancellation approval, family
group changes, onboarding, and the Prisma models for bookings, payments,
refunds, recovery operations, and lifecycle requests.

Hardening applied in #617:

- Direct Stripe refund allocation now reconciles `PaymentTransaction`
  `refundedAmountCents` from the `PaymentRefund` ledger after recording or
  replaying the refund, and caps the local refunded total at the captured
  transaction amount. This keeps idempotent retries from double-counting a
  refund when a previous attempt already updated local transaction state but
  the caller retries the same Stripe refund.
- Stripe refund webhook sync and direct refunded-amount sync now use the same
  captured-amount cap before updating local transaction status.
- Bounded webhook body reads now fail closed on malformed `content-length`
  headers before provider verification or JSON parsing.
- Xero webhook events now require non-empty `eventType`, `eventCategory`, and
  `resourceId` values, and reject invalid `eventDateUtc` values before
  recording inbound rows. Empty `events` validation deliveries remain accepted.
- Operational Xero OAuth callbacks now require Xero to return an organisation
  tenant before encrypted access and refresh tokens are saved, matching the
  existing finance Xero fail-closed tenant behavior.
- Operational and finance Xero callback redirects now show only safe local
  error messages; provider callback exception details are logged through the
  shared redaction layer and are not reflected into browser redirect URLs.

Verified controls already present and intentionally preserved:

- Booking payment success claims capacity inside the shared payment
  reconciliation transaction, refunds after capacity failure outside that
  transaction, and queues external Xero work after local state is durable.
- Stripe webhooks use Stripe signature verification and
  `ProcessedWebhookEvent` idempotency without session auth.
- Xero webhook reconciliation records signed inbound events first and runs
  provider reconciliation after the response path.
- Booking modification refund and additional-payment work happens after the
  booking mutation transaction, with recovery rows for failed refunds and
  cleanup/recovery for superseded PaymentIntents.
- Payment recovery operations claim rows before processing, reset stale
  processing rows, alert on exhausted retries, and use ledger totals for
  superseded-payment refund recovery.
- Member hard delete and archive approvals use second-admin review, lifecycle
  advisory locks, eligibility re-checks, and local link cleanup before
  approval is recorded.
- Membership cancellation approval requires a confirmed participant, blocks
  future owned bookings or guest appearances, disables login locally in the
  database transaction, and queues Xero cancellation work after commit.

Residual risks to keep visible:

- Cron-driven payment recovery remains an operational dependency for failed
  post-transaction Stripe cleanup.
- Webhook freshness/replay controls remain provider-event-id and Xero
  correlation-key based; they do not enforce a separate local delivery timestamp
  window.
- Operational Xero still chooses the first tenant returned by Xero during
  connection; operators must select the intended club organisation at consent.
- Money and date invariants are enforced mostly in application/service logic;
  this pass did not add database check constraints.
- External-provider side effects remain best-effort after local state commits
  and rely on outbox/recovery monitoring rather than synchronous rollback.

## Lodge, Finance, And Legacy Privileged Interface Review - 2026-05-29

Reviewed the current #618 surfaces: lodge/kiosk page gates, lodge guest and
roster APIs, hut-leader PIN login/session cookies, finance page and API guards,
finance Xero connect/status/sync/disconnect routes, and the legacy finance
dashboard bridge.

Hardening applied in #618:

- Hut-leader PIN session cookies created by `/api/lodge/pin-login` are now
  bound to the authenticated lodge/admin account that entered the PIN. The
  binding is HMAC-derived from the auth secret rather than stored as a plaintext
  account id, and lodge API requests reject a copied PIN cookie when it is sent
  by a different authenticated account.
- Staying-guest lodge-list responses keep their read-only lodge list view but
  no longer include adult member phone numbers. Operational tiers
  (`admin`, `lodge`, and `hut-leader`) still receive adult contact numbers for
  arrival/departure coordination.
- Manual finance sync failures no longer reflect raw backend exception text into
  `/finance` redirect query strings. The route logs the detail and redirects
  with a generic failed-sync notice.
- Legacy dashboard export failures no longer return raw backend exception text
  to callers. The bridge still requires finance viewer API access plus a bearer
  token, keeps the bearer comparison constant-time, and stores no bearer token in
  the database.

Verified controls already present and intentionally preserved:

- Finance access remains separate from `ADMIN`: `NONE` cannot access finance
  pages/APIs, `VIEWER` can read reports and the legacy bridge auth/export
  surfaces, and `MANAGER` is required for finance Xero connection,
  disconnection, status, callback handling, and manual sync routes.
- `LODGE` sessions are rejected by finance API guards even if a member row has a
  finance access value.
- Lodge mutation routes continue to reject `staying-guest` access for arrivals,
  departures, and chore toggles; roster generation and confirmation remain
  limited to `admin` or `hut-leader` tiers.
- Kiosk, chores, finance, and Xero routes remain covered by effective module
  route gates in `src/config/feature-routes.ts` and `src/proxy.ts`.
- Leaving `LEGACY_DASHBOARD_EXPORT_TOKEN` unset disables the legacy export with
  a 503 response after finance viewer access succeeds.

Residual risks to keep visible:

- Lodge and admin shared-device sessions still depend on physical device
  control, sign-out habits, and the existing 12-hour hut-leader PIN session
  lifetime.
- Adult phone numbers remain available to operational lodge tiers because the
  current kiosk workflow uses them for same-day arrival/departure coordination.
- The legacy dashboard export remains a bearer-token bridge for compatibility;
  keep it disabled when the legacy dashboard is not actively used.

## CI, Dependency, Docker, And Deployment Hardening Review - 2026-05-29

Reviewed the current #619 supply-chain and deployment boundary: GitHub Actions
permissions, action and scanner versions, npm audit policy, Dependabot policy,
gitleaks/Semgrep/Trivy gates, Dockerfile runtime shape, Compose exposure, GHCR
image naming, and deployment environment contracts.

Hardening applied in #619:

- The Docker image security job no longer uses
  `aquasecurity/trivy-action@master`; both Trivy steps now use the explicit
  `v0.36.0` release tag.
- Semgrep now mounts the repository read-only and writes SARIF output to a
  dedicated `$RUNNER_TEMP` artifact mount.
- The pull-request gitleaks Docker scan now mounts the repository read-only.
- `docs/MAINTENANCE.md` now records the action pinning, scanner isolation,
  GHCR token, commit-SHA image tag, and Trivy severity policies.

Verified controls already present and intentionally preserved:

- Workflow default permissions are `contents: read`; only GHCR publishing on
  `main` gets `packages: write`.
- `verify` remains the only CI job that runs the full production build, and it
  uses fake/test provider values. Local Lightsail validation should stay
  lightweight unless explicitly approved.
- Semgrep uses a pinned `semgrep/semgrep:1.161.0` image, PR-diff gitleaks uses
  `ghcr.io/gitleaks/gitleaks:v8.28.0`, and the Dockerfile uses
  `node:24.15-alpine`.
- Dependabot checks npm, GitHub Actions, and Docker weekly, with Node runtime
  ignores keeping the app on Node 24 until the runtime policy changes.
- The final app container runs as `nextjs`, Compose uses read-only app
  filesystems, tmpfs cache/temp mounts, `no-new-privileges`, resource limits,
  and Caddy is the only public port exposure in the production stack.
- `.dockerignore` excludes `.env`, `.env.*`, `.git`, `node_modules`, `.next`,
  coverage, docs, and markdown from the Docker build context.
- GHCR app and migrate images are commit-SHA tagged, and production deployment
  resolves `origin/main` to select matching images.

Residual risks to keep visible:

- Most GitHub Actions remain pinned to released major tags rather than full
  commit SHAs so Dependabot and upstream patch releases can keep routine
  maintenance low-friction.
- HIGH Trivy findings remain warning-only; CRITICAL findings block. Promote
  HIGH to blocking later if the operational noise level is acceptable.
- The repo does not yet publish signed image attestations or SBOM artifacts.
  Current image provenance is protected PR checks plus commit-SHA GHCR tags.

## Follow-Up Mapping

- #613 - Standardize route guards: route metadata and shared active-session and
  cron/deploy helpers now exist; future batches should continue migrating
  hand-rolled admin checks to `requireAdmin()` or equivalent.
- #614 - Route boundary tests: static tests now walk `src/app/api/**/route.ts`
  and require approved guard markers or public allowlist entries; future batches
  should broaden IDOR behavior coverage for booking and family-owned resources.
- #615 - Anonymous public endpoints: first-pass hardening now covers token
  shape validation, malformed JSON behavior, Addy/committee response bounds, and
  token-path log redaction. Remaining public-form policy tradeoffs are noted in
  the accepted residual risk above.
- #616 - External integrations: review Stripe, operational Xero, finance Xero,
  SES/SNS, Sentry, OAuth state handling, webhook signature/idempotency, token
  encryption, and provider callback logging.
- #617 - Money, booking, and lifecycle integrity: review cents-only money
  handling, payment/refund idempotency, booking ownership/settlement,
  cancellation/deletion/archive state, Xero outbox sequencing, and transaction
  boundaries.
- #618 - Lodge, finance, and legacy privileged interfaces: review completed;
  account-bound PIN sessions, staying-guest contact redaction, generic finance
  failure redirects, and generic legacy bridge 500s are now documented above.
- #619 - CI, dependency, Docker, and deployment hardening: review completed;
  Trivy pinning, read-only scanner mounts, action/dependency policy, image tag
  provenance, GHCR scope, and Compose residual risks are documented above.
