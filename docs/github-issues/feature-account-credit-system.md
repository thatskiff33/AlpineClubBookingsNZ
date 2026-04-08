## Summary

When cancelling a booking, give members the option to hold the refund amount as **account credit** instead of refunding to their card. Credits can then be applied to future bookings before any remaining balance goes to Stripe for payment.

**Approach:** Hybrid — local database ledger as primary source for fast lookups, with periodic Xero reconciliation to ensure consistency.

---

## Background

Currently, cancellation refunds are always processed back to the original Stripe payment method. The club wants to offer members the choice to keep the refund as credit for future stays. This is especially useful for members who cancel due to weather but plan to rebook.

When a member has credit, it should be applied automatically (with their confirmation) before creating a Stripe PaymentIntent for any remaining balance.

---

## Implementation Plan

### 1. Prisma Model: `MemberCredit`

```prisma
model MemberCredit {
  id                  String   @id @default(cuid())
  memberId            String
  member              Member   @relation(fields: [memberId], references: [id])
  amountCents         Int                              // Positive = credit added, negative = credit used
  type                CreditType                       // CANCELLATION_REFUND | ADMIN_ADJUSTMENT | BOOKING_APPLIED
  description         String                           // Human-readable reason
  sourceBookingId     String?                          // Booking that generated the credit (cancellation)
  sourceBooking       Booking? @relation("CreditSource", fields: [sourceBookingId], references: [id])
  appliedToBookingId  String?                          // Booking where credit was spent
  appliedToBooking    Booking? @relation("CreditApplied", fields: [appliedToBookingId], references: [id])
  xeroCreditNoteId    String?                          // Linked Xero credit note ID
  createdAt           DateTime @default(now())

  @@index([memberId])
  @@index([sourceBookingId])
  @@index([appliedToBookingId])
}

enum CreditType {
  CANCELLATION_REFUND
  ADMIN_ADJUSTMENT
  BOOKING_APPLIED
}
```

### 2. Credit Balance Helper: `src/lib/member-credit.ts`

```typescript
// Get member's available credit balance (sum of all credit entries)
export async function getMemberCreditBalance(memberId: string): Promise<number>

// Create a credit entry for cancellation refund
export async function createCancellationCredit(
  memberId: string, amountCents: number, bookingId: string, xeroCreditNoteId?: string
): Promise<MemberCredit>

// Apply credit to a booking (creates negative entry)
export async function applyCreditToBooking(
  memberId: string, amountCents: number, bookingId: string
): Promise<MemberCredit>

// Get credit history for a member
export async function getMemberCreditHistory(memberId: string): Promise<MemberCredit[]>
```

### 3. Cancellation Flow Changes

**Update `src/components/cancel-booking-button.tsx`:**
- In the cancel preview step (QF-1), add refund method choice:
  - Radio: "Refund $XX.XX to original payment method" (default)
  - Radio: "Hold $XX.XX as account credit for future bookings"
- Pass `refundMethod: "card" | "credit"` to cancel API

**Update `src/lib/booking-cancel.ts`:**
- Accept new `refundMethod` parameter in `cancelBooking()`
- If `"credit"`:
  - Skip Stripe refund entirely
  - Create `MemberCredit` record (type: CANCELLATION_REFUND)
  - Create Xero credit note (unapplied — do NOT allocate against invoice or create cash refund)
  - Store `xeroCreditNoteId` on MemberCredit record
  - Send cancellation email with "Credit of $XX.XX added to your account" message
- If `"card"`: existing flow (Stripe refund + Xero credit note + allocation + cash refund)

**Update cancel API routes:**
- Accept optional `refundMethod` in POST body (default: "card" for backward compatibility)

### 4. Booking Creation Flow Changes

**Update `src/app/api/bookings/route.ts`:**
- After price calculation, before Stripe PaymentIntent:
  1. Check `getMemberCreditBalance(memberId)`
  2. If credits available and booking is CONFIRMED (not PENDING):
     - Return credit info in quote/response for UI to display
  3. Accept `applyCreditCents` in booking creation request
  4. If `applyCreditCents > 0`:
     - Validate: `applyCreditCents <= creditBalance` and `applyCreditCents <= finalPriceCents`
     - Create `MemberCredit` record (type: BOOKING_APPLIED, negative amount)
     - If credit covers full amount: skip Stripe entirely (like $0 bookings)
     - If partial: create PaymentIntent for `finalPriceCents - applyCreditCents`
     - Allocate Xero credit note against new booking's invoice

