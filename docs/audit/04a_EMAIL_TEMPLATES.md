# Email Templates Audit

**Date:** 2026-04-04

## Overview

All email templates are defined in `src/lib/email-templates.ts` (HTML generators) with corresponding send functions in `src/lib/email.ts` (transport wrappers). There are **7 branded templates** plus **1 inline email** (contact form).

## Template Summary

| # | Template | Subject | Recipient | Trigger(s) |
|---|----------|---------|-----------|------------|
| 1 | Welcome | "Welcome to TAC Bookings" | New member | Registration |
| 2 | Password Reset | "Reset your TAC Bookings password" | Member | Forgot password, admin invite, Xero import invite |
| 3 | Booking Confirmed | "Booking Confirmed - TAC Lodge" | Booking member | Stripe payment succeeded, cron auto-confirm |
| 4 | Booking Pending | "Booking Pending - TAC Lodge" | Booking member | Booking created with non-members (>7 days out) |
| 5 | Booking Bumped | "Booking Update - TAC Lodge" | Booking member | Member booking bumps PENDING, cron bumps at hold expiry |
| 6 | Booking Cancelled | "Booking Cancelled - TAC Lodge" | Booking member | User or admin cancellation |
| 7 | Chore Roster | "Your chore roster for {date} - TAC Lodge" | Each guest (members only) | Admin sends roster for a date |
| 8 | Contact Form | "Website Contact: {name}" | `CONTACT_EMAIL` env var | Public contact form submission |

---

## Detailed Template Documentation

### 1. Welcome Email

**Template function:** `welcomeTemplate(firstName)` (`email-templates.ts:139`)
**Send function:** `sendWelcomeEmail(email, firstName)` (`email.ts:140`)

**Triggers:**
- `src/app/api/auth/register/route.ts:64` - After successful member registration (fire-and-forget)

**Recipient:** Newly registered member's email

**Content:**
- Heading: "Welcome, {firstName}!"
- Body: Account created confirmation, can book stays / manage bookings / view trips
- CTA: "Log In to Your Account" -> `/login`
- Footer: "If you did not create this account, please ignore this email"

**Variables:**
| Variable | Source | Escaped |
|----------|--------|---------|
| `firstName` | `member.firstName` from DB insert | Yes |

---

### 2. Password Reset Email

**Template function:** `passwordResetTemplate(resetUrl)` (`email-templates.ts:150`)
**Send function:** `sendPasswordResetEmail(email, token)` (`email.ts:47`)

The send function constructs the full URL: `{NEXTAUTH_URL}/reset-password?token={token}`

**Triggers:**
- `src/app/api/auth/forgot-password/route.ts:46` - Member requests password reset (fire-and-forget)
- `src/app/api/admin/members/route.ts:164` - Admin creates member with `sendInvite: true` (fire-and-forget)
- `src/lib/xero.ts:608` - Bulk member import from Xero with invite flag (fire-and-forget)

**Recipient:** Member's email address

**Content:**
- Heading: "Password Reset"
- Body: Explains password reset request, link expires in 1 hour
- CTA: "Reset Password" -> `/reset-password?token={token}`
- Footer: "If you didn't request this, you can safely ignore this email"

**Variables:**
| Variable | Source | Escaped |
|----------|--------|---------|
| `resetUrl` | Constructed from `NEXTAUTH_URL` + token UUID | No (URL, not user-provided text) |

---

### 3. Booking Confirmed Email

**Template function:** `bookingConfirmedTemplate(firstName, checkIn, checkOut, guestCount, totalCents, options?)` (`email-templates.ts:160`)
**Send function:** `sendBookingConfirmedEmail(email, firstName, checkIn, checkOut, guestCount, totalCents, options?)` (`email.ts:61`)

**Triggers:**
- `src/app/api/webhooks/stripe/route.ts:162` - Stripe `payment_intent.succeeded` webhook
- `src/lib/cron-confirm-pending.ts:142` - Cron charges saved card for pending booking at hold expiry

**Recipient:** Booking member's email

**Content:**
- Heading: "Booking Confirmed"
- Greeting: "Hi {firstName}, your lodge booking has been confirmed!"
- Info table: Check-in, Check-out, Guests, Total Paid
- If discount applied: also shows Subtotal, Discount ({promoCode}), then Total Paid
- Success alert: "Payment has been processed successfully."
- CTA: "View Booking" -> `/bookings`

**Variables:**
| Variable | Source | Escaped |
|----------|--------|---------|
| `firstName` | `booking.member.firstName` | Yes |
| `checkIn` | `booking.checkIn` | Formatted via `formatNZDate` |
| `checkOut` | `booking.checkOut` | Formatted via `formatNZDate` |
| `guestCount` | Count of `booking.guests` | No (number) |
| `totalCents` | `booking.finalPriceCents` | Formatted via `formatCents` |
| `options.discountCents` | `booking.discountCents` | Formatted via `formatCents` |
| `options.promoCode` | `promoRedemption.promoCode.code` | Yes |

