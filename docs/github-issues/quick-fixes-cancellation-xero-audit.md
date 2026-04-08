## Summary

Bundle of 4 quick fixes related to cancellation UX, Xero accounting bugs, and audit log usability.

- **QF-1**: Cancellation confirmation shows refund/kept amounts before confirming
- **QF-2**: Fix double Xero credit note creation on cancellation  
- **QF-3**: Add Xero cash refund against Stripe bank account for auto-reconciliation
- **QF-4**: Audit log entries link to referenced bookings/members/entities

---

## QF-1: Cancellation Confirmation UX

### Problem
`CancelBookingButton` (`src/components/cancel-booking-button.tsx`) shows only "Are you sure you want to cancel this booking?" with no information about refund amounts. After cancellation the page silently refreshes — no success message, no mention of refund processing or email confirmation.

### Solution

**1. New API endpoint: `GET /api/bookings/[id]/cancel-preview`**

Extract refund calculation from `cancelBooking()` in `src/lib/booking-cancel.ts` into a reusable helper `calculateCancelRefund(bookingId)` that returns:

```typescript
{
  refundAmountCents: number;    // Amount being refunded
  keptAmountCents: number;      // Amount kept (policy deduction)
  changeFeeCents: number;       // Non-refundable change fees
  refundPercentage: number;     // Policy tier percentage
  totalPaidCents: number;       // Original amount paid
  hasPayment: boolean;          // Whether a Stripe payment exists
}
```

Auth: booking owner or ADMIN only.

Reuse: `calculateRefundAmount()` from `src/lib/cancellation.ts`, `loadCancellationPolicy()`, `getRefundTier()`.

**2. Update `CancelBookingButton` component**

Replace the simple inline confirmation with a multi-step flow:

- **Step 1 (button)**: "Cancel Booking" button (existing)
- **Step 2 (preview)**: Fetch `/api/bookings/[id]/cancel-preview`, display:
  - "Refund to original payment method: **$XX.XX**"
  - "Amount kept per cancellation policy (X%): **$XX.XX**"  
  - If changeFeeCents > 0: "Change fees (non-refundable): **$XX.XX**"
  - For PENDING bookings with no payment: "No payment has been taken — no refund applies"
  - For $0 refund: "No refund applies per cancellation policy"
  - "Confirm Cancellation" and "Keep Booking" buttons
- **Step 3 (success)**: After cancellation succeeds, show green success banner:
  - If refund > 0: "Your refund of $XX.XX has been processed to your original payment method. You'll receive a confirmation email shortly."
  - If no refund: "Your booking has been cancelled. You'll receive a confirmation email shortly."

**3. Files to create/modify**

| File | Action |
|------|--------|
| `src/app/api/bookings/[id]/cancel-preview/route.ts` | NEW — cancel preview endpoint |
| `src/components/cancel-booking-button.tsx` | MODIFY — multi-step flow with preview |
| `src/lib/booking-cancel.ts` | MODIFY — extract `calculateCancelRefund()` helper |
| `src/lib/__tests__/cancel-preview.test.ts` | NEW — tests for preview endpoint and helper |

---

## QF-2: Fix Double Xero Credit Note

### Problem
When a booking is cancelled, `createXeroCreditNote()` is called from TWO locations:

1. **`src/lib/booking-cancel.ts`** (line ~177) — directly after Stripe refund succeeds
2. **`src/app/api/webhooks/stripe/route.ts`** (line ~438) — when `charge.refunded` webhook fires

Both calls create a credit note in Xero and allocate it against the same invoice, resulting in **2x credit notes** and double the accounting reduction. The webhook handler has event-level idempotency (`ProcessedWebhookEvent` table) but no check for whether a Xero credit note was already created for this payment.

### Root Cause
No tracking field on the `Payment` model records whether a Xero credit note has already been created. Both code paths independently create one.

### Solution

**1. Add tracking field to Payment model** (`prisma/schema.prisma`):
```prisma
model Payment {
  // ... existing fields ...
  xeroRefundCreditNoteId    String?   // Track Xero credit note to prevent duplicates
}
```

**2. Add idempotency guard in `createXeroCreditNote()`** (`src/lib/xero.ts`):
```typescript
// At the start of createXeroCreditNote():
const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
if (payment?.xeroRefundCreditNoteId) {
  logger.info({ paymentId }, "Xero credit note already exists, skipping");
  return payment.xeroRefundCreditNoteId;
}

// After successful creation:
await prisma.payment.update({
  where: { id: paymentId },
  data: { xeroRefundCreditNoteId: createdNote.creditNoteID },
});
```

**3. Add guard in webhook handler** (`src/app/api/webhooks/stripe/route.ts`):
Before calling `createXeroCreditNote()`, reload the payment and check `xeroRefundCreditNoteId`. If already set, skip and log.

**4. Files to modify**

| File | Action |
|------|--------|
| `prisma/schema.prisma` | MODIFY — add `xeroRefundCreditNoteId` to Payment |
| `src/lib/xero.ts` | MODIFY — add idempotency guard in `createXeroCreditNote()` |
| `src/app/api/webhooks/stripe/route.ts` | MODIFY — add guard before Xero call |
| `src/lib/__tests__/xero-credit-note-dedup.test.ts` | NEW — deduplication tests |

