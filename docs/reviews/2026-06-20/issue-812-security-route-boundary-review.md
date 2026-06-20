# Issue #812: Security/Auth/Access-Control Route Boundary Review

Date: 2026-06-20

Review type: static, review-only planning task. No application code was changed. No live provider calls, production credentials, production data, DAST, browser automation, endpoint scanning, issue creation, push, merge, or issue closure were performed.

## Scope Reviewed

- Mapped `src/app/api` route boundary patterns against session, role, finance, lodge, cron, webhook, token, and public exception helpers.
- Reviewed the explicit API route boundary allowlist/test strategy and checked current route files for expected guard markers.
- Inspected representative public, token-based, webhook, payment, admin, finance, lodge, cron, booking, group-booking, image, and account-authentication routes.
- Reviewed logging/redaction helpers for token, credential, payment, and provider callback exposure risk visible from static inspection.
- Compared the current route tree with the existing security attack-surface inventory.

## Files/Directories Inspected

- `AGENTS.md`
- `docs/agents/ISSUE_WORKFLOW.md`
- `docs/agents/PROMPT_INJECTION_GUIDE.md`
- `docs/agents/REVIEW_SEVERITY.md`
- `docs/DOMAIN_INVARIANTS.md`
- `docs/SECURITY-ATTACK-SURFACE.md`
- `docs/ARCHITECTURE.md`
- `docs/MAINTENANCE.md`
- `docs/reviews/2026-06-20/REVIEW_ISSUE_BACKLOG.md`
- `docs/reviews/2026-06-20/ISSUE_CREATION_PLAN.md`
- `package.json`
- `prisma/schema.prisma`
- `src/app/api/**/route.ts` route structure, with targeted reads of public, webhook, payment, admin, finance, lodge, cron, booking, group-booking, image, induction, work-party, auth, and token routes.
- `src/lib/api-route-security.ts`
- `src/lib/__tests__/api-route-boundaries.test.ts`
- `src/lib/auth.ts`
- `src/lib/session-guards.ts`
- `src/lib/finance-api-auth.ts`
- `src/lib/finance-auth.ts`
- `src/lib/lodge-auth.ts`
- `src/lib/lodge-pin-session.ts`
- `src/lib/kiosk-access.ts`
- `src/lib/cron-auth.ts`
- `src/lib/action-tokens.ts`
- `src/lib/rate-limit.ts`
- `src/lib/redact-sensitive-json.ts`
- `src/lib/logger.ts`
- `src/lib/webhook-body.ts`
- `src/lib/webhook-log.ts`
- `src/lib/api-logger.ts`
- `src/lib/payment-link.ts`
- `src/lib/group-booking.ts`

## Route/Auth Boundary Map

Current static inventory found 280 `src/app/api/**/route.ts` files.

| Boundary type | Expected guard or control | Current pattern from static review |
| --- | --- | --- |
| Public allowlist | Explicit entry in `explicitPublicApiRoutes`, public-safe response, usually rate-limited | Defined in `src/lib/api-route-security.ts`; route-boundary test uses this list for file-level classification. |
| Member | `requireActiveSession()` or `requireActiveSessionUser()` | Default for non-public API routes outside admin, finance, lodge, cron, deploy, and webhook families. |
| Admin | `requireAdmin()` | Admin route files under `src/app/api/admin` had expected marker coverage in the static marker pass. |
| Finance | `requireFinanceViewerApiAccess()`, `requireFinanceManagerApiAccess()`, or equivalent finance-access check | Finance route files had expected marker coverage. Finance access is separate from role and rejects inactive, lodge, and forced-password-change sessions. |
| Lodge | `checkLodgeAuth()` or lodge PIN login boundary | Lodge route files had expected marker coverage. Lodge PIN sessions are signed, versioned, time-limited, and bound to an allowed request class. |
| Cron/deploy runtime | `requireCronSecret()` or `isValidCronSecret()` | Cron and deploy runtime-status route files had expected marker coverage. |
| Webhook | Provider signature verification plus bounded raw-body handling | Stripe, Xero, and SES routes verify signatures or SNS envelope authenticity before processing. |
| Token-based public flows | Random tokens stored as hashes, constrained format, expiry/status checks, rate limits | Payment links, booking request verification, chores, nominations, password/email actions, and group-booking join verification follow token-boundary patterns, with specific follow-up items below. |

The static route-boundary test is useful, but it is file-level and marker-based. It can miss mixed-method routes where one exported method is public and another is protected, or where a protected method uses an inline role check instead of the canonical guard helper.

## Public Endpoints And Why They Appear Public

- `GET /api/health` and `GET /api/health/ready`: liveness/readiness endpoints with no user data.
- Public site/content endpoints such as age-tier settings, committee data, contact submission, applications, and address autocomplete: intended unauthenticated front-door flows, generally rate-limited or read-only.
- Auth/account flows under `/api/auth`, forgot/reset password, email verification, email change confirmation, resend verification, and registration: public by design, using rate limits, token hashes, expiry checks, and non-enumerating responses where expected.
- Booking request public routes, including request creation, school requests, quote, settings, route metadata, and verification: intended non-member booking-request entry points, with validation, rate limits, date/capacity checks, and token verification.
- Chore, nomination, payment-link, and group-booking join token routes: public because the bearer token is the authority; they should stay tightly scoped, rate-limited, expired, and redacted from logs.
- Public image serving routes: DB-backed public media by ID and uploaded-image paths, with MIME/path controls and response headers.
- Stripe, Xero, and SES webhooks: public network entry points protected by provider signatures and bounded raw-body readers.
- `GET /api/group-bookings/[code]`: appears intentionally public from route comments and implementation because it returns a limited join-code summary. This route is not currently represented as public in `explicitPublicApiRoutes`, which creates a boundary-map blind spot.