---

### 4. Booking Pending Email

**Template function:** `bookingPendingTemplate(firstName, checkIn, checkOut, guestCount, holdUntil)` (`email-templates.ts:195`)
**Send function:** `sendBookingPendingEmail(email, firstName, checkIn, checkOut, guestCount, holdUntil)` (`email.ts:77`)

**Triggers:**
- `src/app/api/bookings/route.ts:291` - Booking created with non-member guests and check-in > 7 days away (fire-and-forget)

**Recipient:** Booking member's email

**Content:**
- Heading: "Booking Pending"
- Greeting: "Hi {firstName}, your lodge booking has been received and is currently pending."
- Info table: Check-in, Check-out, Guests, Hold Until
- Warning alert: Explains non-member hold until {holdUntil}, member priority, card not charged yet
- Body: Explains non-member priority rules
- CTA: "View Booking" -> `/bookings`

**Variables:**
| Variable | Source | Escaped |
|----------|--------|---------|
| `firstName` | `member.firstName` | Yes |
| `checkIn` | `booking.checkIn` | Formatted via `formatNZDate` |
| `checkOut` | `booking.checkOut` | Formatted via `formatNZDate` |
| `guestCount` | Guest count | No (number) |
| `holdUntil` | `booking.nonMemberHoldUntil` (checkIn - 7 days) | Formatted via `formatNZDate` |

---

### 5. Booking Bumped Email

**Template function:** `bookingBumpedTemplate(firstName, checkIn, checkOut, guestCount)` (`email-templates.ts:217`)
**Send function:** `sendBookingBumpedEmail(email, firstName, checkIn, checkOut, guestCount)` (`email.ts:92`)

**Triggers:**
- `src/lib/bumping.ts:214` - Called via `sendBumpedNotifications()` after member booking bumps PENDING bookings. Invoked from `src/app/api/bookings/route.ts:282` (fire-and-forget after transaction commits).
- `src/lib/cron-confirm-pending.ts:74` - Cron finds no beds available at hold expiry, bumps booking

**Recipient:** Booking member's email (the bumped booking's member)

**Content:**
- Heading: "Booking Update"
- Body: "Unfortunately your pending lodge booking has been bumped due to member demand."
- Info table: Check-in, Check-out, Guests
- Info alert: "Your card has not been charged."
- Body: Explains non-member priority policy, welcome to rebook
- CTA: "Book Again" -> `/book`
- Footer: "We apologise for the inconvenience."

**Variables:**
| Variable | Source | Escaped |
|----------|--------|---------|
| `firstName` | `booking.member.firstName` | Yes |
| `checkIn` | `booking.checkIn` | Formatted via `formatNZDate` |
| `checkOut` | `booking.checkOut` | Formatted via `formatNZDate` |
| `guestCount` | Count of `booking.guests` | No (number) |

---

### 6. Booking Cancelled Email

**Template function:** `bookingCancelledTemplate(firstName, checkIn, checkOut, refundCents)` (`email-templates.ts:238`)
**Send function:** `sendBookingCancelledEmail(email, firstName, checkIn, checkOut, refundCents)` (`email.ts:106`)

**Triggers (both routes call it on every cancellation path):**
- `src/app/api/bookings/cancel/route.ts:80,120,201,233` - Member self-cancellation (4 code paths: PENDING, CONFIRMED no payment, CONFIRMED with refund, CONFIRMED no refund)
- `src/app/api/bookings/[id]/cancel/route.ts:81,105,179,203` - Admin cancellation (same 4 paths)

**Recipient:** Booking member's email

**Content:**
- Heading: "Booking Cancelled"
- Body: "Hi {firstName}, your lodge booking has been cancelled."
- Info table: Check-in, Check-out
- Dynamic alert:
  - If `refundCents > 0`: Success alert with refund amount, "processed to your original payment method"
  - If `refundCents === 0`: Info alert "No refund was applicable based on the cancellation policy."
- CTA: "Make a New Booking" -> `/book`

**Variables:**
| Variable | Source | Escaped |
|----------|--------|---------|
| `firstName` | `booking.member.firstName` | Yes |
| `checkIn` | `booking.checkIn` | Formatted via `formatNZDate` |
| `checkOut` | `booking.checkOut` | Formatted via `formatNZDate` |
| `refundCents` | Calculated by cancellation policy engine, or 0 | Formatted via `formatCents` |

---

### 7. Chore Roster Email

**Template function:** `choreRosterTemplate(guestName, date, chores)` (`email-templates.ts:262`)
**Send function:** `sendChoreRosterEmail(email, guestName, date, chores)` (`email.ts:120`)

