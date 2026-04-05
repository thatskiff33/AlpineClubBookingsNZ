# TACBookings Feature Requirements

---


**Date:** 2026-04-04
**Scope:** All features, changes, and improvements for admin member management and member self-service portals.

---

## A. Admin Member Management

### A1. Pagination for Members List

**Description:** The admin members API (`GET /api/admin/members`) fetches all members with no pagination. With ~410 members this works but won't scale, and the table renders all rows at once. Add server-side cursor or offset pagination.

**Acceptance Criteria:**
- API accepts `page` and `pageSize` query params (default pageSize=25)
- API returns `{ members, total, page, pageSize, totalPages }`
- Members table shows pagination controls (prev/next, page numbers)
- Search still works with pagination (resets to page 1 on new search)
- URL query params update to allow bookmarkable/shareable filtered views

**Dependencies:** None

**Complexity:** S

---

### A2. Advanced Filtering for Members List

**Description:** The members table only supports free-text search. Add structured filters for role, active status, age tier, Xero link status, and subscription status.

**Acceptance Criteria:**
- Filter dropdowns/toggles for: role (MEMBER/ADMIN), status (Active/Inactive), age tier (ADULT/YOUTH/CHILD), Xero linked (Yes/No), subscription status (PAID/UNPAID/OVERDUE/None)
- Filters combine with existing text search (AND logic)
- Active filters shown as removable chips/badges
- "Clear all filters" button
- API accepts filter params and applies them server-side
- Filters preserved across pagination

**Dependencies:** A1 (pagination)

**Complexity:** M

---

### A3. CSV Export of Members

**Description:** Admin can export the filtered member list as a CSV file for offline use, mail merges, or committee reports.

**Acceptance Criteria:**
- "Export CSV" button on members page
- Export respects current search and filter state
- CSV includes: firstName, lastName, email, phone, dateOfBirth, role, ageTier, active, xeroContactId, subscriptionStatus, createdAt
- File downloads as `tac-members-YYYY-MM-DD.csv`
- Handles special characters (commas, quotes) in member data correctly

**Dependencies:** A2 (filtering, so export matches what admin sees)

**Complexity:** S

---

### A4. CSV Import of Members

**Description:** Admin can bulk-create members by uploading a CSV file. This is needed for the initial migration from Checkfront/Xero and for onboarding batches of new members.

**Acceptance Criteria:**
- "Import CSV" button opens upload dialog
- Accepts CSV with columns: firstName, lastName, email, phone, dateOfBirth, role (optional, defaults MEMBER)
- Validates all rows before importing (email format, required fields, no duplicates against existing members or within file)
- Shows validation results: valid count, error count, error details per row
- Admin confirms import after reviewing validation results
- Creates members with random placeholder passwords (same as admin create)
- Option to send invite emails to all imported members
- Option to auto-link Xero contacts by email match
- Import results summary: created count, skipped count, errors
- Rate-limited to prevent abuse

**Dependencies:** None (reuses existing `POST /api/admin/members` logic)

**Complexity:** L

---

### A5. Bulk Deactivate/Reactivate Members

**Description:** Admin can select multiple members and deactivate or reactivate them in one action. Needed for annual membership renewals where unpaid members are bulk-deactivated.

**Acceptance Criteria:**
- Checkbox column in members table for row selection
- "Select all on page" checkbox in header
- Bulk action toolbar appears when members selected, showing count
- "Deactivate Selected" and "Reactivate Selected" bulk actions
- Confirmation dialog showing affected member count and names
- Cannot bulk-deactivate the currently logged-in admin
- API endpoint: `POST /api/admin/members/bulk-update` accepting `{ ids: string[], action: "deactivate" | "reactivate" }`
- Success/error summary after operation completes
- Audit log entries for each affected member

**Dependencies:** None

**Complexity:** M

---

### A6. Bulk Role Change

**Description:** Admin can change the role of multiple selected members at once (e.g., promote several members to ADMIN or demote to MEMBER).

**Acceptance Criteria:**
- "Change Role" option in bulk action toolbar
- Role selector dropdown (MEMBER/ADMIN) in confirmation dialog
- Cannot demote own account from ADMIN
- Audit log entries for each role change
- Reuses bulk-update API with `action: "set-role"` and `role` param

**Dependencies:** A5 (shares selection UI and bulk action infrastructure)

**Complexity:** S

---

### A7. Subscription Status in Members Table

**Description:** The members table shows Xero link status but not subscription/membership payment status. Admin needs to see at a glance who has paid for the current season.

**Acceptance Criteria:**
- New "Subscription" column in members table between "Xero" and "Joined"
- Shows badge: PAID (green), UNPAID (yellow), OVERDUE (red), or "-" if no subscription record
- Subscription status fetched for current season year
- API `GET /api/admin/members` includes `currentSubscriptionStatus` field by joining `MemberSubscription` for the current season year

**Dependencies:** None (MemberSubscription model already exists)

**Complexity:** S

---

### A8. Member Detail View with Booking History

**Description:** Clicking a member row or a "View" action opens a detail page/panel showing full member info plus their booking history. Currently the edit dialog only shows editable fields.

**Acceptance Criteria:**
- Member detail accessible via `/admin/members/[id]` page or slide-over panel
- Shows all member fields including subscription history
- Shows booking history: list of bookings (date, status, guests, total) with links to admin booking detail
- Shows total bookings, total spend, last stay date
- Shows audit log entries for this member
- "Edit" button opens edit dialog from this view
- "View in Xero" link if xeroContactId is set

**Dependencies:** None (API `GET /api/admin/members/[id]` already returns subscription data)

**Complexity:** M

---

### A9. Admin Dashboard — Real Data

**Description:** The admin dashboard (`/admin/dashboard`) shows a hardcoded `totalBookings: 0`. The member counts are real but no booking, revenue, or occupancy data is shown.

**Acceptance Criteria:**
- "Total Bookings" card shows actual count from DB (all-time)
- Add cards: "Active Bookings" (CONFIRMED + PENDING), "Revenue This Month" (sum of succeeded payments), "Upcoming Check-ins" (next 7 days)
- Add "Recent Bookings" list showing last 5 bookings with status badges and links
- Add "Members by Status" breakdown (active vs inactive count)
- All data fetched server-side (RSC) — no client-side fetching needed
- No caching needed at this scale (~410 members)

**Dependencies:** None

**Complexity:** M

---

### A10. Admin Force Password Reset for Member

**Description:** The "Reset PW" button on the members page sends a password reset email, but there's no way to force a member to change their password on next login without sending an email (e.g., after a security incident). The `forcePasswordChange` field exists in the schema but isn't exposed in admin UI.

**Acceptance Criteria:**
- New "Force Password Change" action in member edit dialog or actions menu
- Sets `forcePasswordChange: true` on the member record
- Member is redirected to `/change-password` on next login (existing flow in authenticated layout)
- Admin sees `forcePasswordChange` status as a badge/indicator on member row
- Can combine with sending a reset email, or do independently
- Audit log entry when force password change is set

**Dependencies:** None (`forcePasswordChange` field and redirect logic already exist)

**Complexity:** S

---

### A11. Sortable Members Table Columns

**Description:** The members table sorts by lastName/firstName only. Admin should be able to click column headers to sort by any column.

**Acceptance Criteria:**
- Clickable sort indicators on columns: Name, Email, Role, Age Tier, Status, Joined
- Sort direction toggles (asc/desc) on click
- Sort applied server-side via API params `sortBy` and `sortDir`
- Current sort state shown with arrow indicators on column header
- Default sort remains lastName asc

**Dependencies:** A1 (pagination, since sort params go to API)

**Complexity:** S

---

## B. Member Self-Service

### B1. Password Change from Profile Page

**Description:** A change password API and page exist (`/change-password`, `/api/auth/change-password`) but there is no link to it from the profile page. Members can only access it if `forcePasswordChange` is set or if they know the URL.

**Acceptance Criteria:**
- "Change Password" section/card on the profile page (`/profile`)
- Form with: current password, new password, confirm new password
- Client-side validation: min 12 chars, passwords match, new != current
- On success: toast notification, form clears
- Reuses existing `POST /api/auth/change-password` endpoint
- Alternative: link/button on profile page that navigates to existing `/change-password` page

**Dependencies:** None (API already exists)

**Complexity:** S

---

### B2. Email Change with Verification

**Description:** Members cannot change their email address. The profile form only allows name/phone/DOB edits. Email is shown as read-only in the account info card. Members should be able to request an email change, with verification of the new address before it takes effect.

**Acceptance Criteria:**
- "Change Email" button/section on profile page
- Opens form to enter new email address and current password (for security)
- Server validates: email format, not already taken, password correct
- Sends verification email to the NEW address with a time-limited token (1 hour)
- Member clicks verification link to confirm the change
- On confirmation: email updated in DB, old email notified of the change, JWT session updated
- If token expires without confirmation, no change occurs
- Xero contact updated if connected
- Audit log entry for email change

**New schema required:**
- `EmailChangeToken` model: id, memberId, newEmail, token (unique), expiresAt, used, createdAt

**New API routes:**
- `POST /api/profile/change-email` — request email change (validates, sends verification)
- `GET /api/auth/verify-email-change?token=xxx` — confirm email change

**Dependencies:** None

**Complexity:** L

---

### B3. Email Verification on Registration

**Description:** Registration creates an active member immediately with no email verification. Any email address can be used, including typos or others' addresses. New members should verify their email before they can book.

**Acceptance Criteria:**
- Registration creates member with `emailVerified: false`
- Verification email sent with time-limited token (24 hours)
- Member can log in but sees a banner "Please verify your email" and cannot create bookings
- Resend verification email button (rate-limited)
- Clicking verification link sets `emailVerified: true`
- Admin-created members are auto-verified (admin vouches for them)
- Existing members (pre-feature) are grandfathered as verified
- Booking creation API checks `emailVerified` and rejects if false

**New schema required:**
- Add `emailVerified Boolean @default(false)` to Member model
- `EmailVerificationToken` model: id, memberId, token (unique), expiresAt, createdAt
- Migration to set `emailVerified = true` for all existing members

**New API routes:**
- `POST /api/auth/resend-verification` — resend verification email
- `GET /api/auth/verify-email?token=xxx` — verify email address

**Dependencies:** None

**Complexity:** L

---

### B4. Member Dashboard — Real Data

**Description:** The member dashboard (`/dashboard`) shows hardcoded placeholder data. All three cards and the recent bookings section need to query real data.

**Acceptance Criteria:**
- "Upcoming Bookings" card shows count of CONFIRMED + PENDING bookings where checkIn >= today
- "Next Stay" card shows check-in date and lodge name for the nearest upcoming booking, or "No upcoming stays" if none
- "Recent Bookings" section shows the member's last 5 bookings with: dates, status badge, guest count, total price
- Each recent booking links to `/bookings/[id]`
- "View all" link goes to `/bookings`
- All data fetched server-side (RSC)

**Dependencies:** None

**Complexity:** S

---

### B5. Booking Modification — Change Dates

**Description:** Members currently cannot modify a booking's dates. The only option is to cancel and rebook, which may lose availability, promo codes, or incur cancellation fees. Members should be able to change check-in/check-out dates on CONFIRMED or PENDING bookings.

