# Audit: Pages, Templates & Components

Generated: 2026-04-04

---

## Table of Contents

1. [Layouts & Error Boundaries](#1-layouts--error-boundaries)
2. [Public Website Pages](#2-public-website-pages)
3. [Auth Pages (No Login Required)](#3-auth-pages-no-login-required)
4. [Authenticated Member Pages](#4-authenticated-member-pages)
5. [Admin Pages](#5-admin-pages)
6. [Custom Components](#6-custom-components)
7. [Stripe Components](#7-stripe-components)
8. [shadcn/ui Base Components](#8-shadcnui-base-components)

---

## 1. Layouts & Error Boundaries

### Root Layout — `src/app/layout.tsx`
- **Type:** Server component
- **Wraps:** Entire app in NextAuth `SessionProvider` + Sonner `Toaster`
- **Sets:** HTML metadata (title: "Tokoroa Alpine Club")
- **Status:** Fully functional

### Website Layout — `src/app/(website)/layout.tsx`
- **Type:** Server component
- **Wraps:** All public website pages (`/`, `/about`, `/join`, `/rules`, `/committee`, `/contact`)
- **Renders:** `WebsiteHeader` (passes `isAuthenticated` from session) + `WebsiteFooter`
- **Auth:** Checks session to toggle header CTA (Dashboard vs Login)
- **Status:** Fully functional

### Public Layout — `src/app/(public)/layout.tsx`
- **Type:** Server component
- **Wraps:** Auth pages (`/login`, `/register`, `/forgot-password`, `/reset-password`, `/change-password`)
- **Renders:** Centered container, no nav/header
- **Auth:** None
- **Status:** Fully functional

### Authenticated Layout — `src/app/(authenticated)/layout.tsx`
- **Type:** Server component
- **Wraps:** Member pages (`/dashboard`, `/book`, `/bookings`, `/profile`)
- **Renders:** `NavBar` with user name/email/role
- **Auth:** Redirects to `/login` if unauthenticated; redirects to `/change-password` if `forcePasswordChange` flag set in DB
- **Status:** Fully functional

### Admin Layout — `src/app/(admin)/layout.tsx`
- **Type:** Server component
- **Wraps:** All `/admin/*` pages
- **Renders:** `AdminSidebar` + main content area
- **Auth:** Redirects to `/login` if unauthenticated; redirects to `/dashboard` if role !== ADMIN; redirects to `/change-password` if `forcePasswordChange` flag set
- **Status:** Fully functional

### 404 Page — `src/app/not-found.tsx`
- **Type:** Server component
- **Displays:** "Page not found" with links to home (`/`) and booking (`/book`)
- **Status:** Fully functional, static content

### Error Boundary — `src/app/error.tsx`
- **Type:** Client component
- **Displays:** "Something went wrong" with error digest, "Try Again" reset button, link to `/dashboard`
- **Status:** Fully functional

### Global Error Boundary — `src/app/global-error.tsx`
- **Type:** Client component
- **Displays:** Critical error page at HTML root level (uses inline styles, no Tailwind)
- **Status:** Fully functional

### Middleware — `src/middleware.ts`
- **Applies to:** All routes except Next.js internals and static files
- **Sets headers:** X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, HSTS, CSP
- **CSP allows:** Stripe.js scripts/frames, unsafe-inline styles, self for defaults
- **Status:** Fully functional

---

## 2. Public Website Pages

### Home — `src/app/(website)/page.tsx`
- **Route:** `/`
- **Type:** Server component
- **Displays:** Hero section, highlights cards, activity icons, CTAs to `/login` and `/join`
- **Functional:** Navigation links
- **Hardcoded:** All content text, highlights array, activities array, stats

### About — `src/app/(website)/about/page.tsx`
- **Route:** `/about`
- **Type:** Server component
- **Displays:** Club history (est. 1969), mission statement, "At a Glance" stats, objectives list
- **Functional:** Navigation links
- **Hardcoded:** All content — ~410 members, 29-bed lodge, history text, objectives

### Join — `src/app/(website)/join/page.tsx`
- **Route:** `/join`
- **Type:** Server component
- **Displays:** Membership types (Adult/Youth/Child/Family), rate tables per season, how-to-join steps
- **Functional:** Fetches active seasons + rates from database; rate tables are dynamic
- **Hardcoded:** Membership type descriptions, Family membership highlight, join instructions

### Rules — `src/app/(website)/rules/page.tsx`
- **Route:** `/rules`
- **Type:** Server component
- **Displays:** Membership classes, tramping rules, lodge/booking rules, cancellation policy table, hut leader instructions
- **Functional:** Fetches cancellation policy tiers from database; policy table is dynamic
- **Hardcoded:** All rules text, membership class descriptions, hut leader instructions

### Committee — `src/app/(website)/committee/page.tsx`
- **Route:** `/committee`
- **Type:** Server component
- **Displays:** Committee member grid with name, role, optional bio
- **Functional:** Navigation links
- **Hardcoded/Placeholder:** Only 2 of ~10 roles have real names (Chris Duyvestyn, Wayne Peterson); rest show "TBC". Contains TODO comment to update full committee list

### Contact — `src/app/(website)/contact/page.tsx`
- **Route:** `/contact`
- **Type:** Client component
- **Displays:** Contact form (name, email, message) + sidebar with key contacts and Facebook link
- **Functional:** Form submits to `/api/contact`; success/error states; form validation
- **Hardcoded:** Contact names (Chris Duyvestyn, Wayne Peterson), Facebook URL, club email from env var

---

## 3. Auth Pages (No Login Required)

### Login — `src/app/(public)/login/page.tsx`
- **Route:** `/login`
- **Type:** Client component
- **Displays:** Email + password form, links to `/register` and `/forgot-password`
- **Functional:** Calls NextAuth `signIn("credentials", ...)`; redirects to `/dashboard` on success; error display
- **Hardcoded:** Nothing — fully dynamic

### Register — `src/app/(public)/register/page.tsx`
- **Route:** `/register`
- **Type:** Client component
- **Displays:** Registration form (firstName, lastName, email, password x2, dateOfBirth, phone)
- **Functional:** POSTs to `/api/auth/register`; client-side validation (12+ char password); auto-signs in on success; handles 409 duplicate email
- **Hardcoded:** Nothing — fully dynamic

### Forgot Password — `src/app/(public)/forgot-password/page.tsx`
- **Route:** `/forgot-password`
- **Type:** Client component
- **Displays:** Email input form; success confirmation mentioning 1-hour link validity
- **Functional:** POSTs to `/api/auth/forgot-password`; always shows "if account exists" message
- **Hardcoded:** Nothing — fully dynamic

### Reset Password — `src/app/(public)/reset-password/page.tsx`
- **Route:** `/reset-password`
- **Type:** Client component (wrapped in Suspense)
- **Displays:** New password + confirm form; reads `token` from URL params
- **Functional:** POSTs to `/api/auth/reset-password`; validates 12+ char passwords match; shows success with link to `/login`
- **Hardcoded:** Nothing — fully dynamic

### Change Password — `src/app/(public)/change-password/page.tsx`
- **Route:** `/change-password`
- **Type:** Client component
- **Displays:** Current password + new password + confirm form
- **Functional:** POSTs to `/api/auth/change-password`; validates new != current and 12+ chars; signs out and redirects to `/login?changed=1`
- **Hardcoded:** Nothing — fully dynamic

---

## 4. Authenticated Member Pages

### Dashboard — `src/app/(authenticated)/dashboard/page.tsx`
- **Route:** `/dashboard`
- **Type:** Server component
- **Displays:** Welcome message, summary cards (upcoming stays, total bookings), quick-book CTA, recent bookings
- **Functional:** Fetches session for first name display
- **Hardcoded/Placeholder:** All booking counts show "0"; "No upcoming stays" is static text; "Recent Bookings" section always shows empty state. Booking data is NOT fetched from the database

### Profile — `src/app/(authenticated)/profile/page.tsx`
- **Route:** `/profile`
- **Type:** Server component
- **Displays:** Account info (email, age tier, member since, role, active status), editable personal details via `ProfileForm`
- **Functional:** Fetches authenticated member from database; displays real data; imports `ProfileForm` client component for editing
- **Hardcoded:** Nothing — fully dynamic

### Book — `src/app/(authenticated)/book/page.tsx`
- **Route:** `/book`
- **Type:** Client component
- **Displays:** 3-step booking wizard (Dates → Guests → Review & Pay)
- **Functional:** Step 1 uses `BookingCalendar` with `/api/availability/check`; Step 2 uses `GuestForm` with `/api/bookings/quote`; Step 3 shows review with `PromoCodeInput` and submits to `/api/bookings`; redirects to `/bookings/{id}`
- **Hardcoded:** Nothing — fully dynamic

### My Bookings — `src/app/(authenticated)/bookings/page.tsx`
- **Route:** `/bookings`
- **Type:** Server component
- **Displays:** List of user's bookings with dates, guest count, price, status badge, link to detail
- **Functional:** Fetches all bookings for authenticated member from database; shows empty state with CTA to `/book`
- **Hardcoded:** Nothing — fully dynamic

### Booking Detail — `src/app/(authenticated)/bookings/[id]/page.tsx`
- **Route:** `/bookings/[id]`
- **Type:** Server component
- **Displays:** Stay details, status badge, non-member hold info, guest list with per-guest pricing, payment section (subtotal/discount/total), cancel button
- **Functional:** Fetches booking with guests/payment/promo data; renders `BookingPaymentSection` for unpaid bookings; renders `CancelBookingButton` for cancellable bookings
- **Hardcoded:** Nothing — fully dynamic

---

## 5. Admin Pages

### Admin Dashboard — `src/app/(admin)/admin/dashboard/page.tsx`
- **Route:** `/admin/dashboard`
- **Type:** Server component
- **Displays:** Summary cards (Total Members, Active Members, Total Bookings), quick-action links
- **Functional:** Fetches member counts (total, active) from database
- **Hardcoded/Placeholder:** `totalBookings` is hardcoded to `0` — not fetched from database. Quick-action cards are static links

### Members — `src/app/(admin)/admin/members/page.tsx`
- **Route:** `/admin/members`
- **Type:** Client component
- **Displays:** Searchable member table with CRUD dialogs
- **Functional:** Fetches from `/api/admin/members` with debounced search; create/edit dialog (firstName, lastName, email, phone, DOB, role, ageTier, active); reset password; deactivate/reactivate
- **Hardcoded:** Nothing — fully dynamic

### Seasons — `src/app/(admin)/admin/seasons/page.tsx`
- **Route:** `/admin/seasons`
- **Type:** Client component
- **Displays:** Season list with rate tables, create/edit forms
- **Functional:** Full CRUD via `/api/admin/seasons`; 6 rate inputs per season (3 age tiers x member/non-member); dollar-to-cents conversion; activate/deactivate toggle
- **Hardcoded:** Nothing — fully dynamic

### Bookings — `src/app/(admin)/admin/bookings/page.tsx`
- **Route:** `/admin/bookings`
- **Type:** Server component
- **Displays:** All bookings table with `BookingFilters` component (status, date range, member search)
- **Functional:** Fetches bookings with query filters; links to individual booking detail; limited to 100 results
- **Hardcoded:** Nothing — fully dynamic

### Promo Codes — `src/app/(admin)/admin/promo-codes/page.tsx`
- **Route:** `/admin/promo-codes`
- **Type:** Client component
- **Displays:** Promo code list with create/edit forms
- **Functional:** Full CRUD via `/api/admin/promo-codes`; supports PERCENTAGE/FIXED_AMOUNT/FREE_NIGHTS types; dynamic field display per type; redemption count display; date range and restriction badges
- **Hardcoded:** Nothing — fully dynamic

### Chores — `src/app/(admin)/admin/chores/page.tsx`
- **Route:** `/admin/chores`
- **Type:** Client component
- **Displays:** Chore template table with create/edit forms
- **Functional:** Full CRUD via `/api/admin/chores`; fields: name, description, min/max people, age restriction enum, conditional note, min age, sort order, essential flag, active flag
- **Hardcoded:** Nothing — fully dynamic

### Roster — `src/app/(admin)/admin/roster/page.tsx`
- **Route:** `/admin/roster`
- **Type:** Client component
- **Displays:** Daily chore roster with date picker, guest assignments, history
- **Functional:** Fetches from `/api/admin/roster/{date}`; reassign guests via dropdown; add/remove assignments; regenerate (auto-suggest); confirm roster; email roster to guests; link to print view; 4-day assignment history
- **Hardcoded:** Nothing — fully dynamic

### Roster Print — `src/app/(admin)/admin/roster/[date]/print/page.tsx`
- **Route:** `/admin/roster/[date]/print`
- **Type:** Client component
- **Displays:** Printable A4 chore roster table
- **Functional:** Fetches roster from `/api/admin/roster/{date}`; groups by chore template; `@media print` CSS hides non-print elements
- **Hardcoded:** Footer safety note ("Please check all heaters/doors...")

### Cancellation Policy — `src/app/(admin)/admin/cancellation-policy/page.tsx`
- **Route:** `/admin/cancellation-policy`
- **Type:** Client component
- **Displays:** Editable policy tiers table with preview
- **Functional:** Fetches from `/api/admin/cancellation-policy`; add/remove tiers; editable daysBeforeStay and refundPercentage; saves all rules via PUT; policy preview text
- **Hardcoded:** Nothing — fully dynamic

### Xero — `src/app/(admin)/admin/xero/page.tsx`
- **Route:** `/admin/xero`
- **Type:** Client component
- **Displays:** Xero connection status, OAuth connect/disconnect, contact sync, membership refresh, member import
- **Functional:** Fetches status from `/api/admin/xero/status`; connect redirects to Xero OAuth; import members with age-tier mapping per contact group; sync contacts by email; refresh membership status; result counts display
- **Hardcoded:** "How it works" documentation section is static text

### Reports — `src/app/(admin)/admin/reports/page.tsx`
- **Route:** `/admin/reports`
- **Type:** Client component
- **Displays:** Analytics dashboard — summary cards, occupancy chart, revenue chart, booking trends, member/non-member pie, status pie
- **Functional:** Date range picker (defaults last 3 months); fetches from `/api/admin/reports`; 5 Recharts visualizations; downsamples occupancy data if >60 points
- **Hardcoded:** Nothing — fully dynamic

---

## 6. Custom Components

### NavBar — `src/components/nav-bar.tsx`
- **Type:** Client component
- **Props:** `{ user: { name, email, role } }`
- **Displays:** Logo, nav links (Dashboard, Book, My Bookings, Admin if admin), user dropdown with Profile/Log Out
- **Functional:** Active link highlighting; role-based admin link; responsive mobile sheet menu; `signOut()` from next-auth
- **Hardcoded:** Nothing

### WebsiteHeader — `src/components/website-header.tsx`
- **Type:** Client component
- **Props:** `{ isAuthenticated: boolean }`
- **Displays:** Sticky header with logo, nav links (Home, About, Join, Rules, Committee, Contact), auth-aware CTAs
- **Functional:** Shows Dashboard+Book if authenticated, Login+Book if not; active link highlighting; mobile menu
- **Hardcoded:** Navigation link labels and paths

### WebsiteFooter — `src/components/website-footer.tsx`
- **Type:** Server component
- **Props:** None
- **Displays:** 3-column footer — club info, quick links, affiliations (FMC, RMCA)
- **Functional:** Internal links via Next.js `Link`; external links to FMC/RMCA
- **Hardcoded:** All content — club description, affiliation URLs, copyright text

### AdminSidebar — `src/components/admin-sidebar.tsx`
- **Type:** Client component
- **Props:** None
- **Displays:** 10-item sidebar nav (Dashboard, Members, Seasons, Bookings, Promo Codes, Chores, Roster, Cancellation Policy, Xero, Reports)
- **Functional:** Active link highlighting; responsive mobile sheet menu with hamburger
- **Hardcoded:** Menu items and routes

### BookingCalendar — `src/components/booking-calendar.tsx`
- **Type:** Client component
- **Props:** `{ onDateSelect, selectedCheckIn?, selectedCheckOut? }`
- **Displays:** Month grid with availability color-coding (green=available, yellow=limited <=5, red=full), legend
- **Functional:** Fetches from `/api/availability?year=&month=`; two-step date selection (check-in then check-out); disables past/full dates; month navigation
- **Hardcoded:** `LODGE_CAPACITY` imported from `src/lib/capacity`

### GuestForm — `src/components/guest-form.tsx`
- **Type:** Client component
- **Props:** `{ guests: GuestData[], onGuestsChange, maxGuests }`
- **Displays:** Guest cards with name inputs, age tier dropdown, membership dropdown, add/remove buttons
- **Functional:** Add/remove/update guests; enforces maxGuests limit
- **Hardcoded:** Age tier labels ("Adult 18+", "Youth 10-17", "Child under 10")

### PromoCodeInput — `src/components/promo-code-input.tsx`
- **Type:** Client component
- **Props:** `{ checkIn, checkOut, guests, onPromoApplied, appliedPromo }`
- **Exports:** `PromoResult` interface
- **Displays:** Code input + Apply button; green success box with discount when applied; Remove button
- **Functional:** POSTs to `/api/promo-codes/validate`; uppercase conversion; discount amount display
- **Hardcoded:** Nothing

### BookingPaymentSection — `src/components/booking-payment-section.tsx`
- **Type:** Client component
- **Props:** `{ bookingId, amountCents, hasNonMembers, checkInDaysAway, returnUrl }`
- **Displays:** Delegates to `BookingPaymentWrapper`
- **Functional:** Lightweight wrapper adding `router.refresh()` callback on payment completion
- **Hardcoded:** Nothing

### CancelBookingButton — `src/components/cancel-booking-button.tsx`
- **Type:** Client component
- **Props:** `{ bookingId }`
- **Displays:** Red "Cancel Booking" button; confirmation box with Yes/No on click
- **Functional:** POSTs to `/api/bookings/{bookingId}/cancel`; refreshes page on success
- **Hardcoded:** Nothing

### SignOutButton — `src/components/sign-out-button.tsx`
- **Type:** Client component
- **Props:** None
- **Displays:** Ghost button "Sign out"
- **Functional:** Calls `signOut({ callbackUrl: "/login" })`
- **Hardcoded:** Nothing

### BookingFilters — `src/components/admin/booking-filters.tsx`
- **Type:** Client component
- **Props:** None (reads URL search params)
- **Displays:** Filter row — status dropdown, from/to date inputs, member search input, Filter/Clear buttons
- **Functional:** Reads/writes URL query params via `useRouter` and `useSearchParams`
- **Hardcoded:** Status options (ALL, PENDING, CONFIRMED, CANCELLED, BUMPED, COMPLETED)

### SeasonForm — `src/components/admin/season-form.tsx`
- **Type:** Client component
- **Props:** None
- **Displays:** Expandable "Create Season" form with name, type, dates, 6 rate inputs
- **Functional:** POSTs to `/api/seasons`; dollar-to-cents conversion; form reset on success; page refresh
- **Hardcoded:** Season types (Winter/Summer); rate grid labels

---

## 7. Stripe Components

### StripeProvider — `src/components/stripe/StripeProvider.tsx`
- **Type:** Client component
- **Props:** `{ children, clientSecret }`
- **Displays:** Stripe `Elements` wrapper; error message if publishable key missing
- **Functional:** Initializes Stripe with `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`; configures appearance theme
- **Hardcoded:** Stripe appearance theme (blue primary, 8px radius)

### BookingPaymentWrapper — `src/components/stripe/BookingPaymentWrapper.tsx`
- **Type:** Client component
- **Props:** `{ bookingId, amountCents, hasNonMembers, checkInDaysAway, returnUrl, onPaymentComplete }`
- **Displays:** Loading spinner during init; then either `PaymentForm` or `SetupForm` inside `StripeProvider`
- **Functional:** Determines flow: if `hasNonMembers && checkInDaysAway > 7` → SetupIntent (save card); else → PaymentIntent (charge now). Fetches clientSecret from `/api/payments/create-payment-intent` or `/api/payments/create-setup-intent`
- **Hardcoded:** Nothing

### PaymentForm — `src/components/stripe/PaymentForm.tsx`
- **Type:** Client component
- **Props:** `{ bookingId, amountCents, onSuccess, onError, returnUrl }`
- **Displays:** Stripe `PaymentElement`, formatted amount, "Pay Now" button
- **Functional:** Calls `stripe.confirmPayment()`; handles 3D Secure redirects; loading/error states
- **Hardcoded:** Nothing

### SetupForm — `src/components/stripe/SetupForm.tsx`
- **Type:** Client component
- **Props:** `{ bookingId, onSuccess, onError, returnUrl }`
- **Displays:** Amber warning ("card won't be charged now"), Stripe `PaymentElement`, "Save Card & Confirm Booking" button
- **Functional:** Calls `stripe.confirmSetup()`; handles 3D Secure redirects; loading/error states
- **Hardcoded:** Warning text about deferred charging

### CancelBookingButton (Stripe) — `src/components/stripe/CancelBookingButton.tsx`
- **Type:** Client component
- **Props:** `{ bookingId, onCancelled }`
- **Displays:** Red "Cancel Booking" button; confirmation box with refund policy warning
- **Functional:** POSTs to `/api/bookings/cancel`; returns refund amount/percentage/message via callback
- **Hardcoded:** Nothing

---

## 8. shadcn/ui Base Components

Located in `src/components/ui/` — standard library components, unmodified:

`avatar.tsx`, `badge.tsx`, `button.tsx`, `card.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `input.tsx`, `label.tsx`, `select.tsx`, `separator.tsx`, `sheet.tsx`, `sonner.tsx`, `table.tsx`, `tabs.tsx`, `textarea.tsx`

---

## Summary

| Category | Count | Fully Functional | Placeholder/Partial |
|---|---|---|---|
| Layouts | 5 | 5 | 0 |
| Error boundaries | 3 | 3 | 0 |
| Public website pages | 6 | 4 | 2 (Committee: TBC names; About: hardcoded stats) |
| Auth pages | 5 | 5 | 0 |
| Authenticated pages | 5 | 4 | 1 (Dashboard: hardcoded zero counts) |
| Admin pages | 11 | 10 | 1 (Admin Dashboard: hardcoded zero booking count) |
| Custom components | 12 | 12 | 0 |
| Stripe components | 5 | 5 | 0 |
| shadcn/ui components | 15 | 15 | 0 |
| **Total** | **67** | **63** | **4** |

### Known Placeholder/Hardcoded Items

1. **`/dashboard`** — Summary cards show hardcoded `0` for booking counts; "No upcoming stays" is always displayed; booking data not fetched from DB
2. **`/admin/dashboard`** — `totalBookings` hardcoded to `0` instead of queried
3. **`/committee`** — 8 of 10 committee roles show "TBC"; only 2 real names populated; has TODO comment
4. **`/about`** — Stats ("~410 members", "29-bed lodge") are hardcoded, not fetched from DB