**Triggers:**
- `src/app/api/admin/roster/[date]/route.ts:330` - Admin PUT with `action: "email"`, sends to all member guests staying on that date

**Recipient:** Each booking guest's member email (non-member guests without email addresses are skipped)

**Content:**
- Heading: "Chore Roster"
- Greeting: "Hi {guestName},"
- Body: "Here are your assigned chores for {formattedDate} at the lodge:"
- Info table: Rows of chore name + description
- Warning alert: "Last person to bed: Check heaters and fire are safe and doors are secure."
- Footer: "Thanks for helping keep the lodge running smoothly!"

**Variables:**
| Variable | Source | Escaped |
|----------|--------|---------|
| `guestName` | `guest.firstName + " " + guest.lastName` | Yes |
| `date` | YYYY-MM-DD string, formatted to long NZ locale (e.g. "Saturday, 15 March 2026") | Yes (the formatted string) |
| `chores[].name` | `choreTemplate.name` | Yes |
| `chores[].description` | `choreTemplate.description` | Yes (if non-null) |

---

### 8. Contact Form Email (Inline)

**File:** `src/app/api/contact/route.ts:34-56`
**No template function** - uses inline HTML directly with `sendEmail()`

**Triggers:**
- `POST /api/contact` - Public contact form submission (rate limited: 5/hour)

**Recipient:** `CONTACT_EMAIL` env var (default: `bookings@tacbookings.co.nz`)

**Subject:** "Website Contact: {name}"

**Content:**
- Heading: "New Contact Form Submission"
- Table: Name, Email (mailto link), Message (pre-wrapped)

**Variables:**
| Variable | Source | Escaped |
|----------|--------|---------|
| `name` | Request body (Zod validated, max 200 chars) | Yes |
| `email` | Request body (Zod validated) | Yes |
| `message` | Request body (Zod validated, max 5000 chars) | Yes |

---

## Shared Infrastructure

### Transport (`email.ts:12-22`)
- **Provider:** AWS SES via nodemailer SMTP
- **Host:** `SMTP_HOST` env var (default: `email-smtp.ap-southeast-2.amazonaws.com`)
- **Port:** `SMTP_PORT` env var (default: 587, STARTTLS)
- **From address:** `EMAIL_FROM` env var (default: `bookings@tacbookings.co.nz`), displayed as "TAC Bookings"
- **Dev mode:** When `NODE_ENV=development`, emails are logged to console instead of sent

### HTML Layout (`email-templates.ts:26-72`)
All 7 branded templates share a common layout wrapper:
- 600px max-width table layout for email client compatibility
- Blue-800 branded header with mountain icon and "Tokoroa Alpine Club / Lodge Booking System"
- White content area with gray borders
- Footer with "Tokoroa Alpine Club" and link to `NEXTAUTH_URL`
- All CSS is inline (no stylesheet references)

### Helper Components
- `button(text, url)` - Blue branded CTA button
- `infoTable(rows)` - Bordered key-value table
- `alertBox(text, type)` - Colored alert box (info=blue, warning=yellow, success=green)
- `heading(text)` - Section heading
- `paragraph(text)` - Body paragraph
- `muted(text)` - Gray smaller text

### Security: HTML Escaping (`email-templates.ts:9-16`)
`escapeHtml()` replaces `& < > " '` with HTML entities. Applied to all user-provided values:
- `firstName` in all member-facing templates
- `promoCode` in booking confirmed
- `guestName`, chore `name`, chore `description` in chore roster
- `name`, `email`, `message` in contact form

### Sending Pattern
All transactional emails use **fire-and-forget** - the API response is not blocked by email delivery:
```ts
sendWelcomeEmail(email, firstName).catch(err => console.error("...", err));
```
Exceptions: `sendChoreRosterEmail` and the contact form email are `await`ed (failure returns 500).

---

## Missing Emails

The following emails are listed in CLAUDE.md's email notification table but have **no implementation** in the codebase:

| Expected Email | Recipient | Status |
|---------------|-----------|--------|
| Admin: new booking notification | Admin | **Not implemented** - No email sent to admins when a booking is created |
| Admin: capacity warning | Admin | **Not implemented** - No email sent when lodge is nearly full for upcoming dates |
| Admin: pending approaching deadline | Admin | **Not implemented** - No email sent when non-member bookings are about to auto-confirm |

Additionally:
- **Pending -> Confirmed transition** reuses the generic "Booking Confirmed" template. There is no distinct template acknowledging that a previously-pending booking has now been confirmed and the saved card charged. The member receives the same email as an immediate-payment booking.
- **Booking reminder** (e.g. "Your stay is in 3 days") - not listed in CLAUDE.md and not implemented.