**Acceptance Criteria:**
- "Modify Booking" button on booking detail page (visible for CONFIRMED and PENDING bookings)
- Opens date modification interface with availability calendar
- System checks availability for new dates (excluding current booking's beds from capacity count)
- Recalculates price for all guests across new dates using current season rates
- Shows price difference: additional charge or refund amount
- If price increases: collects additional payment (new PaymentIntent for the difference)
- If price decreases: processes partial refund via Stripe
- Updates Xero invoice (void + recreate, or credit note + new invoice)
- Promo code re-validated for new dates; if no longer valid, discount removed and member notified
- Booking `updatedAt` timestamp updated
- Confirmation email sent with updated details
- Audit log entry with old and new dates
- Cannot modify to dates that have already passed
- Cannot modify a booking whose check-in date has passed (stay already started)

**Constraints:**
- Date changes on PENDING bookings recalculate `nonMemberHoldUntil`
- If new dates make the booking all-member (no non-member guests), promote from PENDING to CONFIRMED
- Advisory lock during modification to prevent concurrent booking conflicts

**New API route:**
- `PUT /api/bookings/[id]/modify-dates` — validate availability, recalculate price, process payment/refund

**Dependencies:** B2 is independent; this depends on existing pricing engine, Stripe, and Xero integration

**Complexity:** XL

---

### B6. Booking Modification — Add/Remove Guests

**Description:** Members cannot change the guest list after booking. They should be able to add or remove guests from CONFIRMED or PENDING bookings without cancelling.

**Acceptance Criteria:**
- "Edit Guests" section/button on booking detail page
- Can add new guests (name, age tier, member/non-member) up to available capacity
- Can remove guests (minimum 1 guest must remain — the booking member)
- Recalculates price when guests change
- Price difference handled same as date modification (additional charge or refund)
- Updates Xero invoice
- Promo code re-validated (some codes may be members-only; adding non-member guest could invalidate)
- If removing all non-member guests from a PENDING booking, promote to CONFIRMED
- If adding non-member guests to a CONFIRMED booking with check-in > 7 days, may need to transition to PENDING
- Chore assignments for removed guests are deleted
- Confirmation email with updated guest list and price
- Audit log entry with guest changes
- Cannot reduce below capacity that would make the booking invalid

**New API route:**
- `PUT /api/bookings/[id]/modify-guests` — validate capacity, recalculate price, process payment/refund

**Dependencies:** B5 (shares price recalculation and payment adjustment logic)

**Complexity:** XL

---

### B7. Booking Modification — Update Notes

**Description:** Members cannot edit the notes field on a booking after creation. This is a simple text update with no financial implications.

**Acceptance Criteria:**
- Editable notes field on booking detail page (inline edit or modal)
- Save triggers `PUT /api/bookings/[id]/notes` with new notes text
- Notes field validated: max 500 characters, sanitised (no HTML)
- Only the booking owner or admin can edit notes
- No email notification needed for notes changes
- Works for CONFIRMED and PENDING bookings only

**New API route:**
- `PUT /api/bookings/[id]/notes`

**Dependencies:** None

**Complexity:** S

---

### B8. Profile Page — Link to Change Password

**Description:** Even if B1 adds a full inline form, the existing `/change-password` page should be discoverable from the profile page at minimum.

**Acceptance Criteria:**
- Profile page includes a "Security" card/section
- Contains a "Change Password" link/button pointing to `/change-password` or inline form (per B1)
- Shows when password was last changed (requires tracking `passwordChangedAt`)

**New schema (optional enhancement):**
- Add `passwordChangedAt DateTime?` to Member model
- Set on registration and password change

**Dependencies:** B1

**Complexity:** S

---

### B9. Member Profile — View Subscription Status

**Description:** Members have no visibility into their subscription/membership payment status. This data exists in `MemberSubscription` (sourced from Xero) but is not exposed in the member portal.

**Acceptance Criteria:**
- Profile page shows "Membership Status" card
- Displays current season year and status: PAID (green badge), UNPAID (yellow), OVERDUE (red)
- If no subscription record exists, shows "No subscription record — contact the club"
- Shows subscription history (last 3 seasons)
- Read-only (members cannot change subscription status)

**Dependencies:** None (MemberSubscription model and data already exist)

**Complexity:** S

---

## Summary Table

| ID | Feature | Complexity | Dependencies |
|----|---------|-----------|-------------|
| A1 | Pagination for Members List | S | None |
| A2 | Advanced Filtering for Members List | M | A1 |
| A3 | CSV Export of Members | S | A2 |
| A4 | CSV Import of Members | L | None |
| A5 | Bulk Deactivate/Reactivate Members | M | None |
| A6 | Bulk Role Change | S | A5 |
| A7 | Subscription Status in Members Table | S | None |
| A8 | Member Detail View with Booking History | M | None |
| A9 | Admin Dashboard — Real Data | M | None |
| A10 | Admin Force Password Reset for Member | S | None |
| A11 | Sortable Members Table Columns | S | A1 |
| B1 | Password Change from Profile Page | S | None |
| B2 | Email Change with Verification | L | None |
| B3 | Email Verification on Registration | L | None |
| B4 | Member Dashboard — Real Data | S | None |
| B5 | Booking Modification — Change Dates | XL | None |
| B6 | Booking Modification — Add/Remove Guests | XL | B5 |
| B7 | Booking Modification — Update Notes | S | None |
| B8 | Profile Page — Security Section | S | B1 |
| B9 | Member Profile — View Subscription Status | S | None |

---


**Date:** 2026-04-04
**Status:** Draft
**Scope:** Booking date changes, guest changes, stay extension, late-notice change fees, cancellation consolidation, modification history

---

## Current State

The system supports booking creation (with capacity checks, advisory locks, FIFO bumping, promo codes) and cancellation (with policy-based refunds, Stripe refunds, Xero credit notes, promo cleanup, audit logging). There is **no** booking modification capability -- members must cancel and rebook to change anything.

**Key gaps:**
- No API or UI for changing dates, adding/removing guests, or extending stays
- No concept of a "late notice booking change fee"
- No structured modification history (AuditLog exists but is unstructured)
- Two duplicate cancel routes with identical logic not shared (`/api/bookings/cancel` + `/api/bookings/[id]/cancel`)

---

## Section 1: Cancel Route Consolidation

### CAN-01: Extract Shared Cancellation Service Function

**Description:** Extract duplicated cancellation logic from both cancel routes into a shared function in `src/lib/booking-cancel.ts`. Both routes become thin wrappers that parse input and delegate.

**Acceptance Criteria:**
1. A function `cancelBooking(bookingId, sessionUserId, sessionUserRole, ipAddress)` exists in `src/lib/booking-cancel.ts`
2. Both `/api/bookings/cancel` and `/api/bookings/[id]/cancel` delegate to this shared function
3. All existing cancellation behaviour is preserved: PENDING cancel, CONFIRMED without payment, CONFIRMED with refund (Stripe + Xero credit note), promo cleanup, audit logging, email
4. Existing tests pass without modification

**Dependencies:** None
**Complexity:** S

---

### CAN-02: Deprecate Body-Based Cancel Route

**Description:** Update `src/components/stripe/CancelBookingButton.tsx` to use the path-based route `/api/bookings/[id]/cancel`. The body-based route remains functional but logs a deprecation warning.

**Acceptance Criteria:**
1. `CancelBookingButton` calls `/api/bookings/${bookingId}/cancel` instead of `/api/bookings/cancel`
2. The body-based route logs a deprecation warning to console on each call
3. Both routes remain functional

**Dependencies:** CAN-01
**Complexity:** S

---

## Section 2: Schema Changes

### SCH-01: BookingModification History Model

**Description:** Add a `BookingModification` model to record every modification to a booking with structured before/after data.

**Schema:**
```prisma
model BookingModification {
  id               String   @id @default(cuid())
  bookingId        String
  memberId         String
  modificationType String   // DATE_CHANGE | GUEST_ADD | GUEST_REMOVE | EXTEND_STAY
  previousData     Json     // snapshot of changed fields before
  newData          Json     // snapshot of changed fields after
  priceDiffCents   Int      @default(0)  // positive = owes more, negative = refund
  changeFeeCents   Int      @default(0)  // late-notice fee charged
  createdAt        DateTime @default(now())

  booking Booking @relation(fields: [bookingId], references: [id], onDelete: Cascade)

  @@index([bookingId])
  @@index([memberId])
}
```

**Acceptance Criteria:**
1. Model exists in `schema.prisma` with all fields above
2. `Booking` model has a `modifications BookingModification[]` relation
3. Migration runs cleanly against existing data

**Dependencies:** None
**Complexity:** S

---

### SCH-02: Add changeFeeCents to Payment Model

**Description:** Add `changeFeeCents Int @default(0)` to `Payment` to track cumulative late-notice change fees. Needed so cancellation refund calculation can exclude fees already paid.

**Acceptance Criteria:**
1. `Payment.changeFeeCents` field exists with default 0
2. Existing payment records unaffected (default 0)

**Dependencies:** None
**Complexity:** S

---

## Section 3: Late-Notice Change Fee Engine

### FEE-01: Cancellation Tier Determination Function

**Description:** Extract a pure function `getRefundTier(daysUntilCheckIn, policy)` from the existing `calculateRefundAmount` logic in `src/lib/cancellation.ts`. Returns the applicable tier (refund percentage and days threshold) for a given number of days before check-in.

**Acceptance Criteria:**
1. `getRefundTier(15, [{14, 100}, {7, 50}, {0, 0}])` returns `{ refundPercentage: 100, daysBeforeStay: 14 }`
2. `getRefundTier(5, [{14, 100}, {7, 50}, {0, 0}])` returns `{ refundPercentage: 0, daysBeforeStay: 0 }`
3. `getRefundTier(10, [{14, 100}, {7, 50}, {0, 0}])` returns `{ refundPercentage: 50, daysBeforeStay: 7 }`
4. `getRefundTier(14, ...)` returns `{ refundPercentage: 100, daysBeforeStay: 14 }` (exact boundary)
5. `getRefundTier(7, ...)` returns `{ refundPercentage: 50, daysBeforeStay: 7 }` (exact boundary)
6. Empty policy returns `{ refundPercentage: 0, daysBeforeStay: 0 }`
7. `calculateRefundAmount` is refactored to use `getRefundTier` internally (no behaviour change)
8. Unit tests cover all tier boundaries

**Dependencies:** None
**Complexity:** S

---

### FEE-02: Late-Notice Change Fee Calculation

**Description:** Create a pure function `calculateChangeFee(originalCheckIn, newCheckIn, originalFinalPriceCents, policy)` in `src/lib/change-fee.ts`. The fee is charged when a date modification moves a booking from a stricter cancellation tier (lower refund %) to a more lenient tier (higher refund %). This prevents members from pushing dates out to escape cancellation penalties.

**Fee formula:** `feeCents = (toTierRefundPct - fromTierRefundPct) / 100 * originalFinalPriceCents`

The fee is based on the **original** booking's `finalPriceCents` (after any promo discount).

**Acceptance Criteria:**
1. 5 days out (0% tier) moved to 20 days out (100% tier), $200 booking: `feeCents = 20000`
2. 10 days out (50% tier) moved to 20 days out (100% tier), $200 booking: `feeCents = 10000`
3. 20 days out (100% tier) moved to 25 days out (100% tier): `feeCents = 0` (same tier)
4. 20 days out (100% tier) moved to 10 days out (50% tier): `feeCents = 0` (stricter tier, no fee)
5. 5 days out (0% tier) moved to 10 days out (50% tier), $200 booking: `feeCents = 10000`
6. Tier determination uses days from **now** to the **original** check-in (not the new check-in)
7. Tier determination for the new position uses days from **now** to the **new** check-in
8. Unit tests cover all tier transition combinations including boundaries

**Dependencies:** FEE-01
**Complexity:** M

---

### FEE-03: Change Fee Interaction with Subsequent Cancellation

**Description:** When a booking with a previously charged change fee is cancelled, the change fee is non-refundable. Update the cancellation service (CAN-01) so the refund is calculated on the booking price only -- the change fee is excluded from the refundable base.

**Refund formula:** `refundCents = refundPercentage / 100 * (paidAmountCents - changeFeeCents)`

Where `paidAmountCents` is the total charged (booking price + change fee) and `changeFeeCents` is read from `payment.changeFeeCents`.

**Acceptance Criteria:**
1. Booking $200, change fee $200 (100%), cancelled at 100% refund tier: refund = 100% of ($400 - $200) = $200. Net cost = $200 (the fee)
2. Booking $200, change fee $100 (50%), cancelled at 50% refund tier: refund = 50% of ($300 - $100) = $100. Net cost = $200
3. No change fee: cancellation behaviour identical to current
4. Xero credit note reflects only the cancellation refund amount, not the fee
5. AuditLog entry includes the change fee deduction in details

**Dependencies:** CAN-01, SCH-02, FEE-02
**Complexity:** M

---

## Section 4: Booking Date Modification

### MOD-01: Date Change API Endpoint

**Description:** Create `PUT /api/bookings/[id]/modify-dates` allowing the booking owner or admin to change check-in and/or check-out dates on a PENDING or CONFIRMED booking.

**Acceptance Criteria:**
1. Accepts `{ checkIn?: string, checkOut?: string }` (at least one required)
2. Validates: checkOut > checkIn, checkIn >= today, season coverage exists for new dates
3. Capacity check uses `checkCapacity` with `excludeBookingId` (existing function in `src/lib/capacity.ts`)
4. Price recalculated via `calculateBookingPrice` with existing guests and new dates
5. If booking has a promo code, discount is recalculated against new price. If promo is now invalid (expired, inactive, max redemptions), discount is removed and response includes `promoRemoved: true`
6. For CONFIRMED bookings with SUCCEEDED payment:
   - Price increase: returns `additionalAmountCents` owed (does not auto-charge)
   - Price decrease: processes partial Stripe refund for the difference
7. Late-notice change fee calculated per FEE-02. Fee is charged as a separate Stripe charge or added to the amount owed
8. Updates `Booking.checkIn`, `checkOut`, `totalPriceCents`, `discountCents`, `finalPriceCents`
9. Recalculates `hasNonMembers` and `nonMemberHoldUntil` (= newCheckIn - 7 days if non-members present)
10. Creates a `BookingModification` record (type: `DATE_CHANGE`)
11. Logs to AuditLog with action `booking.modify.dates`
12. Uses `pg_advisory_xact_lock(1)` in transaction (consistent with booking creation)
13. PENDING booking moved to check-in within 7 days with non-members: status changes to CONFIRMED
14. COMPLETED, CANCELLED, BUMPED bookings return 400
15. Sends booking-modified email notification
16. Returns updated booking with modification details, fee info, and price changes

**Dependencies:** SCH-01, FEE-02
**Complexity:** XL

---

### MOD-02: Extend Stay

**Description:** Extending a stay is a special case of MOD-01 -- the member provides a later `checkOut` date. No separate endpoint needed; the UI may present it as a distinct action but it maps to the same API.

**Acceptance Criteria:**
1. Extending checkOut by N days adds N nights to pricing calculation
2. Capacity checked for full new date range (not just extension days)
3. No late-notice change fee when only checkOut changes (checkIn doesn't move, so tier is unchanged)
4. Multi-season stays priced correctly if extension spans a season boundary

**Dependencies:** MOD-01
**Complexity:** S (covered by MOD-01 implementation)

---

## Section 5: Guest Modification

### MOD-03: Add Guests API Endpoint

**Description:** Create `POST /api/bookings/[id]/guests` to add guests to an existing PENDING or CONFIRMED booking.

**Acceptance Criteria:**
1. Accepts `{ guests: [{ firstName, lastName, ageTier, isMember }] }`
2. Capacity check for booking's date range with new total guest count, using `excludeBookingId`
3. Creates `BookingGuest` records with calculated `priceCents` per guest
4. Recalculates `totalPriceCents`, `discountCents`, `finalPriceCents` (reapplying promo if present)
5. Updates `hasNonMembers` and `nonMemberHoldUntil` if new guests include non-members
6. Adding non-members to a CONFIRMED booking does NOT revert status to PENDING
7. For CONFIRMED+paid bookings, returns `additionalAmountCents` owed
8. Creates `BookingModification` record (type: `GUEST_ADD`)
9. AuditLog entry
10. Uses advisory lock in transaction
11. No late-notice change fee (check-in date not moving)
12. If adding guests would exceed capacity, FIFO bumping applies for member-only bookings (same logic as booking creation)

**Dependencies:** SCH-01
**Complexity:** L

---

### MOD-04: Remove Guest API Endpoint

**Description:** Create `DELETE /api/bookings/[id]/guests/[guestId]` to remove a guest from a booking.

**Acceptance Criteria:**
1. Cannot remove the last guest (at least 1 must remain)
2. Deletes the `BookingGuest` record
3. Recalculates booking prices (total, discount, final)
4. For CONFIRMED+paid bookings with price decrease, processes partial Stripe refund
5. Updates `hasNonMembers` if removed guest was the only non-member
6. ChoreAssignment records for the removed guest are deleted (cascade or explicit). CONFIRMED/COMPLETED assignments on the removed guest generate a warning in the response
7. Creates `BookingModification` record (type: `GUEST_REMOVE`)
8. AuditLog entry
9. No late-notice change fee (check-in date not moving)
10. If removed guest has a `memberId`, the Member record is unaffected -- only the BookingGuest is removed

**Dependencies:** SCH-01
**Complexity:** M

---

## Section 6: Modification Quote

### MOD-05: Modification Quote API Endpoint

**Description:** Create `POST /api/bookings/[id]/modify-quote` that previews the cost impact of a proposed modification without committing changes. Used by the UI before the member confirms.

**Acceptance Criteria:**
1. Accepts `{ checkIn?: string, checkOut?: string, addGuests?: [{ firstName, lastName, ageTier, isMember }], removeGuestIds?: string[] }`
2. Returns `{ newTotalPriceCents, newDiscountCents, newFinalPriceCents, priceDiffCents, changeFeeCents, capacityAvailable, promoStillValid }`
3. Does NOT modify any data (read-only)
4. Returns 404 if booking not found, 403 if not owner/admin, 400 if booking not modifiable
5. If capacity insufficient, returns `capacityAvailable: false` with night-level details

**Dependencies:** FEE-02
**Complexity:** M

---

## Section 7: Chore Assignment Handling

### CHR-01: Chore Cleanup on Date Change

**Description:** When booking dates change, delete `ChoreAssignment` records for dates no longer in the booking range. Keep assignments for dates still in range. Do not auto-create assignments for newly added dates.

**Acceptance Criteria:**
1. Booking changed from Mon-Fri to Wed-Fri: assignments for Mon, Tue are deleted
2. Booking extended from Mon-Fri to Mon-Sun: no new assignments created
3. Only SUGGESTED assignments are auto-deleted
4. CONFIRMED and COMPLETED assignments on out-of-range dates are NOT auto-deleted; response includes `choreWarnings` listing them for admin attention
5. No chore cleanup needed for guest-only changes (guests removed cascade via FK)

**Dependencies:** MOD-01
**Complexity:** M

---

## Section 8: Xero Integration for Modifications

### XER-01: Xero Invoice Adjustment on Price Change

**Description:** When a modification changes the price and a Xero invoice exists, create appropriate Xero adjustments.

**Acceptance Criteria:**
1. Price increase + Xero invoice exists: create supplementary Xero invoice for the difference
2. Price decrease + Xero invoice exists: create Xero credit note for the refund amount
3. No Xero invoice (PENDING, unpaid): no Xero action
4. Late-notice change fee appears as a separate line item: "Late notice booking change fee"
5. Xero failures logged but do not block modification (fire-and-forget, consistent with current cancel pattern)

**Dependencies:** MOD-01, FEE-02
**Complexity:** L

---

## Section 9: Email Notifications

### EML-01: Booking Modified Email Template

**Description:** Create a `bookingModifiedTemplate` in `src/lib/email-templates.ts` and `sendBookingModifiedEmail` in `src/lib/email.ts`. Summarises what changed.

**Acceptance Criteria:**
1. Includes: member name, old and new check-in/check-out, old and new guest count, old and new price, change fee (if any), amount owed or refunded
2. Sent after successful modification (fire-and-forget)
3. Uses same branded template pattern as existing emails (TAC header, responsive 600px layout)
4. User-provided values escaped with `escapeHtml()`

**Dependencies:** MOD-01
**Complexity:** S

---

## Section 10: UI Changes

### UI-01: Change Dates UI

**Description:** Add a "Change Dates" button to the booking detail page (`src/app/(authenticated)/bookings/[id]/page.tsx`) for modifiable bookings. Opens a date picker dialog with availability. Shows price summary and change fee before confirming.

**Acceptance Criteria:**
1. Button visible only for PENDING/CONFIRMED bookings with future check-in
2. Date picker shows availability (reuses existing `/api/availability` endpoint)
3. Before confirming: shows new price, price difference, change fee (if any) via `POST /api/bookings/[id]/modify-quote`
4. On confirm: calls `PUT /api/bookings/[id]/modify-dates`
5. If additional payment needed, shows amount owed and payment flow
6. Success/error feedback via toast notification
7. Page refreshes to show updated booking details

**Dependencies:** MOD-01, MOD-05
**Complexity:** L

---

### UI-02: Manage Guests UI

**Description:** Add guest management to the booking detail page. "Add Guest" button opens a form. Each guest row has a "Remove" button (disabled if only 1 guest).

**Acceptance Criteria:**
1. "Add Guest" opens a form reusing the `guest-form.tsx` pattern
2. Adding shows price impact before confirming (via modify-quote)
3. "Remove Guest" shows confirmation dialog with price impact
4. After add/remove, page refreshes with updated pricing and guest list
5. Only available for PENDING/CONFIRMED bookings with future check-in

**Dependencies:** MOD-03, MOD-04, MOD-05
**Complexity:** M

---

### UI-03: Modification History on Booking Detail Page

**Description:** Add a "Modification History" card to the booking detail page showing all `BookingModification` records for the booking.

**Acceptance Criteria:**
1. Each entry: date/time, type of change, summary (old vs new), price difference, change fee
2. Ordered most recent first
3. Section hidden if no modifications exist
4. Visible to booking owner and admins

**Dependencies:** SCH-01
**Complexity:** S

---

## Section 11: Edge Cases & Business Rules

### EDGE-01: PENDING vs CONFIRMED Modification Behaviour

**Description:** Enforce different payment handling for PENDING and CONFIRMED booking modifications.

**Acceptance Criteria:**
1. PENDING bookings: price fields updated, no Stripe interaction
2. CONFIRMED + SUCCEEDED payment: price increase returns amount owed; price decrease triggers Stripe partial refund
3. CONFIRMED without SUCCEEDED payment: treated as PENDING for payment purposes
4. BUMPED, CANCELLED, COMPLETED bookings cannot be modified (400 error)
5. PENDING booking with non-members modified to check-in within 7 days: auto-confirms (status -> CONFIRMED)

**Dependencies:** MOD-01, MOD-03, MOD-04
**Complexity:** Covered by MOD-01/03/04

---

### EDGE-02: Promo Code Handling on Modification

**Description:** Define promo code behaviour when a booking is modified.

**Acceptance Criteria:**
1. Existing promo discount is recalculated against the new price
2. If promo code has expired or been deactivated since booking, promo redemption is removed, `discountCents` set to 0, response includes `promoRemoved: true`
3. Promo codes cannot be added during modification (only at booking creation)
4. FREE_NIGHTS promo on shortened stay: discount recalculated (may decrease)
5. Promo validation uses the same `validatePromoCodeRules` function from `src/lib/promo.ts`

**Dependencies:** MOD-01
**Complexity:** Covered by MOD-01

---

### EDGE-03: Non-Member Hold Recalculation

**Description:** `nonMemberHoldUntil` must be recalculated when dates change on bookings with non-members.

**Acceptance Criteria:**
1. Date change: `nonMemberHoldUntil` = newCheckIn - 7 days (if non-members present)
2. New check-in within 7 days: `nonMemberHoldUntil` set to null, PENDING auto-confirms
3. No non-members: `nonMemberHoldUntil` remains null regardless of date change

**Dependencies:** MOD-01
**Complexity:** Covered by MOD-01

---

### EDGE-04: Concurrent Modification Safety

**Description:** All modification operations must use `pg_advisory_xact_lock(1)` to serialise with booking creation and prevent capacity race conditions.

**Acceptance Criteria:**
1. Two concurrent date changes on different bookings that would exceed capacity: only one succeeds
2. A date change and a new booking that together exceed capacity: only one succeeds
3. Advisory lock acquired within transaction, released on commit/rollback

**Dependencies:** MOD-01, MOD-03
**Complexity:** Covered by MOD-01/03

---

## Complexity Summary

| Size | Count | Features |
|------|-------|----------|
| S | 6 | CAN-01, CAN-02, SCH-01, SCH-02, FEE-01, EML-01, UI-03, MOD-02 |
| M | 5 | FEE-02, FEE-03, MOD-04, MOD-05, CHR-01, UI-02 |
| L | 3 | MOD-03, XER-01, UI-01 |
| XL | 1 | MOD-01 |

---

## Key Files for Implementation

| File | Role |
|------|------|
| `prisma/schema.prisma` | Add BookingModification model, Payment.changeFeeCents |
| `src/lib/cancellation.ts` | Extract `getRefundTier`, update refund to exclude change fees |
| `src/lib/change-fee.ts` | New -- late-notice change fee calculation |
| `src/lib/booking-cancel.ts` | New -- shared cancellation service function |
| `src/lib/pricing.ts` | Reused for price recalculation (`calculateBookingPrice`) |
| `src/lib/capacity.ts` | Reused for capacity checks (`checkCapacity` with `excludeBookingId`) |
| `src/lib/promo.ts` | Reused for promo re-validation (`validatePromoCodeRules`) |
| `src/lib/bumping.ts` | Reused for FIFO bumping on guest additions |
| `src/lib/stripe.ts` | Reused for refunds/charges (`processRefund`, `chargePaymentMethod`) |
| `src/lib/xero.ts` | Extended for supplementary invoices |
| `src/lib/email-templates.ts` | Add booking-modified template |
| `src/lib/email.ts` | Add `sendBookingModifiedEmail` |
| `src/app/api/bookings/cancel/route.ts` | Refactor to delegate to shared service |
| `src/app/api/bookings/[id]/cancel/route.ts` | Refactor to delegate to shared service |
| `src/app/api/bookings/[id]/modify-dates/route.ts` | New -- date change endpoint |
| `src/app/api/bookings/[id]/modify-quote/route.ts` | New -- modification preview endpoint |
| `src/app/api/bookings/[id]/guests/route.ts` | New -- add guests endpoint |
| `src/app/api/bookings/[id]/guests/[guestId]/route.ts` | New -- remove guest endpoint |
| `src/app/(authenticated)/bookings/[id]/page.tsx` | Add modification UI controls + history |
| `src/components/cancel-booking-button.tsx` | Existing -- may need minor updates |
| `src/components/stripe/CancelBookingButton.tsx` | Update to use path-based cancel route |

---


**Date:** 2026-04-04
**Status:** Draft

---

## Feature 1: LODGE Role and Lodge Account

**Description**

Add `LODGE` to the Prisma `Role` enum. Create a dedicated member account (`lodge@tokoroa.org.nz`) with role `LODGE` for use on a shared iPad in the lodge public area. The LODGE role grants access to lodge-specific pages (kiosk, hut leader tools) but not to the admin panel or member booking features.

**Schema Changes**

- `Role` enum: `MEMBER | ADMIN | LODGE`
- Seed lodge account in `prisma/seed.ts` with `forcePasswordChange: true`

**Auth Changes**

- Update session type in `src/lib/auth.ts` and `src/types/next-auth.d.ts` to include `"LODGE"` in the role union
- JWT expiry for LODGE role: extend to 30 days (or indefinite) instead of the standard 8-hour expiry. The iPad stays logged in permanently.
- Admin layout (`src/app/(admin)/layout.tsx`) already rejects non-ADMIN -- no change needed
- Authenticated layout (`src/app/(authenticated)/layout.tsx`) should redirect LODGE users to `/lodge/kiosk`

**Acceptance Criteria**

- [ ] `LODGE` role exists in Prisma schema and can be assigned to a member
- [ ] `lodge@tokoroa.org.nz` account is created by seed script
- [ ] Logging in as lodge account produces a session with `role: "LODGE"`
- [ ] Lodge account cannot access `/admin/*` pages
- [ ] Lodge account cannot access member-only `/dashboard`, `/book`, `/bookings` pages
- [ ] Lodge account can access `/lodge/*` routes

**Dependencies:** None (foundational)

**Complexity:** S

---

## Feature 2: iPad Kiosk Page

**Description**

Full-screen, touch-optimised page at `/lodge/kiosk`. Displayed on an iPad in the lodge public area, logged in as the lodge account. Shows two panels: (a) lodge list -- who is staying tonight with arriving/departing indicators, and (b) the day's chore roster with tick-off capability. Guests walk up and tap to mark chores done without individual login.

**UI Changes**

- New route group `(lodge)` under `src/app/` with layout requiring `role === "LODGE"` or `role === "ADMIN"` or active hut leader (Feature 8)
- Minimal chrome: no sidebar, no nav bar, large touch targets, optimised for 10.9" iPad
- `/lodge/kiosk` page:
  - Current date prominently displayed; date navigation
  - **Lodge List panel:** All confirmed guests staying that night (bookings where `checkIn <= date < checkOut`), grouped by booking. Each guest shows name, age tier, arriving badge (checkIn === date), departing badge (checkOut === date + 1 day)
  - **Chore Roster panel:** Confirmed chore assignments grouped by chore, with large tap target to toggle CONFIRMED <-> COMPLETED
  - Auto-refresh every 60 seconds or pull-to-refresh
  - "Set Up Today's Roster" button when no confirmed roster exists (links to Feature 6 wizard)

**API Changes**

- `GET /api/lodge/guests/[date]` -- lodge list for the date (LODGE/ADMIN/hut-leader auth)
- `GET /api/lodge/roster/[date]` -- roster data without auto-suggest (LODGE/ADMIN/hut-leader auth)
- `PUT /api/lodge/roster/[date]` -- limited actions: `complete` and `uncomplete` only

**Acceptance Criteria**

- [ ] Kiosk loads when logged in as lodge account
- [ ] Denied to unauthenticated users and MEMBER-role users (unless hut leader)
- [ ] Lodge list shows all guests for selected date with correct arriving/departing indicators
- [ ] Guests visually grouped by booking (family group)
- [ ] Tapping a chore assignment toggles CONFIRMED <-> COMPLETED
- [ ] No additional auth required to mark chores done
- [ ] Usable on 10.9" iPad (large fonts, large tap targets, minimal scrolling)
- [ ] Auto-refreshes periodically

**Dependencies:** Feature 1

**Complexity:** L

---

## Feature 3: Time-of-Day for Chore Templates

**Description**

Add `timeOfDay` field to `ChoreTemplate` classifying each chore as MORNING, EVENING, or ANYTIME. Admin-configurable. Used by the allocator, kiosk display, and print view to group chores.

**Schema Changes**

- New enum `ChoreTimeOfDay`: `MORNING | EVENING | ANYTIME`
- New field `ChoreTemplate.timeOfDay ChoreTimeOfDay @default(ANYTIME)`
- Migration sets defaults for the 17 seeded chores:
  - MORNING: Breakfast, Fridge, Breakfast dishes, Dining room floor, Oven/microwave/hob, Tea towels (sortOrder 1-6)
  - EVENING: Dinner, Pre-dinner dishes, Dinner dishes (sortOrder 9-11)
  - ANYTIME: Firewood, Rubbish, Bathrooms x2, Ski room, Lounge, Bunkrooms, Stores (sortOrder 7-8, 12-17)
- Update `prisma/seed.ts` to include `timeOfDay` per chore

**UI Changes**

- Admin chore template form: add `timeOfDay` dropdown
- Admin roster page and print view: group chores under Morning / Evening / Anytime headings
- Kiosk page: group chores by time of day

**API Changes**

- Update `GET/POST /api/admin/chores` and `PUT/DELETE /api/admin/chores/[id]` to include `timeOfDay`

**Allocator Changes**

- Add `timeOfDay` to `ChoreTemplateInput` interface in `src/lib/chore-allocator.ts`
- No filtering by time-of-day yet (that's Feature 7), but field must flow through

**Acceptance Criteria**

- [ ] Each chore template has a `timeOfDay` field defaulting to ANYTIME
- [ ] Admins can set time of day when creating/editing a chore template
- [ ] Roster page and print view group chores under Morning / Evening / Anytime headings
- [ ] Existing 17 chores receive correct default values via migration

**Dependencies:** None

**Complexity:** M

---

## Feature 4: Chore Frequency Settings

**Description**

Allow admins to configure how often a chore should be rostered. Two modes: (a) minimum every X days, or (b) on specific days of the week. The allocator consults the chore's last rostered date to decide whether to include it.

**Schema Changes**

- New enum `ChoreFrequencyMode`: `DAILY | EVERY_X_DAYS | SPECIFIC_DAYS`
- New fields on `ChoreTemplate`:
  - `frequencyMode ChoreFrequencyMode @default(DAILY)`
  - `frequencyDays Int?` -- interval for EVERY_X_DAYS (e.g. 3 = every 3 days)
  - `frequencyDaysOfWeek Int[]` -- ISO day numbers for SPECIFIC_DAYS (1=Mon, 7=Sun). Postgres native int array.

**UI Changes**

- Admin chore template form:
  - Radio/select for frequency mode (Daily / Every X Days / Specific Days)
  - Conditional number input for interval days
  - Conditional day-of-week checkboxes

**Allocator Changes**

- Add `frequencyMode`, `frequencyDays`, `frequencyDaysOfWeek` to `ChoreTemplateInput`
- New exported function `filterChoresByFrequency(chores, choreLastRosteredDates: Map<string, Date>, currentDate: Date)` returns only chores that are "due":
  - `DAILY`: always included
  - `EVERY_X_DAYS`: included only if last rostered >= X days ago (or never rostered)
  - `SPECIFIC_DAYS`: included only if current date's day-of-week is in the array
- Called before `selectChoresForOccupancy` in the pipeline
- Accepts `choreLastRosteredDates` parameter (may need lookback beyond 4 days for large intervals)

**API Changes**

- Roster GET endpoint must query most recent assignment date per chore template and pass to allocator
- Update chore template CRUD endpoints to handle new fields

**Acceptance Criteria**

- [ ] Admins can set a chore to Daily, Every X Days, or Specific Days
- [ ] A chore set to "every 3 days" is excluded from auto-suggest if rostered within last 2 days
- [ ] A chore set to "Sunday and Thursday" only appears on those days
- [ ] Daily chores behave identically to current behavior
- [ ] Hut leader wizard (Feature 6) can manually override frequency exclusions
- [ ] Essential daily chores are always included (backward compatible)

**Dependencies:** None (integrates with Feature 6 and 11)

**Complexity:** L

---

## Feature 5: Family Group Allocation

**Description**

The allocator prefers to group guests from the same booking (family group) onto the same chore. For chores needing 2+ people, after picking the first guest, prefer remaining guests from the same `bookingId` (if eligible).

**Schema Changes:** None. `bookingId` already exists on `GuestInput`.

**Allocator Changes**

- In `allocateChores()`, after sorting eligible guests by assignment count and history, add family-grouping tie-breaker:
  - Among guests with equal assignment count and equal history, prefer same-booking guests as the first picked guest
- For MIXED_PREFERRED: prefer adult+child from the same booking
- For ADULT_SUPERVISED: prefer supervising adult from the same booking as assigned children
- Family preference is secondary to round-robin fairness (don't overload one family)

**Acceptance Criteria**

- [ ] When a chore needs 2 people and a family of 4 is staying, both assigned come from same family (all else equal)
- [ ] Family grouping does not override round-robin fairness
- [ ] Family grouping does not override age restrictions
- [ ] For MIXED_PREFERRED, prefers adult+child from same booking
- [ ] Single-person chores are unaffected
- [ ] Allocator remains a pure function with no database calls

**Dependencies:** None

**Complexity:** M

---

## Feature 6: Hut Leader Wizard / Stepped Flow

**Description**

Multi-step wizard at `/lodge/roster/[date]/setup` where the hut leader reviews guests, selects chores, reviews/tweaks the generated roster, and confirms. Replaces the auto-suggest-on-load behaviour for the hut leader workflow.

**UI Changes**

- New page accessible by LODGE, ADMIN, or active hut leader
- **Step 1 -- Review Guests:** Shows who is staying with arriving/departing indicators. Read-only confirmation.
- **Step 2 -- Select Chores:** All active chore templates grouped by time of day. Pre-checks based on frequency rules and occupancy. Hut leader checks/unchecks any chore. Chores excluded by frequency shown unchecked with explanation (e.g. "Last done 1 day ago, next due in 2 days"). Essential daily chores pre-checked and highlighted.
- **Step 3 -- Review Roster:** Generated allocation shown in full. Manual reassignment via dropdown (per existing admin roster UI). "Regenerate" button re-runs allocator with same chore selections.
- **Step 4 -- Confirm:** Sets all assignments to CONFIRMED, returns to kiosk view.

**API Changes**

- `POST /api/lodge/roster/[date]/generate` -- accepts selected `choreTemplateId[]`, returns allocation without saving
- `POST /api/lodge/roster/[date]/confirm` -- saves final roster, sets status to CONFIRMED
- `PUT /api/lodge/roster/[date]/reassign` -- manual guest swaps during step 3

**Acceptance Criteria**

- [ ] Wizard accessible from kiosk via "Set Up Today's Roster" button (shown when no confirmed roster exists)
- [ ] Step 1 shows all guests with arriving/departing status
- [ ] Step 2 shows all active chores with frequency-based pre-selection
- [ ] Step 2 allows hut leader to override any selection
- [ ] Step 3 shows generated roster with manual reassignment
- [ ] Step 4 confirms roster and navigates to kiosk
- [ ] Already-confirmed roster cannot be overwritten without explicit acknowledgment
- [ ] Touch-optimised for iPad

**Dependencies:** Features 1, 2, 3, 4

**Complexity:** XL

---

## Feature 7: Arriving/Departing Guest Routing

**Description**

The allocator considers whether each guest is arriving or departing on the roster date:
- **Arriving** (checkIn === roster date): only EVENING or ANYTIME chores
- **Departing** (checkOut === roster date + 1 day): only MORNING or ANYTIME chores
- **Staying through**: any time-of-day chore

**Schema Changes:** None. Determined at allocation time from booking `checkIn`/`checkOut`.

**Allocator Changes**

- Extend `GuestInput` with `isArriving: boolean` and `isDeparting: boolean`
- New eligibility filter (applied before age check):
  - Arriving + MORNING chore = ineligible
  - Departing + EVENING chore = ineligible
  - All other combinations = eligible

**API Changes**

- Roster endpoints must compute and pass `isArriving`/`isDeparting` flags per guest. The booking data is already loaded.

**Acceptance Criteria**

- [ ] Arriving guest is never assigned to a MORNING chore
- [ ] Departing guest is never assigned to an EVENING chore
- [ ] Staying-through guest can be assigned to any chore
- [ ] If all guests are arriving, MORNING chores go unassigned (with warning in wizard)
- [ ] Wizard and kiosk show arriving/departing badges next to guest names

**Dependencies:** Feature 3

**Complexity:** M

---

## Feature 8: Hut Leader Role Assignment

**Description**

Admin can designate any member as "hut leader" for a date range. The member uses their own credentials and gains access to lodge tools for their assigned dates. Date-scoped elevation, not a permanent role change.

**Schema Changes**

- New model `HutLeaderAssignment`:
  - `id String @id @default(cuid())`
  - `memberId String` (FK -> Member)
  - `startDate DateTime @db.Date`
  - `endDate DateTime @db.Date`
  - `createdAt DateTime @default(now())`
  - `updatedAt DateTime @updatedAt`
  - Index on `[memberId]` and `[startDate, endDate]`
- Add `hutLeaderAssignments HutLeaderAssignment[]` relation on Member

**Auth Changes**

- Helper function `isHutLeader(memberId: string, date: Date): Promise<boolean>` in `src/lib/hut-leader.ts`
- Lodge layout and lodge API endpoints accept LODGE, ADMIN, or MEMBER with active hut leader assignment

**UI Changes**

- Admin page `/admin/hut-leaders`: list assignments, create (member picker + date range), edit, delete
- Member nav bar shows "Hut Leader" link when member has active assignment
- Member dashboard shows hut leader callout card when active

**API Changes**

- `GET/POST /api/admin/hut-leaders` -- list and create
- `PUT/DELETE /api/admin/hut-leaders/[id]` -- update and delete
- Lodge API endpoints (`/api/lodge/*`) check hut leader status in addition to role

**Acceptance Criteria**

- [ ] Admin can assign any member as hut leader for a date range
- [ ] Assigned member can access kiosk and wizard for dates within their range
- [ ] Member cannot access lodge tools for dates outside their assignment
- [ ] Assignment does not change the member's `role` field
- [ ] Multiple members can be hut leader for overlapping dates
- [ ] Admin can view, edit, and delete assignments

**Dependencies:** Features 1, 2, 6

**Complexity:** L

---

## Feature 9: Guest Arrival/Departure and Chore Tick-Off Without Login

**Description**

On the kiosk, any person can mark chores complete and mark guests as arrived/departed. No individual authentication -- relies on physical presence and social trust. The lodge account session provides the auth context.

**Schema Changes**

- `ChoreAssignment.completedAt DateTime?` -- timestamp when marked complete
- `ChoreAssignment.completedVia String?` -- `"KIOSK"`, `"ADMIN"`, or `"GUEST_LINK"` (for Feature 10)
- `BookingGuest.arrivedAt DateTime?` -- kiosk-level arrival indicator
- `BookingGuest.departedAt DateTime?` -- kiosk-level departure indicator

**UI Changes**

- Kiosk lodge list: tap target per guest for "Mark Arrived" / "Mark Departed"
- Kiosk chore roster: large checkbox per assignment to toggle CONFIRMED <-> COMPLETED
- Visual feedback on completion (color change, checkmark)
- No confirmation dialog (fast, low-friction for shared device)

**API Changes**

- `PUT /api/lodge/roster/[date]` `complete`/`uncomplete` actions set `completedAt` and `completedVia: "KIOSK"`
- `PUT /api/lodge/guests/[date]/arrive` and `/depart` endpoints set `arrivedAt`/`departedAt` on BookingGuest

**Acceptance Criteria**

- [ ] Any person at kiosk can mark a chore as completed
- [ ] Any person at kiosk can mark a guest as arrived or departed
- [ ] Completion records timestamp and method (`KIOSK`)
- [ ] Arrived/departed shown visually on lodge list
- [ ] Arrived/departed does not affect booking `status` (CONFIRMED stays CONFIRMED)
- [ ] No per-guest auth prompt on kiosk

**Dependencies:** Features 1, 2

**Complexity:** M

---

## Feature 10: Per-Guest Email Link for Chore Access

**Description**

When the roster email is sent, include a unique time-limited link per guest. The link shows only that guest's assigned chores and allows marking them complete from their own device.

**Schema Changes**

- New model `GuestChoreToken`:
  - `id String @id @default(cuid())`
  - `token String @unique`
  - `bookingGuestId String` (FK -> BookingGuest)
  - `date DateTime @db.Date`
  - `expiresAt DateTime`
  - `createdAt DateTime @default(now())`
  - Index on `[token]` and `[bookingGuestId]`
- Add `choreTokens GuestChoreToken[]` relation on BookingGuest

**UI Changes**

- New public (unauthenticated) page at `/chores/[token]`:
  - Validates token and checks expiry
  - Shows guest's name and date
  - Lists only that guest's assigned chores
  - Tap targets to mark each chore COMPLETED
  - Clear message for expired/invalid tokens
- Lives outside `(authenticated)` and `(admin)` layouts -- fully public, protected by token unguessability

**API Changes**

- `GET /api/chores/[token]` -- validate token, return guest's assignments
- `PUT /api/chores/[token]` -- mark assignments COMPLETED with `completedVia: "GUEST_LINK"`
- Update roster email action to generate `GuestChoreToken` per guest and embed URL
- Update `sendChoreRosterEmail` and `choreRosterTemplate` to include the link

**Acceptance Criteria**

- [ ] Roster email includes unique link per guest (all guests have email addresses, including non-members)
- [ ] Each guest receives their own email with their own link (not bundled to the booking member)
- [ ] Link shows only that guest's chores for the date
- [ ] Guest can mark chores complete without logging in
- [ ] Token expires after 48 hours
- [ ] Expired/invalid token shows clear error
- [ ] Completion records `completedVia: "GUEST_LINK"`
- [ ] Works on mobile browsers

**Dependencies:** Feature 9

**Complexity:** L

---

## Feature 11: Chore History Lookback for Frequency-Based Roster Generation

**Description**

Ensure the 4-day history lookback is also used at the chore-template level when deciding which chores to include, particularly with frequency settings (Feature 4). The existing guest-level lookback for round-robin fairness continues unchanged.

**Allocator Changes**

- New parameter `choreLastRosteredDates: Map<string, Date>` on `allocateChores` (mapping choreTemplateId to most recent roster date)
- New exported function `filterChoresByFrequency(chores, choreLastRosteredDates, currentDate)` returns only "due" chores
- Called before `selectChoresForOccupancy`

**API Changes**

- Roster GET endpoints query most recent assignment date per chore template and pass to allocator

**Acceptance Criteria**

- [ ] EVERY_X_DAYS chore with `frequencyDays: 3` excluded if rostered within last 2 days
- [ ] SPECIFIC_DAYS chore excluded on non-matching days
- [ ] DAILY chore always included
- [ ] Hut leader wizard shows excluded chores with reason
- [ ] Guest-level 4-day lookback continues working for round-robin

**Dependencies:** Feature 4

**Complexity:** M

---

## Summary

| # | Feature | Complexity | Dependencies |
|---|---------|-----------|-------------|
| 1 | LODGE Role and Lodge Account | S | None |
| 2 | iPad Kiosk Page | L | 1 |
| 3 | Time-of-Day for Chore Templates | M | None |
| 4 | Chore Frequency Settings | L | None |
| 5 | Family Group Allocation | M | None |
| 6 | Hut Leader Wizard / Stepped Flow | XL | 1, 2, 3, 4 |
| 7 | Arriving/Departing Guest Routing | M | 3 |
| 8 | Hut Leader Role Assignment | L | 1, 2, 6 |
| 9 | Guest Arrival/Departure and Chore Tick-Off | M | 1, 2 |
| 10 | Per-Guest Email Link for Chore Access | L | 9 |
| 11 | Chore History Lookback for Frequency | M | 4 |

## Schema Change Summary

**Modified Enums:**
- `Role`: add `LODGE`

**New Enums:**
- `ChoreTimeOfDay`: `MORNING | EVENING | ANYTIME`
- `ChoreFrequencyMode`: `DAILY | EVERY_X_DAYS | SPECIFIC_DAYS`

**New Fields on Existing Models:**
- `ChoreTemplate.timeOfDay`: `ChoreTimeOfDay @default(ANYTIME)`
- `ChoreTemplate.frequencyMode`: `ChoreFrequencyMode @default(DAILY)`
- `ChoreTemplate.frequencyDays`: `Int?`
- `ChoreTemplate.frequencyDaysOfWeek`: `Int[]`
- `ChoreAssignment.completedAt`: `DateTime?`
- `ChoreAssignment.completedVia`: `String?`
- `BookingGuest.arrivedAt`: `DateTime?`
- `BookingGuest.departedAt`: `DateTime?`

**New Models:**
- `HutLeaderAssignment` (id, memberId, startDate, endDate, timestamps)
- `GuestChoreToken` (id, token, bookingGuestId, date, expiresAt, timestamps)

**New Relations:**
- `Member.hutLeaderAssignments` -> `HutLeaderAssignment[]`
- `BookingGuest.choreTokens` -> `GuestChoreToken[]`

## Critical Files

- `prisma/schema.prisma` -- schema changes
- `prisma/seed.ts` -- lodge account, updated chore template seeds
- `src/lib/chore-allocator.ts` -- family grouping, time-of-day routing, frequency filtering
- `src/lib/auth.ts` -- LODGE role in session types
- `src/types/next-auth.d.ts` -- session type augmentation
- `src/app/(lodge)/` -- new route group for kiosk and wizard
- `src/app/api/lodge/` -- new API endpoints
- `src/app/api/admin/roster/[date]/route.ts` -- existing roster API
- `src/app/(admin)/admin/chores/page.tsx` -- chore template form updates
- `src/lib/email-templates.ts` -- guest chore link in roster email
- `src/lib/email.ts` -- updated sendChoreRosterEmail

---


**Date:** 2026-04-05

## Current State

7 transactional email templates exist in `src/lib/email-templates.ts`, sent via nodemailer/AWS SES (`src/lib/email.ts`):

1. Welcome (registration)
2. Password reset
3. Booking confirmed
4. Booking pending (non-member hold)
5. Booking bumped
6. Booking cancelled
7. Chore roster

**Gaps identified:**
- No check-in reminders
- No admin alert emails (new bookings, capacity warnings, payment failures, sync errors)
- No bulk/broadcast communication
- No notification preferences or opt-out
- No email delivery tracking or retry
- No "pending -> confirmed" email distinct from initial confirmation (cron auto-confirm uses the same template but this is already wired)
- Dev mode logs to console only; no email preview/testing tooling

---

## Feature Requirements

### N-01: Check-In Reminder Email

- **Description:** Send an automated reminder email to the booking member N days before check-in (e.g., 3 days). Include dates, guest list, lodge info (directions, check-in time, what to bring), and a link to their booking.
- **Acceptance Criteria:**
  - Cron job (daily, e.g., 9 AM NZST) identifies CONFIRMED bookings with `checkIn` = today + N days
  - Sends one reminder per booking (not per guest)
  - Skips bookings that have already received a reminder (track via a `reminderSentAt` field on Booking or a separate log)
  - N is configurable via env var (default: 3)
  - Email includes: dates, guest names, guest count, total paid, lodge address/directions placeholder, link to booking detail
  - New HTML template in `email-templates.ts` matching existing brand style
  - Does not send for CANCELLED/BUMPED bookings
- **Dependencies:** Existing cron infrastructure in `instrumentation.ts`, `email.ts`
- **Complexity:** S

### N-02: Admin Alert — New Booking Created

- **Description:** Notify admin(s) when a new booking is created, with booking summary.
- **Acceptance Criteria:**
  - Email sent to `CONTACT_EMAIL` (or a new `ADMIN_NOTIFICATION_EMAIL` env var) on booking creation
  - Includes: member name, dates, guest count, member/non-member mix, total price, booking status
  - Sent after successful booking creation in `POST /api/bookings`
  - Fire-and-forget (booking creation does not fail if email fails)
  - New HTML template
- **Dependencies:** `POST /api/bookings` route, `email.ts`
- **Complexity:** S

### N-03: Admin Alert — Capacity Warning

- **Description:** Alert admin when lodge occupancy for any upcoming date crosses a threshold (e.g., 25 of 29 beds booked).
- **Acceptance Criteria:**
  - Checked as part of a daily cron job (can share the reminder cron schedule)
  - Looks 30 days ahead, finds dates where confirmed guest count >= threshold
  - Threshold configurable via env var (default: 25)
  - Sends one summary email listing all dates above threshold with bed counts
  - Does not re-alert for dates already alerted (track last alert date, or only alert once per date)
  - New HTML template
- **Dependencies:** `capacity.ts` (getAvailableBeds), cron infrastructure, `email.ts`
- **Complexity:** M

### N-04: Admin Alert — Payment Failure

- **Description:** Notify admin when a Stripe charge fails during cron auto-confirmation of pending bookings or manual charge.
- **Acceptance Criteria:**
  - Email sent when `confirmPendingBookings()` encounters a Stripe charge failure
  - Email sent when `POST /api/payments/charge-saved-method` fails
  - Includes: member name, email, booking dates, error summary, link to admin booking view
  - Fire-and-forget
  - New HTML template
- **Dependencies:** `cron-confirm-pending.ts`, `charge-saved-method/route.ts`, `email.ts`
- **Complexity:** S

### N-05: Admin Alert — Xero Sync Errors

- **Description:** Notify admin when Xero integration encounters errors (token refresh failure, invoice creation failure, membership sync errors).
- **Acceptance Criteria:**
  - Email sent on: Xero token refresh failure, invoice creation failure, credit note failure, bulk membership refresh with errors
  - Includes: error type, affected member/booking if applicable, error message, timestamp
  - Batched for bulk operations (membership refresh sends one summary email, not one per member)
  - Fire-and-forget
  - New HTML template (or reuse a generic "admin alert" template with variable content)
- **Dependencies:** `xero.ts`, cron Xero job, `email.ts`
- **Complexity:** M

### N-06: Admin Alert — Pending Bookings Approaching Deadline

- **Description:** Warn admin about pending (non-member) bookings that will auto-confirm within 48 hours.
- **Acceptance Criteria:**
  - Daily cron (can share schedule with N-01/N-03) finds PENDING bookings where `nonMemberHoldUntil` is within 48 hours
  - Sends one summary email listing all such bookings with member name, dates, guest count, hold deadline
  - Admin can then manually intervene if needed
  - New HTML template
- **Dependencies:** Cron infrastructure, `email.ts`
- **Complexity:** S

### N-07: Admin Alert — Booking Bumped

- **Description:** Notify admin when a non-member booking is bumped by member priority.
- **Acceptance Criteria:**
  - Email sent to admin when `bumpPendingBookings()` bumps one or more bookings
  - Includes: list of bumped bookings (member name, dates, guest count), triggering member booking details
  - One email per bump event (may contain multiple bumped bookings)
  - Fire-and-forget
  - New HTML template
- **Dependencies:** `bumping.ts`, `email.ts`
- **Complexity:** S

### N-08: Notification Preferences (Member)

- **Description:** Allow members to control which non-essential emails they receive.
- **Acceptance Criteria:**
  - New `NotificationPreference` model (or JSON field on Member) storing opt-in/out per category
  - Categories: `CHECK_IN_REMINDER`, `CHORE_ROSTER`, `BULK_COMMUNICATION`
  - Transactional emails (booking confirmed/cancelled/bumped, password reset) are always sent — no opt-out
  - UI: toggle switches on member profile page (`/profile`)
  - API: `GET/PUT /api/profile/notifications`
  - All non-essential email sends check preference before sending
  - Unsubscribe link in email footer for non-essential emails, linking to profile preferences
- **Dependencies:** Prisma schema change (migration), profile page, `email.ts`, all non-essential email send points
- **Complexity:** M

### N-09: Bulk Member Communication

- **Description:** Admin can send a broadcast email to all active members, or a filtered subset.
- **Acceptance Criteria:**
  - Admin UI page at `/admin/communications` (or similar)
  - Compose form: subject, rich-text body (or markdown), recipient filter (all members, members with upcoming bookings, members by subscription status)
  - Preview before sending
  - Sends via existing SES transport, rate-limited to avoid SES throttling (e.g., 10/sec)
  - Tracks send count and any failures
  - Respects `BULK_COMMUNICATION` notification preference (N-08)
  - Wraps content in existing branded email layout
  - Audit log entry for each bulk send
- **Dependencies:** N-08 (preferences), `email.ts`, `email-templates.ts`, `audit.ts`, new admin page
- **Complexity:** L

### N-10: Email Delivery Tracking

- **Description:** Track email send attempts and outcomes for debugging and audit.
- **Acceptance Criteria:**
  - New `EmailLog` model: `id`, `to`, `subject`, `templateName`, `status` (SENT/FAILED), `error` (nullable), `bookingId` (nullable), `memberId` (nullable), `createdAt`
  - `sendEmail()` in `email.ts` writes a log entry on every send attempt
  - Admin UI: viewable at `/admin/email-log` (or tab on existing admin page) with filters by status, date, recipient
  - Retention: auto-cleanup of logs older than 90 days (cron)
- **Dependencies:** Prisma schema change (migration), `email.ts`, new admin page
- **Complexity:** M

### N-11: Email Retry on Failure

- **Description:** Retry failed email sends with exponential backoff.
- **Acceptance Criteria:**
  - `sendEmail()` retries up to 3 times on transient failures (network errors, SES throttling) with exponential backoff (1s, 2s, 4s)
  - Permanent failures (invalid address, SES rejection) are not retried
  - Each attempt logged in `EmailLog` (N-10)
  - Final failure logged with error detail
  - Does not block the calling operation (fire-and-forget with retry handled async)
- **Dependencies:** N-10 (email logging), `email.ts`
- **Complexity:** S

### N-12: Post-Stay Feedback Request

- **Description:** Send a feedback request email after checkout, asking members about their stay.
- **Acceptance Criteria:**
  - Cron job (daily) finds CONFIRMED bookings where `checkOut` = yesterday
  - Sends email with a link to a simple feedback form or external survey URL (configurable via env var)
  - Skips CANCELLED/BUMPED bookings
  - Respects notification preferences (new category: `POST_STAY_FEEDBACK`)
  - Track `feedbackRequestSentAt` on Booking to prevent duplicates
  - New HTML template
- **Dependencies:** N-08 (preferences), cron infrastructure, `email.ts`, Prisma schema change (field on Booking)
- **Complexity:** S

### N-13: Admin Digest Email

- **Description:** Daily summary email to admin with key operational metrics.
- **Acceptance Criteria:**
  - Sent daily (e.g., 8 AM NZST) to `ADMIN_NOTIFICATION_EMAIL`
  - Includes: bookings created yesterday, bookings checking in today, current occupancy for next 7 days, any payment failures in last 24h, pending bookings approaching deadline
  - Single consolidated email (reduces admin alert fatigue from N-02 through N-07)
  - Configurable: admin can choose real-time alerts (N-02 to N-07) vs digest-only vs both (env var or admin setting)
  - New HTML template
- **Dependencies:** N-02 through N-07 (can be built independently, but conceptually replaces some), `capacity.ts`, `email.ts`, cron infrastructure
- **Complexity:** M

---

## Summary

| ID | Feature | Complexity |
|----|---------|------------|
| N-01 | Check-in reminder | S |
| N-02 | Admin alert: new booking | S |
| N-03 | Admin alert: capacity warning | M |
| N-04 | Admin alert: payment failure | S |
| N-05 | Admin alert: Xero sync errors | M |
| N-06 | Admin alert: pending approaching deadline | S |
| N-07 | Admin alert: booking bumped | S |
| N-08 | Notification preferences | M |
| N-09 | Bulk member communication | L |
| N-10 | Email delivery tracking | M |
| N-11 | Email retry on failure | S |
| N-12 | Post-stay feedback request | S |
| N-13 | Admin digest email | M |

**Totals:** 6x S, 5x M, 1x L, 0x XL

---


**Date:** 2026-04-05
**Scope:** Operational tools for admin: subscription/payment tracking, audit log viewer, report export

---

## 1. Subscription Tracking UI

### 1a. Subscription Overview Page

- **Description:** New admin page at `/admin/subscriptions` showing all members' subscription statuses for the current (or selected) season year. Summary cards at top (total paid, unpaid, overdue counts). Table of members with subscription status, sortable and filterable.
- **Acceptance criteria:**
  - Page accessible at `/admin/subscriptions`, admin-only
  - Summary cards: total members, paid count, unpaid count, overdue count for selected season year
  - Season year selector (defaults to current season year per April–March logic)
  - Table columns: member name, email, age tier, subscription status, paid date, Xero invoice ID
  - Filter by status (ALL / PAID / UNPAID / OVERDUE)
  - Search by member name or email
  - Rows link to member detail (`/admin/members/[id]`)
  - Empty state when no subscriptions exist for selected season
- **Dependencies:** `MemberSubscription` model (exists), `Member` model (exists), admin layout (exists)
- **Complexity:** M

### 1b. Subscription Status API

- **Description:** New API endpoint `GET /api/admin/subscriptions` returning subscription data with filtering and season year selection. Joins Member + MemberSubscription.
- **Acceptance criteria:**
  - Query params: `seasonYear` (int), `status` (optional filter), `search` (optional text)
  - Returns member info + subscription status for each member
  - Members without a MemberSubscription row for the selected season show as UNPAID
  - Admin-only auth check
  - Zod-validated query params
- **Dependencies:** `MemberSubscription` model, `Member` model, auth helper
- **Complexity:** M

### 1c. Sidebar Navigation Entry

- **Description:** Add "Subscriptions" entry to admin sidebar between "Members" and "Seasons".
- **Acceptance criteria:**
  - New nav item with appropriate icon (e.g. `CreditCard` or `BadgeCheck` from lucide)
  - Active state highlights correctly
  - Renders on both desktop and mobile sidebar
- **Dependencies:** `src/components/admin-sidebar.tsx`
- **Complexity:** S

---

## 2. Payment Tracking UI

### 2a. Payments List Page

- **Description:** New admin page at `/admin/payments` showing all payment records across bookings. Provides a single view of all financial transactions (charges, refunds, failed payments) without needing to drill into individual bookings.
- **Acceptance criteria:**
  - Page accessible at `/admin/payments`, admin-only
  - Summary cards: total collected (succeeded), total refunded, total pending, failed count
  - Table columns: date, booking ID (linked), member name, amount, status, refund amount, Stripe PI ID, Xero invoice ID
  - Filter by payment status (ALL / PENDING / PROCESSING / SUCCEEDED / FAILED / REFUNDED / PARTIALLY_REFUNDED)
  - Date range filter
  - Search by member name, email, or Stripe PI ID
  - Sort by date (default desc), amount, status
  - Pagination (25 per page)
- **Dependencies:** `Payment` model (exists), `Booking` model (exists), `Member` model (exists)
- **Complexity:** L

### 2b. Payments API

- **Description:** New API endpoint `GET /api/admin/payments` returning paginated payment records with joins to booking and member.
- **Acceptance criteria:**
  - Query params: `status`, `from`, `to`, `search`, `page`, `pageSize`, `sortBy`, `sortOrder`
  - Returns payment fields + booking checkIn/checkOut + member name/email
  - Summary stats computed server-side (total collected, refunded, pending, failed count)
  - Admin-only auth check
  - Zod-validated query params
- **Dependencies:** `Payment` model, `Booking` model, `Member` model
- **Complexity:** M

### 2c. Sidebar Navigation Entry

- **Description:** Add "Payments" entry to admin sidebar after "Bookings".
- **Acceptance criteria:**
  - New nav item with `DollarSign` icon from lucide
  - Active state highlights correctly
- **Dependencies:** `src/components/admin-sidebar.tsx`
- **Complexity:** S

---

## 3. Audit Log Viewer

### 3a. Audit Log Page

- **Description:** New admin page at `/admin/audit-log` displaying the `AuditLog` table with filtering and search. Provides visibility into sensitive actions (booking cancellations, season changes, promo code changes, policy updates).
- **Acceptance criteria:**
  - Page accessible at `/admin/audit-log`, admin-only
  - Table columns: timestamp, action, actor (member name or "System"), target ID, details (expandable), IP address
  - Filter by action type (dropdown of distinct action values, e.g. `booking.cancel`, `season.create`, `promoCode.update`, etc.)
  - Date range filter
  - Search by actor name/email or target ID
  - Details column: truncated by default, click to expand full JSON
  - Pagination (50 per page)
  - Sort by timestamp desc (default)
  - Actor column resolves `memberId` to member name via join (graceful fallback if member deleted)
- **Dependencies:** `AuditLog` model (exists, no FK — memberId is plain string), `Member` model for name resolution
- **Complexity:** L

### 3b. Audit Log API

- **Description:** New API endpoint `GET /api/admin/audit-log` returning paginated audit log entries with optional actor name resolution.
- **Acceptance criteria:**
  - Query params: `action`, `from`, `to`, `search`, `page`, `pageSize`
  - Resolves `memberId` to member name where member still exists (left join or secondary lookup)
  - Returns entries sorted by `createdAt` desc
  - Admin-only auth check
  - Zod-validated query params
  - Returns list of distinct action values for filter dropdown
- **Dependencies:** `AuditLog` model, `Member` model
- **Complexity:** M

### 3c. Sidebar Navigation Entry

- **Description:** Add "Audit Log" entry to admin sidebar after "Reports".
- **Acceptance criteria:**
  - New nav item with `ScrollText` or `FileText` icon from lucide
  - Active state highlights correctly
- **Dependencies:** `src/components/admin-sidebar.tsx`
- **Complexity:** S

---

## 4. Report Export

### 4a. CSV Export Button on Reports Page

- **Description:** Add a "Download CSV" button to the existing reports page that exports the currently displayed data (summary + all chart datasets) as a CSV file. Client-side generation from already-fetched data.
- **Acceptance criteria:**
  - Button visible next to the date range controls
  - Exports a single CSV file with multiple sections separated by blank rows:
    - Section 1: Summary (Total Bookings, Revenue, Guests, Avg Occupancy, Member Guests, Non-Member Guests)
    - Section 2: Status Breakdown (Confirmed, Completed, Pending, Cancelled, Bumped)
    - Section 3: Occupancy by Date (date, occupied beds, available beds, occupancy rate %)
    - Section 4: Revenue by Month (month, revenue, booking count)
    - Section 5: Booking Trends by Week (week, total, confirmed, cancelled, bumped, pending)
  - Revenue values exported in dollars (not cents) with 2 decimal places
  - Filename: `tac-reports-{from}-to-{to}.csv`
  - Download triggers via browser Blob/URL.createObjectURL (no server round-trip)
  - Button disabled when no data is loaded
- **Dependencies:** Existing reports page (`src/app/(admin)/admin/reports/page.tsx`), existing `ReportData` interface
- **Complexity:** S

### 4b. PDF Export Button on Reports Page

- **Description:** Add a "Download PDF" button that generates a printable PDF of the reports dashboard using the browser's print-to-PDF capability with a print-optimized stylesheet.
- **Acceptance criteria:**
  - Button visible next to CSV export button
  - Triggers `window.print()` with print-specific CSS (`@media print`)
  - Print stylesheet: hides date picker / buttons, renders charts at fixed width, forces white background, page breaks between chart sections
  - Charts render at readable size in print (min 600px width)
  - Page title includes date range
- **Dependencies:** Existing reports page, recharts (renders to SVG, prints natively)
- **Complexity:** M

---

## 5. Admin Dashboard Hydration

### 5a. Fix Stubbed Admin Dashboard

- **Description:** The admin dashboard at `/admin/dashboard` currently has `totalBookings` hardcoded to `0`. Replace with real database queries to show live summary stats.
- **Acceptance criteria:**
  - Total members count (active only)
  - Active members count (with PAID subscription for current season)
  - Total bookings (all time, excludes CANCELLED/BUMPED)
  - Upcoming bookings (CONFIRMED with checkIn >= today)
  - Revenue this month (sum of finalPriceCents for CONFIRMED/COMPLETED bookings created this month)
  - Occupancy today (guests in confirmed bookings where today is between checkIn and checkOut)
  - All values fetched server-side (server component or API call)
  - No hardcoded values remain
- **Dependencies:** `src/app/(admin)/admin/dashboard/page.tsx` (exists, stubbed), Prisma models
- **Complexity:** M

### 5b. Fix Stubbed Member Dashboard

- **Description:** The member dashboard at `/dashboard` has hardcoded "Upcoming Bookings" count and static placeholder for "Recent Bookings". Replace with real queries.
- **Acceptance criteria:**
  - Upcoming bookings count (CONFIRMED/PENDING with checkIn >= today for current user)
  - Recent bookings list (last 5 bookings for current user, showing dates, status, guest count)
  - Each booking links to `/bookings/[id]`
  - No hardcoded values remain
- **Dependencies:** `src/app/(authenticated)/dashboard/page.tsx` (exists, stubbed), Prisma models
- **Complexity:** S

---

## Summary

| # | Feature | Complexity |
|---|---------|------------|
| 1a | Subscription overview page | M |
| 1b | Subscription status API | M |
| 1c | Sidebar entry (Subscriptions) | S |
| 2a | Payments list page | L |
| 2b | Payments API | M |
| 2c | Sidebar entry (Payments) | S |
| 3a | Audit log page | L |
| 3b | Audit log API | M |
| 3c | Sidebar entry (Audit Log) | S |
| 4a | CSV export on reports page | S |
| 4b | PDF export on reports page | M |
| 5a | Fix stubbed admin dashboard | M |
| 5b | Fix stubbed member dashboard | S |

**Total: 13 features** (4S, 6M, 2L, 0XL)

---


**Date:** 2026-04-05
**Status:** Draft
**Context:** All errors currently go to Docker container stdout/stderr via `console.*` calls (~85 occurrences across `src/lib/` and `src/app/api/`). No error aggregation, no alerting, no structured logging, no APM. Error boundaries (`error.tsx`, `global-error.tsx`) only `console.error` to the browser. Cron jobs log to stdout with no persistence or failure alerting. The only health check is Docker's `wget` liveness probe on port 3000.

---

## OBS-01: Sentry Server-Side Integration

**Description:** Install `@sentry/nextjs` and configure server-side error capture for all API routes, server components, and library code. Replace bare `console.error` calls in catch blocks with Sentry capture while preserving console output for Docker logs.

**Acceptance Criteria:**
- `@sentry/nextjs` installed and initialised via `sentry.server.config.ts`
- DSN, environment (`production`/`development`), and release version configured via env vars
- Source maps uploaded to Sentry during Docker build
- Unhandled exceptions in API routes and server components automatically reported
- All existing `catch` blocks in `src/app/api/` and `src/lib/` call `Sentry.captureException()` alongside `console.error`
- Sensitive data (passwords, tokens, Stripe keys) scrubbed from Sentry payloads via `beforeSend`
- `instrumentation.ts` calls `Sentry.init()` for the Node runtime

**Dependencies:** Sentry account + DSN
**Complexity:** M

---

## OBS-02: Sentry Client-Side Integration

**Description:** Configure Sentry browser SDK to capture client-side React errors. Wire into Next.js error boundaries so unhandled UI errors are reported with error digest correlation.

**Acceptance Criteria:**
- `sentry.client.config.ts` initialised with DSN and environment
- `global-error.tsx` and `error.tsx` call `Sentry.captureException(error)` instead of only `console.error`
- `error.digest` attached as Sentry tag for server/client error correlation
- Session replay or breadcrumbs enabled for error context
- Client bundle size impact < 30KB gzipped

**Dependencies:** OBS-01 (shared DSN/project)
**Complexity:** S

---

## OBS-03: Sentry Cron Monitoring

**Description:** Register the 3 node-cron jobs (pending booking confirmation, Xero membership refresh, database backup) as Sentry Cron Monitors. Send check-in/check-out signals so Sentry alerts on missed or failed runs.

**Acceptance Criteria:**
- Each cron job in `instrumentation.ts` wrapped with `Sentry.withMonitor(slug, fn, schedule)`
- Monitor slugs: `confirm-pending-bookings`, `xero-membership-refresh`, `database-backup`
- Sentry alerts if a scheduled run is missed (no check-in within expected window)
- Sentry alerts if a run reports failure (exception during execution)
- Check-in includes duration metric

**Dependencies:** OBS-01
**Complexity:** S

---

## OBS-04: Structured Logging

**Description:** Replace raw `console.*` calls with a structured JSON logger (e.g. `pino`) that includes level, timestamp, and contextual metadata. Ensures Docker log aggregation tools can parse and filter logs.

**Acceptance Criteria:**
- Logger instance exported from `src/lib/logger.ts`
- Log levels: `debug`, `info`, `warn`, `error`, `fatal`
- Output format: JSON with `level`, `time`, `msg`, plus arbitrary context fields
- All ~85 existing `console.log`/`console.error`/`console.warn` calls in `src/lib/` and `src/app/api/` replaced with logger calls
- Cron job logs include `job` field (e.g. `{ job: "confirm-pending", confirmed: 3, bumped: 1 }`)
- Log level configurable via `LOG_LEVEL` env var (default: `info` in production, `debug` in development)
- No `console.*` calls remain in `src/lib/` or `src/app/api/` (enforced by lint rule)

**Dependencies:** None
**Complexity:** M

---

## OBS-05: API Route Request Logging

**Description:** Log every API request with method, path, response status, and duration. Provides visibility into traffic patterns and slow endpoints without full APM.

**Acceptance Criteria:**
- Every API response logged as structured JSON: `{ method, path, status, durationMs, ip }`
- Implemented as a shared wrapper or middleware applied to all `src/app/api/` routes
- Auth endpoints log without including credentials
- Webhook endpoints log event type and processing result
- Requests returning 4xx/5xx logged at `warn`/`error` level respectively
- Duration measured from request start to response send

**Dependencies:** OBS-04 (logger)
**Complexity:** M

---

## OBS-06: System Health Endpoint

**Description:** Add `GET /api/health` that checks connectivity to all critical dependencies and returns structured status. Used by uptime monitors and admin dashboard.

**Acceptance Criteria:**
- Returns JSON: `{ status: "healthy"|"degraded"|"unhealthy", version, uptime, checks: {...} }`
- Checks: PostgreSQL (`SELECT 1`), Stripe API (key validation), Xero connection status, SMTP connectivity
- Each check returns `{ status: "ok"|"error", latencyMs, error? }`
- Overall status is `healthy` if all pass, `degraded` if non-critical fail (Xero/SMTP), `unhealthy` if DB or app error
- Responds within 5 seconds (individual check timeouts at 3s)
- No authentication required (for external monitors), but does not expose sensitive details
- Returns HTTP 200 for healthy/degraded, 503 for unhealthy

**Dependencies:** None
**Complexity:** S

---

## OBS-07: Admin Health Dashboard

**Description:** Add `/admin/health` page showing live integration status, recent errors, cron job history, and system metrics. Single pane of glass for the admin.

**Acceptance Criteria:**
- Page at `/admin/health` behind admin auth guard
- Displays results from `/api/health` endpoint with colour-coded status indicators
- Shows last 5 cron job runs with status and duration (from OBS-09 data)
- Shows webhook success/failure counts for last 24h (from OBS-08 data)
- Shows recent Sentry errors (count + link to Sentry dashboard) or last 10 errors from local log
- Auto-refreshes every 60 seconds
- Displays app version, Node version, uptime, memory usage

**Dependencies:** OBS-06, OBS-08, OBS-09
**Complexity:** L

---

## OBS-08: Webhook Delivery Monitoring

**Description:** Track and persist Stripe and Xero webhook processing metrics (success, failure, latency) so issues are visible before they become critical.

**Acceptance Criteria:**
- Each webhook invocation records: `{ source, eventType, eventId, status, durationMs, error?, timestamp }`
- Data stored in a new `WebhookLog` Prisma model (or appended to `ProcessedWebhookEvent`)
- Success/failure counts queryable by source and time range
- Failed webhooks logged at `error` level with event details
- Admin can view webhook history via OBS-07 dashboard
- Old records auto-pruned after 30 days

**Dependencies:** OBS-04 (logger), Prisma schema update
**Complexity:** M

---

## OBS-09: Cron Job Status Tracking

**Description:** Persist execution metadata for each cron job run so admins can see history and detect silent failures.

**Acceptance Criteria:**
- Each cron run records: `{ jobName, startedAt, completedAt, durationMs, status, resultSummary, error? }`
- Data stored in a new `CronJobRun` Prisma model
- `instrumentation.ts` updated to persist records after each run
- Admin dashboard (OBS-07) shows last 5 runs per job
- Old records auto-pruned after 90 days

**Dependencies:** Prisma schema update
**Complexity:** S

---

## OBS-10: Performance Monitoring (Sentry Tracing)

**Description:** Enable Sentry performance tracing to measure API route latency, DB query duration, and external service call times. Identifies bottlenecks without separate APM tooling.

**Acceptance Criteria:**
- `tracesSampleRate` configured (e.g. 0.2 in production, 1.0 in development)
- API routes automatically instrumented (Next.js integration handles this)
- Prisma queries traced via `@sentry/prisma` integration or manual spans
- Stripe and Xero HTTP calls captured as child spans
- Slow transactions (>2s) flagged in Sentry
- No measurable performance degradation (< 5ms overhead per request)

**Dependencies:** OBS-01
**Complexity:** M

---

## OBS-11: Alerting Rules

**Description:** Configure Sentry alert rules so the admin is notified of critical issues via email (and optionally Slack) without needing to check dashboards.

**Acceptance Criteria:**
- Alert: new unhandled exception (first occurrence) -> email to admin
- Alert: error spike (>10 events in 5 minutes) -> email to admin
- Alert: cron monitor missed or failed (from OBS-03) -> email to admin
- Alert: webhook failure rate >20% in 15 minutes -> email to admin
- All alerts include error message, URL/route, and link to Sentry issue
- Alert recipients configurable in Sentry project settings
- Documented in runbook: what each alert means and initial triage steps

**Dependencies:** OBS-01, OBS-03
**Complexity:** S

---

## OBS-12: Uptime Monitoring

**Description:** Configure external uptime monitoring that pings the health endpoint and alerts on downtime. Catches scenarios where the entire container or instance is down (which Sentry cannot detect).

**Acceptance Criteria:**
- External service (UptimeRobot free tier, Sentry Uptime, or similar) pings `GET /api/health` every 60 seconds
- Alert sent if endpoint is unreachable or returns 503 for 2 consecutive checks
- Alert via email to admin
- Public status page optional but not required
- Health endpoint (OBS-06) must be deployed first

**Dependencies:** OBS-06, external monitoring account
**Complexity:** S

---

## OBS-13: Log Retention and Rotation

**Description:** Configure Docker log rotation to prevent disk exhaustion on the single Lightsail instance. Optionally forward logs to CloudWatch or S3 for long-term retention.

**Acceptance Criteria:**
- Docker Compose `logging` config added for all 3 services: `json-file` driver with `max-size: 10m`, `max-file: 5`
- Total log disk usage capped at ~150MB (3 services x 5 files x 10MB)
- Optional: CloudWatch Logs agent or `docker log-driver=awslogs` for production log forwarding
- Optional: log shipping to S3 for archival (reuse existing backup S3 bucket)
- Log format compatible with structured logging from OBS-04

**Dependencies:** None (OBS-04 recommended for structured format)
**Complexity:** S

---

## Complexity Summary

| ID | Feature | Complexity |
|----|---------|-----------|
| OBS-01 | Sentry server-side | M |
| OBS-02 | Sentry client-side | S |
| OBS-03 | Sentry cron monitoring | S |
| OBS-04 | Structured logging | M |
| OBS-05 | API request logging | M |
| OBS-06 | Health endpoint | S |
| OBS-07 | Admin health dashboard | L |
| OBS-08 | Webhook monitoring | M |
| OBS-09 | Cron job tracking | S |
| OBS-10 | Performance monitoring | M |
| OBS-11 | Alerting rules | S |
| OBS-12 | Uptime monitoring | S |
| OBS-13 | Log retention/rotation | S |

**Total:** 1 Large, 4 Medium, 8 Small

---


## Privacy Compliance

### F-COMP-01: Privacy Policy Page

**Description:** Public page displaying TAC's privacy policy covering data collection, use, storage, and member rights under NZ Privacy Act 2020.

**Acceptance Criteria:**
- Accessible at `/privacy` without authentication
- Covers: what data is collected, why, how it's stored, who it's shared with (Stripe, Xero, AWS SES), retention periods, member rights
- References NZ Privacy Act 2020 and the 13 Information Privacy Principles
- Includes contact details for the club privacy officer
- Linked from site footer on all pages
- Linked from registration page before account creation

**Dependencies:** None

**Complexity:** S

---

### F-COMP-02: Terms of Service Page

**Description:** Public page displaying TAC's terms of service covering booking rules, payment terms, cancellation policy summary, liability, and acceptable use.

**Acceptance Criteria:**
- Accessible at `/terms` without authentication
- Covers: eligibility, booking rules, payment and refund terms, member conduct, liability limitations, account termination
- References the cancellation policy (links to relevant section or summarises tiers)
- Includes effective date and last-updated date
- Linked from site footer on all pages
- Linked from registration page; registration requires implicit acceptance (checkbox or "by registering you agree" text)

**Dependencies:** None

**Complexity:** S

---

### F-COMP-03: Personal Data Export

**Description:** Members can download a machine-readable export of all personal data the system holds about them.

**Acceptance Criteria:**
- Available from the member profile page via a "Download My Data" button
- Export is JSON format
- Includes: profile info (name, email, phone, DOB), all bookings (with guests, payments, promo redemptions), chore assignments, subscription status, audit log entries where they are the actor or target
- Excludes: password hash, internal IDs not meaningful to the user, other members' data
- File is generated on-demand and downloaded directly (no email)
- Rate limited to prevent abuse (max 5 exports per day)
- Response includes `Content-Disposition: attachment` header with filename `tac-my-data-YYYY-MM-DD.json`

**Dependencies:** Profile page (Phase 1), Bookings (Phase 3), Payments (Phase 4), Chore assignments (Phase 8)

**Complexity:** M

---

### F-COMP-04: Account Deletion Workflow

**Description:** Members can request account deletion; admin reviews and approves; personal data is purged or anonymised.

**Acceptance Criteria:**
- Member clicks "Request Account Deletion" on their profile page
- Member must confirm with a modal/dialog explaining consequences (bookings cancelled, data purged, action irreversible)
- Request is recorded in the database with status PENDING, timestamp, and reason (optional free-text)
- Admin sees pending deletion requests on a dedicated admin page (`/admin/deletion-requests`)
- Admin can approve or reject each request with an optional note
- On approval:
  - All future bookings for the member are cancelled (with refunds per cancellation policy)
  - Member profile fields are anonymised (name -> "Deleted Member", email -> random@deleted.invalid, phone/DOB cleared)
  - Password hash is cleared, account is deactivated (cannot log in)
  - Booking history is retained with anonymised member reference (for financial/audit integrity)
  - Payments and Xero invoice references are retained (legal/tax requirement)
  - Chore assignments are retained with anonymised guest names
  - Audit log entry is created recording the deletion
  - Member receives a confirmation email before anonymisation that their request was processed
- On rejection: member is notified by email with the admin's note
- Members with ADMIN role cannot request self-deletion (must be removed by another admin)

**Dependencies:** Profile page (Phase 1), Booking cancellation (Phase 4/5), Email (Phase 1), Admin layout (Phase 1), Audit log (Security Audit)

**Complexity:** XL

---

## Public Pages

### F-PUB-01: Committee Page Content

**Description:** Replace placeholder content on the committee page with actual committee member information.

**Acceptance Criteria:**
- Displays committee roles and member names (President, Vice President, Treasurer, Secretary, Hut Convenor, and any other roles)
- Each entry shows: role title, name, and optional contact email
- Content is admin-editable or stored in a config/data file (not hardcoded in JSX) so committee changes don't require a code deploy
- Falls back gracefully if no committee data is configured (shows "Committee information coming soon" rather than broken layout)
- Page is publicly accessible without authentication

**Dependencies:** None

**Complexity:** M

---

### F-PUB-02: Join Page with Fee Information

**Description:** Replace placeholder content on the join/membership page with actual membership categories, fees, benefits, and a clear call-to-action.

**Acceptance Criteria:**
- Displays all membership categories with annual fees: Adult, Youth, Child (and Family if applicable)
- Fee amounts are pulled from a config/data source (not hardcoded) so they can be updated without code changes
- Describes benefits of membership (priority booking, member rates, lodge access, etc.)
- Includes a clear "Register" or "Join Now" CTA linking to the registration page
- Explains the membership year (April-March cycle)
- Mentions how payment works (Xero invoice / payment instructions)
- Page is publicly accessible without authentication

**Dependencies:** Registration page (Phase 1)

**Complexity:** M

---

### F-PUB-03: Contact Page Content

**Description:** Replace placeholder content on the contact page with actual club contact information.

**Acceptance Criteria:**
- Displays: club mailing address, general enquiry email, phone number (if applicable)
- Includes a simple contact form (name, email, message) that sends an email to the club's configured address
- Contact form has validation (required fields, valid email format) and rate limiting (max 10 submissions per IP per hour)
- Shows a success message after submission
- Optionally includes lodge location/directions (address, map link, or embedded map)
- Page is publicly accessible without authentication

**Dependencies:** Email utility (Phase 1)

**Complexity:** M

---

### F-PUB-04: FAQ Page

**Description:** New public page with frequently asked questions about the lodge, bookings, membership, and general club info.

**Acceptance Criteria:**
- Accessible at `/faq` without authentication
- Accordion/collapsible UI for question-answer pairs
- Covers at minimum:
  - How do I book a stay?
  - What is the cancellation policy?
  - What are the nightly rates?
  - Do I need to be a member to stay?
  - What is the non-member priority/bumping system?
  - What facilities does the lodge have?
  - What should I bring?
  - How do chore rosters work?
  - How do I become a member?
  - How do I reset my password?
- FAQ content is stored in a config/data file (not hardcoded in JSX) for easy updates
- Linked from site footer and navigation
- Linked from relevant pages contextually (e.g., booking page links to "cancellation policy" FAQ)

**Dependencies:** None

**Complexity:** M

---

## Summary

| ID | Feature | Complexity |
|----|---------|------------|
| F-COMP-01 | Privacy Policy Page | S |
| F-COMP-02 | Terms of Service Page | S |
| F-COMP-03 | Personal Data Export | M |
| F-COMP-04 | Account Deletion Workflow | XL |
| F-PUB-01 | Committee Page Content | M |
| F-PUB-02 | Join Page with Fee Information | M |
| F-PUB-03 | Contact Page Content | M |
| F-PUB-04 | FAQ Page | M |

**Total: 2S + 5M + 1XL**
