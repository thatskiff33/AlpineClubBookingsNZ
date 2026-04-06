# TACBookings - Build History

All 9 build phases + security audit + 5 integration reviews completed on 2026-04-03. 292 tests pass. All critical/high issues resolved.

---

## Security Audit - COMPLETED

**Date:** 2026-04-03

**Scope:** Dedicated security audit across authentication, authorization, input validation, payment security, Xero security, data exposure, infrastructure, and rate limiting. Build, type check, 292 tests all pass.

**12 issues found and fixed (1 Critical, 2 High, 5 Medium, 4 Low). All fixed:**

1. **CRITICAL: PostgreSQL port exposed to internet** (`docker-compose.yml`) - `ports: "5432:5432"` bound the database to all network interfaces. On a Lightsail instance, this makes the DB reachable from the internet. Combined with `${DB_PASSWORD:-password}` default, an attacker gets full database access. Removed the port mapping entirely — only the app container needs DB access via Docker internal network. (OWASP A05:2021 Security Misconfiguration)

2. **HIGH: App port bypasses Caddy HTTPS** (`docker-compose.yml`) - `ports: "3000:3000"` allowed direct HTTP access to the app, bypassing Caddy's automatic HTTPS, security headers, and certificate validation. Removed the port mapping — Caddy connects to `app:3000` via Docker network. (OWASP A05:2021 Security Misconfiguration)

3. **HIGH: CSP allows unsafe-eval** (`src/middleware.ts`) - `'unsafe-eval'` in `script-src` allowed `eval()`, `Function()`, and similar, significantly weakening XSS protection. Not needed for Next.js production builds. Removed from CSP directive. (OWASP A03:2021 Injection)

4. **MEDIUM: No Stripe webhook idempotency** - No tracking of processed Stripe event IDs. Replayed events could cause duplicate Xero invoices/emails. Added `ProcessedWebhookEvent` model in Prisma schema. Webhook handler now checks for existing event ID before processing and records it after.

5. **MEDIUM: Timing-unsafe cron secret comparison** - `src/app/api/cron/route.ts`, `src/app/api/cron/xero/route.ts`, and `src/app/api/payments/charge-saved-method/route.ts` used `===` for CRON_SECRET comparison. Replaced with `crypto.timingSafeEqual()`.

6. **MEDIUM: Timing-unsafe Xero webhook signature comparison** - `src/app/api/webhooks/xero/route.ts` used `!==` for HMAC comparison. Replaced with `crypto.timingSafeEqual()`.

7. **MEDIUM: Webhook error leaks details** - `src/app/api/webhooks/stripe/route.ts` included Stripe verification error message in response body. Changed to generic "Webhook signature verification failed" message (details still logged server-side).

8. **MEDIUM: Type assertion in reports route** - `src/app/api/admin/reports/route.ts` used `(session.user as { role: string }).role`. Replaced with `session.user.role` consistent with all other routes.

9. **LOW: Password minimum 8 characters** - Increased to 12 per NIST SP 800-63B guidance. Updated server-side Zod schemas in register and reset-password routes, plus client-side validation in both form pages.

10. **LOW: Bcrypt cost factor 12** - Increased to 13 in both register and reset-password routes.

11. **LOW: No audit logging** - Added `AuditLog` model and `logAudit()` fire-and-forget helper. Wired into: booking cancellations (all paths, with refund details), season create/update/delete, promo code create/update/delete, cancellation policy updates.

12. **LOW: JWT 24h expiry** - Reduced from 24 hours to 8 hours to limit token compromise window.