**Update booking wizard (`src/app/(authenticated)/book/page.tsx`):**
- After guest entry / price display, if member has credits:
  - Show: "You have $XX.XX in account credit"
  - Toggle: "Apply credit to this booking"
  - If partial: "Credit: -$XX.XX / Remaining: $YY.YY (pay by card)"
  - If full: "Credit covers entire booking — no card payment needed"

### 5. Xero Integration

**When credit is created (cancellation with credit option):**
- Create Xero credit note (AUTHORISED) but do NOT allocate against the cancelled booking's invoice
- The credit note stays as an open credit in Xero
- Store `xeroCreditNoteId` on `MemberCredit` record

**When credit is applied (future booking):**
- Find the member's unallocated Xero credit notes
- Allocate against the new booking's Xero invoice using `createCreditNoteAllocation()`
- If credit partially used: allocate the used portion only

**Daily reconciliation cron:**
- Query Xero for member's remaining credit note balances
- Compare against local `MemberCredit` ledger balance
- If discrepancy > threshold: create admin alert
- Log reconciliation results

### 6. Admin Features

**Member detail page (`src/app/(admin)/admin/members/[id]/page.tsx`):**
- New "Account Credit" section showing balance and transaction history
- Admin can add manual adjustments (positive or negative) with reason

**Admin API:**
- `GET /api/admin/members/[id]/credits` — credit history
- `POST /api/admin/members/[id]/credits` — manual adjustment (admin only)

### 7. Profile Page

**Update `src/app/(authenticated)/profile/page.tsx`:**
- New "Account Credit" card showing:
  - Current balance
  - Transaction history (date, type, amount, booking reference)

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `prisma/schema.prisma` | MODIFY — add MemberCredit model, CreditType enum |
| `src/lib/member-credit.ts` | NEW — credit balance helpers |
| `src/app/api/member/credit-balance/route.ts` | NEW — member credit balance API |
| `src/app/api/admin/members/[id]/credits/route.ts` | NEW — admin credit management |
| `src/components/cancel-booking-button.tsx` | MODIFY — add credit option in preview |
| `src/lib/booking-cancel.ts` | MODIFY — accept refundMethod, implement credit path |
| `src/app/api/bookings/[id]/cancel/route.ts` | MODIFY — pass refundMethod from body |
| `src/app/api/bookings/route.ts` | MODIFY — credit application in booking creation |
| `src/lib/xero.ts` | MODIFY — unapplied credit note creation, credit note allocation for applied credits |
| `src/app/(authenticated)/book/page.tsx` | MODIFY — credit application in wizard |
| `src/app/(authenticated)/profile/page.tsx` | MODIFY — credit balance section |
| `src/app/(admin)/admin/members/[id]/page.tsx` | MODIFY — credit history in member detail |
| `src/lib/email-templates.ts` | MODIFY — credit-related email templates |
| `src/instrumentation.ts` | MODIFY — add daily credit reconciliation cron |
| `src/lib/__tests__/member-credit.test.ts` | NEW — credit system tests |

---

## Test Plan

- [ ] Cancel booking → choose "hold as credit" → verify MemberCredit record created → verify Xero credit note created (unapplied) → verify no Stripe refund
- [ ] Cancel booking → choose "refund to card" → verify existing flow unchanged
- [ ] Create new booking with member who has credit → verify credit option shown → apply credit → verify PaymentIntent reduced by credit amount
- [ ] Create booking where credit covers full amount → verify no Stripe charge → verify booking goes to PAID
- [ ] Admin: add manual credit adjustment → verify balance updated
- [ ] Profile page: verify credit balance and history displayed
- [ ] Xero reconciliation: verify cron detects balance discrepancy
- [ ] Run `npm test` and `npm run build`
