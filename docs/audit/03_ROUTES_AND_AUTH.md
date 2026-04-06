# Routes & Authentication Audit

**Date:** 2026-04-04
**Scope:** Every route and view in the TACBookings application, with HTTP methods, purpose, and authentication requirements.

---

## Authentication Architecture

| Layer | File | Behaviour |
|-------|------|-----------|
| Middleware | `src/middleware.ts` | Security headers only (CSP, HSTS, X-Frame-Options, etc.). **Does not enforce authentication.** |
| Website layout | `src/app/(website)/layout.tsx` | No auth required. Reads session to toggle header links. |
| Public layout | `src/app/(public)/layout.tsx` | No auth required. |
| Authenticated layout | `src/app/(authenticated)/layout.tsx` | Requires valid session via `auth()`. Redirects to `/login` if unauthenticated. Checks `forcePasswordChange` flag and redirects to `/change-password`. |
| Admin layout | `src/app/(admin)/layout.tsx` | Requires valid session **and** `role === "ADMIN"`. Redirects to `/login` if unauthenticated, `/dashboard` if not admin. Checks `forcePasswordChange`. |

Session strategy: JWT, 8-hour max age, credentials provider only (email + password).

---

## 1. Public Website Pages

No authentication required. Served under the `(website)` route group.

| URL | File | Description |
|-----|------|-------------|
| `/` | `src/app/(website)/page.tsx` | Landing page with club highlights and CTAs |
| `/about` | `src/app/(website)/about/page.tsx` | Club history and information |
| `/committee` | `src/app/(website)/committee/page.tsx` | Committee member listing |
| `/contact` | `src/app/(website)/contact/page.tsx` | Contact form (client component, POSTs to `/api/contact`) |
| `/join` | `src/app/(website)/join/page.tsx` | Membership types and features |
| `/rules` | `src/app/(website)/rules/page.tsx` | Club rules, cancellation policy (reads policy from DB via Prisma) |

---

## 2. Public Auth Pages

No authentication required. Served under the `(public)` route group.

| URL | File | Description |
|-----|------|-------------|
| `/login` | `src/app/(public)/login/page.tsx` | Email + password sign-in form |
| `/register` | `src/app/(public)/register/page.tsx` | Self-registration form (name, email, password, DOB, phone) |
| `/forgot-password` | `src/app/(public)/forgot-password/page.tsx` | Request password reset email |
| `/reset-password` | `src/app/(public)/reset-password/page.tsx` | Set new password using token from email |
| `/change-password` | `src/app/(public)/change-password/page.tsx` | Change password (used for forced password change on first login) |

---

## 3. Member-Facing Pages

Requires authenticated session. Guarded by `(authenticated)/layout.tsx`.

| URL | File | Description |
|-----|------|-------------|
| `/dashboard` | `src/app/(authenticated)/dashboard/page.tsx` | Member welcome page with summary cards and quick-book CTA. **See Stubbed Routes below.** |
| `/book` | `src/app/(authenticated)/book/page.tsx` | Booking wizard: calendar, guest forms, promo code, price quote |
| `/bookings` | `src/app/(authenticated)/bookings/page.tsx` | List of member's bookings (queries DB by `session.user.id`) |
| `/bookings/[id]` | `src/app/(authenticated)/bookings/[id]/page.tsx` | Booking detail with payment section, cancel action |
| `/profile` | `src/app/(authenticated)/profile/page.tsx` | View/edit name, phone, date of birth |

---

## 4. Admin-Facing Pages

Requires authenticated session with `role === "ADMIN"`. Guarded by `(admin)/layout.tsx`.

| URL | File | Description |
|-----|------|-------------|
| `/admin/dashboard` | `src/app/(admin)/admin/dashboard/page.tsx` | Admin summary: total members, active members, total bookings. **See Stubbed Routes below.** |
| `/admin/members` | `src/app/(admin)/admin/members/page.tsx` | Member list with search, create, edit |
| `/admin/bookings` | `src/app/(admin)/admin/bookings/page.tsx` | All bookings with status/date/search filters |
| `/admin/seasons` | `src/app/(admin)/admin/seasons/page.tsx` | Season CRUD with rate tiers (3 age tiers x member/non-member) |
| `/admin/cancellation-policy` | `src/app/(admin)/admin/cancellation-policy/page.tsx` | Cancellation policy rules management |
| `/admin/promo-codes` | `src/app/(admin)/admin/promo-codes/page.tsx` | Promo code CRUD with redemption counts |
| `/admin/chores` | `src/app/(admin)/admin/chores/page.tsx` | Chore template management (age restrictions, people requirements) |
| `/admin/roster` | `src/app/(admin)/admin/roster/page.tsx` | Chore roster review/edit with date picker and reassignment |
| `/admin/roster/[date]/print` | `src/app/(admin)/admin/roster/[date]/print/page.tsx` | Printable A4 roster for a specific date |
| `/admin/xero` | `src/app/(admin)/admin/xero/page.tsx` | Xero connection status, connect/disconnect, contact sync, membership refresh |
| `/admin/reports` | `src/app/(admin)/admin/reports/page.tsx` | Analytics dashboard: occupancy, revenue, booking trends, member breakdown (recharts) |