**Security controls verified as working correctly:**
- All 36 API routes check authentication (auth() call)
- All admin routes verify `role === "ADMIN"`
- All inputs validated with Zod schemas
- No raw SQL injection risk (Prisma parameterized, advisory lock uses no user input)
- No `dangerouslySetInnerHTML` usage anywhere
- Stripe webhook signature properly verified with idempotency protection
- Xero OAuth tokens encrypted at rest with AES-256-GCM
- Xero webhook HMAC-SHA256 signature verified with timing-safe comparison
- Stripe secret key never exposed client-side
- PaymentIntent amounts set server-side from database
- Booking prices calculated server-side (client cannot manipulate)
- Password reset tokens are single-use with 1-hour expiry
- Rate limiting on all auth routes, booking creation, and query endpoints
- Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, CSP, etc.)
- .env in .gitignore, .env.example contains no real secrets
- Dockerfile uses multi-stage build, runs as non-root user
- No environment variables baked into Docker image

---

## Full Integration Review #5 (Remaining Issues) - COMPLETED

**Date:** 2026-04-03

**Scope:** Fix all remaining medium/low issues identified in Review #4 and agent reviews. Build, type check, 292 tests all pass.

**6 issues fixed:**

1. **MEDIUM: Advisory lock only covered check-in date** - Changed to a fixed lock key (`pg_advisory_xact_lock(1)`) to serialize all booking creation.
2. **MEDIUM: `(session.user as any).role` type assertions** - 19 occurrences across 9 admin routes replaced with `session.user.role`.
3. **MEDIUM: Missing rate limiting on query endpoints** - Added `bookingQuery` rate limiter (60 req/min) to `/api/bookings/quote`, `/api/availability`, `/api/promo-codes/validate`.
4. **MEDIUM: Non-deterministic chore allocator sorting** - Added stable tie-breaker using `a.id.localeCompare(b.id)`.
5. **MEDIUM: HTML injection in email templates** - Added `escapeHtml()` helper and applied to all user-provided values across all 7 email templates.
6. **LOW: FK indexes already existed** - PasswordResetToken.memberId and ChoreAssignment.choreTemplateId were already indexed. No change needed.

---

## Full Integration Review #4 (Complete Codebase) - COMPLETED

**Date:** 2026-04-03

**Scope:** End-to-end flow verification across all 9 phases, concurrency review, data integrity, deployment config. Build, type check, 292 tests all pass.

**6 issues found (3 Critical, 3 High). All fixed:**

1. **CRITICAL: BookingPaymentWrapper not wired into booking flow** - Added `BookingPaymentSection` client component and integrated it into the booking detail page.
2. **CRITICAL: Cancellation emails never sent** - Added email sends to all cancellation paths in both cancel routes.
3. **CRITICAL: Stripe publishable key env var mismatch** - Fixed env var name in docker-compose and .env.example.
4. **HIGH: Missing env vars in .env.example** - Added `DB_PASSWORD` and `DOMAIN`.
5. **HIGH: Cron double-charge race condition** - Added atomic `updateMany` claim (WHERE status=PENDING) before charging.
6. **HIGH: Promo code max-redemptions race condition** - Added `SELECT ... FOR UPDATE` row lock on the promo code.

---

## Cross-Phase Integration Review #3 (Wave 2 Merge) - COMPLETED

**Date:** 2026-04-03

**Scope:** Focused review of Phases 7 (Promo Codes) and 9 (Polish & Production Hardening) integration.

**5 issues found (2 Critical, 3 High). All fixed:**

1. **CRITICAL: Promo redemption not cleaned up on bumping** - Added cleanup within the existing transaction in `bumping.ts`.
2. **CRITICAL: Promo redemption not cleaned up on cancellation** - Added `cleanupPromoRedemption()` helper to both cancel routes.
3. **HIGH: Login route not rate limited** - Wrapped POST handler with `applyRateLimit(rateLimiters.login, request)`.
4. **HIGH: Promo code PUT route missing type-specific validation** - Added validation matching the POST route.
5. **HIGH: Promo code expiry boundary off-by-one** - Changed `now > validUntil` to `now >= validUntil`.

---

## Cross-Phase Integration Review #2 - COMPLETED

**Date:** 2026-04-03

**Scope:** Full 8-section codebase review after all phases merged. 224 tests all pass.

