# Security Attack Surface Inventory

This inventory was generated from the current repository state on 2026-05-28,
refreshed on 2026-06-21 during the issue #812 route-boundary review follow-up,
refreshed again on 2026-07-04 during the issue #1135 quality-wave security
review, extended on 2026-07-05 with the multi-lodge route families
(`admin/lodges/**`, `/api/lodges`, `admin/members/[id]/lodge-access`, and the
bulk room/bed and locker seed endpoints) added on
`feature/multi-lodge-support`, and extended again on 2026-07-15 (issue #157)
with the lobby-display surface families (`/display`, `/api/display/**`,
`/api/admin/display/**`, and the exclusive-hold admin route) added on
`feature/lobby-display-v2`. The API count is from:

```bash
rg --files 'src/app/api' -g 'route.ts' | wc -l
```

Current count: 371 `src/app/api/**/route.ts` files.

The issue text for #612 mentioned 216 files. That count is stale; the route tree
has grown since (booking review, group-booking, Internet Banking, and Xero
operational routes). This document treats the route tree as the source of truth.

**Status of the original hardening programme:** issues #612–#619 are all
CLOSED. The living sections of this document (Boundary Summary, Route And
Surface Inventory, Route Family Coverage) were updated on 2026-07-04 to match
the current state: every admin API method reaches the shared `requireAdmin()`
guard and every finance method calls its documented viewer/manager guard,
enforced per exported HTTP method by the suites listed under Route Family
Coverage (issue #1132), and all three webhook handlers carry full
Critical-matrix route tests (issue #1133). Where a dated historical review
section below still says "#61x should…", treat it as a record of the review
that produced those issues, not as open work.

## Boundary Summary

Authentication and authorization currently use these mechanisms:

| Mechanism | Current implementation | Main route families |
| --- | --- | --- |
| Auth.js session | `src/lib/auth.ts` exposes `auth()` backed by credentials login, JWT sessions, dynamic access-role refresh, email verification, and session invalidation on password change. | Member, admin, finance, lodge, booking, payment, profile routes. |
| Active-account guard | `requireActiveSessionUser()` in `src/lib/session-guards.ts` checks `Member.active` and `forcePasswordChange`. | Most session-authenticated routes. |
| Shared admin guard | `requireAdmin()` in `src/lib/session-guards.ts` combines Auth.js session, scoped access-role bundles (`getAdminRouteRequirement` area/level resolution), and active-account checks. | Every `/api/admin/**` route — each exported method must reach `requireAdmin()` (directly, via a local helper, or via an allowlisted shared wrapper), enforced per-method by `api-route-boundaries.test.ts` (#1132). The former hand-rolled inline admin checks (#613) are fully migrated. |
| Finance API guard | `requireFinanceViewerApiAccess()` and `requireFinanceManagerApiAccess()` in `src/lib/finance-api-auth.ts`. | `/api/finance/**`. |
| Lodge/kiosk guard | `checkLodgeAuth()` in `src/lib/lodge-auth.ts`, including active session and hut-leader PIN session support. | `/api/lodge/**` and lodge roster/guest routes. |
| Cron/deploy secret | Repeated `x-cron-secret` comparison against `CRON_SECRET`, usually with `timingSafeEqual`. | `/api/cron/**`, `/api/deploy/runtime-status`, `/api/deploy/warmup`. |
| Provider signature | Stripe signed body, Xero HMAC, SES/SNS signature verification. | `/api/webhooks/**`. |
| Public exception | Explicit route metadata in `src/lib/api-route-security.ts`, backed by static route-boundary tests. | Anonymous health, contact, application, auth token, address autocomplete, committee, age-tier, and public token routes. |

Resolved (was a known guard gap): `src/app/api/admin/runtime-status/route.ts`
now uses the shared `requireAdmin()` guard, and `src/app/api/deploy/runtime-status/route.ts`
now uses the shared `requireCronSecret()` helper. Issue #613 (guard
standardisation and the explicit public-route allowlist) is closed.

### Rate limiting degraded mode (issue #1142)

Rate-limit counters are shared through Postgres (`RateLimitCounter`). When
that store is unreachable, `src/lib/rate-limit.ts` falls back to per-process
in-memory counters rather than failing requests. Limiters marked
`authSensitive` (login, register, membership application, forgot/reset
password, lodge PIN login, two-factor verify, contact form) fall back at a
reduced budget — `limit / DEGRADED_AUTH_LIMIT_DIVISOR` (currently 4, floored
at 1) — so degrading the store cannot be used to multiply a brute-force or
form-abuse budget across replicas or process restarts. Fail-closed was
rejected because a limiter-store-local fault (table lock, migration drift)
must not become a full login outage while ordinary auth queries still work.
The policy is frozen by tests in `src/lib/__tests__/rate-limit.test.ts`,
including the exact set of limiters marked auth-sensitive.

## Route And Surface Inventory

`External calls` means direct provider/network interaction or provider-backed
side effects from the route or the service it invokes. Database access is listed
under `Data touched` instead.

The `Residual risk or follow-up` column predates the closure of hardening
issues #612–#619; `#61x should…` phrasing there records which review covered
the row, not open work. Open findings now live in labelled GitHub issues
(`quality-wave` for the 2026-07 wave).

| Route or surface | Auth mechanism | Actor | Data touched | External calls | Rate, signature, or boundary controls | Logging and audit | Residual risk or follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `src/proxy.ts` global proxy, pre-setup gate, and module gates | No session auth. Applies CSP/security headers to page requests and selected API matcher paths; returns 404 for disabled module routes; returns 503 + the "Site setup in progress" screen for every public-website path until `ClubTheme.completedAt` is set (#2420, "The Pre-Setup Gate" below). | Anonymous and authenticated browser traffic. | Module settings via `loadEffectiveModuleFlags()`; setup state, club name and contact address via `setup-gate.ts` (memoised 15s, read only while setup is incomplete). | None. | CSP nonce, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, module route blocking, pre-setup 503 gate (fails closed, `no-store`, `Retry-After`). | No per-request audit. | API matcher is selective, not global for every API path. Keep route-level auth as the enforcement boundary. The setup gate never covers `/api/*`, the admin area, or the login flows — an operator must be able to finish setup. Since #2404 the matcher RUNS on asset-shaped URLs (`/foo.png`, `/favicon.ico`, `/wp-content/uploads/x.jpg`), so those carry a policy and meet the gate like any other address; only `/api`, `/_next/static/` and `/_next/image` stay excluded. A miss under `_next/static` is terminated without a document by the `afterFiles` rewrites, whose own `default-src 'none'` is then the policy that ships; a miss under `/api` is answered as JSON by `api/[[...unmatched]]`, and no rewrite rule may touch `/api` at all (module-state parity — see "Static-Asset URLs And The Nonce-Only CSP"). #2404 also removed the prefetch exemption outright, so no request header — `Purpose: prefetch`, `Next-Router-Prefetch`, `RSC`, in any combination — takes a URL outside the proxy. The gate still declines to CLAIM asset-shaped paths (a 503 holding screen is a document), so a URL of that shape which reaches a render is ungated by design; the shared public chrome (`src/components/website/website-chrome.tsx`, composed by both public route groups) and the public metadata guard cover it. |
| `/api/health`, `/api/health/ready` | Public. | Load balancers, operators, anonymous callers. | DB reachability, runtime version/uptime, config readiness. Public responses omit provider error detail. | DB query only. | No rate limit. No secrets in response. | Logger debug/error only. | Anonymous callers can observe availability. #615 can decide whether to add light rate limiting or cache headers. |
| `/api/age-tier-settings`, `/api/committee` | Public read endpoints. | Anonymous website users. | Public age-tier/rate settings and published committee assignment presentation fields; and, **only when `PublicContentSettings.committeePhotoDisplay != NONE`**, per-published-member photo metadata (member id + `photoUpdatedAt` version) so the roster can build the scoped `/api/members/[id]/photo` URL. | None. | No rate limit. Committee query selects active, published assignment fields only; member email is not selected or returned, phone is returned only when show-phone is enabled, and contact keys are returned only for contactable assignments. Photo metadata (incl. member id) is emitted **only** when the club has opted the roster into photos — with `committeePhotoDisplay = NONE` (the default), no member id or photo pointer is returned. | None beyond DB errors if thrown. | Public committee names and optional phone numbers are intentional once an admin publishes the assignment; email remains server-only. Committee-photo bytes are served (and gated) by the scoped `/api/members/[id]/photo` endpoint, which applies the SAME `committeePhotoDisplay != NONE` condition to its anonymous branch (#2242) — so "Don't show photos" takes the bytes off the public internet, not just the roster metadata. |
| `/api/address-autocomplete/search`, `/api/address-autocomplete/details/[id]` | Public server-side proxy to Addy, gated by the `addressAutocomplete` Admin Module. | Anonymous website users. | Search terms, address suggestion ids, Addy result payloads. | Addy API via `src/lib/addy-api.ts`. | Module-route/proxy gate returns 404 while disabled, Zod query validation, `rateLimiters.addressAutocomplete` at 90/min/IP. Secrets stay server-side. | Minimal error responses, no audit. | Upstream-cost and enumeration surface remains public only when the module is enabled; manual address entry remains the fallback. |
| `/api/contact` | Public contact form. | Anonymous website users. | Name, email, message, optional published committee assignment recipient key. | SMTP/SES through `sendEmail()`. | Zod validation, CRLF checks, HTML escaping, `rateLimiters.contact` at 10/hour/IP. Committee recipient keys resolve server-side only when the assignment is active, published, contactable, and linked to an active member; delivery prefers the role email and falls back to linked member email server-side. | Email delivery logs through email layer; committee-routed messages store an opaque committee-contact marker instead of the private member recipient address; no audit log. | Spam and mailbox flooding are bounded but not CAPTCHA-backed. Invalid or non-contactable recipient keys safely fall back to the configured club contact address. |
| `/api/applications` | Public membership application submission. | Anonymous applicant. | Applicant PII, DOB, family member PII, nominator emails, application rows. | Email notifications through nomination/application service. | Zod validation, max family member count of 10, `rateLimiters.membershipApplication` at 3/hour/IP. | Logger on unexpected errors; application workflow records status in DB. | Public PII collection endpoint. #615 should review enumeration, attachment absence, response detail, and email storm controls. |
| `/api/auth/register` | Public but disabled. | Anonymous caller. | None. | None. | Always returns `410 Gone`; self-service registration replaced by applications. | None. | Low risk. Keep in explicit public allowlist so a future implementation cannot appear silently. |
| `/api/auth/[...nextauth]` | Public Auth.js credentials + Google-OAuth entrypoint. | Anonymous login attempts; Google OAuth round-trips (login, profile-initiated link, and the admin setup verify). | Member email, bcrypt password hash verification, session JWT, last login timestamp; Google `googleSub` linkage. | Google token exchange (client id/secret resolved DB-side, #2087). | `rateLimiters.login`, email verification gate, active-member gate, session invalidation after password changes, lodge extended session age. The NextAuth config is **request-scoped**: the Google provider is omitted unless credentials resolve, and the resolver **fails open** so a DB/decrypt failure can never break password/magic-link/2FA login. Google link + verify round-trips are disambiguated by short-lived HMAC-signed HttpOnly intent cookies (link binds the linking member; verify binds a Full Admin, namespaced `k:"verify"` so the two never cross), both bound to the current session before any write. | Logger warns if last-login update fails; loud log on a Google resolver failure. | Brute force is rate-limited in memory only. #615/#616 should revisit if deployment becomes multi-instance. |
| `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/verify-email`, `/api/auth/resend-verification`, `/api/auth/confirm-email-change` | Public token and account recovery routes. | Anonymous user with email or token link. | Password reset/action tokens, verification tokens, member email status, email-change records, password hashes. | Email send; Xero contact update may run after email-change confirmation. | Per-route rate limiters for forgot/reset/resend/verification token; token helpers hash/store tokens and enforce expiry. | Audit logs for password reset and email-change flows where implemented; logger for failures. | Token-bearing URLs and account enumeration behavior need periodic review. #615 covers validation, non-enumerating responses, and token/log redaction. |
| `/api/auth/change-password`, `/api/auth/request-email-change` | Authenticated active member. | Signed-in member. | Password hash, password-changed timestamp, email-change token rows, member email. | Email send for email-change verification. | Auth.js session plus `requireActiveSessionUser()`; change-password can allow forced password-change sessions; email-change request is rate-limited. | Audit log rows for security-sensitive changes; logger on errors. | Current pattern is hand-rolled member guard. #613 should consider a shared active-member API helper. |
| `/api/applications/nominate` | Authenticated active member plus nomination token. | Existing member acting as nominator. | Application nomination token/status and member id. | Email/application workflow side effects in nomination service. | Auth.js session, active-account guard, Zod token validation. | Logger on unexpected errors. | Token is body-provided and session-bound by service logic. #614 should include token ownership/regression coverage if not already covered. |
| `/api/availability`, `/api/availability/check`, `/api/booking-policies/check`, `/api/promo-codes/available`, `/api/promo-codes/validate` | Authenticated active member. | Signed-in member. | Capacity, booking policies, promo definitions, age-tier data. | None directly. | Active-session checks; availability and promo validation use `rateLimiters.bookingQuery`. Zod validation on policy and promo inputs. On the multi-lodge availability/pricing reads (`/api/availability`, `/api/availability/check`, `/api/bookings/quote`, `/api/bookings/rooms`) the resolved lodge is passed through `isMemberEligibleToBookLodge` (mirroring the booking create path) so a `BOOKING_RESTRICTION`ed member gets `403` instead of reading a forbidden lodge's availability/pricing; admin on-behalf quotes bypass it as the audited override. | Logger on errors. | These are not anonymous in current code despite being booking-discovery shaped. #613 should keep member-read helpers distinct as this family grows. (Season CRUD now lives solely under `/api/admin/seasons`; the duplicate member-open `/api/seasons` route was removed in #1252.) |
| `/api/bookings`, `/api/bookings/quote`, `/api/bookings/drafts` | Authenticated active member. | Signed-in member creating, quoting, or reading draft bookings. | Booking, booking guest, capacity, cancellation, credit, promo, waitlist, payment-target data. | Email sends and Xero outbox queueing through booking services for some transitions. | Auth.js session, active-account guard, booking create/query rate limiters, Zod/date validation in services. | Logger and service-level audit/email side effects. | High-value business logic. #617 should review booking integrity and money/credit invariants. |
| `/api/bookings/[id]/**`, including cancel, modify, guests, payment confirmation, refund request, waitlist confirmation, notes, and payment secret routes | Authenticated active member with route/service ownership checks. | Booking owner/member, sometimes admin through service rules. | Booking ownership, guest records, payment transactions, Stripe IDs/client secrets, cancellation/refund/change-request data, notes. | Stripe PaymentIntent/SetupIntent confirmation or retrieval, Xero invoice/credit-note outbox, email notifications. | Auth.js session, active-account guard, rate limits on cancel/change flows, service-level owner checks, Zod/date validation. | Audit logs for payment/guest/refund/change operations where implemented; logger on failures. | IDOR and money-state risk. #614 should include representative owner-boundary tests; #617 should review transaction invariants. |
| `/api/payments/options`, `/api/payments/charge-saved-method`, `/api/payments/create-payment-intent`, `/api/payments/create-setup-intent` | Authenticated active member. | Signed-in member discovering payment options, paying for booking, or saving payment method. | Payment method availability, payment, payment transaction, booking, Stripe customer/payment method/client secret references. | Stripe API for Stripe paths; Xero-backed Internet Banking availability is reported but settlement stays in Xero reconciliation. | Auth.js session, active-account guard, booking/payment service checks, module-state gates for Internet Banking. | Audit/logging around payment reconciliation and failure paths. | Client secret exposure is intentional to the owning member only. Internet Banking bookings must stay out of Stripe-only mutation paths; #617 should verify ownership checks and cents-only money handling. |
| `/api/profile`, `/api/notifications/preferences`, `/api/member/**` | Authenticated active member. | Signed-in member. | Member PII, address/phone/email preferences, audit log, credit balance, subscription status, onboarding, data export, deletion request, membership cancellation request/confirmation. | Email send, Xero contact/group update, export generation where invoked. | Auth.js session, active-account guard, rate limits for data export, deletion request, and cancellation request/confirmation. | Audit log for profile/security/deletion/cancellation operations; logger for Xero/email failures. | Member PII and lifecycle state. #614 should cover inactive/forced-password boundaries; #617 should review lifecycle integrity. |
| `/api/members/[id]/photo` GET (serve) | Data-layer authorisation, not a session-guard marker. Anonymous **iff** the target member is active, holds an active, published `CommitteeAssignment`, AND the club's `committeePhotoDisplay` is not `NONE`; every other request falls through to the SAME shared session guards this file's POST/DELETE use — `requireActiveSessionUser` for the owning member, `requireAdmin({ membership: view })` for an admin — so the serve path cannot skip the force-password-change or two-factor gates (#2242). | Anonymous website visitor (committee case), owning member, or membership admin. | One `MediaImage` blob (`kind = MEMBER_PHOTO`) plus the target member's photo pointer and committee-published status. Member photos never surface through the public `/api/images/[id]` content path (that route returns 404 for any non-`CONTENT` row — enforced, not just documented) or the content picker (`kind = CONTENT` filter). | None. | Documented mixed-method public GET in `api-route-security.ts` with an explicit `conditionalAuth` declaration (the boundary is mixed WITHIN the method), enforced both ways by `api-route-boundaries.test.ts` — a silent guard fails, and so does a declaration with no guard. Committee-public responses use `Cache-Control: public, max-age=300, must-revalidate` + an **opaque digest ETag** (never the raw `MediaImage` id; short window bounds cache-leak past un-publication); private responses use `private, no-store` + `Vary: Cookie`. `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, and a locked-down CSP on every response; content-type restricted to JPEG/PNG/WebP at upload (no SVG). | Non-mutating; no per-fetch audit. | Prefers 404 over 403 so a private photo's existence is never confirmed — a guard refusal is mapped onto that same 404, never surfaced as its own 401/403, so a real member id and a nonexistent one are indistinguishable to an unauthorised caller. Cache-leak window bounded to 300s if committee membership is revoked or roster photos are switched off. |
| `/api/members/[id]/photo` POST/DELETE (upload/remove) | Owning member via `requireActiveSessionUser` (self path), or a `membership:edit` admin via `requireAdmin` acting on behalf. A plain member may act only on their own id (no IDOR). | Signed-in member (self) or membership-edit admin. | Creates/deletes a `MediaImage` (`kind = MEMBER_PHOTO`) and sets `Member.photoImageId` + `photoUpdatedAt`/`photoUpdatedByMemberId` audit columns. Replace and remove read the current pointer under a `SELECT … FOR UPDATE` row lock and delete exactly that prior MEMBER_PHOTO blob (scoped `deleteMany` on `kind`) inside one transaction — concurrent replace/remove serialise, no orphans. | None. | Content-type sniffed from magic bytes (JPEG/PNG/WebP allowlist), 2MB byte cap (Content-Length pre-check + buffered recheck), and a 4096px dimension backstop (JPEG/PNG/GIF/WebP dimensions parsed, incl. the VP8X canvas, so an oversized decode-bomb is rejected). EXIF/XMP/comment metadata (camera GPS) is stripped from JPEG/PNG/WebP before storage, FAIL-CLOSED (an unconfirmable strip rejects the upload) — the one path that rejects rather than logs, because a member photo is personal data on a narrow purpose-built path. Client-side resize only — no server image library (metadata strip is byte-surgery, not a re-encode). Documented member mixed-methods, enforced by `api-route-boundaries.test.ts`. | `logAudit` `member_photo.upload` / `member_photo.remove` with actor/subject and on-behalf flag; DB audit columns stamped. | Self-upload is the consent (ADR-001 decision 4). Committee removal warning is a UI concern (MP3/MP5); no DB-level block. |
| `/api/members/family/**` | Authenticated active member, usually family-group owner or adult login holder. | Signed-in member managing family relationships. | Family groups, invitations, child/adult join/removal requests, delegated non-login member details, inherited email, dependent records. | Email notifications and optional Xero contact/group sync. | Auth.js session, active-account guard, family request rate limiter, service-level ownership and adult/login-holder checks. | Audit log, logger, and email logs. | Family IDOR and shared-email risk. #614 should include a representative family-owned-resource boundary test. |
| `/api/issue-reports` | Authenticated active member. | Signed-in member reporting an issue. | Issue report text, screenshot metadata/storage path if captured, member id. | Email notification to admins. | Auth.js session, active-account guard, issue-report retention helpers. | Audit log and logger. | Not anonymous in current code. #615 should only treat it as public if the implementation changes. |
| `/api/chores/[token]` | Public opaque token. | Guest with chore link. | Guest chore assignment for one token/date. | None. | `rateLimiters.guestChoreToken`; token validation; `PUT` explicitly returns 405. | None. | Token URL can be logged or forwarded. Existing mitigation is rate limit and token expiry. Keep in public allowlist. |
| `/api/chores/roster/[date]/print` | Authenticated active member holding the `ADMIN` access role (`hasAdminAccess`). | Admin needing printable roster data. | A headcount and the chore rows for one lodge on one date. Since #2631 the headcount is not a query of its own: it is the length of the shared roster selector's list (`getOperationalRosterGuestsForDate`), so it inherits that selector's exclusions — soft-deleted bookings, review-blocked bookings, and member guests whose consent is still pending — and counts the OPERATIONAL DAY (the night plus the following morning) rather than the night. No guest names, ids, or contact details leave this route except the names already printed on the chore rows. | None. | Auth.js session, active-account guard, two-step date-only validation (`isDateOnlyString` then `parseDateOnly`, so an out-of-range day is refused rather than rolled forward), and lodge scoping — `?lodgeId=` must name an active lodge (400 otherwise), omitted falls back to the club's default lodge, and both the assignment and booking queries carry that lodge (#2478). | None. | No page calls this feed today (the admin Print Roster button uses `/api/admin/roster/[date]`); it is kept correct for a future consumer. #618 can review lodge/roster exposure. |
| `/api/lodge/access`, `/api/lodge/pin-login`, `/api/lodge/guests/[date]/**`, `/api/lodge/roster/[date]/**` | Lodge guard or PIN login flow. `pin-login` starts a hut-leader PIN session behind an authenticated lodge/admin path. | Lodge account, admin, member with kiosk access, hut leader PIN session. | Lodge guest list, arrival/departure, roster chores, PIN session, audit records. | None. | `checkLodgeAuth()` for most routes, active-account guard, `rateLimiters.lodgePinLogin`, date scoping. The kiosk's lodge is resolved from its STAFF binding: exactly one grant binds, zero grants fall back to the default lodge, and a grant at **two or more lodges is ambiguous and denied** (`resolveKioskLodgeId` throws `AmbiguousKioskLodgeError`, which every kiosk data route maps to a clean `403` via `kioskLodgeAuthErrorResponse` rather than a 500; `pin-login` returns `403` directly) so a mis-selected double-grant cannot serve the default lodge's guest list/roster or accept its hut-leader PINs on the wrong property. | Audit log for arrival/departure and roster updates; logger for failures. | Shared lodge devices and PIN sessions have elevated operational risk. #618 should review kiosk session lifetime and device assumptions. |
| `/api/lodge-instructions` | Authenticated active member who is an admin or holds a current/upcoming hut-leader assignment (`canReadLodgeInstructions`). | Signed-in hut leader or admin. | Per-lodge operational documents (OPEN/CLOSE/DAY_TO_DAY), which may carry door codes and emergency access details. | None. | Active-session guard plus the reader gate. A requested `?lodgeId=` is constrained to the caller's own hut-leader assignment lodges (the assignment lodge set); an out-of-set lodge is `403`. Admins may request any lodge. Without this, the reader gate had no lodge dimension, so a lodge A hut leader could read lodge B's documents. | Logger on errors. | Reader-only surface; the admin editor lives under `/api/admin/lodge-instructions`. Assignment-scoped read keeps operational access details scoped to the lodge the leader actually runs. |
| `/display`, `/api/display/state`, `/api/display/heartbeat` | Unauthenticated public lobby-TV surface. A paired device carries a long-lived, hashed display token in an httpOnly cookie; `checkDisplayAuth()` (`src/lib/lodge-display-auth.ts`) resolves `tokenHash` → device → lodge and nothing else — it never maps to a `Member` and shares no code path with `checkLodgeAuth`, so a display token cannot inherit a kiosk capability. `lobbyDisplay` module-gated at the proxy (404 when off). | Anonymous lobby TV / paired display device; a full-admin session may also preview through the state route. | Privacy-reduced `DisplayState` from `buildDisplayState()` (`src/lib/lodge-display-state.ts`): names reduced to the configured granularity, minors never individually named, no money or member-id fields; an adult member phone appears only under the two-sided opt-in gate (`canServeMemberPhoneOnLodgeSurface`, both flags default off). | None. | `rateLimiters.api` (100/min/IP) on state and heartbeat; `buildDisplayState` is the single privacy-enforcement point (templates render as pure functions of its payload and cannot reach past it); window clamped server-side (default 3, max 7 days); revoked or inactive-lodge tokens are rejected without stamping `lastSeenAt`; every payload path sets `Cache-Control: no-store` (#176) so the privacy-reduced feed — which can include guest names and opted-in phone numbers — is never held in a shared/browser cache; scoped CSP on `/display` — `img-src 'self' data:`, `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN` (`src/lib/csp.ts`). | Only the device `lastSeenAt` stamp on a genuine device poll; no per-request audit. | Unattended public screen in a physical lobby. The display token is deliberately the weakest-privileged credential in the system (ADR-001); exposure is bounded to one lodge's already-privacy-reduced wall feed. |
| `/api/display/pair`, `/api/admin/display/devices/**` (including `[id]/pairing` bind and `[id]/revoke`) | Pairing `start`/`claim` are anonymous but bound to an HMAC-signed httpOnly pairing blob (`{code, exp}` signed with the auth secret); device create/list, code bind, and revoke require the shared `requireAdmin()` guard. | Anonymous display device (start/claim) and admin (create/bind/revoke). | `LodgeDisplayDevice` rows — name, lodge FK, `pairingCode`+expiry, and `tokenHash` (hash only; the raw token is returned once to the device and never re-read). | None. | `rateLimiters.displayPairing` (10/15min, auth-sensitive) on start and admin bind; `rateLimiters.displayClaim` (30/min) on the claim poll; a 6-character code from a 31-symbol unambiguous alphabet; the anonymous side persists nothing (start only signs a blob); claim must present the server-signed blob for that browser, so a shoulder-surfed code alone is useless; a matched claim issues the token, stores only its hash, and clears the pairing fields (single-use); revoke sets `revokedAt`, rejecting the token on its next request. | `LODGE_DISPLAY_DEVICE_REVOKED` audit on revoke; logger otherwise. | Shared-device physical control and the long-lived token are the standing operational trust assumptions (ADR-001); revocation is the containment lever. |
| `/api/admin/display/**` (`layouts/**`, `templates/**`, `lodge-config`, `devices/**`, `reference/conditions`) | Admin session via the shared `requireAdmin()` guard on every method. | Admin. | Authored `DisplayLayout`/`DisplayTemplate` HTML/CSS, slot content, footer HTML, CSS overrides, and device bindings. | None. | Threat is admin-authored HTML/CSS rendered on an unattended public wall. The shared save contract (`validateTemplateForSave`/`validateLayoutForSave`, `src/lib/lodge-display/authoring-validation.ts`) rejects structurally-broken content before it can persist; a serve-time allow-list sanitiser with CSS scoping and value-token escaping neutralises unsafe markup/CSS at render; because value-token resolution runs AFTER the sanitiser, a resolved token value that opens an authored `href`/`src` is additionally scheme-validated (#176) so a config value like `javascript:`/`data:` collapses to an inert `#` rather than surviving into a live URL; nonce-based CSP (`script-src 'self' 'nonce-…'`, no inline script); previews run in a `sandbox="allow-scripts"` opaque-origin iframe — never `allow-same-origin`, pinned by tests on both preview surfaces (the preview host and the Visual builder's Live preview, #2246). | `DISPLAY_TEMPLATE_CREATED`/`DISPLAY_LAYOUT_CREATED` and equivalent update audit entries; logger on failures. | Authored content is admin-trusted but rendered unattended, so the sanitiser plus nonce CSP are the standing mitigations. The ADR-003 `img-src https:` image-beacon exfiltration residual is now CLOSED on display routes: `/display` and `/admin/display/preview` reduce `img-src` to `'self' data:` (#161, `src/lib/csp.ts`). That tightened set and the `frame-src 'self'` set are separate exact-match allowlists (#2246): the Visual builder `/admin/display/builder` is in the `frame-src` set only, because it embeds the `/display` iframe but is itself a full admin page rather than a sandboxed display document. A scoped relaxation only applies on a hard document load, so the builder is entered by a plain `<a>`/`window.open(…, "_self")` and never by a soft `<Link>` — see "Per-Route CSP Relaxation And Soft Navigation" below for that rule, its guard test, and the accepted forward-leak residual. |
| `/api/admin/display/preview-grant`, `/api/admin/display/preview`, and the state route's `?previewGrant` path | The shared `requireAdmin()` guard mints the grant; the grant itself is an HMAC-signed, 5-minute, domain-separated, stateless capability. | Admin (mint); a sandboxed opaque-origin preview iframe (consume). | A signed payload naming exactly one template + lodge (plus an optional simulated date); on redemption, the same privacy-reduced preview state. | None. | A distinct HMAC domain-separation prefix (`lodge-display-preview-grant:`) means a pairing blob can never be replayed as a grant or vice versa; the expiry lives inside the signed payload (cannot be extended by tampering); a signed `windowStart` in the grant is authoritative — an unsigned `?previewDate` on the sandbox-rewritable iframe URL cannot shift the served window beyond it (#176); single-purpose — only the state route's preview path honours it, never the heartbeat or any admin route; it is not a display token and never stamps `lastSeenAt`; it renders through the same privacy serialiser; the permissive `Access-Control-Allow-Origin: *` is safe because the opaque-origin fetch sends no cookies and the body is already the public wall feed. | None beyond logger. | A leaked grant can at worst re-render a five-minute, privacy-reduced board for its named lodge/template. |
| `/api/admin/setup/**`, `/api/admin/modules`, `/api/admin/health`, `/api/admin/runtime-status` | Admin session. `runtime-status` now uses the shared `requireAdmin()` guard. | Admin. | Setup progress, provider readiness, module settings, health detail, runtime status. | Provider test route can check Stripe/email/Xero config when admin triggers it; health checks DB/Xero/SMTP/Stripe readiness. | Admin role plus active-account guard via `requireAdmin()`. | Audit logs for setup/progress/module changes; logger for provider/health errors. | Resolved under #613 (closed): `admin/runtime-status` uses `requireAdmin()`. Provider-test/setup guard standardisation is the remaining hardening item. |
| `/api/admin/members/**`, including dependents, family, lifecycle, setup invites, password resets, import/export, credits, Xero link/push/unlink | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Member PII, passwords/action tokens, family/dependent links, credits, lifecycle/archive/delete state, Xero contact links, import/export payloads. | Email sends, Xero contact/group sync, password setup/reset email. CSV setup invites are limited to imported rows that can log in. | Shared `requireAdmin()` guard on every method; import has rate limit; some credit/lifecycle routes import rate-limit helpers. Access-role writes are Full-Admin-only (#1012). Deactivating, de-logging, or archiving an account is guarded (#1604, extended #1622): the last active Full Admin can never be removed, and only a Full Admin may deactivate/de-login/archive a privileged-role account — enforced on member edit, bulk update, lifecycle archive, and dependent linking with `disableLogin` (`POST /api/admin/members/[id]/dependents/link`) via `src/lib/admin-account-guards.ts`. | Extensive audit log for member, credit, lifecycle, and Xero actions; logger for failures. | Highest PII/IDOR blast radius. #613 should migrate to shared admin guard; #614 should guard missing admin checks; #617 should review lifecycle integrity. |
| `/api/admin/family-groups/**` (list, `[id]`, `requests`, `member-search`, `partner-invites`), `/api/admin/family-suggestions/**` | Admin session via the shared `requireAdmin()` guard. The identity-confirmation surfaces name the requirement explicitly rather than inferring it from the request path: `GET /api/admin/family-groups/member-search` and `GET /api/admin/family-groups/[id]` both demand `membership:view` (#2568). | Membership admin (view to read, edit to act). | Family group membership, pending join/child/adult/removal requests, partner invitations, and — on the identity-sensitive surfaces only — each member's **calculated age** (#2568). | Email sends on request review; partner invitation tokens. | Area permission checked server-side against database-read roles on every request, so an admin whose role covers an unrelated area receives no identity information. Dates of birth are NOT in these payloads: the age is computed server-side and sent as a finished string, and no calculated age is stored. The routine group-list response carries neither. `GET /api/admin/family-groups/[id]` builds its body by WHITELIST rather than by spreading the Prisma row (#2568 review): the spread re-exported the raw `memberships` relation beside the sanitised member list, so every member's `passwordHash`, `passwordChangedAt` and `lastLoginAt` — and the `dateOfBirth` the age work added — reached the browser despite the mapping stripping all four. Only `hasPassword`, derived server-side, survives of the credential columns. | Audit log for group create / update / delete and request review; logger for failures. | The blast radius is member identity data rather than money. A regression to watch for is a new family-group payload re-introducing `dateOfBirth`, or age appearing on a routine or member-facing view — both are pinned by `src/lib/__tests__/member-identity-age-surfaces.test.ts`. |
| `/api/admin/member-applications/**`, `/api/admin/membership-cancellation-requests/**`, `/api/admin/members/[id]/membership-cancellation`, `/api/admin/membership-cancellation-settings`, `/api/admin/deletion-requests/**` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Applications, cancellation requests/participants/settings, deletion request state, member lifecycle action requests. | Email sends; cancellation approval can affect Xero contact groups/archive through services. | Admin role plus active guard; participant resend/approval routes import rate-limit helpers. Approving a membership cancellation or a deletion request applies the #1604 admin-account guards (extended by #1622): only a Full Admin may de-login/anonymise a privileged-role account, and the last active Full Admin cannot be removed. The family-group login-holder transfer (`POST /api/admin/family-groups/[id]/login-holder`) carries the same two guards, evaluating the last-admin end state on its post-write count so the incoming holder's login grant is included. | Audit log and logger. | Sensitive lifecycle and account deletion operations. #617 should review durable state transitions and external writes outside long transactions. |
| `/api/admin/bookings/**`, `/api/admin/booking-change-requests/**`, `/api/admin/booking-reviews`, `/api/admin/waitlist` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Booking list/search/detail, operational payment/Xero/bed/change filters, review/force-confirm state, change requests, waitlist. | Email sends; Xero invoice/outbox; capacity/booking services. | Admin role plus active guard; route/service validation. | Audit logs for booking approvals/force-confirm/change-request decisions; logger. | Financial and reservation integrity surface. #613/#614 should standardize guard markers; #617 should review invariants. |
| `/api/admin/bookings/[id]/exclusive-hold` | Admin session via the shared `requireAdmin()` guard (mirrors the sibling capacity-hold route). | Admin. | `Booking.wholeLodgeHold` plus its who/when audit fields; on set, the ids of overlapping capacity-holding bookings surfaced for officer resolution. **Also `BedAllocation` rows (#2285):** setting the hold DELETES every per-bed row this booking owns (manually placed and admin-approved rows included) and clearing it re-plans them through the auto-allocator, which can in turn move or unallocate OTHER bookings' provisional rows; each such displacement and each `#1750` partner promotion writes its own extra audit row. | None. | The flag write, the conflict read and the allocation reconcile all run inside the per-lodge capacity lock (`acquireLodgeCapacityLock`, #154) — the same key every admission takes — so setting a hold cannot race an in-flight admission and the flag can never commit apart from its allocation rows; the reconcile runs strictly after the compare-and-set write, so a lost claim (409) changes nothing. No capacity **admission** decision is made here and the availability engine (`checkCapacityForGuestRanges`) is never consulted (exclusive-booking ADR-001 decision 1) — the hold is never refused for want of space — but the bed-allocation planner IS run on the clear direction, so "no arithmetic at all" is not accurate: it is bed *placement*, not bed *admission*. Set and clear are idempotency-guarded (409 on a redundant set or clear); Zod body validation. | `booking.exclusiveHold.set`/`booking.exclusiveHold.cleared` audit entries (important severity) recording the overlapping conflict ids, the reconcile counts, and — on set — a capped list of the removed allocation rows so a mistaken hold can be undone by hand (#2285); plus `bed_allocation.provisional_displaced` and `BED_ALLOCATION_PARTNER_PROMOTED` rows from the reconcile itself. | Privacy property is member-facing indistinguishability (exclusive-booking ADR-001 decision 6): held nights present to members and the public exactly as a genuinely full lodge — same "no space" messaging, waitlist, and emails — and the exclusive nature is visible only on admin surfaces, never surfaced to members. |
| `/api/admin/bed-allocation/**` | Admin session plus bed-allocation module capability. | Admin. | Lodge rooms, lodge beds, per-night guest allocations, allocation approvals, booking highlight/date-range filters. | None directly. | The route-appropriate `requireBedAllocationRead()`, `requireBedAllocationWrite()`, `requireBedInventoryRead()`, or `requireBedInventoryWrite()` guard; module-state gate; Zod/body validation through bed-allocation route helpers; service-level allocation uniqueness constraints. | Audit logs for room/bed/allocation/settings mutations and approval runs; logger on failures. | Reservation and shared-room integrity surface. Keep allocation writes synchronized with booking lifecycle and preserve per-guest date-only semantics. |
| `/api/admin/booking-policies/**`, `/api/admin/seasons/**`, `/api/admin/age-tier-settings`, `/api/admin/promo-codes/**` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Booking policy settings, seasons/rates, age-tier settings, promo codes, Xero item/account mappings for promos. | Xero mapping reads/writes where promo/account mappings are touched. | Admin role plus active guard; Zod validation in several routes. | Audit logs for policy/rate/promo changes. | Money values must remain integer cents. #617 should review pricing/promo abuse and concurrent updates. |
| `/api/admin/payments/**`, `/api/admin/refund-requests/**`, `/api/admin/credit-approvals` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Payments, refund requests, member credits, booking/payment reconciliation state. | Stripe refunds/charges as needed, Xero invoice/credit-note work, email notifications. | Admin role plus active guard; service-level validation. | Audit log, logger, email logs. | High money-movement risk. #617 should review cents-only invariants, idempotency, and external call placement. |
| `/api/admin/communications/**`, `/api/admin/email-templates/**`, `/api/admin/email-settings`, `/api/admin/email-suppressions/**`, `/api/admin/email-failures/**`, `/api/admin/notification-delivery-policies`, `/api/admin/notifications` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Email templates/settings, send history, suppressions, notification preferences, email failure review. | SES/SMTP email send. | Admin role plus active guard; communications send is rate-limited. | Audit logs for template/settings/suppression/notification changes; logger. | Admin-triggered bulk email and template injection risk. #616 should review SES/email boundaries and redaction. |
| `/api/admin/audit-log`, `/api/admin/reports`, `/api/admin/members/export`, `/api/admin/members/import` | Admin session. | Admin. | Audit log, reports, member import/export data, bookings/payments/report aggregates. | Import may email login-enabled rows when invites are requested; non-login shared-email rows do not receive setup tokens. | Admin role plus active guard; import has API rate limit; exports select broad PII. | Logger and audit rows for import/export where implemented. | Large data extraction surface. #613/#614 should guard missing admin markers; #617/#619 should review export handling and storage. |
| `/api/admin/access-roles/**` | Admin session via the shared `requireAdmin()` guard (support area); create/update/delete additionally require Full Admin via an explicit `isFullAdmin` check inside the handlers, because an editable definition could otherwise widen itself past the area gate. | Full Admin for mutations; any admin with support view for the read/options list. | Access-role definitions: labels, descriptions, per-area permission matrices, holder counts. | None. | Zod validation; deletion returns 409 while any member holds the role (including bare enum rows) with a Restrict FK backstop; protected system roles have no definition rows and cannot be touched. | Critical-severity structured audit entries for create/update/delete with before/after definitions. | Permission definitions are security-critical configuration: an edit applies to every holder on their next request. Full-Admin-only management plus the separation-of-duties gate on assignments keeps scoped admins from widening access. |
| `/api/admin/lodge`, `/api/admin/chores/**`, `/api/admin/committee/**`, `/api/admin/hut-leaders/**`, `/api/admin/roster/**`, `/api/admin/issue-reports/**` | Admin session. | Admin. | Lodge config, chores, committee contacts, hut leader PIN/email data, roster, issue reports. | Email sends for hut-leader PIN/issue report workflows. | Shared `requireAdmin()` guard with active-account checks on every method. | Audit log for committee/issue/lodge changes; logger for failures. | Public-facing committee and lodge operational data. #618 should review kiosk and roster assumptions. |
| `/api/admin/xero/**` | Admin session plus Xero OAuth state for connect/callback. | Admin. | Operational Xero tokens, contact groups, account/item mappings, contact links, sync operations, inbound events, duplicate/contact mismatch snapshots, Xero API usage. | Xero API and OAuth. | Admin role plus active guard; OAuth callback validates state cookie; feature gates through proxy/module state for many Xero paths. | Audit log for mutating admin Xero actions, Xero operation logs, Xero inbound event records, logger. | Sensitive integration surface. #613 should standardize guards; #616 should review OAuth state, token encryption, retry/replay controls, and webhook reconciliation. |
| `/api/admin/lodges`, `/api/admin/lodges/[id]` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). The former `multiLodge` module flag was removed (ADR-005 / #128), so this surface is always-on and relies solely on `requireAdmin()` for authorisation; the data model is core (ADR-002), so the API is guarded on its own regardless. | Admin. | `Lodge` identity rows (name, slug, active, door code, travel note); the sole-active-lodge identity sync. | None. | Admin role plus active guard; Zod-validated strict schemas; deactivating the last active lodge is rejected with 409 (booking flows and the ADR-002 presentation rule assume one active lodge exists). | Structured audit logs for `LODGE_CREATED`/`LODGE_UPDATED`/`LODGE_ACTIVATED`/`LODGE_DEACTIVATED` with before/after identity. | Deactivation guards only the last-active-lodge case; it does not yet check future bookings, waitlist entries, hut-leader assignments, or kiosk STAFF bindings on the deactivated lodge (production-review §1.3). Kiosk/capacity resolvers do not read `Lodge.active`, so a kiosk bound to a deactivated lodge keeps operating. Door code and travel note are lodge-operational data behind the admin guard, not exposed on the member `/api/lodges` surface. |
| `/api/lodges` | Authenticated active member (Auth.js session plus `requireActiveSessionUser()`). Not admin-gated: it is the booking-flow lodge selector. | Signed-in member. | Active lodges the member is eligible to book — id, name, and travel note only. Door codes and operational settings are deliberately not selected. | None. | Active-session guard; per-lodge eligibility filter (`isMemberEligibleToBookLodge`) so a `BOOKING_RESTRICTION`ed member never sees lodges they cannot book; only `active` lodges returned. Response hides the selector client-side when one lodge is returned (ADR-002). | None beyond DB errors if thrown. | Public-ish member-read surface. Keep the select list to identity-only fields; door codes and per-lodge operational settings must stay out of this response. Eligibility is enforced server-side, not just hidden client-side. |
| `/api/admin/members/[id]/lodge-access` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | `MemberLodgeAccess` grant rows for one member: `BOOKING_RESTRICTION` rows (which lodges the member may book) and `STAFF` rows (kiosk-account lodge binding). | None. | Admin role plus active guard; Zod strict schema (max 50 lodge ids per kind); unknown lodge ids rejected 400; PUT replaces the member's rows for both kinds in one transaction. | Structured audit log `MEMBER_LODGE_ACCESS_UPDATED` recording previous and new lodge-id sets per kind. | **Authorization-granting surface.** Editing these rows changes what a member may book and which lodge a kiosk (STAFF) account binds to — it grants/removes access, so it must stay Full-admin-guarded and fully audited. A wrong STAFF grant re-homes a shared kiosk device to another lodge. No self-widening path exists (only admins reach it), but treat it as security-sensitive configuration like `access-roles`. |
| `/api/admin/bed-allocation/rooms/bulk`, `/api/admin/lockers/bulk` | Admin session. Rooms-bulk via `requireBedInventoryWrite()` (admin plus `bookings:edit` and the Bed Allocation module capability); lockers-bulk via the shared `requireAdmin()` guard. | Admin. | Bulk-created `LodgeRoom`/`LodgeBed` and `Locker` rows for a resolved active lodge. | None. | Admin/module guard; Zod strict schemas cap batch size (`MAX_BULK_ROOMS`, `MAX_BULK_BEDS_PER_ROOM`, `MAX_BULK_LOCKERS = 100`); target lodge validated active or 400; a clashing name prefix is rejected (409) before any rows are written; the whole batch is created in one transaction. | Structured audit logs `BED_ALLOCATION_ROOMS_BULK_CREATED` and `locker.bulk_created` with lodge id and counts. | Write-amplification surface: one admin call seeds many rows. Batch caps and transactional all-or-nothing creation bound the amplification; keep the caps in place and the clash pre-check ahead of the write. Name uniqueness is `[lodgeId, name]`; null-lodge rows still clash at every lodge until the contract release enforces NOT NULL. |
| `/api/finance/bookings/metrics`, `/api/finance/sync/**`, `/api/finance/legacy-dashboard/**` | Finance viewer or manager guard depending on route. Legacy auth route redirects/204s for viewer access. | Finance viewer/manager; not lodge accounts. | Finance snapshots, booking metrics, finance sync run state, operational Xero organisation/config status. | Operational Xero API through the finance sync service. | `requireFinanceViewerApiAccess()` or `requireFinanceManagerApiAccess()`; active and force-password-change checks; shared admin-managed Xero connection. | Logger for sync/Xero failures; sync status records. | Privileged but not always admin. #618 should review finance role assignment and legacy dashboard bridge; #614 should cover ordinary member/admin-without-finance denial. |
| `/api/cron`, `/api/cron/payments`, `/api/cron/xero`, `/api/cron/issue-reports` | Shared `x-cron-secret` header matching `CRON_SECRET`. | External scheduler or operator with cron secret. | Pending booking confirmation, payment recovery, Xero outbox/retry/inbound reconciliation, issue-report digest, cron run rows. | Stripe through payment recovery, Xero through operational sync, email alerts/digests. | Constant-time compare in each route, task allowlists, module-state gating for Xero tasks. | Logger; `CronJobRun` records for payment recovery; provider/service logs. | Cron guard is centralised in `requireCronSecret()` and covered by missing/wrong/different-length secret tests (#613/#614 closed). |
| `/api/deploy/runtime-status` | Shared `x-cron-secret` header matching `CRON_SECRET`. | Blue/green deploy script or operator with cron secret. | Runtime role and cron-enabled flag only. | None. | Shared `requireCronSecret()` helper (constant-time compare). | None. | Resolved under #613 (closed): now uses the shared cron/deploy guard helper rather than a duplicated local compare. |
| `/api/deploy/warmup` | Shared `x-cron-secret` header matching `CRON_SECRET`. | Blue/green deploy script or operator with cron secret. | A warm-up report: route counts, failed public paths with their HTTP result and cache-verification result, warnings, and the gate verdict. No page content, no member data, and the release identifier is never returned — the caller sends the release it EXPECTS and receives only match/mismatch (#2566). | Its own public pages, over its own loopback origin. The path list comes from the release's build output and the `published` `PageContent` rows; no request input reaches it, so it is not an SSRF pivot. Requests are capped by a configurable concurrency (default 3), a per-request timeout, and a whole-gate deadline, and a second concurrent run is refused (409). | Shared `requireCronSecret()` helper (constant-time compare); every query parameter is refused unless it is a whole number in range or a hex commit id, so a mistyped tolerance cannot silently widen the gate; `force-dynamic` so no response is ever stored. | The deploy log carries the whole report; nothing is written to the database. | Warms only addresses `isFixedNonceWebsitePath()` claims, so admin, member, auth and API routes are structurally unreachable from it, and drafts are excluded at the database read. It is a GET because the runtime image's only HTTP client is busybox `wget`, which cannot POST — warming is idempotent, so the verb costs nothing. |
| `/api/webhooks/stripe` | Stripe signature. No session auth by design. | Stripe. | Stripe event payload, payment intent/setup intent state through service. | Stripe webhook verification and downstream payment handling. | Resolves the signing secret from the encrypted `IntegrationCredential` store via the shared resolver (`getOperationalStripeWebhookSecret`), **fail-closed**: no/unreadable secret or a resolver error ⇒ reject (HTTP 500), never accept — #2082, the legacy `STRIPE_WEBHOOK_SECRET` env var is no longer read. Requires `stripe-signature`; bounded raw body read before signature verification. | Logger for signature/body-limit errors; service-level records. | Do not add session auth. Event idempotency is handled by `ProcessedWebhookEvent`; keep Stripe event coverage under payment-integrity review. The setup wizard's webhook **Verify** reads a marker written only for signature-verified test-mode events, freshness-scoped against the stored signing secret (#2082). |
| `/api/webhooks/xero` | Xero HMAC signature. No session auth by design. | Xero. | Xero inbound event records, webhook logs, reconciliation queue. | Xero reconciliation cycle after response. | Resolves the webhook signing key from the encrypted `IntegrationCredential` store via the shared resolver (`getOperationalXeroWebhookKey`), **fail-closed**: no key ⇒ reject (never accept unsigned) — #2079, the legacy `XERO_WEBHOOK_KEY` env var is no longer read. Requires `x-xero-signature`, bounded body read, HMAC with `timingSafeEqual`, object payload, array `events`, and max-event cap; invalid or unverifiable signatures return 401. A valid-signature **empty-events** POST is Xero's intent-to-receive (ITR) validation ping (#2081): the route records a `WebhookValidationReceipt` marker stamped with the receipt time and a non-reversible SHA-256 fingerprint of the resolved webhook key (never the key itself), then returns 200. | `recordWebhookLog()`, Xero inbound event records, `WebhookValidationReceipt` (ITR marker), logger. | Do not add session auth. Replay/idempotency relies on Xero inbound correlation keys and async reconciliation. The setup wizard's webhook **Verify** reads the ITR marker via `/api/admin/xero/webhook/verify-status` (any admin can read; only Full Admin can write the key) and is **freshness-scoped**: green only for a marker newer than a server-issued verify-start AND matching the current key's fingerprint, so a stale marker or one under a replaced key can never satisfy a new verify. Exposure contract (#2079): the key/fingerprint never leaves the server — only booleans/timestamps do. |
| `/api/webhooks/ses-sns` | AWS SNS signature verification. No session auth by design. | AWS SNS for SES feedback. | Processed webhook ids, email suppression/failure records, webhook logs. | SNS certificate verification, SES feedback ingestion. | Bounded JSON envelope validation, SNS signature verification, and `SES_SNS_TOPIC_ARN` allowlisting unless a non-production unsafe override is set. | `recordWebhookLog()`, logger; duplicate event ids are idempotent. | `SES_SNS_TOPIC_ARN` must stay configured for deployed environments; unsafe missing-topic override is local-only. |
| GitHub Actions, Dockerfile, Compose, deployment scripts | CI/deployment boundary, not app-session auth. | Maintainer, GitHub Actions, deploy operator. | Repository, package lock, Docker images, GHCR packages, environment variables, migrations. | npm, Docker, GHCR, Semgrep, gitleaks, Trivy, CodeQL if enabled by repo settings. | CI gates: audit, lint, tests, production build in CI only, Semgrep, gitleaks, Docker image security. Compose uses read-only app container, tmpfs cache, no-new-privileges, resource limits. | GitHub logs and deploy logs. | #619 should review workflow permissions, package publishing, secret scopes, image provenance, and deploy env contracts. |

## External Integration Review (#616)

This review covered the current Stripe, operational Xero, finance reporting over
the operational Xero connection, SES/SNS, Sentry, OAuth state, webhook signature,
token encryption, and provider callback logging paths without live provider
calls.

Concrete hardening added from the review:

- Stripe, Xero, and SES/SNS webhooks now enforce bounded request bodies before
  provider verification or JSON parsing. Oversized payloads return `413`, while
  malformed signed payloads still return `400`/`401` as appropriate.
- Xero webhook JSON now requires an object payload with an array `events` value
  and caps a single delivery to 100 events before processing any event rows.
- Operational Xero OAuth callbacks still pass the exact registered callback URL
  to the Xero SDK, but logs now record only callback path and presence flags for
  `code`/`state`.
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
- Operational Xero token storage encrypts access and refresh tokens at rest.

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

These family rules are enforced by automated tests (issue #1132):

- `src/lib/__tests__/api-route-boundaries.test.ts` asserts per exported HTTP
  method that admin routes reach `requireAdmin()` (directly, via a local
  helper, or via an allowlisted shared wrapper), that finance routes call the
  viewer/manager guard documented for them, and that member routes carry an
  active-session guard unless explicitly documented as public.
- `src/lib/__tests__/admin-permissions.test.ts` enumerates every
  `src/app/api/admin/**` route and method from the filesystem and checks the
  resolved area/level requirement against a hand-written role-bundle truth
  table: anonymous, plain member, lodge, finance-viewer, and org identities
  must be denied everywhere, and each admin bundle must match the table. A new
  admin route that falls into the `/api/admin` overview catch-all (readable by
  every scoped admin bundle) fails the suite until it is mapped to a specific
  area or consciously allowlisted.
- `src/lib/__tests__/finance-api-auth.test.ts` behaviourally tests the
  `/api/finance` guard pair, including that a full `ADMIN` without a finance
  role is rejected (the finance surface is separate from the admin portal).

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
- `src/app/api/display/**/route.ts`
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
- `src/app/api/lodges/route.ts`
- `src/app/api/member/**/route.ts`
- `src/app/api/members/family/**/route.ts`
- `src/app/api/members/guest-candidates/**/route.ts` — **a deliberate PII
  surface, see the Sensitive Data Inventory below.** The exact-email resolve
  exists whenever the `memberGuests` module is on; the name type-ahead exists
  only where a club has additionally switched open search on, and both answer
  **404** when their gate is off so an unauthorised caller cannot learn the club
  has the feature at all.
- `src/app/api/notifications/preferences/route.ts`
- `src/app/api/payments/**/route.ts`
- `src/app/api/profile/route.ts`
- `src/app/api/promo-codes/**/route.ts`

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
- Multi-lodge management (always-on since ADR-005 / #128 removed the
  `multiLodge` flag; `requireAdmin()` is the sole boundary): `admin/lodges/**`,
  `admin/members/[id]/lodge-access`. `admin/lodges/**` also hosts the guided
  new-lodge wizard at `admin/lodges/[id]/setup`.
- Bulk lodge-inventory seeding: `admin/bed-allocation/rooms/bulk`,
  `admin/lockers/bulk`
- Lobby display authoring and devices: `admin/display/**` (layouts, templates,
  lodge-config, devices, pairing/revoke, preview, and preview-grant)
- Operational Xero: `admin/xero/**`

### Finance Routes

- `src/app/api/finance/**/route.ts`

### Cron And Deploy Routes

- `src/app/api/cron/**/route.ts`
- `src/app/api/deploy/runtime-status/route.ts`
- `src/app/api/deploy/warmup/route.ts`

## Sensitive Data Inventory

| Data store or secret class | Where it appears | Current controls | Follow-up |
| --- | --- | --- | --- |
| Password hashes and session security fields | `Member.passwordHash`, `forcePasswordChange`, `passwordChangedAt`, Auth.js JWT callbacks. | bcrypt, email verification before session, session invalidation on password change. | #615 for account-recovery behavior; #617 for lifecycle interactions. |
| Action and verification tokens | Password reset, setup invite, verification, email change, nomination, chore, cancellation confirmation helpers. | Token helpers store hashes/expiry where implemented; some routes are session-bound in addition to token-bound. | #615 for token URL/log exposure and enumeration. |
| Member PII | Member/profile/family/admin/application routes. | Session/admin guards, audit logs on sensitive changes, scoped selects in public committee route that exclude email and gate phone by assignment flag. | #613/#614 for route boundaries; #617 for integrity and lifecycle review. |
| **Member name list, deliberately browsable when a club opts in** (`memberGuests`, epic #2305) | `src/app/api/members/guest-candidates/**` (member finder, #2308) and `src/app/api/admin/bookings/[id]/member-guest-candidates` (officer picker, #2309). | **The honest model, not softened:** with *open member search* ON the club's member name list IS browsable to any member who can start a booking — that is the setting's purpose, it is a per-club choice, and it ships OFF. The controls are (1) rate limits, burst and daily, keyed per acting member as well as per IP; (2) a full audit trail — every query in both modes, including empty, under-minimum and rate-limited ones, and the email path stores the **full address** because "who looked up which household" is the whole point of the row; (3) a ten-row cap with prefix-only matching and a boolean overflow rather than a count, so harvesting is slow and noisy rather than one request; (4) minors excluded from the type-ahead by default. Neither path evaluates eligibility, so neither can become an eligibility oracle, and the envelope is always 200 and identical for found, not-found and inactive. The officer picker is NOT bound by the two member-facing switches (D-20) but its NAME mode is gated on **`membership:view`**, so #1376's directory-less Booking Officer falls back to exact-email; its lookups are audited through the same two writers. Neither privacy setting travels in config transfer (D-18). | #2305 / #2308 / #2309; the two settings' defaults and the audit actions are pinned by `member-guest-widening.test.ts`. |
| Booking and payment records | Booking, payment, refund, admin booking/payment routes. | Session guards, service-level ownership, Stripe server-side calls, payment transaction records. | #617 for money-state invariants, idempotency, and integer cents. |
| Stripe identifiers and client secrets | Payment routes and webhook/service layers. | Server-side Stripe secret key resolved from the encrypted `IntegrationCredential` store (#2082), never in the client bundle; client secret returned only through authenticated payment routes; publishable key delivered at runtime from the store. | #616/#617 for webhook idempotency and client-secret ownership. |
| Operational Xero tokens and object links | `admin/xero/**`, Xero token store, outbox/inbound reconciliation. | Admin guard, encrypted token store, OAuth state cookie, feature gates. | #616 for OAuth/webhook/retry boundaries. |
| Finance snapshots and reporting datasets | Finance sync routes and storage, using the shared operational Xero connection. | Finance manager/viewer guards, operational Xero token encryption and admin-managed reconnect flow. | #618 for finance roles and legacy bridge; #616 for Xero integration controls. |
| Email/SNS data | Contact, application, admin communications, email templates, SES/SNS webhook. | Rate limits for public senders, template escaping, SNS signature verification, email suppression records. | #616 for SES/SNS topic allowlist and outbound email abuse. |
| Audit, webhook, cron, and provider logs | `AuditLog`, `WebhookLog`, `CronJobRun`, Xero operation/inbound records. | Structured logging with redaction helpers for known sensitive URL tokens; webhook logs redact error text. | #615/#616 for callback URL and token redaction review; compromised log reader threat below. |
| CI/deploy secrets | GitHub Actions secrets/vars, `.env`, Compose, GHCR tokens, Sentry token. | CI permission scoping, gitleaks, deployment docs warn not to commit secrets. | #619 for workflow permissions, provenance, and secret-scope review. |
| Encrypted integration credentials (#2079, #2082, #2087, #2095) | `IntegrationCredential` (Xero client id/secret/webhook key, wrapped Xero token key; Stripe secret/publishable/webhook-signing keys; **Google OAuth client id + secret, plus a non-secret `verified_at` marker**; Backup S3 access key/secret, restore-validation DSN, and non-secret destination/config). | AES-256-GCM under an HKDF-SHA256 key derived from `AUTH_SECRET`/`NEXTAUTH_SECRET`, per-write random IV, AAD context-binding to `(provider,key,labelVersion)`; write-only Full-Admin API; secret values never returned/logged/exported; excluded from config-transfer. The Stripe publishable key is the ONE value delivered to the browser (it is not secret) — at runtime via `GET /api/stripe/publishable-key`, never a secret. Google's client id/secret are resolved server-side into the request-scoped NextAuth config and never leave the server; the resolver **fails open** (a DB/decrypt failure omits the Google provider, never breaking password/magic-link/2FA sign-in — #2087). | See "Credentials at rest" and "Backup S3 blast radius" below. |
| Backup S3 destination + credentials (#2095) | `IntegrationCredential` provider `backup`; consumed by `src/lib/backup.ts` (pg_dump → gzip → `aws s3 cp`) and the `/admin/backups` surface. | S3 access key/secret and the restore-validation DSN are write-only Full-Admin secrets (never returned/logged); the destination (bucket/region) is ALSO Full-Admin-only to write even though it is not secret (see below); the S3 secrets ride the child process env (`AWS_*`), never argv, and the Postgres password rides `PGPASSWORD`, never argv; bucket/region are strictly format-validated before any CLI call. | See "Backup S3 blast radius" below. |

## Credentials at rest (#2079)

Provider credentials are stored encrypted in `IntegrationCredential` and
decrypted with a key derived from the app auth secret
(`AUTH_SECRET`/`NEXTAUTH_SECRET`) via HKDF-SHA256. This concentrates trust in
that single secret:

- **A database backup + the auth secret decrypts everything.** Anyone who holds
  both a DB dump (or replica) and the auth-secret value can recover every stored
  provider credential. Treat the auth secret with the same care as the database
  itself.
- **Production and staging/clones must NEVER share an auth secret.** A restored
  clone (or staging seeded from prod) is **expected** to fail GCM decryption of
  every credential and enter the "needs re-entry (encryption key changed)"
  state — that is the correct, safe outcome, not a bug. If a clone shared prod's
  secret it would silently hold live, decryptable credentials.
- **Rotation blast radius.** Rotating the auth secret strands all stored
  credentials (and the wrapped Xero token key), on top of dropping sessions and
  all 2FA enrolments/recovery codes. See the auth-secret rotation runbook in
  `DEPLOYMENT.md`.
- **Decrypt-before-verify on webhook paths.** Both the Xero webhook route
  (`getOperationalXeroWebhookKey`) and the Stripe webhook route
  (`getOperationalStripeWebhookSecret`, #2082) resolve their signing secret from
  the encrypted store (a decrypt) before verifying the request signature, and stay
  **fail-closed**: a missing or unreadable secret — or a resolver error — rejects
  every delivery (HTTP 500), never accepts. A DB/decrypt failure therefore degrades
  to rejection, never to acceptance. The Stripe webhook additionally records a
  freshness-scoped verified marker only for signature-verified TEST-MODE events,
  which is dropped whenever any Stripe credential is rewritten (verify-reset).
- **Exposure contract.** No plaintext or ciphertext/iv/authTag ever appears in an
  API response, server-component prop, client bundle, log line, Sentry event,
  audit row, or config-transfer export.
- **Config transfer: never travels, in any form (permanent policy, #2205).** The
  `IntegrationCredential` entity is **permanently excluded** from config transfer
  — credential rows never ride in a bundle, neither the encrypted values nor any
  per-field metadata about them. Two independent mechanisms enforce this at HEAD:
  1. **Entity exclusion (primary).** No config-transfer category module registers
     a descriptor for `IntegrationCredential`, so nothing on the row — including
     the un-patternable `iv` column — can be exported. The
     "registers NO IntegrationCredential entity" test in
     `src/lib/__tests__/config-transfer-registry.test.ts` walks every registered
     descriptor and fails if one names the entity, its file, or any
     `iv`/`ciphertext`/`authTag` field.
  2. **Forbidden-field sweep (defence in depth).** The `ciphertext` and
     `auth.?tag` patterns are in `FORBIDDEN_FIELD_PATTERNS` in
     `src/lib/config-transfer/registry.ts`; `assertDescriptorValid` (run at module
     load and by the same test) throws if any future descriptor's allowlist ever
     names one, so a mistaken re-registration fails the build.

  A **presence-metadata export** (non-secret "which providers are configured"
  booleans, never any value/ciphertext, so a clone could show honest "re-enter
  credentials" affordances) was considered and **rejected** by the owner
  (decision on #2205, 2026-07-23): the wholesale exclusion is the ratified
  permanent policy and no presence metadata travels either. The config-transfer
  reference documents the same contract — see
  [Configuration Export & Import](config-transfer/README.md#implemented-categories).

## Backup S3 blast radius (#2095)

The managed backup uploads a **full `pg_dump` of the production database** to the
configured S3 bucket. That makes the backup subsystem a first-class exfiltration
surface, not just a durability feature:

- **The destination is privileged even though it is not secret.** Anyone who can
  change the S3 bucket/region can redirect the entire database dump to a bucket
  they control. So destination writes are **Full-Admin only** (same tier as the
  credentials), enforced in `POST /api/admin/backups/config`, not merely
  support-area edit. Support-area edit can toggle enabled/retention but never the
  destination or credentials. Every config change writes a metadata-only audit
  entry (`backup.config.set`); credential writes audit as
  `integration.credential.set`; run-now audits as `backup.run.now`.
- **Bucket/region are validated before any CLI call.** They are interpolated into
  `aws s3 cp` (via `execFileSync` array-args, which are injection-safe) and an
  `s3://…` URI, so a strict bucket regex and `^[a-z0-9-]+$` region regex reject
  malformed/surprising input at write time.
- **Credentials never reach argv.** The S3 access key/secret ride the child
  process environment (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`); the Postgres
  connection password rides `PGPASSWORD` (moved off the `pg_dump`/`psql` command
  line in #2095) — neither is visible in a host `ps` listing.
- **Decrypt failure fails loudly.** Backups run unattended from cron, so a
  post-rotation GCM decrypt failure on the backup credentials is surfaced as a
  **`FAILURE` cron run + error Sentry check-in** (the disaster-recovery path can
  never silently disable itself), plus a "re-enter credentials" banner on the
  Backups page. The Backup row also joins the unified "needs re-entry" aggregate.
- **Cross-process run lock.** Run-now and the nightly cron both claim a
  `BackupRun` row under a `pg_advisory_xact_lock`, so no two containers dump at
  once; a run whose container died mid-dump is reaped to `FAILURE` after a
  staleness window rather than wedging the lock. Local artifacts live on per-
  container tmpfs and are ephemeral — only S3 and the DB run record are
  authoritative.
- **Restore-validation DSN.** When set, each backup is restored into a disposable
  shadow database and smoke-checked; the DSN is a write-only Full-Admin secret and
  the engine refuses it if it equals the live `DATABASE_URL`.

## Threat Model By Actor

Issue pointers in this section (#613–#619) are provenance for the reviews
that hardened each actor path; all are closed. Open items are tracked in
labelled GitHub issues instead of this document.

### Anonymous Internet User

Main reachable surfaces are public health, public read endpoints, auth/account
recovery, contact/application forms, address autocomplete, public chore tokens,
and provider webhooks. Abuse goals include credential stuffing, account
enumeration, spam, upstream-cost exhaustion, token guessing, and availability
probing. Current mitigations are route-specific rate limits, Zod validation,
non-secret public health responses, token expiry, and provider signatures.

Rate limits are backed by a shared Postgres counter (`RateLimitCounter`,
one atomic upsert per check), so blue/green drain and any future multi-replica
routing share the same window (#1039). If the database is unreachable the
limiter degrades to the previous per-process in-memory counters rather than
failing requests. Public exceptions are now backed by route metadata and
static tests, but #615 should still review the concrete anonymous endpoint
behavior.

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

Finance actors can view metrics/snapshots and managers can run finance sync.
Abuse goals include reading sensitive financial data without club-wide admin
rights, triggering expensive syncs, or syncing against the wrong operational
Xero tenant.

Current mitigations are separate finance access levels, active-session checks,
force-password-change checks, the shared admin-managed Xero connection, and
route-level viewer/manager split. #614 should test denial for ordinary
members/admins without finance access; #618 should review finance role
assignment and legacy dashboard behavior.

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
- Addy autocomplete is module-gated, keeps session validation explicit, and caps
  returned search suggestions to the requested top 10. Malformed detail-session
  parameters fail locally before calling Addy.
- Public committee reads are capped to 50 active, published assignment records;
  email is server-only, contact keys are returned only for contactable
  assignments, member email can be used server-side only when no role email is
  configured, member phone is returned only when show-phone is enabled, and
  committee-routed contact EmailLog rows use opaque recipient markers.
- Log redaction covers token-bearing `/membership-cancellation/`, `/chores/`,
  `/nominations/`, `/pay/`, `/booking-requests/verify/`, and
  `/group-bookings/join/verify/` paths, including URL-encoded `callbackUrl`
  values from login redirects.
- The group-booking join-request mutation endpoint returns the same neutral
  success response for account-state and group-state lookup failures; the public
  group summary endpoint remains the intentional limited join-code lookup
  surface.

Accepted residual risk:

- Rate limits share a Postgres-backed counter across slots/replicas (#1039);
  during a database outage the limiter degrades to per-process counters, which
  briefly restores the old split-counter behaviour rather than blocking
  traffic.
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
  tenant before encrypted access and refresh tokens are saved.
- Operational Xero callback redirects now show only safe local error messages;
  provider callback exception details are logged through the shared redaction
  layer and are not reflected into browser redirect URLs.
- Browser-facing API fallback catches return fixed route-specific errors and
  keep unexpected Prisma, provider, and runtime messages in structured logs.
  Intentional validation/domain copy is admitted only through explicit error
  types. A source contract scans the client-facing API tree to prevent direct
  or locally-aliased catch messages from being serialized; machine-facing
  cron/webhook routes and explicit provider-diagnostic endpoints keep their
  distinct response contracts.
- The shared Xero API error classifier exposes separate `clientMessage` and
  `diagnosticMessage` fields. Admin browser routes serialize only the fixed
  client field; provider body text and correlation identifiers remain in
  structured server logs. The source contract treats helper-derived diagnostic
  fields as tainted so they cannot bypass the direct-catch guard.

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
finance sync routes, and the legacy finance dashboard bridge.

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

- Finance access remains separate from `ADMIN`: `FINANCE_USER` can read finance
  pages/APIs and `FINANCE_ADMIN` is required for manager-only sync and mapping
  routes. Xero connection state is managed through the shared operational admin
  Xero connection, with `financeAccessLevel` kept synchronized only for legacy
  compatibility and ignored by runtime guards.
- `LODGE` alone is rejected by finance guards; deliberate mixed-role accounts
  such as `LODGE` plus `FINANCE_USER` retain lodge access and gain finance
  viewer access.
- Lodge mutation routes continue to reject `staying-guest` access for arrivals,
  departures, and chore toggles; roster generation and confirmation remain
  limited to `admin` or `hut-leader` tiers.
- Kiosk, chores, finance, Xero, and address autocomplete routes remain covered
  by effective module route gates in `src/config/feature-routes.ts` and
  `src/proxy.ts`.
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

## Streamed Multipart Upload Cap Review - 2026-07-24

Reviewed every `multipart/form-data` upload route for the memory-pressure DoS in
#2235: a `Content-Length` header pre-check followed by `request.formData()`. The
`Content-Length` header is optional and attacker-controlled, so a chunked
request (no header) or a spoofed-small value skipped the pre-check and
`request.formData()` then buffered the **entire** body into memory before the
real per-file byte caps ran. An authenticated user could POST a multi-GB body
and exhaust server memory.

Hardening applied in #2235:

- A shared streaming reader, `readCappedMultipartFormData`
  (`src/lib/capped-multipart.ts`), replaces `request.formData()` on every
  multipart route. It pipes `request.body` through `busboy` incrementally with a
  total-byte counter sitting **upstream** of the parser: the moment the running
  total exceeds the route's request-body ceiling the source stream is cancelled
  and the parser torn down, so the server stops consuming a hostile body
  mid-flight instead of buffering it whole. It also enforces per-file, file-count
  and field caps, and fails **closed** (413) when `busboy` would silently
  truncate a file past its `fileSize` limit rather than accepting the truncated
  remainder. It keeps the cheap honest-`Content-Length` fast-fail (413 before the
  stream is read) and uses the strict `Content-Length` parse from
  `readBoundedWebhookText` so a malformed header is treated as absent, never
  trusted.
- Adopted across all five multipart surfaces with their existing status codes and
  messages preserved: `/api/members/[id]/photo` (2MB/file), `/api/admin/image-library`
  (2MB/file), `/api/admin/site-style/logo` (2MB/file, #2322 — additionally
  re-checks the materialised source size after buffering, bounds the decoded
  image to 160x640 through `sharp`, and 413s if the RE-ENCODED bytes exceed the
  2MB cap, so a pathological canvas cannot be stored), `/api/admin/image-manager/upload`
  (a batch route — now capped at 25 files and an 80MB total request body, while
  keeping its friendly per-file 10MB result), and the config-transfer
  `readBundleUpload` shared by the plan / apply / reseal routes (50MB bundle
  file, ~54MB request body).
- **Inclusive caps (fix, this review).** `busboy` trips its `fileSize` / `fieldSize`
  truncation when the running size *reaches* the limit (`size === limit`), so the
  first cut of #2235 turned a byte-exact upload (a file of exactly 2MB / 50MB, or a
  form field of exactly the field cap) into a spurious 413 — the old post-parse
  `size > MAX` check accepted it. The reader now configures `busboy` with
  `fileSize: maxFileBytes + 1` and `fieldSize: maxFieldBytes + 1`, restoring the
  inclusive-maximum semantics; the routes keep their own `size > MAX` re-checks.
- **Cause-tagged 413s.** The reader now reports *which* cap tripped
  (`request` / `file` / `field` / `count`) so routes message precisely: the
  image-manager batch distinguishes "too many files (25 limit)" from "batch too
  large (80MB total) — split it", and `readBundleUpload` was given an explicit
  2MB form-field cap (the accompanying `resolutions` JSON legitimately exceeds the
  1MiB default) and now says "Upload form fields are too large." for a field/count
  overflow instead of the misleading "Bundle is too large." reserved for the file
  itself.

Guaranteed backstop (defence in depth):

- The reverse-proxy / platform request-body cap is the guaranteed first line of
  defence: it rejects an oversize body at the edge before it ever reaches the
  Node process, independent of any application code. Configure it on every
  deployment — Caddy's `request_body { max_size <n> }` directive, Nginx
  `client_max_body_size`, or the host platform's request-size limit — set
  comfortably above the largest legitimate in-app cap (the config-transfer 50MB
  bundle and the 80MB image-manager batch), e.g. 100MB.
- **Current state:** the repo's `Caddyfile` and `Caddyfile.staging` set
  `request_body { max_size 100MB }` (#2235), so an oversize body is dropped at
  the edge on every Caddy-fronted deployment. Deployments fronted by something
  other than Caddy must configure the equivalent limit themselves. The in-app
  reader remains the second line regardless — it enforces the per-route
  byte/file caps a generic proxy limit cannot know about, and it protects an
  attacker path that reaches the Node process directly (bypassing the proxy).

Accepted residual risk:

- **Slow-loris (trickle) uploads.** This fix targets *memory* pressure — it
  bounds how many bytes a hostile body can buffer, not how long a connection is
  held. A client that trickles bytes *under* the caps still occupies a connection
  and request-handler slot for as long as the transfer lasts; the streamed reader
  does not shorten that. This is bounded today by Node's default
  `server.requestTimeout` (~5 minutes, after which the request is aborted) and by
  the reverse proxy's own connection/read timeouts and concurrency handling. We
  accept it as a **residual** here rather than treat it as closed: mitigating
  connection-holding attacks is the proxy/platform's job (request/idle timeouts,
  per-IP connection limits), not this in-app byte cap. Revisit if a deployment
  fronts the Node process without such a timeout.

## Member-Photo Serving And Image Metadata Review - 2026-08-01

Three related findings on the member-photo / stored-image surface, ported from
the Tokoroa fork's review and fixed in #2242.

- **The photo GET skipped two auth gates the rest of the route enforced.** Its
  private branch hand-rolled `auth()` + `hasAdminAreaAccess` instead of using
  `requireActiveSessionUser` / `requireAdmin`, so it never applied the
  `forcePasswordChange` 403 or the `isTwoFactorSessionBlocked` gate — while the
  same file's POST and DELETE did. Someone with a valid password but no second
  factor completes step one of sign-in, `auth()` returns a real session, every
  other admin surface refuses them, and this endpoint served private member
  photos by id. The branch now runs the same shared guards, and a guard refusal
  is mapped onto the route's existing `notFoundResponse()` so the deliberate
  404-not-403 behaviour survives — a real member id and a nonexistent one stay
  indistinguishable to an unauthorised caller. The route's `public` GET now
  carries an explicit `conditionalAuth` declaration in `api-route-security.ts`,
  enforced in both directions by `api-route-boundaries.test.ts`. A second, minor
  tightening comes with it: the self path used to allow `viewerId === id` with no
  active-account check at all, so a deactivated member's session could still
  fetch their own photo; `requireActiveSessionUser` now refuses that too, in step
  with POST/DELETE.
- **`committeePhotoDisplay = NONE` did not stop anonymous serving.** It was
  presentational only: it hid photo metadata from `/api/committee` and the
  roster, but the endpoint still served committee photos anonymously to anyone
  holding a member id, and the `version` field disclosed when the photo last
  changed. The admin control reads "Don't show photos", so an operator handling a
  takedown request reasonably believed the image was no longer public. `NONE` now
  also blocks the ANONYMOUS branch. The AUTHENTICATED branch is deliberately not
  gated on it — self and `membership:view` admins must still see the photo when
  public display is off — and those responses fall back to `private, no-store`
  rather than keeping the short public cache.
- **Metadata was stripped on one path out of five.** `stripImageMetadata` had
  exactly one non-test caller (the member-photo route), while
  `POST /api/admin/image-library`, `src/lib/config-transfer/media.ts`,
  `POST /api/admin/image-manager/upload` and the inline club logo
  (`ClubTheme.logoDataUrl`) stored raw bytes. All four feed anonymously-served
  content — the first two as `MediaImage` rows served from `/api/images/[id]`
  with `public, max-age=31536000, immutable`, the third as files written straight
  into `public/images` at 10 MB × 25 files per batch, the fourth inlined into the
  header, footer and mobile menu of every public page — so a straight-from-phone
  photo published its GPS coordinates effectively forever. All five paths now
  strip. The member-photo route keeps its **fail-closed** policy (an unconfirmable
  strip rejects the upload); the other four fail **open** through the shared
  `storableImageBytes` helper (the inline logo through `storableLogoDataUrl`,
  which wraps it), storing the original and logging a warning, because blocking a
  legitimate admin content upload, a site-style save, or an operator's
  configuration restore is the worse outcome there. Relatedly,
  `stripImageMetadata`'s `default:` branch used to claim `ok: true` for the three
  allowed types it has no stripper for (gif, avif, svg+xml) — all of which do
  carry metadata — which silenced that warning for exactly the types that are
  never stripped; it now returns `ok: false` with the original bytes.

Notes on the fail-open choice and its cost:

- The asymmetry is deliberate. `stripJpegMetadata` is known to reject some
  spec-legal JPEG fill-byte sequences (T.81 §B.1.1.2). On a member photo —
  personal data on a narrow, purpose-built path — refusing is right. On the
  admin's general content tools it is not, so those log instead. Anything stored
  without a confirmed strip is visible in operations as
  `"Image stored without a confirmed metadata strip"` with the source, filename
  and content type.
- `/api/admin/site-style/logo` also stores image bytes and is deliberately
  untouched: it re-encodes through `sharp` (`webp()`/`png()`) with no
  `withMetadata()`, and sharp drops EXIF/XMP/ICC unless asked to keep it, so the
  stored logo is already metadata-free by construction. Adding `withMetadata()`
  there would reopen this hole.
- The INLINE club logo (`ClubTheme.logoDataUrl`, a base64 `data:` URI rendered
  by `website-logo.tsx` in the public header, footer and mobile menu) is a
  separate store from the `MediaImage` table and needed its own strip. It has two
  writers — the site-style save (`saveClubTheme`) and the config-transfer import
  (`deriveThemeWrite`, the single derivation plan and apply share) — and both now
  route the value through `storableLogoDataUrl`. New logos normally go through
  `POST /api/admin/site-style/logo` above and never touch this column, so what is
  left here is the legacy rows and a small hand-crafted/bundled escape hatch (a
  64 KB write budget, a 900 KB read bound) — but a hand-crafted logo can still be
  a phone photo, and it renders on every public page. The helper returns the
  value byte for byte whenever nothing was removed, so an untouched logo neither
  churns the stored row on an unrelated colour change nor turns an "unchanged"
  import dry-run into a spurious update; stripping only ever shrinks the value,
  so both budgets still hold. Two consequences worth knowing: an existing
  unstripped inline logo is scrubbed the next time the theme is saved or
  re-imported (not by a backfill), and a legacy inline logo whose payload cannot
  be sniffed or confirmed is stored unchanged and logged, exactly like the other
  fail-open paths.
- Cost on the widest path (image-manager batch): each stripper is a single linear
  pass with one output buffer, files are processed sequentially, and the batch is
  already fully buffered by the streamed multipart reader, so the added peak
  memory is about one file (≤10 MB), not the whole batch. The slowest case is the
  byte-by-byte walk of a large JPEG's entropy-coded scan — tens of milliseconds
  for a 10 MB file, so a worst-case 25-file batch adds well under a second to an
  upload already dominated by transfer and disk.
- In config-transfer the strip is applied identically by both plan helpers
  (`planBundleMedia`, `planBundleMediaTarget`) and by `recreateBundleMedia`, and
  the create-vs-reuse dedup keys on the STORED (stripped) bytes and their length,
  so the dry-run keeps disclosing exactly what the write will do (ADR-002
  plan/apply parity). One consequence is worth knowing: an image imported before
  this change is stored unstripped, so re-importing the same bundle now creates a
  fresh, scrubbed row instead of reusing the old one, and references remap to it.
  That happens once, only for images that actually carried strippable metadata
  (a clean image strips to identical bytes and still matches), and it leaves the
  superseded row orphaned rather than losing anything.
- Existing stored images are **not** retro-scrubbed. The strip applies to bytes
  arriving from now on; there is no backfill pass over `MediaImage` rows or over
  files already sitting in `public/images`.
- The enumeration guarantee is about the RESPONSE — status, body and headers are
  byte-identical across every refusal, which is what
  `member-photo-route.test.ts` pins. It is not a constant-time claim: the number
  of database round-trips still varies by branch (a committee-published member
  costs the extra `PublicContentSettings` read that a non-committee member does
  not), exactly as it did before this change. What that timing could distinguish
  is committee-publication status, which the public roster already publishes by
  name.

## Per-Route CSP Relaxation And Soft Navigation - 2026-07-26

`src/lib/csp.ts` scopes two relaxations to named exact paths (`frame-src 'self'`
for the two admin pages that embed the sandboxed `/display` iframe; the tightened
`img-src 'self' data:` for the routes that render authored display markup, #161),
plus `frame-ancestors 'self'` / `X-Frame-Options: SAMEORIGIN` on `/display`
itself. Reviewing #2246 surfaced a property of route-scoped headers that applies
to **any** scoped policy this app adds in future, not just these (#2279):

- **A scoped CSP only takes effect on a hard document load.** The policy is a
  property of the *document*, parsed from its response headers and fixed for that
  document's lifetime. A Next.js App Router `<Link>` (or `router.push`) is a
  **soft** navigation — same document, new React tree — so the destination runs
  under the **entry** document's policy. With one root layout, every
  `/admin/*` → `/admin/*` `<Link>` is soft. A route that depends on a scoped
  relaxation must therefore be *entered* by a hard navigation, or the relaxation
  is silently inert. This is what made the builder's Live preview show "Content
  blocked" even after the allowlist was correct: both in-app links to
  `/admin/display/builder` were `<Link>`s. They are now a plain `<a href>` (hub
  card via the `hardNavigate` opt-in in `src/components/admin-hub-page.tsx`, and
  the Layouts page), joining the Templates page's existing
  `window.open(url, "_self")`.
- **Every relaxed route was audited, and the guard now enforces the rule for
  future ones.** The other two relaxed paths were checked rather than assumed:
  `/admin/display/preview` is only ever entered by `window.open(…, "_blank")`
  from the Templates page, and `/display` only by a real frame navigation (the
  `<iframe src>` in both preview surfaces), a `target="_blank"` anchor on the
  Devices page, or a TV browser opening the URL. All are hard loads; neither has
  a `<Link>`, a `router.push`, or a server `redirect()` pointing at it. The
  static guard `src/lib/__tests__/display-builder-csp-static.test.ts` is driven
  from `FRAME_SRC_SELF_PATHS` and `TIGHT_IMG_SRC_PATHS` themselves, so adding a
  path to a relaxation fails until that path's entry points are hard
  navigations. It requires a relaxed `href` to sit on a plain `<a>` (any
  component wrapper fails, not just `<Link>`), forbids `router.push`/`replace`
  at a relaxed path, and requires any hub/nav descriptor pointing at one to carry
  `hardNavigate: true` — the variable-`href` case a literal scan cannot see.
- **Accepted residual — a relaxation leaks forward, never backward.** The same
  mechanism means an admin who hard-loads *any* relaxed route and then
  soft-navigates on to other admin pages carries that relaxation into those
  documents until the next hard load. Impact is low: it permits only
  *same-origin* framing on an authenticated admin page, adds no third-party
  origin, and the global `X-Frame-Options: DENY` / `frame-ancestors 'none'`
  still prevent those pages being framed by anyone. It is recorded here because
  it is inherent to soft navigation and cannot be closed by the allowlist —
  closing it would need a hard load on the way out too. The *tightened* `img-src`
  cannot leak this way in a harmful direction: it is strictly narrower than the
  global policy, and `/display` is only ever entered as a fresh document (a TV
  browser, or an iframe/new tab from the admin), never by a soft navigation.
- **Why the builder is excluded from the tightened `img-src`.** The builder keeps
  the normal admin `img-src ... https:` because it is admin chrome (avatars,
  uploaded imagery), and it never renders authored display markup in its own
  document — the draft is rendered only inside the opaque-origin `/display`
  frame, which carries the tightened policy itself. That invariant is now pinned
  by the same static guard file: the builder component must contain no
  `dangerouslySetInnerHTML`, `srcDoc`, `innerHTML` or injected `<style>`. A
  future in-canvas WYSIWYG preview would otherwise reinstate the #161
  image-beacon exfiltration channel with nothing failing.
- **A trailing slash is folded before the exact match.** `src/lib/csp.ts` strips
  one trailing slash from a path longer than `/` before comparing. Next
  308-redirects `/admin/display/builder/` to the canonical form, but the proxy
  runs *before* that redirect, so without this the redirect response — and
  anything that ever reached the route without being redirected — carried the
  unrelaxed policy. Only the input is normalised; the comparison stays exact
  equality, so `/…/builder/extra`, `/…/builder-foo`, `//admin/display/builder`
  and a doubled trailing slash all still fail closed. The one normalisation
  feeds every allowlist, so they cannot diverge on a trailing slash.
- **The edge no longer overrides the app's `X-Frame-Options`.** `Caddyfile` and
  `Caddyfile.staging` used to set `X-Frame-Options "DENY"` unconditionally,
  replacing the `SAMEORIGIN` the app deliberately sets on `/display`. Both
  preview surfaces therefore worked only because CSP2 requires browsers to
  ignore `X-Frame-Options` when `frame-ancestors` is present — a browser
  precedence rule, not the header the app intends to send. The edge header is
  now path-scoped to the same single path (`path_regexp ^/display/?$`, which is
  case-sensitive and so mirrors the app's exact comparison; Caddy's `path`
  matcher is case-*in*sensitive and would have relaxed `/DISPLAY`). Every other
  path keeps a **guaranteed** `DENY` set at the edge, including
  `/finance-legacy*` (a reverse-proxied third-party upstream) and `/images/*`,
  neither of which the app's own middleware covers. Caddy's set-if-absent
  `?X-Frame-Options` form was considered and rejected in review: it would
  downgrade a guaranteed edge control into an advisory one on every route, so
  any upstream emitting a permissive value would win.
  - **Two directives, both load-bearing — do not de-duplicate them.** The scoped
    pair uses the deferred `>` prefix so the edge value *overwrites* the app's
    rather than being appended as a second, conflicting header (measured against
    `caddy:2` with a permissive upstream, a plain set left both `DENY` and
    `ALLOWALL` on one response). But that deferred rewrite lives in a
    `ResponseWriter` wrapper which is unwound when a handler returns an **error**,
    so Caddy's error chain writes the response without it: a 502 when an upstream
    is down (including `/finance-legacy*`), the 413 from the `request_body` cap,
    any 5xx. Those responses never reach Next either, so they carry no CSP and no
    `frame-ancestors` fallback. An **eager** unscoped `X-Frame-Options "DENY"`
    therefore stays in the shared `header { }` block as the floor; the deferred
    pair overwrites it on every normal proxied response. Measured against
    `caddy:2`, exactly one `X-Frame-Options` per response: `/display` →
    `SAMEORIGIN`; `/other`, `/DISPLAY`, `/images/*` → `DENY`; 502, 413 and 500 →
    `DENY`.
  - **The edge matcher is not byte-identical to the app's comparison, and cannot
    be.** Caddy matches on the *cleaned, percent-decoded* path but forwards the
    *raw* URI, so the app compares a different string. Measured divergences where
    the edge relaxes to `SAMEORIGIN` while the app still sends `DENY`:
    `//display`, `/display//`, `/%64isplay`, `/dis%70lay`, `/display%2F`.
    Accepted: those responses still carry the app's own `frame-ancestors 'none'`,
    which browsers honour over `X-Frame-Options`, and `SAMEORIGIN` never permits
    more than same-origin framing. The dangerous inverse — the app relaxing where
    the edge denies, which would break the preview — is impossible, because both
    paths the app relaxes sit inside the edge's match set.

  `src/lib/__tests__/edge-frame-options-static.test.ts`
  pins all of this, including the eager floor and that the edge relaxes exactly
  the path the app relaxes. **Operators: a Caddyfile change only takes effect
  after Caddy is reloaded on the host — it does not ship with the app deploy.**
- **Staging gained production's defensive CSP baseline.** `Caddyfile.staging` now
  carries the same `?Content-Security-Policy "default-src 'self'"` the production
  `Caddyfile` has. Because `?` is set-if-absent it is a no-op whenever the Next
  proxy emits its own policy, so it never intersects with the real CSP; its only
  effect is on failure. There it is deliberately loud — a bare `default-src
  'self'` breaks every nonce'd script — so a proxy/middleware regression fails
  visibly on staging instead of silently shipping an unprotected page to
  production. Measured against `caddy:2`: with an upstream emitting a CSP the
  header is untouched; with an upstream emitting none the baseline appears.

## Anonymous Public-Page Caching - 2026-07-29

Issue #2322, narrowed by the #2404 re-review and widened in reach by #2578.
`src/proxy.ts` relaxes `Cache-Control` to
`private, max-age=60, stale-while-revalidate=300` on a **closed allow list** of
public pages — currently the home page `/` alone — when the request is a `GET`
carrying no session cookie. Every other page-shaped `GET` is sent
`private, no-cache, no-store, max-age=0, must-revalidate` explicitly.

**Explicitly, not "left to the framework", and #2578 is why that distinction is
the whole of it.** Next writes its own `Cache-Control` only when the response does
not already carry one, so a path the proxy skips ships whatever the framework
computed — and `getCacheControlHeader()`
(`next/dist/server/lib/cache-control.js`) returns `private, no-cache, no-store`
only for `revalidate === 0`. A route served from a prerender returns
`s-maxage=<revalidate>` (or `s-maxage=31536000` when `revalidate` is absent) with
`stale-while-revalidate=<expireTime − revalidate>` beside it. So "skipped" and
"private" are the same thing only for as long as every route on that path is
dynamic.

The security-relevant properties:

- **Allow list, not deny list.** A route added later is uncached until someone
  adds it deliberately, so a new token- or session-bearing page cannot become
  publicly cacheable by omission. Every `(public)` route (login, register,
  password reset, `pay/[token]`, `family-invite/[token]`, `chores/[token]`…) is
  excluded because all of them are token-, form-, or session-bearing, as are
  `/join/*` and `/contact`. `/hut-leader-instructions` is excluded despite
  having no login gate: it is per-assignment and PIN-gated (`?a=` from an
  assignment email), so it is not shared content. The `(website)` `[...slug]`
  CMS catch-all is excluded too: middleware cannot distinguish a CMS path from
  an application path without a database read.
- **Session detection fails toward not caching.** The cookie test matches the
  next-auth v5 name (plain, `__Secure-` prefixed, and chunked `.0`/`.1`
  variants) **and** the legacy v4 `next-auth.session-token`. This deliberately
  diverges from `SESSION_COOKIE_NAME_PATTERN` in `src/lib/auth-diagnostics.ts`,
  which excludes v4 so a stale cookie is not misread as an auth anomaly. Here a
  stale cookie only costs a cache miss, whereas the opposite error would let a
  shared cache store a page served to someone holding a session.
- **`Vary: Cookie` is required, not decorative.** One browser profile holds
  sessions in sequence, so without it the stored anonymous render — which paints
  the header logged-out — could be replayed to the same person after they sign
  in. It is appended rather than set so any `Vary` the framework adds for RSC
  navigation survives.
- **No member data is in scope.** The allow-listed page renders club-wide
  branding and CMS content only, so a mis-keyed cache entry cannot disclose
  anything member-specific. It does carry the **per-request CSP nonce**, but
  under `private` the stored copy never leaves the browser that fetched it, so
  the nonce is not replayed to anyone else. It is still not unique-per-response
  within that one browser for up to the cache lifetime, so it must never be
  treated as a CSRF token or a per-session secret.
- **`private`, and no `s-maxage` — a browser cache only.** No shared cache exists
  in the deployment path (Caddy runs without a cache module and sets no cache
  directives), so `s-maxage` was storing nothing anywhere, and `max-age` earns
  the whole of the measured benefit on its own. The reason it is not merely
  unused but actively withheld is below.
- **The explicit directive covers BOTH territories, and keying it on the public
  website was a live defect (#2578).** The rule was written as "every
  public-website path except `/`", on the reasoning that the CMS catch-all is the
  only route carrying a `revalidate` export and it lives inside the public
  website. The catch-all claims every URL no other route claims, which includes
  addresses whose first segment belongs to another route group — so `/pay`,
  `/dashboard/nope` and `/admin/typo` were answered from the page store while the
  proxy, having classified them as not-the-website, left the framework's
  `s-maxage=15, stale-while-revalidate=31535985` on them, with no `Vary: Cookie` and
  possibly with the D2 marker `Set-Cookie` beside it. Measured on a container
  build of slice 1, against a pre-slice-1 baseline that answered
  `private, no-cache, no-store` on the same four URLs. Middleware runs before
  routing and cannot tell `/dashboard/nope` from `/dashboard/bookings`, so the
  fix is the rule that does not need to know which route answers: **an address
  outside the public website is never invited into a shared cache either.** On a
  real member or admin page the value is byte-identical to Next's own
  `revalidate === 0` default, so nothing a member is served changes. It covers GET
  **and HEAD**: a HEAD for a page is routed exactly as the GET is and takes the same
  framework directive, so restricting the rule to GET would make it true of bodies
  and false of headers. Widening to HEAD is the one change the fix makes IN
  territory: the proxy used to write nothing for `HEAD /about` (measured), so the
  framework's own directive reached the wire — the `s-maxage=15` measured for the
  GET of the same stored page, derived for HEAD from the routing being identical.
  An in-territory GET is byte-identical to before.

  The `s-maxage=15` above is the MEASURED wire value, not the `revalidate = 300`
  on `src/app/(website)/[...slug]/page.tsx`. They differ because `unstable_cache`
  shrinks the enclosing work unit's revalidate to the smallest nested value
  (`next/dist/server/web/spec-extension/unstable-cache.js`), and the public layout
  reads five tagged caches built at `SHORT_CONFIG_TTL_SECONDS = 15`
  (`src/lib/public-layout-config.ts`) — hence 15, and
  `31536000 − 15 = 31535985` for the stale-while-revalidate half. **The exposure
  window a reader sizes off these figures is the layout's TTL, not the page's
  export**: change `SHORT_CONFIG_TTL_SECONDS`, or take the last short-TTL cache out
  of the public layout, and the numbers here move. Nothing about the fix depends
  on them — the proxy refuses the whole class whatever the figure.
- **`/` is excluded only while the anonymous window is actually being sent, and
  the first cut of #2578 got that wrong.** It excluded `/` outright, arguing that
  `/` is `force-dynamic` so the framework writes `private, no-store` for it
  anyway. True, and still not safe: for a SIGNED-IN GET of `/`, and for any HEAD
  of `/` (the anonymous rule is GET-only), neither rule wrote a directive while
  the D2 marker `Set-Cookie` was still written — so the structural invariant
  below held on the busiest URL in the app only by virtue of a route export, which
  is the class of assumption #2578 exists to stop relying on and which #2352
  slice 2 (making `/` static) intends to change. The proxy now covers `/` exactly
  when the anonymous rule does not; today that value is byte-identical to Next's
  own, so nothing on the wire changes yet.
- **Two shapes deliberately keep another layer's directive, and the marker cookie
  is withheld on exactly those.** `/api/*` is one: the optional catch-all
  `api/[[...unmatched]]` claims the whole namespace so no `/api` address can come
  from the page store, the handlers there choose their own directives on purpose
  (`/api/skifield-conditions` answers `public, max-age=600,
  stale-while-revalidate=1800`), and a middleware header WINS over a route
  handler's — `sendResponse()` appends the handler's value only when the name is
  not already set. Asset-shaped URLs are the other: a real file is served by the
  filesystem under `send`'s set-if-absent `public, max-age=…`, and a miss is
  terminated at `/asset-not-found` with no document, so again there is no
  shared-cache directive to strip — and overriding would replace the club logo's
  and favicon's browser caching with `no-store` on every public page view. Both
  are answered by one predicate in the proxy (`isPageShapedPath()`), which also
  gates the D2 `Set-Cookie`, so the invariant holds structurally: **the proxy
  never emits a `Set-Cookie` on a response whose `Cache-Control` it has left to
  another layer.** One predicate was necessary and not sufficient — the review of
  the first cut found the invariant false at `/`, where the directive side had a
  carve-out the predicate knew nothing about (see the `/` bullet above). It now
  rests on two facts together: the hint sync is the proxy's only `Set-Cookie`
  writer and is gated on that predicate, and every path the predicate admits gets a
  directive from one of the two cache rules. A third `Set-Cookie` writer, or a
  second carve-out on the directive side, has to re-establish the pairing rather
  than inherit it, and BOTH facts are tested rather than only documented (review
  finding, 4 Aug 2026): the gating is mutation-proven, and the sole-writer half is a
  source-reading contract case that walks `src/proxy.ts`'s AST and fails on any
  `"Set-Cookie"` literal or `.cookies.set()` outside the hint sync. Without it a
  lodge-preference or consent-banner cookie added ahead of the header block would
  have left the whole suite green while `GET /branding/logo.png` shipped that cookie
  beside `send`'s `public, max-age=…`. The hint is NOT suppressed out of territory
  generally —
  `/login` and the member area are where the session state changes, so
  suppressing there would take the correction off the responses that need it —
  and it does not have to be, because those responses now carry `private` rather
  than a shared-cache directive.

  **One carve-in inside the asset exclusion: an odd-cased `/API/…`.** The rewrite
  that terminates asset misses compiles case-INSENSITIVELY (path-to-regexp's
  `sensitive` defaults to false), so its `(?!api/)` lookahead refuses `/API/x.png`
  as well as `/api/x.png`, while Next's route table is case-SENSITIVE, so no
  handler claims it either. `(website)/[...slug]` therefore renders the club's 404
  page for it, out of the page store, with the framework's `s-maxage` on it — the
  first cut of #2578 left exactly that on the wire, measured, over an unbounded
  URL space that scanners probe (`src/lib/__tests__/asset-url-404.test.ts` already
  pinned the routing). For header purposes such an address is a page, so it is
  treated as one; the real lowercase namespace is taken first, so nothing an
  `/api` handler can answer is affected.

  **The asset class is exactly `ASSET_URL_EXTENSIONS` (seven image extensions),
  which is narrower than "a file under `public/`".** Both halves of the exclusion's
  premise come from that list, so a static file of any other type — a self-hosted
  font, a PDF handbook — counts as page-shaped and is sent `private, no-store`,
  meaning a browser refetches it on every page view. `/robots.txt` is the only such
  file shipped today (`send` gave it `public, max-age=0`, i.e. revalidate every
  time, so the change is negligible), and `/sitemap.xml` is a genuine but NARROWER
  closure than an earlier draft of this bullet claimed.

  **What `/sitemap.xml` actually shipped, measured rather than derived (review
  correction, 4 Aug 2026).** The earlier wording said "as a static prerender with no
  `revalidate` it was shipping `s-maxage=31536000`", derived from
  `next/dist/server/lib/cache-control.js`. The build's own prerender manifest
  falsifies it: the entry for `/sitemap.xml` carries
  `initialHeaders["cache-control"] = "public, max-age=0, must-revalidate"` with
  `initialRevalidateSeconds: false`, because Next's metadata-route wrapper sets that
  header itself and `build/index.js` records it as `initialHeaders: meta.headers`.
  Serving reads the same `.meta` back into `cacheEntry.value.headers`
  (`server/lib/incremental-cache/file-system-cache.js`), and
  `build/templates/app-route.js` only fills a directive in when
  `cacheEntry.cacheControl && !res.getHeader('Cache-Control') &&
  !headers.get('Cache-Control')` — that third clause is false here, so
  `getCacheControlHeader()` is never reached for this URL and the year-long value was
  never on the wire. This is the same measured-versus-derived trap the `s-maxage=15`
  paragraph in `src/proxy.ts` warns about, caught on the other side.

  **The real residual on that URL, and why the fix still matters there.** `public,
  max-age=0, must-revalidate` forces validation on every reuse, so nothing stale
  could be served — the exposure was not duration but SHARING: a `public` answer
  carrying `Set-Cookie: signed-in-hint=1` with no `Vary: Cookie`, where a shared cache that
  revalidates, gets a `304`, merges its headers into the stored response and reuses it
  can hand that stored `Set-Cookie` to a stranger. The private-only directive closes
  exactly that, and it does reach this URL: `send-response.js` appends the cache
  entry's value only when the name is not already set, and `cache-control` is not in
  its `headersWithMultipleValuesAllowed` list, so the proxy's header (written first by
  the router server) wins and the entry's `public` value is dropped. App JS and CSS
  are unaffected — they live under
  `_next/static/`, which the matcher excludes. If a non-image static file is ever
  added, the single knob is `ASSET_URL_EXTENSIONS` in `src/lib/asset-url-404.ts`,
  which moves the rewrite, the setup gate's classifier and the proxy predicate
  together; adding an extension to the proxy alone would hand the framework's
  `s-maxage` back to every miss of that shape.
- **A response the proxy returns itself is sealed too, and by its OWN rule.** The
  #2420 holding screen already sends `no-store` with a `Retry-After`; a module
  gate's 404 for a page path carried no directive at all, which RFC 9111 lets a
  shared cache store heuristically, so it now gets the private-only value
  set-if-absent. The first cut reused the pass-through predicate here, which was a
  category error: its exclusions exist to protect ANOTHER layer's directive, and a
  response the proxy returns never reaches `send` or a route handler, so there is
  no other layer — measured through the proxy with the display module off,
  `GET /display/screen.png` came back 404 with no directive at all. The gate for these responses is therefore
  the method (GET and HEAD; the other verbs are unstorable without explicit
  freshness) plus the `/api` carve-out, which is what keeps #2405's module-state
  parity — a directive there would read as "the module is off". `/` gets no
  carve-out here: #2322's browser window belongs to the home page, not to a gate's
  404 served at that address.

The relaxed value survives the framework default because Next writes its own
`Cache-Control` only when the response does not already carry one
(`node_modules/next/dist/server/send-payload.js`:
`if (cacheControl && !res.getHeader('Cache-Control'))`). This holds in
production only — in development `base-server` overwrites the header
unconditionally, so a dev-server observation of this behaviour is a false
negative. Caddy neither sets nor rewrites `Cache-Control`, so the edge does not
override these values either.

**Flight requests, and why the directive is `private` rather than `public`
(#2404 re-review).** A React Server Components navigation returns a *different
body under the same URL*, and on stable Next builds `validateRSCRequestHeaders`
is off, so a `RSC: 1` GET of `/` is handed a flight payload rather than the HTML
document. Marked `public` with an `s-maxage`, that payload could be stored under
the HTML's cache key and served to ordinary document requests by any shared cache
that ignores `Vary`.

The proxy used to guard that by refusing to cache any request carrying `RSC`,
`Next-Router-State-Tree`, `Next-Router-Prefetch` or `Next-Router-Segment-Prefetch`.
**That guard could never fire, and the claim that it did was false.** Next's
middleware adapter (`next/dist/server/web/adapter.js`) DELETES every one of those
headers — Next's own `FLIGHT_HEADERS` list — before userland middleware runs,
and re-attaches them for the render afterwards; the `?_rsc=` cache-busting
parameter is stripped off `nextUrl` as well. Measured by running the real adapter
around the proxy: on a genuine flight prefetch, on a plain RSC navigation and on a
crafted bare `RSC: 1` GET, the proxy sees none of the four. `Purpose` and
`Sec-Purpose` do survive, but they mark a PREFETCH and a plain RSC navigation
carries neither, so no surviving signal identifies a flight request. **Middleware
cannot tell a flight request from a document request at all.**

So the property is held by the directive instead: `private` invites no shared
cache to store the response, whatever body Next goes on to produce for it. Next
also appends its own `vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch,
Next-Router-Segment-Prefetch` on app paths, which protects a *correct* shared
cache — but the threat being closed here is precisely a cache that ignores
`Vary`, so that is a second layer rather than the mechanism.

`public`/`s-maxage` must not be restored without a mechanism that can distinguish
a flight response, and middleware cannot be that mechanism; #2352 (static/ISR
public pages) is where such a mechanism would come from. The pin is in
`src/lib/__tests__/csp-proxy.test.ts`, which drives the REAL adapter rather than
constructing a `NextRequest` directly — direct construction is exactly how the
dead guard passed its tests for as long as it did.

**Accepted residual: non-steady-state renders of `/`.** The home page is
allow-listed unconditionally, so a transient screen it serves is
browser-cacheable for up to 60 seconds (300 stale) after the admin transitions
out of that state. Tag invalidation (`revalidateTag`) reaches Next's own data
cache but cannot reach an HTTP cache already holding the response, so the stale
screen simply expires. Self-healing, bounded by that lifetime, and affecting only
anonymous visitors during a content edit — accepted rather than special-cased,
since gating the allow list on render state would put a database read in the
proxy.

The screen this applies to is the 404 that renders while the home page content
is unpublished. It does NOT apply to the "site setup in progress" holding screen,
and #2420's review had to fix real code to make that true rather than assert it
(finding F4). The first attempt claimed the gate's own `no-store` was enough. It
was not: the gate returns before the allow list is consulted only when the GATE
believes setup is incomplete, and the layout could reach the opposite conclusion
independently. `getWebsiteThemeRenderState()` reported a FAILED `ClubTheme` read
as `isComplete: false`, identically to a genuine unfinished setup, so on a
long-live club a two-second database blip inside the layout's cache refresh —
while the proxy still held a cached "complete" — painted "Site setup in progress"
with a 200 and got it stamped `public, max-age=60, stale-while-revalidate=300`.
A launch-state lie, pinned in every anonymous visitor's cache, from an outage
already over.

Fixed at the root: that function now reports `readFailed` separately, and the
shared public chrome (`src/components/website/website-chrome.tsx`, which held this
branch as `(website)/layout.tsx` until the D1 narrowing extracted it) paints the
holding screen only on a POSITIVE answer. The
asymmetry with the proxy gate, which still fails closed on the same input, is
deliberate and is the general rule worth keeping — **503 is a true statement
about an unreadable database; a 200 that describes the club is not.**

## Prerendered Pages And The Nonce-Only CSP - 2026-07-31

Issue #2356. **A statically prerendered page can never satisfy this app's
production CSP.** The policy is nonce-only (`script-src 'self' 'nonce-…'`,
`src/lib/csp.ts`) and the nonce is minted per request in `src/proxy.ts`. Next
stamps that nonce into its inline bootstrap/RSC `<script>` tags only during
**dynamic** rendering, reading it back out of the request's own CSP header
(`next/dist/server/app-render/app-render.js` via `get-script-nonce-from-header`).
A route prerendered at build time was rendered once with no request, so it ships
inline scripts with no `nonce` attribute — and the browser blocks every one of
them, using the very header the same response carries. The page renders but never
hydrates.

This is a standing invariant, not a one-off bug. It has now been hit twice: the
lobby TV display (fork #54) and the global 404 (#2356).

- **Measured on a real build, before the fix.** `.next/server/app/_not-found.html`
  carried 24 `<script>` tags: 17 with `src=` (fine under `script-src 'self'`) and
  7 inline with no nonce. The emitted flight payload spells the cause out —
  every script entry serialised as `"nonce":"$undefined"`. Confirmed at runtime
  against the built server: a response served from that artefact carried
  `script-src 'self' 'nonce-…'` in its headers and a body byte-identical to the
  prerendered file, 0 of 7 inline scripts nonced. A *dynamically* rendered
  response in the same session had all of its inline scripts nonced, which is
  the contrast that isolates the mechanism.
- **How narrow the pre-fix exposure actually was, measured rather than
  assumed.** On the pre-fix build the frozen artefact was reached only by
  `/_next/data/*` and `/_error` — URL shapes a browser or an ordinary scanner
  does not request. Every human-plausible miss (`/definitely-missing`,
  `/wp-admin/setup-config.php`, `/.env`, `/admin/nope`,
  `/wp-content/uploads/x.php`) was claimed by the `(website)/[...slug]` CMS
  catch-all instead, rendered dynamically, and came back with the club's real
  title from the database and every inline script nonced. So the practical value
  of this change is CSP correctness on two synthetic shapes plus future-proofing
  — not the rescue of a broken visitor-facing 404. Say so plainly anywhere this
  is described to clubs.
- **Two latent defects travelled with the frozen artefact, both from "no request,
  no database at build time".** In the artefact, the `/404` page-content lookup
  (now `getPublishedPageContentByPath("/404")`, #2440) had failed at build and
  been swallowed by the surrounding catch, so the admin-authored `/404` CMS page
  could not appear in it — the hardcoded fallback was baked in. And the root layout's
  `generateMetadata()` fell back to `SAFE_DEFAULT_CONFIG`, baking the template
  placeholder club name and `http://localhost:3000` into that artefact's
  `<title>` and OG tags. Both were confined to the artefact, which is why they
  were invisible in normal browsing. Forcing dynamic rendering removes all three
  at once.
- **The reach is wider than the app route.** Next copies a prerendered app 404
  and global error to `server/pages/404.html` and `server/pages/500.html` and
  registers them in `pages-manifest.json`; `base-server` serves those copies for
  status pages that never enter the app render. Any audit of this property must
  look at `server/pages/**` as well as `server/app/**`.
- **The fix for the 404: `export const dynamic = "force-dynamic"` in
  `src/app/not-found.tsx`**, the same mechanism `src/app/display/page.tsx`
  already uses. Verified on the post-fix build: `/_not-found` leaves
  `prerender-manifest.json`, and `_not-found.html` and `pages/404.html` are no
  longer emitted. On the two shapes that previously hit the artefact
  (`/_next/data/*`, `/_error`) the response now renders per-request, keeps its
  404 status, carries the CSP header, and has zero unnonced inline scripts.
  - **Not a status claim about 404s generally.** The 200s recorded here —
    `/definitely-missing`, `/wp-admin/setup-config.php`, `/.env`, `/admin/nope`,
    `/foo%00bar`, `POST /definitely-missing` — were real, but the cause given
    was wrong, and #2405 re-measured them against a running app in both
    configurations. Corrected reading:
    - **The stated cause is refuted.** The shell is not flushing ahead of
      `(website)/[...slug]`'s database-bound `notFound()`. `notFound()` from a
      page is caught by Next's `HTTPAccessFallbackBoundary` *inside* the render
      and the status is set from the render's outcome, so there is no race with
      the wire to lose. Nothing in `(website)` has a `loading.tsx`, so the page
      is not behind a streaming boundary in the first place.
    - **What was actually measured was an unconfigured site.** On a club that
      has not completed site-style setup (`ClubTheme.completedAt IS NULL`), the
      shared public chrome — `(website)/layout.tsx` when this was measured, since
      the D1 narrowing `src/components/website/website-chrome.tsx` — returns its
      "Site setup in progress" screen
      INSTEAD of `{children}`. The page component never runs, its `notFound()`
      never fires, and **every** URL answers 200 — including `/about` and the
      other real pages. Verified directly: zero `PageContent` reads are issued
      for `/definitely-missing` in that state.
      `prisma/seed.ts` leaves `completedAt` NULL unless `SEED_THEME_COMPLETE=1`
      is set. CI's E2E stack DOES set it (`.github/workflows/e2e.yml`), as does
      `.env.staging.example` — but a locally prepared staging stack whose env
      file predates or omits that flag serves the holding screen for every URL,
      which is the configuration these 200s were recorded on. Check
      `ClubTheme.completedAt` before reading a status measurement off a local
      stack.
    - **With setup complete, every shape above already returns 404** — measured
      on the running app, and independently on a fully configured downstream
      staging build. `/api` misses were the genuine defect and were served the
      HTML page; they now terminate at `api/[[...unmatched]]/route.ts` with JSON,
      in either configuration. That route is an **optional** catch-all
      (double brackets) because the required form matches one segment or more,
      which left bare `/api` and `/api/` on the HTML path and made "in either
      configuration" untrue for them.
    - **The `generateMetadata()` guard in `(website)/[...slug]` is a tidy-up,
      not the mechanism, and the reason first given for it was wrong.** It was
      described as the version of the decision that survives a streaming
      boundary. Read against the vendored next@16.2.11 it is not:
      `create-component-tree.js` puts `MetadataOutlet` in the SAME `Fragment` as
      the page element, so a `loading.tsx` on this segment would wrap both
      together; and when metadata is streamed — the default for any agent
      outside `HTML_LIMITED_BOT_UA_RE`, which does not include Googlebot —
      `metadata.js` puts the outlet behind an EXTRA `Suspense`, committing the
      status LATER than the page's own `notFound()`. What the guard actually
      buys is the blocking-metadata path (the HTML-limited crawlers) and not
      computing metadata for a URL with no page. If #2352's static/ISR slices
      land, or a `loading.tsx` is added here, the decision has to move to a
      segment-level guard — this line will not cover it.
    - **That guard is deliberately gated on setup being complete, and this is a
      security property rather than a nicety.** The root not-found boundary sits
      ABOVE `(website)/layout.tsx`, so a `notFound()` raised in
      `generateMetadata()` escapes the holding screen: on a pre-launch club,
      unknown paths would answer 404 while published pages still answered 200,
      which is an enumeration oracle for an unlaunched site's page inventory,
      and the 404 body would serve database-backed content the club has not
      opened yet. `generateMetadata()` therefore reads the layout's own cached
      `ClubTheme` render state (no extra query, and only on the miss path) and
      keeps the previous title-fallback behaviour while `completedAt` is NULL.
      **#2420 does not retire that guard, it demotes it.** The setup gate runs
      in `src/proxy.ts` BEFORE the render, so no ordinary document request
      reaches this code path pre-setup at all — but the gate answers only for a
      path `isPublicWebsitePath()` CLAIMS, and asset-extension paths are refused
      on purpose (a 503 holding screen is a document, which must never answer a
      request for an image). A URL of that shape that no route serves still
      reaches this code, and this guard is what stops it raising a 404 that
      escapes the holding screen. Keep it: same defence-in-depth argument as the
      layout's retained pre-setup branch.
    - The remaining pre-setup soft 404 for PAGE URLs was tracked on **#2420**
      and is now CLOSED — see "The Pre-Setup Gate" below. An unconfigured site
      answers 503 for every public-website address, so the "every URL answers
      200" state described above no longer exists in any configuration. Do not
      read the bullet above as saying every 404 URL returns 404 in every
      configuration: pre-setup they return 503, by design.
- **A terminal `/api` 404 is a module-state oracle unless it matches the module
  gate (#2405 security review).** `src/proxy.ts` short-circuits an `/api` path
  whose module is switched off; with the module on the same path reaches a real
  handler, or `src/app/api/[[...unmatched]]/route.ts`. The property enforced
  here is narrow and worth stating exactly: **for one path under a gated prefix
  that no handler claims, the STATUS, BODY and `content-type` are identical
  whether the module is on or off, on every verb.** Header parity is NOT claimed
  in full — `vary` differs, and the reasons that is accepted rather than fixed
  are in "What \"a module's state cannot be read\" actually means" below, along
  with everything else known to remain readable. Two verb/body findings were
  found and closed:
  - **HEAD.** The route hand-wrote `HEAD` as `new NextResponse(null, { status:
    404 })`, which carries no `content-type`; the gate answers HEAD with its
    `NextResponse.json(...)`, which does. `HEAD /api/<gated-prefix>/zzz` with a
    `content-type` therefore meant "module off", and without one "module on".
    Fixed by DELETING the export: Next auto-implements HEAD from GET
    (`route-modules/app-route/helpers/auto-implement-methods.js`) and strips the
    body downstream, so the headers match the gate by construction and cannot
    drift. Hand-writing HEAD on any route that has to be indistinguishable from
    something else is the anti-pattern here.
  - **Non-standard verbs.** Next's app-route module rejects any method outside
    its seven (`GET HEAD OPTIONS POST PUT DELETE PATCH`) with a bare `400`
    before it resolves a handler, while the gate answered its JSON `404` to
    anything. `PROPFIND /api/<gated-prefix>/zzz` answering 400 meant "module
    on", 404 meant "off". `getFeatureFlagBlockResponse()` now takes the request
    method and mirrors the bare 400 for `/api` paths. Scoped to `/api`: a page
    is served by a different Next module with different verb handling, so the
    gate keeps its bodyless 404 there rather than claiming a parity nobody
    measured.
  - The parity is asserted verb-by-verb in
    `src/app/__tests__/unmatched-url-status.test.ts`, comparing status, raw
    response text (not parsed JSON — parsing hides key order and whitespace) and
    `content-type`, and resolving the route side through Next's own
    `autoImplementMethods()` so HEAD is checked as it is served.
  - **#2420 leaves this parity untouched, by construction.** The setup gate sits
    ahead of the module gate in `proxy()` but returns `null` for every `/api`
    path (the matcher drops them, and `isPublicWebsitePath()` refuses them
    again), so both sides of the comparison above behave identically whether or
    not site setup is complete.
- **The cost is small, and was checked rather than assumed.** #2351 measured a
  cold dynamic render at ~3.5-5 CPU-seconds, so "every 404 now costs a render"
  deserved scrutiny — bot traffic on nonexistent URLs is real load. It turns out
  the app was already paying it: the `(website)/[...slug]` CMS catch-all claims
  essentially every mistyped or probed URL, reads the database, and calls
  `notFound()`, which renders this boundary dynamically. Only the narrow set of
  paths that bypassed the catch-all and hit the static artefact changes cost.
- **`src/app/global-error.tsx` cannot use the same mechanism, and separately, the
  prerendered "global error" artefact is not this app's page at all.** Two
  distinct facts that are easy to conflate:
  - A global error boundary must be a Client Component (Next's own
    `docs/01-app/03-api-reference/03-file-conventions/error.md`, which is also
    why `metadata`/`generateMetadata` are unsupported there), and route segment
    config is not read from a client module. `export const dynamic =
    "force-dynamic"` in `src/app/global-error.tsx` was tried and measured: the
    build accepts it with no error and no warning, and `/_global-error`
    prerenders exactly as before — a silent no-op.
  - But `.next/server/app/_global-error.html` (9,387 bytes) and its
    byte-identical `server/pages/500.html` copy are **Next's own built-in error
    shell**, not a render of `src/app/global-error.tsx`. Their visible text is
    "500 — This page couldn't load — A server error occurred. Reload to try
    again — Reload"; the strings this repo's page renders ("Something went
    wrong", "Try Again", "Go to Home Page") appear zero times, as does any
    `<a href="/">`. The framework emits that shell with 6 unnonced inline
    scripts and nothing in this repository influences it.
  - Consequence for the allowlist in
    `scripts/ci/check-prerendered-script-nonces.mjs`: those two entries are
    carve-outs for a **framework** artefact, and they will fall away only if a
    Next release starts nonce-ing its own shell — not if this app's global error
    page becomes fixable. The allowlist comment says exactly that; keep it that
    way.
  - `src/app/error.tsx` exists and handles the ordinary case, so
    `global-error.tsx` is reached only when the root layout itself fails. When it
    is reached it renders dynamically in the failing request, with the nonce, and
    hydrates normally. The plain `<a href="/">` it now renders is therefore
    ordinary progressive enhancement — an escape route that survives a failed or
    blocked hydration — not a rescue of the static artefact, which contains none
    of this app's markup. Do not replace it with a `<Link>` or an `onClick`
    handler.
  - Server-side reporting for app-render errors goes through `onRequestError` in
    `src/instrumentation.ts`. Until #2356 that hook lived in
    `src/instrumentation.node.ts` — a module Next never reads it from, since the
    framework looks only at the `instrumentation` convention entry — so it had
    never run at all: the compiled convention entry exported `register` and
    nothing else. To re-check that, read the emitted **chunk**, not
    `.next/server/instrumentation.js` — that file is a ~160-byte Turbopack
    wrapper (`R.c("server/chunks/<hash>._.js"); module.exports =
    R.m(<id>).exports`) and contains neither name before or after the fix. The
    chunk it loads carries the export list. It is wired now — that chunk's
    export list reads `["onRequestError", …, "register", …]`, verified in a
    rebuild — and `src/lib/__tests__/instrumentation-hooks.test.ts` asserts it
    stays on the convention module and is reached there directly, not via a
    static re-export from `instrumentation.node` (which would drag Prisma and
    node-cron into the edge bundle). It also now records the request `path` Next
    actually passes; the old dead copy read a `request.url` that does not exist.
    Router errors never reach this channel: Next resolves `notFound()` and
    `redirect()` to a digest first, and the Sentry configs additionally ignore
    `NEXT_HTTP_ERROR_FALLBACK` (the prefix `notFound()`/`forbidden()`/
    `unauthorized()` actually throw on Next 16 — the long-standing
    `NEXT_NOT_FOUND` string matched nothing and was corrected in this work) and
    `NEXT_REDIRECT`.
- **Enforced by `scripts/ci/check-prerendered-script-nonces.mjs`**, run in the
  `verify` job immediately after `npm run build` (the only point where the
  property is observable). It walks every `.html` under `server/app/**` and
  `server/pages/**` and fails on any inline `<script>` without a non-empty
  `nonce`. `nonce=""` counts as unnonced, because it matches no `'nonce-…'`
  source expression and is blocked just the same. Data blocks the browser never
  executes (`type="application/json"`, `type="application/ld+json"`) are skipped,
  because `script-src` does not govern them; `type="module"`,
  `type="importmap"` and anything unrecognised are still checked. A missing build
  directory, a missing scan root, or a scan that finds no HTML at all throws
  rather than reporting success. The two framework artefacts sit on a closed,
  reason-carrying allowlist, and each allowlisted entry is itself asserted to
  still exist and still offend, so a carve-out cannot quietly outlive its reason.
  `scripts/ci/check-prerendered-script-nonces.test.mjs` pins the rules without
  needing a build.
- **What this guard does NOT cover, and it is the bigger half of the class.** It
  reads emitted HTML, so it can only see pages Next prerendered. It cannot see a
  page that renders dynamically but never receives a CSP header in the first
  place. There were two ways for a request to arrive without one, and #2404
  closed both: by URL SHAPE (anything the matcher's asset exclusions skip, whose
  miss then rendered the CMS 404 document) and by HEADER (a bare `Purpose:
  prefetch` skipped the matcher on every URL — the whole exemption is now gone,
  so no header does). The measurements, both fixes, and
  the guards that now cover the runtime half are in "Static-Asset URLs And The
  Nonce-Only CSP" below. Read this bullet as "this particular script enforces
  prerendered output only", not as "the runtime class is unenforced".
- **Interaction with #2352.** The constant-per-deploy nonce proposed for public
  routes would make a fixed nonce value available at build time and so would
  dissolve this whole class — including Next's own built-in error shell, which
  nothing else can reach. This fix does not conflict with it: it adds no CSP
  surface and no new policy branch, only a per-request render for one route. If #2352 lands, the
  `force-dynamic` here becomes a performance question rather than a correctness
  one and can be revisited on its own merits; the CI guard above stays useful
  either way, since it asserts the outcome (no unnonced inline script ships)
  rather than the mechanism.

## The Pre-Setup Gate - 2026-08-01

Issue #2420, closing the residual #2405 left open. **Until a club completes
site-style setup, every public-website address answers `503 Service Unavailable`
with the "Site setup in progress" holding screen.** Before this, that same
holding screen was served with `200 OK` from `(website)/layout.tsx` for *every*
address — real page, typo, and bot probe alike — which is the configuration the
#2356 measurements above were actually taken on.

- **Where the decision lives, and why it could not stay in the layout.**
  `src/lib/setup-gate.ts`, called from `src/proxy.ts` before anything else. A
  layout cannot set a status code: `notFound()` is the only status a React
  render can raise and it means something else. The proxy is the only place that
  runs before every request and can write a status, and a middleware response
  body is the only middleware outcome whose status Next actually propagates —
  `NextResponse.rewrite(url, { status })` does **not** (verified in the vendored
  `next@16.2.11`: `server/lib/router-utils/resolve-routes.js` propagates
  `middlewareRes.status` on the direct-response and `location` branches only,
  never on the rewrite branch). Do not "simplify" this into a rewrite.
- **Two choices made explicitly rather than by default**, both stated in the code
  and both owner-visible:
  - **A real published page is 503 during setup too**, not 200. Serving 200 for
    `/about` and 503 for `/nope` would publish the club's page inventory from a
    half-built install and let a crawler index pages before the club has chosen
    how they look.
  - **`Retry-After: 120` is sent** on every gated 503. A bare long-running 503
    is a signal to start dropping a site's URLs from an index; 503 plus
    `Retry-After` is read as a temporary outage. The value is short because
    completion is one human save away and the gate re-reads its state within 15
    seconds of it. `Cache-Control: no-store` rides along, because `/` is
    otherwise allow-listed as browser-cacheable for 60 seconds
    (`getAnonymousPageCacheControl`) and the holding screen must not outlive
    setup in anyone's cache.
- **What is deliberately NOT gated**, so an operator part-way through setup can
  finish it: the admin area (including `/admin/site-style` itself), the login and
  password-recovery flows, the member/lodge/finance areas, the lobby display,
  `robots.txt`/`sitemap.xml`/`favicon.ico`, and everything under `/_next`.
  `/api/*` is excluded twice over — by the proxy matcher and by the gate's own
  path test — which is what keeps `api/[[...unmatched]]/route.ts` (#2405)
  answering JSON 404, and the module gate's verb parity above intact, in both
  setup states. The exclusion list is a **deny** list because
  `(website)/[...slug]` claims every URL no other route group claims;
  `setup-gate.test.ts` walks `src/app/**` and fails if a top-level route is added
  outside `(website)` without being listed, so the list cannot quietly go stale.
- **The holding screen needs no static asset to render.** The proxy cannot
  reference the app's compiled stylesheet (its URL carries a build hash the proxy
  has no way to know), so the 503 body is a complete self-contained document:
  the club's own theme CSS inlined exactly as the layout inlines it, plus a short
  inline stylesheet, no images and no scripts. That is why the "don't 503 the
  assets the screen needs" constraint is satisfied trivially — there are none.
  Two of the three admin-editable values interpolated into it — club name and
  contact address — are HTML-escaped. **The third, the theme CSS, is not, and
  cannot be:** it is injected raw into a `<style>` element, exactly as the shared
  public chrome (`src/components/website/website-chrome.tsx`, extracted from
  `(website)/layout.tsx` by the D1 narrowing) injects it, and its safety rests
  entirely on `sanitiseRawCss()` stripping every `</style` sequence from the admin-authored
  `rawCss`. Say it that way round rather than "the interpolated values are
  escaped", because the review found that sanitiser broken (finding F2, below)
  and the earlier wording would have let a reader conclude the 503 page was safe
  by construction. It is safe by dependency.
- **It adds no per-request database read.** The setup state — and, while
  incomplete, the fully rendered document — is memoised for 15 seconds behind a
  single-flight promise, matching the TTL of the tagged cache the layout reads
  the same `ClubTheme` row through. Once setup is complete the cached answer is a
  bare boolean and the club identity and contact address are never read at all.
  The proxy is bundled separately from route handlers, so the `revalidateTag`
  the site-style save issues cannot reach this memo; the TTL is the propagation
  bound, and it is why the site opens within 15 seconds of the save rather than
  instantly.
- **Fails CLOSED.** A failed `ClubTheme` read leaves `isComplete` false, so a
  database outage is answered with the holding screen and a 503 — which is what
  503 literally means. Failing open would restore the 200-for-every-address
  defect under exactly the conditions that make it hardest to notice. Note the
  deliberate asymmetry with the render-time fallback in
  `src/components/website/website-chrome.tsx` — `(website)/layout.tsx` until the D1
  narrowing extracted it, and now the one copy shared by both public route groups —
  which since finding F4 does the OPPOSITE on the same input: see the `/` caching
  residual above.
- **The gate has two preconditions — the proxy must RUN, and the classifier must
  CLAIM — and the layout and metadata guards behind it are load-bearing because
  of the second.** The first used to be bypassable by anyone: the `missing:`
  clause skipped any request carrying `next-router-prefetch` or
  `purpose: prefetch`, so a bare `curl -H 'Purpose: prefetch' https://club/about`
  reached the app with the proxy, and therefore the gate, skipped entirely. An
  earlier draft of this section described that as "a prefetch issued from an
  admin page"; that was wrong, and the correction mattered, because it moved the
  layout's retained pre-setup branch and the `(website)` metadata guard from
  belt-and-braces to the only thing standing on that path.
  - **#2404 closed the header route in completely** (see "The other way in: the
    prefetch headers"): the exemption was first narrowed to a real flight
    prefetch and then, on the owner's decision, deleted. There is no combination
    of request headers that takes a URL outside the proxy.
  - **Nothing below is demoted, because the second precondition still holds
    open a path.** `isPublicWebsitePath()` deliberately refuses asset-extension
    paths — the holding screen is an HTML **document**, and answering a request
    for an image with one is the whole of #2404 — so a URL of that shape that
    reaches a render is rendered with no gate in front of it. The live shape is
    `/API/x.png`: the `afterFiles` rewrites hand it back unchanged (they match
    case-insensitively, so it is never terminated as a miss), and Next's own
    route table is case-SENSITIVE, so no `/api` route claims it and the
    `(website)` catch-all renders it. These guards are what stop that render
    showing the real site or its page inventory.
  - The chrome's branch answers 200 — a layout or component cannot set a status,
    which is precisely why the authoritative decision is in the proxy — and
    substitutes
    the holding screen for `{children}`. Only the copy is shared with the 503
    document (`SETUP_IN_PROGRESS_COPY`); a test pins that both surfaces use it.
  - **Suppressing `{children}` is not enough on its own, and the review found
    the gap (finding F1).** In the vendored next@16.2.11 the document head is a
    SEPARATE flight slot from the page's seed data (`app-render.js` builds
    `initialHead` alongside `seedData`, and `createMetadataComponents()` resolves
    from the loader tree), so `generateMetadata()` still runs and still emits
    `<title>` and `<meta name="description">` for a page whose component never
    executed. Worse, the `[...slug]` guard consulted the setup state only inside
    `if (!page)`, so pre-setup a miss answered with the club name while a HIT
    answered with the page's own title and header text — the enumeration oracle
    the guard existed to prevent, merely inverted. `/`, `/contact`, `/join` and
    `/join/apply` had no guard at all, and — until #2440 — `/contact` and
    `/join` looked their content up with no `published === false` filter, so an
    unlaunched club also disclosed pages it had explicitly unpublished. (Closed
    post-setup as well as pre-setup: every public render path now reads through
    `getPublishedPageContentByPath()` in `src/lib/page-content-html.ts`, which
    treats an unpublished row as absent, and a contract test bans the
    unfiltered by-path read from application code outside that module so the
    routes cannot drift apart again.) Measured effect at the time: an anonymous
    prober with a slug wordlist could recover the full page inventory of a site
    that had never opened, plus each page's title and header text.
  - Closed by `src/lib/website-setup-metadata.ts`. Every `generateMetadata()`
    under `(website)` calls it FIRST — before any lookup, and on the hit path as
    well as the miss path — and returns a neutral head whose `<title>` is
    byte-identical to the 503 document's, with `noindex` to match. A guard that
    fires only on a miss is worse than none, so the property under test is
    uniformity: hit, miss and unpublished must be indistinguishable.
    `website-metadata-setup-gate.test.ts` walks the route tree and fails if a new
    page skips the helper.
- **This gate is a LAUNCH-STATE SIGNAL, not a security boundary.** It exists so
  an unlaunched club does not advertise, or let a crawler index, content it has
  not opened — and so machines are told "not ready yet" rather than "fine". It is
  NOT authorisation. Everything reachable behind a `(website)` URL — route
  handlers, server actions, the CMS reads themselves — must keep its own
  enforcement and must never be written as though the gate had already refused
  the caller, exactly as the module gate is qualified in the surface table above
  ("keep route-level auth as the enforcement boundary"). The bypass in the bullet
  above is the concrete reason: a header anyone can set removes the gate from the
  request path.
- **`sanitiseRawCss()` was a single-pass replace, and a single pass is not a
  sanitiser (finding F2).** `src/lib/club-theme-schema.ts` stripped `</style…>`
  with one `String.replace`, which makes ONE pass over the ORIGINAL string and
  never re-scans text its own deletions splice together. Verified by execution:
  `</sty</style>le><script>alert(1)</script>` came out as
  `</style><script>alert(1)</script>` — a live breakout from the `<style>`
  element's rawtext mode. Reachable pre-setup, because `saveClubTheme()` persists
  `rawCss` while leaving `completedAt` NULL whenever `completeSetup` is false, so
  a half-finished wizard is enough to arm it. Pre-existing — the `(website)`
  layout has always inlined the same value — but #2420 adds a second consumer
  that serves it to every anonymous visitor as the 503 body, which is what
  brought it to light. Fixed by repeating to a FIXPOINT, with the `>` made
  optional so a trailing `</style` cannot borrow the closing tag's own `>`; the
  postcondition is now absolute and asserted as such — the output contains no
  `</style` in any case. The same fix closes the hole for the layout and for the
  lobby-display CSS tokens, which share the function.
- **The matcher and the gate's classifier disagreed, so some website URLs were
  never gated (finding F3).** The gate runs INSIDE `proxy()`, so a URL the
  matcher skips is a URL the gate cannot answer. Three alternatives in the
  matcher's negative lookahead were bare PREFIXES rather than anchored tokens, so
  `/apiary` and `/api-docs` (`api`), `/logo.pngs` (`logo.png`), and
  `/favicon.icons` plus `/faviconXico` (`favicon.ico`, dot unescaped) all skipped
  the proxy while `isPublicWebsitePath()` called them website paths. Measured:
  they answered 200 pre-setup, and carried no CSP header at any time. Reconciled
  in both directions on purpose — the three prefixes were anchored in the matcher
  because those are genuine website addresses, while the image-extension
  alternative stays a skip and the classifier was narrowed to agree, because
  minting a nonce on every image request is the worse trade.
  `csp-proxy.test.ts` now asserts the invariant directly: every path the
  classifier claims must be matched by `config.matcher`.
  - **Stated limit that follows from that choice.** Pre-setup, an asset-shaped
    URL that no file backs (`/gallery.svg`) is answered by the app rather than
    the gate, so its status is 200 rather than 503. It carries no club content —
    the layout still substitutes the holding screen — but "every public-website
    address answers 503" is true of pages, not of asset-shaped paths.
  - **Superseded in part by #2404 (1 Aug 2026).** The matcher's image-extension
    exclusion was removed, so the reconciliation no longer runs "in both
    directions": the matcher now covers strictly more than the classifier claims,
    and the subset invariant holds with room to spare. The classifier's refusal of
    asset shapes stays, on a different and stronger reason — the holding screen is
    an HTML document and must never be the answer to a request for an image — so
    the stated limit above stands, except that such a URL now answers an empty 404
    rather than 200.
- **Measured on the wire, not just on the object (finding F5).** The unit suite
  asserts on the `NextResponse` that `proxy()` returns, which is precisely the
  layer at which the rewrite-status trap above LOOKS correct. `e2e/pre-setup/`
  runs as its own Playwright project, last (`dependencies: ["chromium"]`), and
  reads the real status line: 503 with `Retry-After` and `no-store` on `/`, on a
  real page and on a miss; the admin area, `/login` and the `/api` JSON 404
  unaffected; and the site reopening once setup is completed. It needs no second
  stack — it un-completes `ClubTheme.completedAt` directly and restores it in
  `afterAll`, which is unavoidable because `saveClubTheme()` deliberately has no
  path that clears that column. Safe where it sits: `workers: 1`,
  `fullyParallel: false`, and nothing runs after it.
- **Interaction with #2352 (static/ISR for public routes).** The gate is
  deliberately not a render-time check, so making `(website)` routes static
  cannot bypass it — the proxy still runs on the request even when the body would
  be served from a prerender. The direction #2352 must handle is the reverse: a
  page prerendered while setup was incomplete has to be revalidated on
  completion, or the first post-setup visitor is served a cache entry built under
  the holding screen. The note is repeated in `setup-gate.ts` where the decision
  lives.
- **Measurement trap, unchanged and still worth stating.** `prisma/seed.ts`
  leaves `ClubTheme.completedAt` NULL unless `SEED_THEME_COMPLETE=1`. A local
  stack without that flag now answers **503** for every public address rather
  than 200 — a different wrong reading of the same misconfiguration. Check
  `ClubTheme.completedAt` before trusting any locally measured status.

## Static-Asset URLs And The Nonce-Only CSP - 2026-08-01

Issue #2404, the runtime half of the class #2356 opened. **A URL the proxy matcher
skips gets no nonce and no policy of ours — and until this landed, some of those
URLs still rendered a full HTML page.**

`src/proxy.ts` mints the CSP nonce per request, and its `config.matcher`
used to skip static-asset shapes: anything ending in an image extension, two
named files (`favicon.ico`, `logo.png`), plus `_next/static` and `_next/image`.
#2420 re-affirmed that exclusion on the grounds that a real asset must never pay
a nonce mint on the hottest path in the app, and `csp-proxy.test.ts` asserted
those shapes stayed outside the matcher.

It was wrong for a file that does NOT exist. The miss fell through to the
`(website)/[...slug]` CMS catch-all, which called `notFound()` and rendered the
club's entire "page not found" document — with no nonce on any inline script,
because the thing that mints nonces had been skipped, and with no
`Content-Security-Policy` header at all. `Caddyfile`'s set-if-absent
`?Content-Security-Policy "default-src 'self'"` then supplied a policy carrying no
`'nonce-…'` source, which blocked every one of those scripts. The same end state as
#2356, on the URL shapes bots actually hit.

**Measured pre-fix, anonymously, against a production build of the app** —
`/foo.png` 404 with ~29KB of `text/html`, no CSP header and 19 unnonced inline
`<script>` tags; `/favicon.ico`, `/logo.png`, `/wp-content/uploads/x.jpg`,
`/branding/favicon.ico`, `/_next/static/chunks/nope.js` and `/_next/staticfoo` all
the same shape at 18 each; the control `/definitely-missing` 404 with a nonced
policy and 0 unnonced. **Provenance matters here and is stated rather than
implied:** those figures were taken on a developer-host build, so treat them as
indicative of the defect's shape and size, not as a platform measurement. The
authoritative runtime measurement is `e2e/asset-url-404.spec.ts`, which runs
against the Linux container stack in CI's Playwright job and asserts the same
properties on the wire.

- **#2434 fixed the `/api` half of this and nothing else.** Unmatched `/api` URLs
  terminate at `src/app/api/[[...unmatched]]/route.ts` with a JSON 404: no
  document, no inline script, so the missing CSP header costs nothing there. #2434
  also turned `/foo.png` from a soft 200 into a 404 — the status was fixed, the CSP
  was not. Do not read "#2405 is closed" as "asset URLs are safe".
- **#2420 fixed three bare prefixes, and left two.** Its finding F3 anchored `api`,
  `favicon.ico` and `logo.png`, which had been excluding `/apiary`, `/api-docs`,
  `/favicon.icons`, `/logo.pngs` and `/faviconXico`. `_next/static` and
  `_next/image` were still bare, so `/_next/staticfoo`, `/_next/imagemap` and
  `/_next/image/x` were skipped the same way — ordinary addresses no framework
  handler claims, served with no CSP header. #2404 anchors those two.
- **Two of those alternatives were excluding nothing at all.** No `favicon.ico`
  and no `logo.png` exist to be served: the app's shipped imagery lives under
  `public/branding/`, and the root layout points at `/branding/favicon.ico`.
  Anchoring them in #2420 stopped them catching neighbouring addresses, but left
  two URL shapes that skipped the proxy for no benefit whatever. #2404 deletes
  them. If either file is ever added, the filesystem serves it ahead of any
  rewrite and the entire cost of the proxy running on it is one nonce mint.
- **The two anchors deliberately differ in shape.** `_next/static` is a DIRECTORY,
  so only `/_next/static/…` is ever served and a trailing slash is the whole
  exclusion; `_next/image` is a single ENDPOINT taking a `?url=` query, so only the
  exact path is served and `$` is. Each now excludes precisely what the framework
  serves and nothing else.

### The fix: two layers, and how they compose

1. **`afterFiles` rewrites remove the render** (`next.config.ts`; rules in
   `src/lib/asset-url-404.ts`). A path OUTSIDE `/api` ending in an asset
   extension, or anything under `_next/static`, is rewritten to
   `src/app/asset-not-found/route.ts`, which
   answers **404 with an empty body and no `content-type`**. An empty body is the
   security property, not a shortcut: with no document there is nothing a
   nonce-less policy has to permit, so the absent nonce stops mattering rather than
   being worked around. It also removes a render amplifier — every probe of
   `/wp-content/uploads/x.png` used to buy a full dynamic render, and bots probe
   those addresses continuously.
2. **The matcher's asset exclusions are then removed as well** (owner decision,
   1 Aug 2026, "Option A"), so the proxy runs on those URLs too. The two are
   complementary rather than alternatives. Removing the render makes the absent
   nonce harmless, but it cannot put a `Content-Security-Policy` on the response
   and it cannot bring the URL inside the #2420 pre-setup gate — a URL the matcher
   skips is a URL nothing of ours can attach a header to. What is left excluded
   from the MATCHER is `/api` (its own JSON terminal, with the explicit
   `/api/…` matcher entries re-admitting every module-gated prefix),
   `_next/static/` and `_next/image$`.
3. **The cost was measured before the decision, not assumed.** On the compiled
   matcher the shorter lookahead is marginally *cheaper* per request (~1.4 ns);
   the genuinely hot shape — the dozens of `/_next/static/…` chunk requests one
   page load issues — is still excluded by its own alternative; and `public/` holds
   only `branding/*` and `robots.txt`, so the real asset requests newly running the
   proxy are few. Those responses serve identical bytes and gain the app's
   security headers, which they did not previously carry.

**How the two layers compose on the wire.** An asset-shaped miss now meets both:
the proxy answers first and sets the per-request page policy plus the security
headers, then the rewrite terminates the request at the empty 404. Which
`Content-Security-Policy` reaches the client is decided by the framework and is
recorded here rather than left to be discovered — Next appends a route handler's
header only when that name is not already set on the outgoing response
(`next/dist/server/send-response.js`), and the router server applies the
middleware's headers first (`server/lib/router-server.js`). So the proxy's nonced
page policy ships wherever the proxy runs, and the terminal route's tighter
`default-src 'none'` ships for the shapes it still skips (`/_next/static/…`) and
as the floor if the matcher ever stops covering a shape. Both are correct answers
for an empty body, and the property that matters — a policy always ships, from
whichever layer answered — holds either way. `X-Content-Type-Options`,
`X-Frame-Options` and the rest are identical in both layers, so nothing there
depends on the order.

**One consequence of running the proxy on more shapes, stated rather than
discovered.** An asset-shaped URL under a module-gated PAGE prefix
(`/lodge/x.png`) now reaches the module gate and behaves like its non-asset
siblings: with the module off it is answered by the gate, with it on by the
rewrite. Both answers are an empty 404 with the same status, the same absent
`content-type` and the same empty body — pinned in `asset-url-404.test.ts` — and
both carry the proxy's nonced policy and security headers, because the proxy runs
on this URL in either state and the composition rule above gives its headers
precedence. They are still not byte-identical on the wire, and the difference is
stated rather than glossed: a middleware short-circuit is sent chunked while the
terminal route handler sends `Content-Length: 0`. That is no
new module-state oracle, because with the module off `/lodge` ITSELF answers an
empty 404 while with it on the same address answers a 200 page — a strictly
louder signal on the identical flag, and one the module gate cannot avoid. It
does mean a static file placed under a gated prefix would become gated; nothing
in `public/` sits under one today.

Under `/api` the same reasoning does NOT apply and the parity is exact, because
there the whole point is that the URL gives no signal at all. That is why both
`/api` rewrite rules are identities — see below.

- **`afterFiles` is the only stage that works.** Next checks the filesystem —
  `public/`, `_next/static`, the non-dynamic routes — BEFORE consulting an
  `afterFiles` rewrite, so a real asset is served exactly as before and never
  reaches these rules; only a miss does. `beforeFiles` would shadow every real
  asset; `fallback` runs after `(website)/[...slug]` has already turned the URL
  into a render. Getting this wrong 404s every image in the app, which is why the
  E2E spec asserts a real `public/branding/*` file and a real
  `/_next/static/chunks/*.js` still answer 200 with their bytes.
- **No rewrite rule may match an `/api` URL at all — not even an identity — and
  that is the central security decision here** (owner decision, 1 Aug 2026;
  corrected by the #2404 re-review). #2405's parity property is that a path under
  a module-gated prefix that no handler claims must answer the same bytes AND the
  same headers whether the module is ON or OFF. With it off, `src/proxy.ts`'s
  gate answers `{"error":"Not found"}` as `application/json` from middleware and
  routing stops there — its matcher entries (`/api/chores/:path*` and friends)
  match whatever the URL's tail looks like, `.png` included — so **no rewrite runs
  in the module-off state**. Anything a rewrite does in the module-ON state is
  therefore a difference an anonymous prober can read.
  - **The body half.** An asset-shaped `/api` URL must not reach the empty-bodied
    404: that reply has no `content-type` where the gate's has one.
  - **The header half, and it is why an identity is not enough.**
    `resolve-routes.js` makes TWO independent comparisons on an RSC request:
    it sets `x-nextjs-rewritten-path` when the destination PATHNAME differs from
    the request path, and `x-nextjs-rewritten-query` when the destination SEARCH
    differs. `prepareDestination()` gives a query-less destination an empty
    search, and no destination can reproduce the request's own query string — so
    an identity rewrite ships `x-nextjs-rewritten-query` for every probe that
    appends `?x=1`, present with the module on and absent with it off. An earlier
    cut of this fix used identity rewrites for exactly this parity and closed only
    the path half; `curl -H 'RSC: 1' '/api/<gated-prefix>/zzz.png?x=1'` still read
    the flag, across roughly twenty optional modules, two of which
    (`addressAutocomplete`, `groupBookings`) have no page surface to probe at all.
    Measured with Next's own `getPathMatch()` and `prepareDestination()` compiled
    under `router-utils/filesystem.js`'s exact options.
  - **So the general rule carries a leading `(?!api/)` lookahead and there is no
    `/api` rule of any kind.** With no rewrite running on `/api` in either module
    state, neither header can ship in either state — which is also exactly how the
    app behaved before this rewrite layer existed. The lookahead's trailing slash
    is the anchor: `/api.png`, `/apiary-photo.png`, `/apis/logo.png` and
    `/nested/api/x.png` are ordinary addresses and are still terminated.
  - **Why a lookahead is safe now, when the first cut of #2404 rejected one.**
    That cut argued a lookahead was itself a hole: Next compiles the middleware
    matcher case-SENSITIVELY and `rewrites` case-INSENSITIVELY (path-to-regexp's
    `sensitive` defaults to false), so `/API/x.png` was skipped by the matcher
    (its `.png` tail) AND excluded by the rewrite (its `/api` carve-out) and still
    rendered an unnonced document. Option A removed the premise — the matcher no
    longer excludes asset extensions, so the proxy runs on `/API/x.png` and it is
    nonced and policy-carrying like any other page. The lookahead compiles with
    the same `i` flag as the rest of the rule, so it excludes `/API/`, `/Api/` and
    `/api/` symmetrically: no case seam, and no dependence on rule order.
  - **Consequence for an odd-cased `/API/x.png`, recorded rather than hidden.** No
    rule claims it, and it matches no `/api` route either (Next's route table is
    case-sensitive), so the `(website)/[...slug]` catch-all renders the club's 404
    page for it. That is a wasted render, not a missing nonce — since Option A the
    proxy runs on it — and it is the same outcome `/foo.avif` gets from an
    unlisted extension. It is also the reason the layout's pre-setup branch and the
    `(website)` metadata guard stay load-bearing: that render is not covered by the
    setup gate.
  - **Leaving `/api` alone is not a gap in the original fix.** An unmatched
    asset-shaped `/api` URL lands on `api/[[...unmatched]]` and gets the same JSON
    any other unmatched `/api` URL gets — a route handler, never a document — so
    the render this issue exists to remove was never on that path in the first
    place.
- **One route is exempted in its own right, because it really does serve
  extension-suffixed URLs.** `src/app/api/images/uploaded/[...path]/route.ts` is
  the production URL for every admin-uploaded image: `imagePublicUrl()` in
  `src/lib/image-storage.ts` mints `/api/images/uploaded/…`, and `Caddyfile`
  rewrites `/images/*` onto the same route. The first cut of this fix routed all
  of them to the `/api` JSON 404 and every uploaded picture in the app
  disappeared. The `(?!api/)` lookahead covers it along with the rest of the
  namespace: no rule claims those URLs, so routing reaches the real handler
  untouched. Guarded twice: a
  unit guard walks every `route.ts` under `src/app`, builds a concrete
  extension-suffixed URL for each, and fails unless the rewrites leave it exactly
  where routing would have taken it (no destination naming is involved, which is
  how an earlier version of that guard passed vacuously); and
  `e2e/asset-url-404.spec.ts` uploads a real image through the admin API and
  fetches it back anonymously on the wire.
- **A stale extension list is a cost regression, not a security one, and the
  layering is what makes that true.** `/foo.avif` is not in the list, so it renders
  the club's 404 page instead of an empty one — but the proxy runs on it, so it is
  nonced. Since Option A the proxy runs on every extension, so nothing missing from
  the list can reproduce the original defect at all.
- **The list's remaining coupling moved, and it is now the sharper one.** The
  extensions the rewrites terminate must stay in step with the shapes
  `isPublicWebsitePath()` refuses in `src/lib/setup-gate.ts`, not with the matcher.
  An extension terminated by a rewrite but unrecognised by that classifier would be
  treated as a public-website address, and on a club whose setup is incomplete the
  gate would answer it with the "Site setup in progress" screen — an HTML
  **document** on an asset URL, which is this issue reopened through the gate.
  `isPublicWebsitePath()`'s refusal of asset shapes therefore stopped being a
  mirror of the matcher string and became an independent rule with its own reason,
  recorded next to it; the guard drives it through the real function and fails on
  drift.
- **`/asset-not-found` is itself a reachable URL** and answers exactly what it
  answers for rewritten traffic: an empty 404. It has no extension, so it cannot be
  rewritten into itself, and a URL that does not exist answering 404 is the right
  outcome whoever asks. It discloses nothing — the club's own 404 screen still
  answers every page-shaped miss, which the E2E spec pins so this change cannot
  quietly blank a human-plausible mistyped address.
- **It also had to be exempted from the #2420 pre-setup gate, and that was caught
  by a guard rather than by review.** Being a new top-level route, the gate's
  `isPublicWebsitePath()` classified it as a public-website path, so on a club
  whose `ClubTheme.completedAt` is NULL every missing image would have been
  answered with the "Site setup in progress" screen — a 503 HTML **document**,
  i.e. exactly the thing this fix exists to stop sending, reintroduced through the
  back door. `asset-not-found` is now in `NON_WEBSITE_ROOT_SEGMENTS`.
  `setup-gate.test.ts` walks the app directory and fails on any unexempted
  top-level route, which is how this surfaced; `asset-url-404.test.ts` asserts the
  same property directly so the coupling fails in the suite that owns it too. Any
  future route added for machine traffic needs the same entry.
- **The route sets its own headers rather than leaning on the edge.**
  `default-src 'none'; frame-ancestors 'none'; base-uri 'none'` plus the app's own
  security headers, so the property holds in dev, in the E2E stack, and in any
  deployment that does not front the app with our reverse proxy. That policy needs
  no nonce, so unlike the page-render path it cannot rot. Since Option A it is the
  policy that reaches the wire for the shapes the proxy still skips, and the floor
  behind the proxy's for the rest — see "How the two layers compose" above. Verb
  handling mirrors `[[...unmatched]]`: HEAD is NOT exported, so Next derives it
  from GET and the two cannot disagree on headers.

### What "a module's state cannot be read" actually means (#2465, restated)

The goal recorded on #2465 was that *one anonymous request cannot reveal whether
a module runs*. Stated that broadly it is not achievable, and pretending
otherwise would leave the next reviewer trusting a claim this file cannot
support. Four modules have endpoints whose whole job is to answer an anonymous
caller with real data — `lobbyDisplay` (a wall-mounted screen pairs and polls
with no human session), `addressAutocomplete` (the address lookup runs on the
public join and booking forms), `skifieldConditions` (the mountain report is
public content) and `groupBookings` (the school/group enquiry form is a public
page). Those endpoints answer differently when the module is on because
answering is the point.

**The property this codebase does hold** is narrower and checkable:

> A module-gated path reveals nothing beyond what that module's own
> deliberately-public endpoints already reveal.

In other words, probing a gated address that is NOT public-by-design must not
add a bit; and for the four modules above, whatever a prober learns they could
have learnt by using the feature as intended.

What is enforced to that end:

- **Body, status and `content-type` parity** on `/api` paths, verb by verb,
  including the bare `400` for non-standard verbs — the two closed findings
  above, pinned in `src/app/__tests__/unmatched-url-status.test.ts`.
- **No rewrite may run on `/api`**, so neither `x-nextjs-rewritten-path` nor
  `x-nextjs-rewritten-query` can appear in one module state and not the other —
  see "Static-Asset URLs And The Nonce-Only CSP" above.
- **The auth failure no longer differs from the module failure on a gated path.**
  `requireAdmin()` and `requireActiveSession()` (`src/lib/session-guards.ts`)
  answer an ANONYMOUS caller on a module-gated path with the same frozen
  `404 {"error":"Not found"}` the gate sends, instead of `401`. Without that,
  `401` meant "module on" and `404` meant "module off" on roughly 121 gated
  routes, from one unauthenticated request. Deliberately narrow: a signed-in
  caller still gets the honest `403` that tells them what to fix, ungated paths
  keep their `401` exactly, and a route that supplies its own unauthenticated
  reply (a login redirect, a deliberate 403) keeps it. The gating decision reads
  the path header `src/proxy.ts` stamps on every request it runs on, and the
  proxy necessarily runs on every gated path; a spoofed value on an ungated path
  can only turn that caller's own `401` into a `404`, never the reverse.

**Known and accepted, each with its reason** (owner decision, 1 Aug 2026 — worth
not making worse, not worth a 150-endpoint audit):

- **The four public-by-design modules above.** Their public endpoints answer
  anonymous callers on purpose; hiding that would remove the feature.
- **The verb oracle.** `OPTIONS` on a gated route answers `204` with an `Allow`
  header when the module is on and the frozen `404` when it is off, on every
  gated route. Closing it would mean the gate reproducing Next's per-route
  `Allow` list, which means knowing each route's exported verbs in middleware.
  Not fixed; recorded here so it is not re-discovered as new.
- **The `vary` difference.** A module-OFF reply comes from middleware and never
  enters the render pipeline, so it carries no `vary`; with the module ON the
  same address is served by an app route handler and `base-server.js`'s
  `setVaryHeader` appends `vary: RSC, Next-Router-State-Tree,
  Next-Router-Prefetch, Next-Router-Segment-Prefetch` for every app path before
  any handler runs. Both halves are traced through the vendored framework
  source; the module-OFF half is asserted in
  `src/app/__tests__/unmatched-url-status.test.ts`, and the module-ON half is
  **traced but not measured against a running server** — stated that way rather
  than asserted as fact. Pre-existing, and independent of everything above.
- **Modules whose ADMIN page is gated alongside the API.** For most optional
  modules the page prefix is gated too, so the page itself already answers 404
  when the module is off; the API adds no bit an operator could not get from the
  address bar.
- **Route families with their own auth that this slice does not touch** —
  `src/lib/finance-api-auth.ts`, the lodge/kiosk PIN path, the display device
  grant, the webhook and cron callers. Each answers on a contract someone else
  depends on (a third party, a device, an operator's sign-in prompt), and
  changing those has a real user cost for a configuration-only disclosure.

None of these expose member data, money, capacity, or credentials. What they
expose is club-wide configuration on a public repository whose route table is
already published.

### The other way in: the prefetch headers

The URL-shape class above is only half of "a request that reaches a render with no
nonce". The other half was carried by a HEADER, and it applied to **every** URL,
not only asset-shaped ones.

The matcher's `missing:` clause exempted any request carrying
`Next-Router-Prefetch` or `Purpose: prefetch`. The exemption is legitimate in
itself — Next's router prefetches whole route trees on hover, and minting a nonce
for a response the user may never see is waste. But `missing:` on its own made it
depend on **a header anyone can set**: a plain `GET /anything` with
`Purpose: prefetch` skipped the proxy, and so was served with no nonce, no
`Content-Security-Policy` header, and — since the gate lives inside `proxy()` —
outside the #2420 pre-setup gate as well. Same end state as the asset class,
reachable on any address.

**Closed in #2404 by DELETING the exemption, not by narrowing it** (owner
decision, 1 Aug 2026). The first attempt narrowed it: a genuine flight prefetch is
never bare, because Next's app router sends `RSC` alongside its prefetch header,
so the matcher became two entries over one source — one running when no prefetch
header was present, one when no `RSC` header was present — and their union skipped
only when both arrived together.

**That narrowing did not hold, and the reason is worth recording, because it is a
general limit of `missing:` rather than a slip.** The matcher cannot express
Next's own definition of a flight request. Next flags one on `RSC: 1` EXACTLY
(`next/dist/server/lib/is-rsc-request.js`), whereas a `missing:` item with no
`value` counts ANY non-empty header as present
(`next/dist/shared/lib/router/utils/prepare-destination.js`, `matchHas`). So
`RSC: 2`, `RSC: 0`, a non-numeric `RSC: x`, or the `1, 1` Node produces when a
caller sends two `RSC` headers, all satisfied the `missing:` clause and skipped
the proxy — while Next, seeing no flight request, rendered the full HTML document.
That was strictly MORE useful to a prober than the exemption itself: a real
prefetch only ever gets flight bytes back, whereas any other `RSC` value got the
page. Pinning `value: "1"` would have closed those instances; deleting the clause
closes the class.

The matcher is therefore ONE root entry with no header conditions at all:

| Request | Proxy runs |
| --- | --- |
| ordinary `GET` | yes |
| `Purpose: prefetch` only | **yes (was: no)** |
| `Next-Router-Prefetch` only | **yes (was: no)** |
| `RSC` only (an ordinary flight navigation) | yes (unchanged) |
| prefetch + `RSC: 1` (a real prefetch) | **yes (was: no)** |
| prefetch + any other `RSC` value | **yes (was: no)** |

Two things paid for that. The exemption was measured at ~1.4ns per request on the
compiled matcher, the same benchmark that removed the extension alternative — so
there was no saving to defend. And **#2352 (static/ISR public pages) requires it
gone**: a prefetch that skipped the proxy would store a nonce-less copy of the
page in the page cache, which every later visitor would then be served. The whole
matrix is pinned in `csp-proxy.test.ts`, including the non-`1` `RSC` values, and
the `Purpose: prefetch` row's expectation was flipped there deliberately, with the
reason recorded next to it, because the old pin recorded the defect rather than
the intent.

Consequence worth stating: a bare `Purpose: prefetch` request now reaches the
setup gate, so pre-setup it answers 503 with the holding screen where it used to
answer 200. That is the correct answer and the whole point, but it is
operator-visible. A genuine flight prefetch now mints a nonce as well; that is the
cost, taken knowingly.

**One consequence had to be paid for elsewhere.** Deleting the exemption means a
flight prefetch of `/` now runs the proxy, and `/` is the one page on the
anonymous cache allow list. The proxy cannot recognise a flight request — Next's
adapter strips the headers that would say so before middleware runs — so the
anonymous page cache directive was narrowed to `private` instead. That is the
whole of the fix, and it is written up under "Anonymous Public-Page Caching"
above.

### Guards

- **`src/lib/__tests__/asset-url-404.test.ts`** holds the invariant in the ordinary
  `npm test` run, with no stack required. It works at three depths, because each
  catches a different regression:
  - it compiles the **shipped** rule array on the fly with the exact options
    `filesystem.js` uses (`strict`, `removeUnnamedParams`, `modifyRouteRegex`, and
    `sensitive` read from `experimental.caseSensitiveRoutes`) and substitutes
    destinations through the real `prepareDestination()`, so deleting or
    reordering a rule changes the answer here rather than in production;
  - it runs the **real `next.config.ts`** through
    `unstable_getResponseFromNextConfig()` for the key shapes, so a rule Next's own
    `loadCustomRoutes()` would reject, or a config that stops shipping the rules,
    fails; and it asserts the staged return value directly
    (`beforeFiles: []`, `afterFiles: [...rules]`, `fallback: []`), which is the
    assertion that catches an `afterFiles` → `beforeFiles` move — the config-testing
    util flattens the three stages and cannot see that difference;
  - it decides matcher coverage with `unstable_doesMiddlewareMatch()`.
  Every shape must be covered by the proxy, a terminating rewrite, the `/api` JSON
  catch-all, or the image optimiser; a shape covered by none fails, and since
  Option A most asset rows are covered TWICE, which the table states explicitly so
  a silent return to single coverage fails. It also walks every `route.ts` under
  `src/app` and fails unless the rewrites leave that route's own
  extension-suffixed URL exactly where routing would have taken it — stated as
  "left alone", never as "does not reach one named terminal", because naming a
  terminal is how that guard once passed vacuously for the whole `/api` namespace.
  The rewrite resolver threads the request's SEARCH through
  `prepareDestination()` as well as its pathname, so the rewritten-QUERY axis is
  measured rather than assumed: every gated `/api` prefix in
  `FEATURE_ROUTE_RULES` is probed at an asset-shaped child, in both spellings and
  with a query string, and must be claimed by no rule — and one non-`/api` row
  demonstrates the header really does get set, so those assertions cannot pass by
  measuring nothing. Beyond that it pins the matcher source string down to its
  three remaining alternatives, asserts the matcher carries no extension carve-out
  and no header condition at all, asserts every terminated extension stays outside
  the pre-setup gate in UPPER case as well as lower (the classifier's
  case-insensitivity is a `/i` flag, and the obvious rewrite of it is
  case-sensitive and would otherwise pass), asserts the shipped rule list is
  exactly the two terminating rules with the `(?!api/)` lookahead in place,
  asserts a module-gated PAGE prefix's asset shape answers the same empty 404 from
  either layer, and asserts the terminal route's empty body and headers on every
  served verb.
  - **One recorded fidelity gap, pinned rather than hidden.**
    `unstable_getResponseFromNextConfig()` matches rewrites case-SENSITIVELY: it
    serialises the compiled pattern to a regex STRING and re-matches with
    `pathname.match(string)`, which rebuilds the regex with no flags and loses
    path-to-regexp's `i`. The router server (`filesystem.js`) keeps the flag. So
    the util disagrees with production on `/API/x.png`, the compiled copy is the
    authoritative one, and a test asserts both answers so a Next release fixing the
    util turns red instead of drifting.
- **`e2e/asset-url-404.spec.ts`** is the runtime measurement, against the Linux
  container stack in CI's Playwright job — which is where the empty-body,
  no-`content-type` property is first measured on a real HTTP response rather than
  on a handler return value. It asserts a miss ships no document and no unnonced
  script, and that a policy header arrives on it either way — the terminal
  `default-src 'none'` pinned exactly on `/_next/static/…`, the one shape the proxy
  still skips; that a real `public/` file and a real hashed chunk still answer 200
  with their bytes, and that the `public/` file now also carries the app's security
  headers and a nonced policy, which is the runtime check that middleware running
  on static assets disturbs nothing; that an image uploaded through the admin API
  is served back anonymously at its `/api/images/uploaded/…` URL with its own
  bytes, while a missing one still gets that route's JSON 404; that the newly
  anchored `_next` lookalikes carry a nonced policy; that an ordinary page miss
  still renders the club's own nonced 404 screen; that asset-shaped `/api` URLs
  no handler claims answer the frozen JSON 404 — probed WITH `RSC: 1` and with a
  query string, and asserted to carry neither `x-nextjs-rewritten-path` nor
  `x-nextjs-rewritten-query`, which is the only shape in which those assertions
  can fail; that an asset-shaped `/api` URL a real handler DOES claim is left to
  that handler and likewise ships no rewrite header; and that the mixed-case
  `/API/x.png` renders the club's nonced 404 page — the recorded consequence of
  the `(?!api/)` lookahead matching case-insensitively.
- `scripts/ci/check-prerendered-script-nonces.mjs` is unchanged and still covers the
  build-output half of the class.

## The Public Website's Fixed CSP Nonce - 2026-08-02

Issue #2352 slice 1. Recorded here explicitly, in the owner's words from decision
D1, rather than slipped in as an implementation detail: **the public website now
carries one fixed script nonce per release instead of a fresh one per request.**

### What changed, and why it could not be avoided

The admin-authored CMS pages (`(website)/[...slug]`) are served from Next's
full-route ISR cache: rendered once for a path, stored, and handed to every later
visitor until the content changes. A stored page can carry only ONE nonce value,
because Next stamps the nonce into its own inline bootstrap and RSC scripts at
render time, reading it from the request's own `Content-Security-Policy` header
(`next/dist/server/app-render/app-render.js`). If the policy on a later response
named a different value, every inline script on the stored page would be blocked
and the page would never hydrate.

Two alternatives were evaluated and are not available:

- **Injecting a nonce at the edge.** Next's proxy layer and Caddy can change
  response HEADERS, not response BODIES. Rewriting the stored HTML on the way out
  is not something either can do.
- **Hash-based CSP.** The inline scripts needing hashes are Next's RSC payload
  scripts, whose contents literally contain the rendered page — so any build-time
  hash list is stale the moment an admin edits a page.

The remaining options were a fixed-per-release nonce, `unsafe-inline`, or not going
static at all. The owner chose the fixed nonce and explicitly rejected
`unsafe-inline`.

### What the trade costs

On those five pages the nonce is readable in the page source, so it no longer
stops a FULLY INJECTED `<script>` tag. It still stops the commoner injection
shapes — `onclick=` and other `on*` handlers, `javascript:` URLs — because those
cannot carry a nonce at all. Everything else is unchanged: no `unsafe-inline`,
`object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-ancestors 'none'`.

The first line of defence is what makes this a second line rather than the only
one: the only untrusted content on these pages is admin-authored CMS HTML, which
is allowlist-sanitised on write AND again on read, permitting no `script` element
and no `on*` attribute.

Bundled tightening, per D1: **Stripe is dropped from `script-src` on these pages.**
Stripe.js is loaded only from the member payment surfaces, so allowing it on a
public information page was reach for an attacker and nothing for the club.

### Scope — exactly the five addresses D1 named

The fixed nonce covers `/`, the `[...slug]` CMS catch-all, `/join`, `/contact` and
`/join/apply`, and nothing else.

**The one-sentence invariant:** an address carries the fixed per-release nonce if
and only if it is a public website address that one of those five routes can serve
— so no PAGE is ever stored outside that set, and every other address on the site,
public or not, is rendered per request under a nonce minted for that request.

It is stated over PAGES on purpose, and an earlier wording that said "if and only
if one of those five can serve it" was wrong in the "if" direction. The catch-all
claims every URL no other route claims, so `/dashboard/nope` IS served by one of
the five while deliberately keeping a per-request nonce — and the 404 DOCUMENT the
catch-all produces there is stored. That is the #2570 residual recorded below, and
the two statements have to agree.

**Percent-encoded addresses are not a gap in the split, and this was measured
rather than argued** (slice-1 security re-review reported the opposite as high
severity). The classifier compares raw URL segments, and so does Next: a static
route matches by exact string equality against the raw pathname, a dynamic route
matches its regex against the raw pathname with only the captured params decoded
afterwards, and the router server invokes the render with the raw pathname
(`invokePath`). `fsChecker.getItem()` does try a decoded variant, but for an app
route it only produces the `invokeOutput` hint, which filters DYNAMIC candidates
only, so a decoded static route never wins.

Measured on a container build of this branch (`next start`, next 16.2.12) and read
off the ISR headers rather than the status, because the catch-all is the only route
in either public group that answers with `x-nextjs-cache` / `x-nextjs-prerender`:

| Address | Status | ISR headers | Route that answered |
| --- | --- | --- | --- |
| `/hut-leader-instructions` | 200 | no | the `(website-dynamic)` page, per-request nonce |
| `/hut-leader-instruction%73` | 404 | yes | the CATCH-ALL, refusing the slug — fixed nonce |
| `/dashboar%64` | 404 | yes | the catch-all, not `/dashboard` — fixed nonce |
| `/logi%6E` | 404 | yes | the catch-all, not `/login` — fixed nonce |
| `/join/apply` | 200 | no | the static route, one of the five — fixed nonce |
| `/join/appl%79` | 404 | no | `/join/[code]`, exactly as `/join/ANY` — per-request |
| `/join/verif%79/tok` | 404 | yes | the catch-all, not the token page — fixed nonce |

So an encoded static address is catch-all territory and correctly takes the fixed
nonce — and the stored document at `/hut-leader-instruction%73` was verified
consistent, both requests naming the same nonce as the HTML carries, with no
unnonced inline script. `/join/appl%79` correctly does not take it: decoding before
classifying would have handed a genuinely dynamic page the publicly readable fixed
nonce, which is the security regression rather than the repair. (On an earlier
container at 16.2.11 with group bookings enabled, that address answered 200 titled
"Join a group booking" — the same conclusion read off the body.) The one thing Next
does resolve from a decoded path is a static FILE, which has an `fsPath` and is
served directly (`/robots%2Etxt` returns the real `robots.txt`); the only consequence
is that such a URL is claimed
as a website address and answered with the 503 holding screen while setup is
incomplete, which nothing emits and which carries no document risk after setup.
`src/lib/public-website-paths.ts` holds the framework source references,
`public-website-path-predicates.test.ts` pins each shape with a literal expected
answer, and `e2e/static-cms-pages.spec.ts` pins the route-table half on a real
server.

The first cut of this work applied the fixed nonce to the whole `(website)` route
group, which swept in three more pages: `/hut-leader-instructions`, `/join/[code]`
and `/join/verify/[token]`. **The owner reversed that on 3 Aug 2026** and the
narrowing is implemented. The reasoning is worth keeping, because the structural
argument for the widening was real:

- A route takes its CSP nonce from the layout above it, and the shared public layout
  may not read the request — that read is precisely what forced a full render on
  every public page view. So two nonce sources genuinely do need two layouts.
- What made the widening the wrong trade is that the three swept-in pages are
  `force-dynamic` and therefore never stored, so the fixed nonce cost them the
  unguessable-per-response defence and returned nothing at all.
- So there are now two route groups: `src/app/(website)` (the five, fixed nonce) and
  `src/app/(website-dynamic)` (the three, per-request nonce, read out of
  `CSP_NONCE_HEADER` exactly as every member and admin page reads it).
- **The markup is not duplicated to get that** — the owner's direction was explicit
  on the point. Both layouts are three lines around one shared
  `src/components/website/website-chrome.tsx`, which takes the nonce as a prop, and
  CI fails the build if either layout grows chrome of its own or stops composing it.

Two deliberate asymmetries in the split, each recorded because it looks like an
inconsistency and is not:

- **The Stripe tightening follows the WIDE predicate, not the nonce.** Dropping
  `https://js.stripe.com` from `script-src` is right for the whole public website:
  Stripe.js is loaded only from the member payment surfaces, so allowing it on a
  PIN-gated instructions page is reach for an attacker and nothing for the club.
  Narrowing that flag alongside the nonce would have handed those three pages a
  LOOSER policy as a side effect of tightening their nonce.
- **The #2420 pre-setup holding screen also follows the wide predicate.** The three
  moved pages are public website addresses, so an unlaunched club still answers them
  with 503 and the holding screen. Narrowing the shared predicate would have been
  the small change and would have quietly taken that off them — a change to what an
  unconfigured install exposes, made as a side effect of a CSP decision. Verified on
  a real container build: with `ClubTheme.completedAt` NULL, all three answer 503.

Login, registration, the member area, admin, finance, lodge and `/display` keep a
freshly minted per-request nonce, exactly as before. `/login` is out of scope
permanently (D7).

### The mechanism

- `src/lib/release-nonce.ts` derives the value as a SHA-256 digest of a namespaced
  string plus the release identifier, so **the release identifier is not
  recoverable from the page source**.
- The identifier is `RELEASE_ID`, a Docker build ARG promoted to an ENV in both the
  builder and the runner stage (`Dockerfile`). CI and
  `scripts/run-production-blue-green-deploy.sh` pass the commit SHA. Deriving from
  something baked into the IMAGE is what makes every process of one release agree
  without coordination — a per-process value would break a page one process stored
  when another served it.
- CI asserts the value on the image that actually ships: `publish-ghcr-images`
  passes `RELEASE_ID` to the app image and then RUNS that pushed image and fails if
  the value does not equal the built commit. The earlier arrangement asserted it on
  the throwaway image `docker-image-security` scans while the published image was
  built without the argument at all, and the deploy script's own export could not
  cover for it — `prepare_application_images()` returns early on the prebuilt-image
  path, which is the ordinary GHCR deploy. Found in the slice-1 review.
- `GIT_COMMIT_SHA` is a real second fallback: it is now declared in the Dockerfile's
  RUNNER stage, not only the builder, so a runtime read can see it.
- With no identifier readable at all (a bare `docker build`, or local `next start`),
  the value comes from a random per-BUILD seed that `next.config.ts` substitutes into
  every bundle. That is still one value per release, shared by every reader.
  **The previous wording here — "falls back to one random value per process ... safe
  only for a single-process deployment" — was wrong in both halves.** The module is
  imported by two separately-compiled bundles (the proxy entry and the app-server
  graph), so a per-process value was not even self-consistent inside one container:
  the proxy published one nonce in the policy while `(website)/layout.tsx` stamped
  another onto the analytics `<Script nonce>`, and Google Analytics was refused on
  every public page. The per-instance random survives only as a last resort behind an
  error-level log.
- `src/lib/csp.ts` takes the public-website decision from its caller, and
  `src/proxy.ts` makes TWO decisions from two predicates in
  `src/lib/public-website-paths.ts`: `isFixedNonceWebsitePath()` for the nonce, and
  `isPublicWebsitePath()` for the policy's Stripe tightening and the #2420 setup
  gate.
- **One predicate used to answer three questions, and the narrowing forced a split**
  — by question, not by convenience. While the fixed nonce covered the whole
  `(website)` group, "is this the public website for 503 purposes", "does this carry
  the fixed nonce" and "may the CMS catch-all serve this" had the same answer, so one
  function served all three. They no longer do: the nonce covers five addresses while
  the holding screen must still cover the whole public website. So
  `isPublicWebsitePath()` keeps the setup gate's meaning unchanged (both groups),
  `isFixedNonceWebsitePath()` answers the nonce, and `isCmsServablePageSlug()`
  restates the second as a slug question. Each caller uses the one that answers ITS
  question, and `src/lib/__tests__/public-website-path-predicates.test.ts` pins the
  addresses where the answers differ.
- **The nonce set and the CACHE's territory are the same set, and that is a security
  property rather than tidiness** (slice-1 review, F1). `(website)/[...slug]` claims
  every URL no other route claims, which is wider than the five. The difference was
  reachable: `pay` was a legal CMS slug and `(public)/pay` holds only `[token]/`, so a
  published page at `/pay` was stored carrying whatever per-request nonce generated it
  and then served under a policy naming a different one — every inline script refused,
  permanently, for everyone. It is closed from the CMS side rather than by widening
  the nonce, because widening would hand the fixed nonce to `/dashboard` and `/admin`,
  which D1 keeps per-request: `isCmsServablePageSlug()` makes the admin write and the
  catch-all's loader both refuse those slugs. The narrowing tightened it three
  addresses further — `hut-leader-instructions`, `join/<code>` and
  `join/verify/<token>` are refused as slugs, because a real per-request route claims
  each of them, so a CMS page there could never have been served in any release.
  Refusing them at the write is what stops one being created; refusing them in the
  loader and the menu reader is what handles a row from an earlier release.
  `trips/hut-leader-instructions`, which no route claims, is still a valid page — a
  reserved WORD would have refused that too, for no reason.
- **The same predicate now filters what ADVERTISES a page, which the first pass
  missed** (slice-1 security re-review). Refusing to serve a row is not the whole
  answer while the site still links to it: a page saved at `/lodge/history` before
  this slice stays `published` with its menu title intact, so
  `listWebsiteMenuPages()` kept it in the public header and the mobile drawer, and
  an admin-chosen Book Now target at such an address kept the button pointing there
  — a nav link to a 404 on every public page, with no signal to the visitor or the
  operator. Both readers now apply `isCmsServablePageSlug()`
  (`src/lib/page-content-html.ts`, `src/lib/book-now-config.ts`), so an address the
  site will not serve is an address the site does not offer; the Book Now case
  reuses #1929's existing fail-open to the booking flow. Finding the affected row
  is an operator step, and `CONFIGURATION.md` carries the query for it.
- One residual is recorded rather than claimed closed, and it is now MEASURED rather
  than reasoned about (#2570). A 404 the catch-all raises for an address outside the
  set is stored as a 404 entry carrying the generating request's nonce, so the
  not-found DOCUMENT served from the store afterwards has a nonce the policy no longer
  names and does not hydrate. Observed on a real container build of this branch: two
  requests for `/admin/typo` returned 404 both times, the first with policy nonce and
  HTML nonce equal, the second with a fresh policy nonce while the HTML still carried
  the first request's value. An in-territory miss (`/definitely-missing`) is
  consistent on both requests, because it carries the fixed nonce — so the fault is
  confined to addresses belonging to another route group. It holds nothing personal,
  the status is a correct 404 on every request, and an admin write or a deploy clears
  it.

  **The visible symptom is worse than the #2570 briefing said, and this correction
  matters to the decision.** That briefing described a page whose "text and ordinary
  links work" with only its scripts refused. Measured on the same build: a
  `notFound()` response from this route carries ZERO server-rendered visible markup —
  `<body>` is an empty placeholder and the entire 404 screen arrives in the RSC flight
  payload, inside nonce'd inline `<script>` tags (0 visible characters outside
  `<script>` on `/admin/typo`, `/dashboard/nope` and `/definitely-missing`, against
  ~3.7k on `/contact`). So a later visitor to a mistyped member address sees a BLANK
  page until the next admin save or deploy, not a readable "page not found". No data
  is exposed and the HTTP status stays correct, but "documented wart" was assessed
  against the gentler description.

  **The same stored documents also shipped a shared-cache directive, and THAT half is
  closed rather than accepted (#2578).** Because the response came out of the page
  store, the framework's own `s-maxage=15, stale-while-revalidate=31535985` reached the
  wire with no `Vary: Cookie` — and could do so alongside the D2 marker `Set-Cookie` — on
  addresses the proxy had classified as not-the-public-website. Measured on the same
  container build, on `/pay`, `/dashboard/nope` and `/admin/typo`, against a
  pre-slice-1 baseline that answered `private, no-cache, no-store` on all four
  addresses. The proxy now writes the private-only directive for every page-shaped GET
  or HEAD in either territory, so no out-of-territory address is invited into a shared
  cache whichever route answers it, and no `Set-Cookie` of ours ever leaves beside a
  shared-cache directive. That includes an odd-cased `/API/x.png`, which no rewrite and
  no handler claims and which the catch-all therefore answers from the store as well.
  See "Anonymous Public-Page Caching" above for the rule, its two deliberate
  exclusions, and the measured-versus-derived reconciliation of the `s-maxage=15`
  figure quoted here. The nonce residual described here is untouched by
  that fix: same store, same blank document, same accepted trade — only its headers
  changed.

  The owner chose option 2 on 3 Aug (stop storing those documents), and the mechanism
  it named does not exist on next@16.2.12: with `cacheComponents` off, an on-demand
  ISR generation renders under the prerender-legacy work-unit store, where both
  `connection()` and `unstable_noStore()` throw `DynamicServerError` and base-server
  converts that to a 500 — the worse outcome that option's own terms said to drop the
  change for. The replacement considered was a proxy rewrite of such an address to a
  dedicated per-request not-found route, and **that cannot work either, for a reason
  of principle rather than of framework version: middleware runs BEFORE routing, so
  the proxy cannot tell `/dashboard/nope` from `/dashboard/bookings`.** Rewriting
  every non-website address would 404 the real member and admin areas. So this is back
  with the owner rather than downgraded quietly; the mechanisms that would work, and
  what each costs, are set out on #2570.
- **The analytics scripts take their nonce from the LOADED DOCUMENT, not from the
  render that mounted them** (slice-1 review). A document's CSP is fixed when it
  loads; the nonce prop is not, because the two public layouts pass different values.
  A soft navigation between the groups therefore remounted `AnalyticsConsent` holding
  the other territory's nonce while the policy in force was still the first
  document's, and `script-src` carries no `'strict-dynamic'`, so the injected inline
  GA config was refused: gtag loaded and never configured, one console CSP error, no
  other symptom. `src/components/analytics-consent.tsx` now reads the nonce off a
  nonced `<script>` already in the document (IDL property, because CSP nonce hiding
  blanks the attribute) and falls back to the prop. It is not a relaxation — the value
  is already in the DOM of the document those scripts run in, and naming the wrong
  nonce can only get our own script refused, never make an injected one run. The same
  fault predated the split on `/` → `/login`, and the same change closes it.
  **#2573 removed both INLINE analytics scripts** — the consent bootstrap and the
  `gtag('config', …)` call now run from the bundle, pushing onto `window.dataLayer` in
  the same order — so exactly one external `<Script src>` is left. The document-nonce
  read is unchanged and still load-bearing: `script-src` carries no
  `'strict-dynamic'`, so a dynamically injected script tag is nonce-checked whether it
  is inline or not.
- **Google Analytics can only be pointed somewhere by an authorised admin, and only
  at what the application allows** (#2573). The measurement id moved out of
  `NEXT_PUBLIC_GA_MEASUREMENT_ID` into `AnalyticsSettings`, behind
  `finance:view`/`finance:edit` on `/api/admin/integrations/analytics` and behind the
  `analytics` module flag in `src/config/feature-routes.ts` (which 404s the subtree
  when the module is off). It is validated as a GA4 `G-…` id on write, and re-validated
  on every read, so a restored or hand-edited row that is not a GA4 id means no
  analytics rather than an arbitrary third-party script id in a `<script src>`.
  Advertising consent categories are denied unconditionally, in both banner modes, with
  no setting that changes it. The admin-authored banner message is stored as plain text
  and rendered as a React text child — never `dangerouslySetInnerHTML` — so markup in
  it is shown literally.
- **What may be sent to Google is bounded by code, not by configuration**
  (`src/lib/analytics-route-policy.ts`). Two independent gates: the address must be one
  the five approved `(website)` routes serve (derived from the same route census the
  nonce split uses, so a new admin, member or token route is excluded the day it is
  added), and it must also *look* like an admin-authored page slug — which is what
  refuses the catch-all's territory of identifier-shaped and credential-flavoured
  addresses (`/reset/<token>`, `/t/<hex>`, `/cm5x…`). `send_page_view: false` turns
  Google's own automatic page view off, so `location.href` is never used; this app sends
  one `origin + pathname` view per navigation, de-duplicated against the last value
  sent. `document.referrer` is sanitised before Google sees it — an excluded
  same-origin referrer is reduced to the bare origin, which is what stops a visitor
  arriving from `/pay/<token>` handing Google the payment token.

### The sign-in marker cookie (D2)

`signed-in-hint`, value `"1"`, `Path=/`, `SameSite=Lax`, not `HttpOnly`.

It is **not authentication and must never be treated as such.** It carries one bit
and no name, email, role, identifier or token. Forging it changes three things,
all of them link text or link targets: the desktop account CTA, the same CTA in
the mobile drawer, and the Book Now destination. Every page behind those links is
still guarded server-side.

Two properties are worth stating because they are what keep it a display hint:

- `src/proxy.ts` sets and clears it from the OBSERVED presence of a next-auth
  session cookie, so it is self-healing — sign-out through any path, an expired
  session or a cleared cookie jar all converge on the next request.
- It is stripped from the `Cookie` header forwarded to the render, so no server code
  can come to depend on a forgeable answer to "is this visitor signed in?". That is
  now true rather than asserted: `NextResponse.next({ request: { headers } })`
  re-emits every header of the copied set as `x-middleware-request-<name>`, and
  `Cookie` is one header, so the hint was reaching `(await cookies()).get(...)` in
  any server component or route handler. The test that was meant to catch it asserted
  on a header name that can never exist. The proxy also writes the `Set-Cookie`
  header directly instead of through `response.cookies`, because the latter emits
  `x-middleware-set-cookie`, which Next merges into `cookies()` — so even the request
  that first sets the hint cannot read it back. Found in the slice-1 review.

The public header never exposed any personal data — the #2352 planning pass
enumerated it as exactly one boolean — which is what makes serving one stored copy
to everyone acceptable.

### The prefetch-header finding (F1)

The reconciliation's highest-severity finding, and the reason #2404 had to land
first. The proxy matcher used to skip any request carrying `next-router-prefetch`
or `Purpose: prefetch` — ordinary headers anyone can set. On a dynamic response
that only skipped the per-request CSP. Under full-route ISR, a prefetch-shaped
request that missed the cache would **generate and store a page with no nonce at
all**, and that copy would then be served to every visitor under the nonce-only
policy: zero inline scripts execute, the page never hydrates. Invisible to the
build-time prerender guard, because nothing was prerendered.

#2404 deleted the exemption outright. `csp-proxy.test.ts` pins the whole
prefetch/`RSC` matrix, and `e2e/static-cms-pages.spec.ts` asserts on a real server
that a `Purpose: prefetch` request stores a fully nonced page.

### Multi-tenant fork warning

Next's page cache is keyed by PATH with no tenant dimension. That is correct for
this template, which serves one club per deployment. **A fork serving several clubs
from one process would serve club A's home page to club B.** See `CONFIGURATION.md`
and `DEPLOYMENT.md`.

### Guards

- `scripts/ci/check-website-render-modes.mjs` — every route in either public group
  declares its render mode; the CMS catch-all keeps `generateStaticParams() => []`
  plus its `revalidate`; nothing in `(website-dynamic)` so much as mentions
  `generateStaticParams` or `revalidate`; no `loading.tsx`/`template.tsx`/`default.tsx`
  and no Partial Prerendering anywhere in either group. The boundary ban is the
  enforceable form of the #2434 streaming warning: a boundary could commit a 200
  before the catch-all decides a URL is a 404, and under ISR that soft 404 would then
  be stored. Three structural checks arrived with the narrowing, and each covers a
  change that would otherwise fail nothing at all:
  - **the fixed-nonce census** — `src/app/(website)`'s routes must equal
    `FIXED_NONCE_WEBSITE_ROUTES`, and `(website-dynamic)`'s must equal
    `PER_REQUEST_WEBSITE_ROUTES`. A route group is invisible in a URL, so a page
    dropped into the wrong one is a CSP decision made by accident; adding a sixth
    fixed-nonce route fails CI until the census is deliberately amended. The runtime
    predicate is derived from the same lists, so there is one source of truth rather
    than a mirror to keep in step.
  - **chrome parity** — both layouts compose the one shared chrome component and no
    chrome of their own, and the set of chrome components each renders directly must
    be identical (empty). This is the owner's "no duplicated markup" as an
    enforceable rule.
  - **the shared chrome's own reads** — it may call none of `auth()`, `cookies()` or
    `headers()`, and may resolve neither nonce itself. **This is coverage the gate
    never had, not coverage preserved.** Before the narrowing nothing at source level
    banned a request read in the public layout: the only thing standing between a
    `headers()` call there and a silent loss of ISR was
    `check-website-prerender-manifest.mjs`, which needs a full build to answer. The
    extraction is what made the absence matter — the chrome is now composed by both
    groups, so one read there would opt every public route out at once — so the ban
    was written in the same commit as the move.
- `scripts/ci/check-prerendered-script-nonces.mjs` — unchanged, and still green
  because `generateStaticParams()` returning `[]` emits no build-time HTML. That
  property is why slice 1 was safe to ship before the build-time-nonce question
  (#2352 F2) is answered, and it is asserted directly by the route's own test.
  Verified on a real container build of this branch: two prerendered artefacts,
  both of them Next's own error shell, both already documented exceptions.
- `scripts/ci/check-website-prerender-manifest.mjs` — the same class from the
  build's own records, with a closed allowlist on BOTH halves. A new build-time route
  is a page whose inline scripts carry no nonce (nothing stamps one without a
  request). A new ON-DEMAND route is worse: one visitor's render is stored and handed
  to whoever asks next. The second half used to be checked only against the seven
  routes that must stay per-request, so `/pay/[token]` becoming storable — by a later
  PR dropping the group-level `force-dynamic` from `src/app/(public)/layout.tsx` —
  passed both this gate and `check-website-render-modes.mjs`, which walks
  `src/app/(website)` only. Closed in the slice-1 review.
- `src/lib/__tests__/csp-proxy.test.ts` — the fixed nonce appears on exactly the
  addresses `isFixedNonceWebsitePath()` claims and nowhere else, while the tightened
  source list appears on every address `isPublicWebsitePath()` claims (the two
  predicates asserted separately on one URL matrix, so the addresses where they
  disagree are the cases); the three per-request pages get a DIFFERENT nonce on each
  of two requests, and each response hands its own value to the render; every other
  directive is byte-identical to a member page's; the marker cookie is set, cleared,
  left alone when it already agrees, and stripped from the `Cookie` header the render
  is handed (asserted on `x-middleware-request-cookie`, where the value really
  travels); and no public-website response invites a shared cache to store it.
- `src/lib/__tests__/public-website-path-predicates.test.ts` — the split itself: the
  setup gate still claims all three moved addresses, the fixed-nonce set is exactly
  the five plus the catch-all's territory, `/join/apply` stays with the five even
  though it matches `/join/[code]`'s shape (Next serves the static route, and the
  predicate mirrors that precedence), and the census walk classifies every
  per-request route from the list rather than from a second hand-written set.
- `src/lib/__tests__/cms-page-nonce-territory.test.ts` — every slug the admin write
  accepts is inside the fixed-nonce set, and every root segment belonging to another
  route group is refused. Driven off `NON_WEBSITE_ROOT_SEGMENTS` itself, so a segment
  added for a new route group is covered the day it lands.
- `src/lib/__tests__/isr-page-cache-behaviour.test.ts` — executes Next's own cache
  to observe that a store which cannot be written degrades to a warning and a
  re-render rather than a 500.

## Follow-Up Mapping

- #613 - Standardize route guards: route metadata and shared active-session and
  cron/deploy helpers now exist; future batches should continue migrating
  hand-rolled admin checks to `requireAdmin()` or equivalent.
- #614 - Route boundary tests: static tests now walk `src/app/api/**/route.ts`
  and require approved guard markers or public allowlist entries; future batches
  should broaden IDOR behavior coverage for booking and family-owned resources.
- #615 - Anonymous public endpoints: first-pass hardening now covers token
  shape validation, malformed JSON behavior, Addy/committee response bounds, and
  token-path log redaction. Public committee/contact privacy now reads from
  published member-linked assignments, keeps email server-only, and gates phone
  by assignment flag. Remaining public-form policy tradeoffs are noted in the
  accepted residual risk above.
- #616 - External integrations: review Stripe, operational Xero, finance
  reporting through Xero, SES/SNS, Sentry, OAuth state handling, webhook
  signature/idempotency, token encryption, and provider callback logging.
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

## Wave-2 Verification Close-Out (epic #1204) - 2026-07-05

Re-audit of the wave-1 concurrency/integrity findings (#1127) against the fixed
code, plus the wave-2 security/integrity end state.

### Booking / person-night concurrency (#1127 F1-F4 — all resolved)

Every transaction that **creates or re-dates** a member-linked guest-night
footprint now takes the global booking advisory lock (`pg_advisory_xact_lock(1)`)
before running `assertNoBookingMemberNightConflicts`, and that lock-before-guard
ordering is frozen for every such writer by `review-findings-contracts.test.ts`:

- **F1** — `modifyBookingDates` (`booking-date-modification-service.ts`): guard
  added inside the locked transaction. Fixed by #1157.
- **F2/F3** — `approveBookingRequest` (`booking-request.ts`), the quote-hold path
  (`booking-request-quotes.ts`), and school-request approval
  (`school-booking-request.ts`): guard added inside each locked transaction.
  Fixed by #1158.
- **F4** — the contract test froze only two create paths and DOMAIN_INVARIANTS.md
  overstated the coverage. The test now freezes lock→guard ordering across all
  member-linked writers (`createDraftBooking`/`createConfirmedBooking`/
  `createWaitlistedBooking`, `modifyBookingDates`, `approveBookingRequest`, the
  quote-hold path, school-request approval, the `/bookings/[id]/guests` POST, and
  the delegated `modifyBookingBatch`→`prepareGuestPlan` path); the invariant doc
  is corrected to the footprint-scoped claim. Fixed by #1159.

Non-member group-join (`verifyAndCreateNonMemberJoin`) takes the lock but is a
guard no-op (writes only `memberId: null` guests) — correctly excluded, and
re-price / name-only / timestamp / anonymization writes skip the guard because
they do not change the member-night footprint. See DOMAIN_INVARIANTS.md.

### Money-path integrity (#1234)

Extended the money-path invariant defenses: **L1** repairs credit allocations
atomically under the booking advisory lock (`pg_advisory_xact_lock(1)`); **L2**
guards the supplementary-invoice path with an idempotency key, rejecting a
supplementary invoice when its `bookingModificationId` is absent. **L3 was
ratified as no-change**: the Xero outbox (`XeroSyncOperation`) deliberately keeps
**no** `@@unique` on `correlationKey`/`idempotencyKey` — a full unique would
reject a legitimate re-enqueue (a settled row from attempt 1 plus a fresh
`PENDING` retry) and break retries, so outbox dedup stays status-based (see the
by-design schema comment and the *Money, Booking, And Lifecycle Integrity Review*
above).

### Member-facing info-leak on the pay step (#1223)

Stripe initialization errors no longer surface the raw provider string (which can
carry partial `sk_*` key material) to members: the pay step shows generic copy,
and the raw detail reaches only Sentry (scrubbed by `beforeSend`) — never the DOM
**or** the member's browser console.

### Observability (#1214, decision D6)

Scoped `pino → Sentry` bridge on the cron + webhook loggers (deliberately not
global); the G5 observability gap is partially closed by design.

### Ratified trade-offs (epic decision menu, owner 2026-07-04)

- **D1 — CSP `style-src 'unsafe-inline'` + broad `img-src https:`: ratified.**
  Left in place; tightening `style-src` is a UI-wide project with regression risk
  disproportionate to the exposure. Revisit only if the HTML-sanitizer surface
  changes.
- **D2 — `getClientIp` trusting `x-real-ip`: ratified.** Removing it breaks
  non-Caddy deploys; the "Caddy always fronts" deployment invariant stands. The
  rate-limiter degraded mode (issue #1142) is documented above.