---

## 5. Error Pages

No authentication. Rendered by Next.js on errors.

| File | Description |
|------|-------------|
| `src/app/not-found.tsx` | 404 page with links to home and booking |
| `src/app/error.tsx` | 500 error boundary with retry and dashboard link |
| `src/app/global-error.tsx` | Root-level error boundary (renders own `<html>` tag) |

---

## 6. API Endpoints

### 6.1 Authentication

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET, POST | `/api/auth/[...nextauth]` | NextAuth internal | Login: 10/15min | N/A | NextAuth handlers (sign-in, sign-out, session, CSRF) |
| POST | `/api/auth/register` | None | 5/hour | Yes | Self-register new member. Bcrypt 13 rounds. Sends welcome email. |
| POST | `/api/auth/forgot-password` | None | 5/hour | Yes | Request password reset. Always returns success (no email enumeration). |
| POST | `/api/auth/reset-password` | None | 10/hour | Yes | Reset password via token. Token is single-use, 1-hour expiry. |
| POST | `/api/auth/change-password` | Session required | No | Yes | Change password for authenticated user. Clears `forcePasswordChange` flag. |

### 6.2 Member Profile

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| PUT | `/api/profile` | Session required | No | Yes | Update name, phone, DOB. Recomputes age tier. |

### 6.3 Bookings

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| POST | `/api/bookings` | Session required | 20/hour | Yes | Create booking. Handles promo codes, bumping, pending vs confirmed, advisory lock. |
| POST | `/api/bookings/quote` | Session required | 60/min | Yes | Price quote for dates and guests. |
| POST | `/api/bookings/cancel` | Session required (owner or admin) | No | Yes | Cancel booking by ID in body. Full flow: refund, Xero credit note, promo cleanup, email. |
| POST | `/api/bookings/[id]/cancel` | Session required (owner or admin) | No | No | Cancel booking by URL param. Same full flow as above. **Duplicate of `/api/bookings/cancel`.** |

### 6.4 Availability

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/availability` | Session required | 60/min | No | Occupancy by date for a given month (year/month query params). |
| GET | `/api/availability/check` | Session required | No | No | Check capacity for specific check-in/check-out date range. |

### 6.5 Payments

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| POST | `/api/payments/create-payment-intent` | Session required (owner or admin) | No | Yes | Create Stripe PaymentIntent for confirmed booking. |
| POST | `/api/payments/create-setup-intent` | Session required (owner or admin) | No | Yes | Create Stripe SetupIntent to save card for pending booking. |
| POST | `/api/payments/charge-saved-method` | CRON_SECRET or admin | No | Yes | Charge saved payment method. Used by cron and admin to confirm pending bookings. Timing-safe secret comparison. |

### 6.6 Promo Codes

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| POST | `/api/promo-codes/validate` | Session required | 60/min | Yes | Validate promo code and return discount preview. |

### 6.7 Seasons

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/seasons` | Session required | No | No | List active seasons with rates. |
| POST | `/api/seasons` | Admin only | No | Yes | Create new season with rates. |

### 6.8 Contact

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| POST | `/api/contact` | None | 5/hour | Yes | Public contact form submission. Sends email to CONTACT_EMAIL. |

### 6.9 Webhooks

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| POST | `/api/webhooks/stripe` | Stripe signature verification | No | No | Handles payment_intent, setup_intent, charge.refunded events. Idempotency via ProcessedWebhookEvent. |
| POST | `/api/webhooks/xero` | HMAC-SHA256 signature (`x-xero-signature`) | No | No | Handles Xero webhook events. Supports intent-to-receive pattern. Timing-safe comparison. |

### 6.10 Cron Jobs

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| POST | `/api/cron` | CRON_SECRET (timing-safe) | No | No | Trigger pending booking confirmation (finds PENDING past hold deadline, charges or bumps). |
| POST | `/api/cron/xero` | CRON_SECRET (timing-safe) | No | No | Daily membership status refresh from Xero for all active members. |

### 6.11 Admin - Members

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/admin/members` | Admin | No | No | List members with search filter. |
| POST | `/api/admin/members` | Admin | No | Yes | Create member with optional invite email. |
| GET | `/api/admin/members/[id]` | Admin | No | No | Get member detail with subscription history. |
| PUT | `/api/admin/members/[id]` | Admin | No | Yes | Update member info. Syncs to Xero if connected. |

### 6.12 Admin - Seasons

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/admin/seasons` | Admin | No | No | List all seasons. |
| POST | `/api/admin/seasons` | Admin | No | Yes | Create season with rates. Audit logged. |
| GET | `/api/admin/seasons/[id]` | Admin | No | No | Get season detail. |
| PUT | `/api/admin/seasons/[id]` | Admin | No | Yes | Update season with rates. Audit logged. |