## Protected Endpoints And Expected Guard Type

- Member application routes outside the explicit public/webhook/admin/finance/lodge/cron families should require an active session and usually ownership checks before returning or mutating booking, payment, family, profile, induction, work-party, and member data.
- Admin routes under `src/app/api/admin` should require `requireAdmin()`. Bed-allocation admin routes additionally flow through a module gate helper.
- Finance routes under `src/app/api/finance` should require finance viewer or manager API access. Xero finance callback/connect flows should remain manager-only and state-bound.
- Lodge routes under `src/app/api/lodge` should require `checkLodgeAuth()` except the PIN login boundary, which should authenticate the PIN and issue a constrained signed lodge session.
- Cron routes and deploy runtime-status should require the cron secret.
- Payment routes that return Stripe client secrets or mutate booking payment state should require active session plus owner-or-admin authorization, or be token-bound payment-link flows with no session assumption.
- Webhook routes should never rely on user session. They should verify provider signatures, bound payload size, handle idempotency, and avoid leaking provider payload details.

## Likely Risk Areas To Verify

1. Method-level boundary blind spot: `GET /api/group-bookings/[code]` is public while `PATCH /api/group-bookings/[code]` is protected in the same route file. The file-level boundary test classifies the file as member-protected because one method contains the session marker.
2. Public group-booking join responses: static inspection found a mismatch between neutral-response comments and route behavior for some public join-request errors. Sensitive follow-up required.
3. Token-bearing group-booking join verification URLs: the current redaction path patterns cover several token URL families but do not appear to cover the group-booking join verification path. Sensitive follow-up required.
4. Payment and group-booking token flows: static inspection suggests strong token/hash/status patterns, but these routes should have regression tests proving token scope, response shape, capacity checks, idempotency, and no cross-booking exposure.
5. Security inventory drift: `docs/SECURITY-ATTACK-SURFACE.md` is stale compared with the current route tree and still references an admin runtime-status guard gap that appears resolved in current code.
6. In-memory public-route rate limits: current limiters are process-local. This may be acceptable for the deployed topology, but should be re-verified for blue/green or multi-instance runtime assumptions and proxy IP handling.
7. Mixed privilege methods outside admin folders: routes such as `seasons` use member-level file boundaries with stricter inline checks for write operations. Method-aware tests should make this explicit.

## Proposed Follow-Up Issues

No GitHub issues were created as part of this task.

- Add method-aware API boundary metadata and tests that evaluate each exported HTTP method, including mixed public/protected and mixed member/admin route files.
- Review public group-booking join-request response semantics against anti-enumeration requirements. Sensitive follow-up required.
- Extend token URL redaction coverage and tests for group-booking join verification links and encoded callback/query variants. Sensitive follow-up required.
- Refresh `docs/SECURITY-ATTACK-SURFACE.md` from the current route tree and remove stale resolved guard-gap notes.
- Add representative mocked owner-boundary tests for booking, payment, payment-link, group-booking, family/member, induction, and lodge-instruction routes.
- Add targeted tests around payment-link client-secret issuance, expired-link refresh, idempotent used-link handling, and no session-based ownership bypass.
- Verify public-route rate-limit behavior under the actual deployment topology and trusted proxy header assumptions without live scanning.
- Standardize inline role checks on canonical helpers where practical, or document accepted exceptions in route-boundary metadata.

## Sensitive Findings That Should Not Be Public

This review intentionally avoids detailed exploitation instructions.

- Public group-booking join-request response behavior may disclose more account or group state than the surrounding comments imply. Sensitive follow-up required.
- Group-booking join verification token URLs may not be covered by the current token-path log redaction pattern. Sensitive follow-up required.
- Any review of token-bearing payment or group-booking routes that confirms a client-secret or bearer-token exposure problem should be handled privately until fixed.

## Tests/Static Checks Recommended

- Expand `src/lib/__tests__/api-route-boundaries.test.ts` or add a companion check that parses exported `GET`, `POST`, `PATCH`, `PUT`, and `DELETE` methods and records the expected boundary per method.
- Add redaction tests for `/api/group-bookings/join/verify/[token]`, encoded callback URLs containing that path, and request logger path fields.
- Add route tests proving neutral public join-request behavior where intended, without revealing whether an email belongs to an existing member or whether a join code exists beyond the intended public summary route.
- Add mocked payment ownership tests for direct payment routes and token-only tests for public payment-link routes, especially routes that return Stripe client secrets.
- Add static assertions that all new token-bearing URL families are registered in redaction and public-route boundary metadata.
- Add mocked webhook tests for bounded-body rejection, missing/invalid signature rejection, idempotency, and redacted error logging.
- Keep these as local or CI-safe mocked tests only; do not use live providers, production credentials, production databases, browser automation, DAST, or live endpoint scans.

## Uncertainty/To-Verify List

- No lint, unit, integration, browser, DAST, live provider, or production checks were run per the issue instructions.
- Static inspection did not prove every downstream service-layer ownership check; representative route tests should cover the highest-risk families.
- The intended public status of `GET /api/group-bookings/[code]` should be confirmed and then encoded in method-level boundary metadata or separated into a clearly public route.
- The intended disclosure model for public group-booking join errors needs product/security confirmation before changing behavior.
- Deployment assumptions for process-local rate limits and trusted proxy IP handling should be confirmed from operator documentation or a non-production environment.
- The attack-surface inventory should be regenerated or manually refreshed after method-level boundary decisions are made.
