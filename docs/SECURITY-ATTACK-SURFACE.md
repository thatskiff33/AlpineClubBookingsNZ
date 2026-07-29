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
| Cron/deploy secret | Repeated `x-cron-secret` comparison against `CRON_SECRET`, usually with `timingSafeEqual`. | `/api/cron/**`, `/api/deploy/runtime-status`. |
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
| `src/proxy.ts` global proxy and module gates | No session auth. Applies CSP/security headers to page requests and selected API matcher paths; returns 404 for disabled module routes. | Anonymous and authenticated browser traffic. | Module settings via `loadEffectiveModuleFlags()`. | None. | CSP nonce, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, module route blocking. | No per-request audit. | API matcher is selective, not global for every API path. Keep route-level auth as the enforcement boundary. |
| `/api/health`, `/api/health/ready` | Public. | Load balancers, operators, anonymous callers. | DB reachability, runtime version/uptime, config readiness. Public responses omit provider error detail. | DB query only. | No rate limit. No secrets in response. | Logger debug/error only. | Anonymous callers can observe availability. #615 can decide whether to add light rate limiting or cache headers. |
| `/api/age-tier-settings`, `/api/committee` | Public read endpoints. | Anonymous website users. | Public age-tier/rate settings and published committee assignment presentation fields; and, **only when `PublicContentSettings.committeePhotoDisplay != NONE`**, per-published-member photo metadata (member id + `photoUpdatedAt` version) so the roster can build the scoped `/api/members/[id]/photo` URL. | None. | No rate limit. Committee query selects active, published assignment fields only; member email is not selected or returned, phone is returned only when show-phone is enabled, and contact keys are returned only for contactable assignments. Photo metadata (incl. member id) is emitted **only** when the club has opted the roster into photos — with `committeePhotoDisplay = NONE` (the default), no member id or photo pointer is returned. | None beyond DB errors if thrown. | Public committee names and optional phone numbers are intentional once an admin publishes the assignment; email remains server-only. Committee-photo bytes are still served (and gated) by the scoped `/api/members/[id]/photo` endpoint — `committeePhotoDisplay` governs roster rendering/metadata only, not the serving rule. |
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
| `/api/bookings/[id]/**`, including cancel, modify, guests, payment confirmation, refund request, waitlist confirmation, notes, arrival time, and payment secret routes | Authenticated active member with route/service ownership checks. | Booking owner/member, sometimes admin through service rules. | Booking ownership, guest records, payment transactions, Stripe IDs/client secrets, cancellation/refund/change-request data, notes. | Stripe PaymentIntent/SetupIntent confirmation or retrieval, Xero invoice/credit-note outbox, email notifications. | Auth.js session, active-account guard, rate limits on cancel/change flows, service-level owner checks, Zod/date validation. | Audit logs for payment/guest/refund/change operations where implemented; logger on failures. | IDOR and money-state risk. #614 should include representative owner-boundary tests; #617 should review transaction invariants. |
| `/api/payments/options`, `/api/payments/charge-saved-method`, `/api/payments/create-payment-intent`, `/api/payments/create-setup-intent` | Authenticated active member. | Signed-in member discovering payment options, paying for booking, or saving payment method. | Payment method availability, payment, payment transaction, booking, Stripe customer/payment method/client secret references. | Stripe API for Stripe paths; Xero-backed Internet Banking availability is reported but settlement stays in Xero reconciliation. | Auth.js session, active-account guard, booking/payment service checks, module-state gates for Internet Banking. | Audit/logging around payment reconciliation and failure paths. | Client secret exposure is intentional to the owning member only. Internet Banking bookings must stay out of Stripe-only mutation paths; #617 should verify ownership checks and cents-only money handling. |
| `/api/profile`, `/api/notifications/preferences`, `/api/member/**` | Authenticated active member. | Signed-in member. | Member PII, address/phone/email preferences, audit log, credit balance, subscription status, onboarding, data export, deletion request, membership cancellation request/confirmation. | Email send, Xero contact/group update, export generation where invoked. | Auth.js session, active-account guard, rate limits for data export, deletion request, and cancellation request/confirmation. | Audit log for profile/security/deletion/cancellation operations; logger for Xero/email failures. | Member PII and lifecycle state. #614 should cover inactive/forced-password boundaries; #617 should review lifecycle integrity. |
| `/api/members/[id]/photo` GET (serve) | Data-layer authorisation, not a session-guard marker. Public **iff** the target member has an active, published `CommitteeAssignment`; otherwise the handler resolves the session and serves only to the owning member (own id) or a `membership:view` admin. | Anonymous website visitor (committee case), owning member, or membership admin. | One `MediaImage` blob (`kind = MEMBER_PHOTO`) plus the target member's photo pointer and committee-published status. Member photos never surface through the public `/api/images/[id]` content path (that route returns 404 for any non-`CONTENT` row — enforced, not just documented) or the content picker (`kind = CONTENT` filter). | None. | Documented mixed-method public GET in `api-route-security.ts`, enforced by `api-route-boundaries.test.ts`. Committee-public responses use `Cache-Control: public, max-age=300, must-revalidate` + an **opaque digest ETag** (never the raw `MediaImage` id; short window bounds cache-leak past un-publication); private responses use `private, no-store` + `Vary: Cookie`. `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, and a locked-down CSP on every response; content-type restricted to JPEG/PNG/WebP at upload (no SVG). | Non-mutating; no per-fetch audit. | Prefers 404 over 403 so a private photo's existence is never confirmed. Cache-leak window bounded to 300s if committee membership is revoked. |
| `/api/members/[id]/photo` POST/DELETE (upload/remove) | Owning member via `requireActiveSessionUser` (self path), or a `membership:edit` admin via `requireAdmin` acting on behalf. A plain member may act only on their own id (no IDOR). | Signed-in member (self) or membership-edit admin. | Creates/deletes a `MediaImage` (`kind = MEMBER_PHOTO`) and sets `Member.photoImageId` + `photoUpdatedAt`/`photoUpdatedByMemberId` audit columns. Replace and remove read the current pointer under a `SELECT … FOR UPDATE` row lock and delete exactly that prior MEMBER_PHOTO blob (scoped `deleteMany` on `kind`) inside one transaction — concurrent replace/remove serialise, no orphans. | None. | Content-type sniffed from magic bytes (JPEG/PNG/WebP allowlist), 2MB byte cap (Content-Length pre-check + buffered recheck), and a 4096px dimension backstop (JPEG/PNG/GIF/WebP dimensions parsed, incl. the VP8X canvas, so an oversized decode-bomb is rejected). EXIF/XMP/comment metadata (camera GPS) is stripped from JPEG/PNG/WebP before storage. Client-side resize only — no server image library (metadata strip is byte-surgery, not a re-encode). Documented member mixed-methods, enforced by `api-route-boundaries.test.ts`. | `logAudit` `member_photo.upload` / `member_photo.remove` with actor/subject and on-behalf flag; DB audit columns stamped. | Self-upload is the consent (ADR-001 decision 4). Committee removal warning is a UI concern (MP3/MP5); no DB-level block. |
| `/api/members/family/**` | Authenticated active member, usually family-group owner or adult login holder. | Signed-in member managing family relationships. | Family groups, invitations, child/adult join/removal requests, delegated non-login member details, inherited email, dependent records. | Email notifications and optional Xero contact/group sync. | Auth.js session, active-account guard, family request rate limiter, service-level ownership and adult/login-holder checks. | Audit log, logger, and email logs. | Family IDOR and shared-email risk. #614 should include a representative family-owned-resource boundary test. |
| `/api/issue-reports` | Authenticated active member. | Signed-in member reporting an issue. | Issue report text, screenshot metadata/storage path if captured, member id. | Email notification to admins. | Auth.js session, active-account guard, issue-report retention helpers. | Audit log and logger. | Not anonymous in current code. #615 should only treat it as public if the implementation changes. |
| `/api/chores/[token]` | Public opaque token. | Guest with chore link. | Guest chore assignment for one token/date. | None. | `rateLimiters.guestChoreToken`; token validation; `PUT` explicitly returns 405. | None. | Token URL can be logged or forwarded. Existing mitigation is rate limit and token expiry. Keep in public allowlist. |
| `/api/chores/roster/[date]/print` | Authenticated active member. | Member needing printable roster. | Roster/booking guest data for a date. | None. | Auth.js session, active-account guard, date validation via services. | None. | Data visibility should remain bounded to lodge/booking expectations. #618 can review lodge/roster exposure. |
| `/api/lodge/access`, `/api/lodge/pin-login`, `/api/lodge/guests/[date]/**`, `/api/lodge/roster/[date]/**` | Lodge guard or PIN login flow. `pin-login` starts a hut-leader PIN session behind an authenticated lodge/admin path. | Lodge account, admin, member with kiosk access, hut leader PIN session. | Lodge guest list, arrival/departure, roster chores, PIN session, audit records. | None. | `checkLodgeAuth()` for most routes, active-account guard, `rateLimiters.lodgePinLogin`, date scoping. The kiosk's lodge is resolved from its STAFF binding: exactly one grant binds, zero grants fall back to the default lodge, and a grant at **two or more lodges is ambiguous and denied** (`resolveKioskLodgeId` throws `AmbiguousKioskLodgeError`, which every kiosk data route maps to a clean `403` via `kioskLodgeAuthErrorResponse` rather than a 500; `pin-login` returns `403` directly) so a mis-selected double-grant cannot serve the default lodge's guest list/roster or accept its hut-leader PINs on the wrong property. | Audit log for arrival/departure and roster updates; logger for failures. | Shared lodge devices and PIN sessions have elevated operational risk. #618 should review kiosk session lifetime and device assumptions. |
| `/api/lodge-instructions` | Authenticated active member who is an admin or holds a current/upcoming hut-leader assignment (`canReadLodgeInstructions`). | Signed-in hut leader or admin. | Per-lodge operational documents (OPEN/CLOSE/DAY_TO_DAY), which may carry door codes and emergency access details. | None. | Active-session guard plus the reader gate. A requested `?lodgeId=` is constrained to the caller's own hut-leader assignment lodges (the assignment lodge set); an out-of-set lodge is `403`. Admins may request any lodge. Without this, the reader gate had no lodge dimension, so a lodge A hut leader could read lodge B's documents. | Logger on errors. | Reader-only surface; the admin editor lives under `/api/admin/lodge-instructions`. Assignment-scoped read keeps operational access details scoped to the lodge the leader actually runs. |
| `/display`, `/api/display/state`, `/api/display/heartbeat` | Unauthenticated public lobby-TV surface. A paired device carries a long-lived, hashed display token in an httpOnly cookie; `checkDisplayAuth()` (`src/lib/lodge-display-auth.ts`) resolves `tokenHash` → device → lodge and nothing else — it never maps to a `Member` and shares no code path with `checkLodgeAuth`, so a display token cannot inherit a kiosk capability. `lobbyDisplay` module-gated at the proxy (404 when off). | Anonymous lobby TV / paired display device; a full-admin session may also preview through the state route. | Privacy-reduced `DisplayState` from `buildDisplayState()` (`src/lib/lodge-display-state.ts`): names reduced to the configured granularity, minors never individually named, no money or member-id fields; an adult member phone appears only under the two-sided opt-in gate (`canServeMemberPhoneOnLodgeSurface`, both flags default off). | None. | `rateLimiters.api` (100/min/IP) on state and heartbeat; `buildDisplayState` is the single privacy-enforcement point (templates render as pure functions of its payload and cannot reach past it); window clamped server-side (default 3, max 7 days); revoked or inactive-lodge tokens are rejected without stamping `lastSeenAt`; every payload path sets `Cache-Control: no-store` (#176) so the privacy-reduced feed — which can include guest names and opted-in phone numbers — is never held in a shared/browser cache; scoped CSP on `/display` — `img-src 'self' data:`, `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN` (`src/lib/csp.ts`). | Only the device `lastSeenAt` stamp on a genuine device poll; no per-request audit. | Unattended public screen in a physical lobby. The display token is deliberately the weakest-privileged credential in the system (ADR-001); exposure is bounded to one lodge's already-privacy-reduced wall feed. |
| `/api/display/pair`, `/api/admin/display/devices/**` (including `[id]/pairing` bind and `[id]/revoke`) | Pairing `start`/`claim` are anonymous but bound to an HMAC-signed httpOnly pairing blob (`{code, exp}` signed with the auth secret); device create/list, code bind, and revoke require the shared `requireAdmin()` guard. | Anonymous display device (start/claim) and admin (create/bind/revoke). | `LodgeDisplayDevice` rows — name, lodge FK, `pairingCode`+expiry, and `tokenHash` (hash only; the raw token is returned once to the device and never re-read). | None. | `rateLimiters.displayPairing` (10/15min, auth-sensitive) on start and admin bind; `rateLimiters.displayClaim` (30/min) on the claim poll; a 6-character code from a 31-symbol unambiguous alphabet; the anonymous side persists nothing (start only signs a blob); claim must present the server-signed blob for that browser, so a shoulder-surfed code alone is useless; a matched claim issues the token, stores only its hash, and clears the pairing fields (single-use); revoke sets `revokedAt`, rejecting the token on its next request. | `LODGE_DISPLAY_DEVICE_REVOKED` audit on revoke; logger otherwise. | Shared-device physical control and the long-lived token are the standing operational trust assumptions (ADR-001); revocation is the containment lever. |
| `/api/admin/display/**` (`layouts/**`, `templates/**`, `lodge-config`, `devices/**`, `reference/conditions`) | Admin session via the shared `requireAdmin()` guard on every method. | Admin. | Authored `DisplayLayout`/`DisplayTemplate` HTML/CSS, slot content, footer HTML, CSS overrides, and device bindings. | None. | Threat is admin-authored HTML/CSS rendered on an unattended public wall. The shared save contract (`validateTemplateForSave`/`validateLayoutForSave`, `src/lib/lodge-display/authoring-validation.ts`) rejects structurally-broken content before it can persist; a serve-time allow-list sanitiser with CSS scoping and value-token escaping neutralises unsafe markup/CSS at render; because value-token resolution runs AFTER the sanitiser, a resolved token value that opens an authored `href`/`src` is additionally scheme-validated (#176) so a config value like `javascript:`/`data:` collapses to an inert `#` rather than surviving into a live URL; nonce-based CSP (`script-src 'self' 'nonce-…'`, no inline script); previews run in a `sandbox="allow-scripts"` opaque-origin iframe — never `allow-same-origin`, pinned by tests on both preview surfaces (the preview host and the Visual builder's Live preview, #2246). | `DISPLAY_TEMPLATE_CREATED`/`DISPLAY_LAYOUT_CREATED` and equivalent update audit entries; logger on failures. | Authored content is admin-trusted but rendered unattended, so the sanitiser plus nonce CSP are the standing mitigations. The ADR-003 `img-src https:` image-beacon exfiltration residual is now CLOSED on display routes: `/display` and `/admin/display/preview` reduce `img-src` to `'self' data:` (#161, `src/lib/csp.ts`). That tightened set and the `frame-src 'self'` set are separate exact-match allowlists (#2246): the Visual builder `/admin/display/builder` is in the `frame-src` set only, because it embeds the `/display` iframe but is itself a full admin page rather than a sandboxed display document. A scoped relaxation only applies on a hard document load, so the builder is entered by a plain `<a>`/`window.open(…, "_self")` and never by a soft `<Link>` — see "Per-Route CSP Relaxation And Soft Navigation" below for that rule, its guard test, and the accepted forward-leak residual. |
| `/api/admin/display/preview-grant`, `/api/admin/display/preview`, and the state route's `?previewGrant` path | The shared `requireAdmin()` guard mints the grant; the grant itself is an HMAC-signed, 5-minute, domain-separated, stateless capability. | Admin (mint); a sandboxed opaque-origin preview iframe (consume). | A signed payload naming exactly one template + lodge (plus an optional simulated date); on redemption, the same privacy-reduced preview state. | None. | A distinct HMAC domain-separation prefix (`lodge-display-preview-grant:`) means a pairing blob can never be replayed as a grant or vice versa; the expiry lives inside the signed payload (cannot be extended by tampering); a signed `windowStart` in the grant is authoritative — an unsigned `?previewDate` on the sandbox-rewritable iframe URL cannot shift the served window beyond it (#176); single-purpose — only the state route's preview path honours it, never the heartbeat or any admin route; it is not a display token and never stamps `lastSeenAt`; it renders through the same privacy serialiser; the permissive `Access-Control-Allow-Origin: *` is safe because the opaque-origin fetch sends no cookies and the body is already the public wall feed. | None beyond logger. | A leaked grant can at worst re-render a five-minute, privacy-reduced board for its named lodge/template. |
| `/api/admin/setup/**`, `/api/admin/modules`, `/api/admin/health`, `/api/admin/runtime-status` | Admin session. `runtime-status` now uses the shared `requireAdmin()` guard. | Admin. | Setup progress, provider readiness, module settings, health detail, runtime status. | Provider test route can check Stripe/email/Xero config when admin triggers it; health checks DB/Xero/SMTP/Stripe readiness. | Admin role plus active-account guard via `requireAdmin()`. | Audit logs for setup/progress/module changes; logger for provider/health errors. | Resolved under #613 (closed): `admin/runtime-status` uses `requireAdmin()`. Provider-test/setup guard standardisation is the remaining hardening item. |
| `/api/admin/members/**`, including dependents, family, lifecycle, setup invites, password resets, import/export, credits, Xero link/push/unlink | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Member PII, passwords/action tokens, family/dependent links, credits, lifecycle/archive/delete state, Xero contact links, import/export payloads. | Email sends, Xero contact/group sync, password setup/reset email. CSV setup invites are limited to imported rows that can log in. | Shared `requireAdmin()` guard on every method; import has rate limit; some credit/lifecycle routes import rate-limit helpers. Access-role writes are Full-Admin-only (#1012). Deactivating, de-logging, or archiving an account is guarded (#1604, extended #1622): the last active Full Admin can never be removed, and only a Full Admin may deactivate/de-login/archive a privileged-role account — enforced on member edit, bulk update, lifecycle archive, and dependent linking with `disableLogin` (`POST /api/admin/members/[id]/dependents/link`) via `src/lib/admin-account-guards.ts`. | Extensive audit log for member, credit, lifecycle, and Xero actions; logger for failures. | Highest PII/IDOR blast radius. #613 should migrate to shared admin guard; #614 should guard missing admin checks; #617 should review lifecycle integrity. |
| `/api/admin/member-applications/**`, `/api/admin/membership-cancellation-requests/**`, `/api/admin/members/[id]/membership-cancellation`, `/api/admin/membership-cancellation-settings`, `/api/admin/deletion-requests/**` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Applications, cancellation requests/participants/settings, deletion request state, member lifecycle action requests. | Email sends; cancellation approval can affect Xero contact groups/archive through services. | Admin role plus active guard; participant resend/approval routes import rate-limit helpers. Approving a membership cancellation or a deletion request applies the #1604 admin-account guards (extended by #1622): only a Full Admin may de-login/anonymise a privileged-role account, and the last active Full Admin cannot be removed. The family-group login-holder transfer (`POST /api/admin/family-groups/[id]/login-holder`) carries the same two guards, evaluating the last-admin end state on its post-write count so the incoming holder's login grant is included. | Audit log and logger. | Sensitive lifecycle and account deletion operations. #617 should review durable state transitions and external writes outside long transactions. |
| `/api/admin/bookings/**`, `/api/admin/booking-change-requests/**`, `/api/admin/booking-reviews`, `/api/admin/waitlist` | Admin session via the shared `requireAdmin()` guard (per-method test-enforced, #1132). | Admin. | Booking list/search/detail, operational payment/Xero/bed/change filters, review/force-confirm state, change requests, waitlist. | Email sends; Xero invoice/outbox; capacity/booking services. | Admin role plus active guard; route/service validation. | Audit logs for booking approvals/force-confirm/change-request decisions; logger. | Financial and reservation integrity surface. #613/#614 should standardize guard markers; #617 should review invariants. |
| `/api/admin/bookings/[id]/exclusive-hold` | Admin session via the shared `requireAdmin()` guard (mirrors the sibling capacity-hold route). | Admin. | `Booking.wholeLodgeHold` plus its who/when audit fields; on set, the ids of overlapping capacity-holding bookings surfaced for officer resolution. **Also `BedAllocation` rows (#2285):** setting the hold DELETES every per-bed row this booking owns (manually placed and admin-approved rows included) and clearing it re-plans them through the auto-allocator, which can in turn move or unallocate OTHER bookings' provisional rows; each such displacement and each `#1750` partner promotion writes its own extra audit row. | None. | The flag write, the conflict read and the allocation reconcile all run inside the per-lodge capacity lock (`acquireLodgeCapacityLock`, #154) — the same key every admission takes — so setting a hold cannot race an in-flight admission and the flag can never commit apart from its allocation rows; the reconcile runs strictly after the compare-and-set write, so a lost claim (409) changes nothing. No capacity **admission** decision is made here and the availability engine (`checkCapacityForGuestRanges`) is never consulted (exclusive-booking ADR-001 decision 1) — the hold is never refused for want of space — but the bed-allocation planner IS run on the clear direction, so "no arithmetic at all" is not accurate: it is bed *placement*, not bed *admission*. Set and clear are idempotency-guarded (409 on a redundant set or clear); Zod body validation. | `booking.exclusiveHold.set`/`booking.exclusiveHold.cleared` audit entries (important severity) recording the overlapping conflict ids, the reconcile counts, and — on set — a capped list of the removed allocation rows so a mistaken hold can be undone by hand (#2285); plus `bed_allocation.provisional_displaced` and `BED_ALLOCATION_PARTNER_PROMOTED` rows from the reconcile itself. | Privacy property is member-facing indistinguishability (exclusive-booking ADR-001 decision 6): held nights present to members and the public exactly as a genuinely full lodge — same "no space" messaging, waitlist, and emails — and the exclusive nature is visible only on admin surfaces, never surfaced to members. |
| `/api/admin/bed-allocation/**` | Admin session plus bed-allocation module capability. | Admin. | Lodge rooms, lodge beds, per-night guest allocations, allocation approvals, booking highlight/date-range filters. | None directly. | `requireBedAllocationAdmin()`, module-state gate, Zod/body validation through bed-allocation route helpers, service-level allocation uniqueness constraints. | Audit logs for room/bed/allocation/settings mutations and approval runs; logger on failures. | Reservation and shared-room integrity surface. Keep allocation writes synchronized with booking lifecycle and preserve per-guest date-only semantics. |
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
| `/api/admin/bed-allocation/rooms/bulk`, `/api/admin/lockers/bulk` | Admin session. Rooms-bulk via `requireBedAllocationAdmin()` (admin plus the Bed Allocation module capability); lockers-bulk via the shared `requireAdmin()` guard. | Admin. | Bulk-created `LodgeRoom`/`LodgeBed` and `Locker` rows for a resolved active lodge. | None. | Admin/module guard; Zod strict schemas cap batch size (`MAX_BULK_ROOMS`, `MAX_BULK_BEDS_PER_ROOM`, `MAX_BULK_LOCKERS = 100`); target lodge validated active or 400; a clashing name prefix is rejected (409) before any rows are written; the whole batch is created in one transaction. | Structured audit logs `BED_ALLOCATION_ROOMS_BULK_CREATED` and `locker.bulk_created` with lodge id and counts. | Write-amplification surface: one admin call seeds many rows. Batch caps and transactional all-or-nothing creation bound the amplification; keep the caps in place and the clash pre-check ahead of the write. Name uniqueness is `[lodgeId, name]`; null-lodge rows still clash at every lodge until the contract release enforces NOT NULL. |
| `/api/finance/bookings/metrics`, `/api/finance/sync/**`, `/api/finance/legacy-dashboard/**` | Finance viewer or manager guard depending on route. Legacy auth route redirects/204s for viewer access. | Finance viewer/manager; not lodge accounts. | Finance snapshots, booking metrics, finance sync run state, operational Xero organisation/config status. | Operational Xero API through the finance sync service. | `requireFinanceViewerApiAccess()` or `requireFinanceManagerApiAccess()`; active and force-password-change checks; shared admin-managed Xero connection. | Logger for sync/Xero failures; sync status records. | Privileged but not always admin. #618 should review finance role assignment and legacy dashboard bridge; #614 should cover ordinary member/admin-without-finance denial. |
| `/api/cron`, `/api/cron/payments`, `/api/cron/xero`, `/api/cron/issue-reports` | Shared `x-cron-secret` header matching `CRON_SECRET`. | External scheduler or operator with cron secret. | Pending booking confirmation, payment recovery, Xero outbox/retry/inbound reconciliation, issue-report digest, cron run rows. | Stripe through payment recovery, Xero through operational sync, email alerts/digests. | Constant-time compare in each route, task allowlists, module-state gating for Xero tasks. | Logger; `CronJobRun` records for payment recovery; provider/service logs. | Cron guard is centralised in `requireCronSecret()` and covered by missing/wrong/different-length secret tests (#613/#614 closed). |
| `/api/deploy/runtime-status` | Shared `x-cron-secret` header matching `CRON_SECRET`. | Blue/green deploy script or operator with cron secret. | Runtime role and cron-enabled flag only. | None. | Shared `requireCronSecret()` helper (constant-time compare). | None. | Resolved under #613 (closed): now uses the shared cron/deploy guard helper rather than a duplicated local compare. |
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

## Sensitive Data Inventory

| Data store or secret class | Where it appears | Current controls | Follow-up |
| --- | --- | --- | --- |
| Password hashes and session security fields | `Member.passwordHash`, `forcePasswordChange`, `passwordChangedAt`, Auth.js JWT callbacks. | bcrypt, email verification before session, session invalidation on password change. | #615 for account-recovery behavior; #617 for lifecycle interactions. |
| Action and verification tokens | Password reset, setup invite, verification, email change, nomination, chore, cancellation confirmation helpers. | Token helpers store hashes/expiry where implemented; some routes are session-bound in addition to token-bound. | #615 for token URL/log exposure and enumeration. |
| Member PII | Member/profile/family/admin/application routes. | Session/admin guards, audit logs on sensitive changes, scoped selects in public committee route that exclude email and gate phone by assignment flag. | #613/#614 for route boundaries; #617 for integrity and lifecycle review. |
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
- Adopted across all four multipart surfaces with their existing status codes and
  messages preserved: `/api/members/[id]/photo` (2MB/file), `/api/admin/image-library`
  (2MB/file), `/api/admin/image-manager/upload` (a batch route — now capped at 25
  files and an 80MB total request body, while keeping its friendly per-file
  10MB result), and the config-transfer `readBundleUpload` shared by the plan /
  apply / reseal routes (50MB bundle file, ~54MB request body).
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