**15 issues found (1 Critical, 2 High, 8 Medium, 4 Low). All Critical and High issues fixed:**

1. **CRITICAL: Xero invoice night calculation wrong** - Replaced `Math.round()` with `getStayNights()` from pricing engine.
2. **HIGH: Xero token refresh unhandled** - Added try-catch with descriptive error message.
3. **HIGH: Season end boundary bug in membership check** - Changed to exclusive upper bound using April 1.

---

## Cross-Phase Integration Review #1 - COMPLETED

**Date:** 2026-04-03

**Scope:** Full codebase review after merging Phases 5, 6, and 8 in parallel. 224 tests all pass.

**24 issues found (2 Critical, 8 High, 10 Medium, 4 Low). All Critical and High issues fixed:**

1. **CRITICAL: `/api/bookings/cancel` had no auth** - Restored `auth()` call and ownership verification.
2. **HIGH: Payment routes missing ownership checks** - Added `booking.memberId !== session.user.id` checks.
3. **HIGH: Missing Xero invoice on manual charge** - Added guarded `createXeroInvoiceForBooking()` call.
4. **HIGH: Duplicate cancellation routes with inconsistent logic** - Rewrote to include full cancellation flow.
5. **HIGH: Wrong CHILD age threshold in profile** - Now imports from `@/lib/age-tier`.
6. **HIGH: Missing Xero env vars in docker-compose** - Added `XERO_ENCRYPTION_KEY` and `XERO_WEBHOOK_KEY`.
7. **HIGH: No cron overlap guard** - Added `isRunning` flags with `finally` cleanup.

---

## Phase Build Summaries

### Phase 1: Foundation
Next.js 15 + TypeScript + Tailwind + shadcn/ui, Prisma schema (all entities), NextAuth v5 credentials auth with JWT sessions, password reset flow, member profile, admin layout with sidebar, Docker Compose + Caddy setup.

### Phase 2: Seasons & Pricing
Admin seasons CRUD, cancellation policy management, pricing engine with full test coverage.

### Phase 3: Core Booking
Availability calculator (29-bed capacity), booking wizard, guest forms, booking API routes, my bookings list + detail pages, admin bookings page with filters.

### Phase 4: Stripe Payments
PaymentIntents for confirmed bookings, SetupIntents for pending bookings, Stripe webhook handler, cancellation with policy-based refunds, Stripe React components.

### Phase 5: Non-Member Guests & Bumping
FIFO bumping algorithm, cron job for auto-confirming pending bookings, booking API integration with bumping for member bookings, email notifications.

### Phase 6: Xero Integration
OAuth2 connect flow, encrypted token storage, invoice creation on booking confirmation, credit notes on refunds, contact sync, membership verification, daily cron for membership refresh, webhook handler.

### Phase 7: Promo Codes & Discounts
Admin promo code CRUD, promo validation library, validation API, promo code input component in booking wizard, booking API integration with promo redemption tracking. Supports PERCENTAGE, FIXED_AMOUNT, and FREE_NIGHTS discount types. 44 new tests.

### Phase 8: Chore Roster
Chore allocator algorithm (round-robin, age-aware), admin chore template management, roster review/edit page, printable A4 roster view, chore roster email notifications. 39 chore allocator tests.

### Phase 9: Polish & Production Hardening
Error pages (404/500/global), security headers middleware, rate limiting on auth/booking routes, admin reports dashboard with recharts, polished HTML email templates, automated pg_dump backup cron with S3 upload. 31 new tests.

---

## Known Remaining Issues (from reviews, not yet fixed)

- Duplicate cancel routes (`/api/bookings/cancel` + `/api/bookings/[id]/cancel`) with duplicated logic
- `getSeasonYear` duplicated in 3 files (`utils.ts`, `pricing.ts`, `age-tier.ts`)
- `formatCents` duplicated in 2 files
- Unused `Room` model in Prisma schema
- Unused `calculateRefund` function in `pricing.ts` (active version is in `cancellation.ts`)
