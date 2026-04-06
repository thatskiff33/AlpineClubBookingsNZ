# 02 - Booking Modifications & Cancellation Requirements

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