### 6.13 Admin - Cancellation Policy

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/admin/cancellation-policy` | Admin | No | No | Get current cancellation policy rules. |
| PUT | `/api/admin/cancellation-policy` | Admin | No | Yes | Update cancellation policy. Audit logged. |

### 6.14 Admin - Promo Codes

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/admin/promo-codes` | Admin | No | No | List all promo codes with redemption counts. |
| POST | `/api/admin/promo-codes` | Admin | No | Yes | Create promo code. Audit logged. |
| GET | `/api/admin/promo-codes/[id]` | Admin | No | No | Get promo code detail. |
| PUT | `/api/admin/promo-codes/[id]` | Admin | No | Yes | Update promo code with type-specific validation. Audit logged. |
| DELETE | `/api/admin/promo-codes/[id]` | Admin | No | No | Delete promo code. Audit logged. |

### 6.15 Admin - Chores

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/admin/chores` | Admin | No | No | List all chore templates. |
| POST | `/api/admin/chores` | Admin | No | Yes | Create chore template. |
| PUT | `/api/admin/chores/[id]` | Admin | No | Yes | Update chore template. |
| DELETE | `/api/admin/chores/[id]` | Admin | No | No | Delete chore template. |

### 6.16 Admin - Roster

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/admin/roster/[date]` | Admin | No | No | Get roster for date with auto-suggestion if none exists. |
| POST | `/api/admin/roster/[date]` | Admin | No | Yes | Roster actions (reassign, add, remove assignments). |
| PUT | `/api/admin/roster/[date]` | Admin | No | Yes | Confirm or email roster (discriminated union schema). |

### 6.17 Admin - Roster Print

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/chores/roster/[date]/print` | Admin | No | No | Get roster data formatted for printable A4 view. |

### 6.18 Admin - Reports

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/admin/reports` | Admin | No | Yes | Occupancy, revenue, booking trend data for date range. |

### 6.19 Admin - Xero Integration

| Method | URL | Auth | Rate Limited | Zod | Description |
|--------|-----|------|-------------|-----|-------------|
| GET | `/api/admin/xero/status` | Admin | No | No | Check Xero connection status. |
| GET | `/api/admin/xero/connect` | Admin | No | No | Redirect to Xero OAuth2 consent page. |
| GET | `/api/admin/xero/callback` | Admin | No | No | Handle OAuth2 callback, store encrypted tokens. |
| POST | `/api/admin/xero/disconnect` | Admin | No | No | Revoke Xero tokens and disconnect. |
| POST | `/api/admin/xero/sync-contacts` | Admin | No | No | Bulk import contacts from Xero, match by email. |
| POST | `/api/admin/xero/sync-memberships` | Admin | No | No | Refresh membership statuses from Xero. |
| GET | `/api/admin/xero/contact-groups` | Admin | No | No | List available Xero contact groups for import UI. |
| POST | `/api/admin/xero/import-members` | Admin | No | Yes | Import members from Xero contact groups with age tier mapping. |

---

## 7. Stubbed / Placeholder Routes

| URL | Issue |
|-----|-------|
| `/admin/dashboard` | `totalBookings` is hardcoded to `0` at line 26 of `src/app/(admin)/admin/dashboard/page.tsx` (`getStats()` returns `{ totalBookings: 0 }` without querying the database). |
| `/dashboard` | "Upcoming Bookings" count is hardcoded to `0`. "Recent Bookings" section is a static placeholder with no database query. The page only checks session, it does not fetch any booking data. |

---

## 8. Notes

1. **Duplicate cancel routes:** `/api/bookings/cancel` (accepts booking ID in request body) and `/api/bookings/[id]/cancel` (accepts booking ID in URL) both implement the full cancellation flow. This is documented as a known issue in CLAUDE.md.

2. **Rate limiter configuration** (from `src/lib/rate-limit.ts`):
   - Login: 10 requests / 15 minutes
   - Register: 5 / hour
   - Forgot password: 5 / hour
   - Reset password: 10 / hour
   - Booking create: 20 / hour
   - Booking query: 60 / minute
   - Contact form: 5 / hour
   - General API: 100 / minute

3. **`/api/seasons` GET** is accessible to any authenticated user (not admin-only). This is intentional as the booking wizard needs season/rate data.

4. **`/rules` page** reads the cancellation policy directly from the database via Prisma (server component). It is public-facing with no auth.

5. **Webhook routes** use signature verification instead of session auth (Stripe: `stripe.webhooks.constructEvent`, Xero: HMAC-SHA256 with timing-safe comparison).

6. **Cron routes** use `CRON_SECRET` header with `crypto.timingSafeEqual` instead of session auth.

7. **`/api/payments/charge-saved-method`** accepts either CRON_SECRET or admin session auth, allowing both automated cron and manual admin triggering.

8. **All admin API routes** check `auth()` then verify `session.user.role === "ADMIN"`, returning 401 for unauthenticated and 403 for non-admin.