---

## QF-3: Xero Cash Refund Against Stripe Bank Account

### Problem
After cancellation, the system creates a Xero credit note and allocates it against the original invoice — but does **NOT** create a refund payment in Xero against the Stripe bank account (account code "606"). This means the Stripe refund transaction won't auto-reconcile with the Xero bank feed.

### Current flow
1. Credit note created ✓
2. Credit note allocated against invoice ✓  
3. Refund payment against Stripe bank account ✗ **MISSING**

### Solution

After the credit note allocation step in `createXeroCreditNote()` (`src/lib/xero.ts`), add:

```typescript
// Create refund payment against Stripe bank account for reconciliation
const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";

try {
  await xero.accountingApi.createPayments(tenantId, {
    payments: [{
      invoice: { invoiceID: payment.xeroInvoiceId },
      account: { code: bankCode },
      amount: refundAmountCents / 100,
      date: formatDate(new Date()),
      reference: `Stripe Refund - Booking ${payment.booking.id}`,
      isReconciled: false,
      paymentType: Payment.PaymentTypeEnum.ACCRECPAYMENT,
    }],
  });
} catch (err) {
  logger.error({ err, paymentId }, "Failed to create Xero refund payment");
  // Don't fail the whole operation — credit note was already created
}
```

**Note:** `isReconciled: false` ensures the payment appears as an expected transaction to match against the Stripe bank feed. The existing `stripeBankAccount` account mapping (default "606") from `XeroAccountMapping` is reused.

**Important:** This must use Xero's **Overpayment** or **Prepayment** refund pattern rather than a direct payment against the invoice, since the invoice was already paid. The correct Xero approach is:
1. Credit note already created and allocated ✓
2. Create a **batch payment** or use `createCreditNoteAllocation` with a bank account to record the cash outflow

Research the exact Xero API pattern for "Apply Refund" from a credit note to a bank account. The Xero UI calls this "Make a payment" on the credit note → selecting the bank account.

**Files to modify**

| File | Action |
|------|--------|
| `src/lib/xero.ts` | MODIFY — add refund payment after credit note allocation |

---

## QF-4: Audit Log Clickable Drill-Down

### Problem
The audit log page (`src/app/(admin)/admin/audit-log/page.tsx`) shows `targetId` as truncated plain text. Users cannot navigate to the referenced booking, member, or other entity.

### Solution

Add a URL resolver function and render `targetId` as clickable links:

```typescript
function getTargetUrl(action: string, targetId: string): string | null {
  if (!targetId) return null;
  if (action.startsWith("booking.")) return `/bookings/${targetId}`;
  if (action.startsWith("member.") || action.startsWith("MEMBER_")) return `/admin/members/${targetId}`;
  if (action.startsWith("season.")) return `/admin/seasons`;
  if (action.startsWith("FAMILY_GROUP_")) return `/admin/family-groups`;
  if (action.startsWith("cancellation-policy.")) return `/admin/cancellation-policy`;
  if (action.startsWith("promo")) return `/admin/promo-codes`;
  if (action.startsWith("chore")) return `/admin/chores`;
  if (action.startsWith("payment")) return `/admin/payments`;
  if (action.startsWith("deletion")) return `/admin/deletion-requests`;
  if (action.startsWith("hut-leader")) return `/admin/hut-leaders`;
  if (action.startsWith("xero")) return `/admin/xero`;
  if (action.startsWith("age-tier")) return `/admin/age-tiers`;
  return null;
}
```

Update the `targetId` `<TableCell>` to render as a Next.js `<Link>` when a URL can be resolved, with an external-link icon indicator. Falls back to plain text for unknown action types.

**Files to modify**

| File | Action |
|------|--------|
| `src/app/(admin)/admin/audit-log/page.tsx` | MODIFY — add URL resolver + clickable links |

---

## Test Plan

- [ ] **QF-1**: Cancel a CONFIRMED booking with payment → verify preview shows correct refund/kept amounts → confirm → verify success message → check cancellation email received
- [ ] **QF-1**: Cancel a PENDING booking (no payment) → verify preview shows "no payment taken" → confirm → verify success message
- [ ] **QF-2**: Cancel a booking → verify exactly 1 credit note in Xero (not 2) → wait for Stripe webhook → verify no duplicate created
- [ ] **QF-3**: Cancel a booking → verify Xero has: credit note + allocation + refund payment against Stripe bank account (code 606)
- [ ] **QF-4**: Open audit log → verify booking.cancel entries have clickable targetId → click → navigates to booking detail
- [ ] **QF-4**: Verify entries without targetId show plain text dash
- [ ] Run `npm test` — all tests pass
- [ ] Run `npm run build` — builds successfully

## Implementation Order

1. **QF-2** first — fix double credit note (prevents further data corruption)
2. **QF-3** next — add cash refund (builds on corrected credit note flow)
3. **QF-1** next — cancel preview UX (user-facing improvement)
4. **QF-4** last — audit log links (standalone UI change)
