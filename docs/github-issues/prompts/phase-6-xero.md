# Phase 6: Xero & Modification Edge Cases

You are fixing 5 Xero and modification edge case issues. Most are documentation + small code changes.

## Setup

```
git checkout -b fix/phase-6-xero-edge-cases
```

## Change 1 of 5: Document Xero credit note amount behavior

Read `src/lib/xero.ts` and search for `createXeroCreditNote`. There should be two functions:
- `createXeroCreditNote` (for cancellation refunds)
- `createXeroCreditNoteForModification` (for modification refunds)

In each, find the `lineItems` array where `unitAmount` is set. Add a comment above each:

```typescript
    // Note: Xero credit notes expect POSITIVE unitAmount values.
    // Xero handles the sign internally — a credit note with unitAmount: 50
    // will correctly reduce the invoice balance by $50.
```

No code change needed — just add the documenting comments.

## Change 2 of 5: Increase Xero token refresh buffer

Read `src/lib/xero.ts` and find `TOKEN_REFRESH_BUFFER_MS`. It should be near the top of the file (around line 51):

```typescript
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
```

Change to:

```typescript
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes — buffer for long-running bulk ops (contact sync, membership refresh)
```

## Change 3 of 5: Link supplementary invoices to original

Read `src/lib/xero.ts` and search for `createXeroSupplementaryInvoice`. Read the full function. Find where the invoice object is constructed — there should be a `reference` field or you may need to add one.

The function receives a `bookingId` parameter. It should also have access to the payment record with `xeroInvoiceId`. Add the original invoice reference:

Find the invoice creation object (it will have fields like `type`, `contact`, `lineItems`, `date`, etc.) and add or update the `reference` field:

```typescript
      reference: `Supplementary for booking ${bookingId.slice(0, 8)}${payment?.xeroInvoiceId ? ` (original: ${payment.xeroInvoiceId})` : ""}`,
```

Read the function signature and body to find exactly where `payment` or `xeroInvoiceId` is available. If the function doesn't receive the payment, you may need to query it:

```typescript
    const payment = await prisma.payment.findUnique({
      where: { bookingId },
      select: { xeroInvoiceId: true },
    });
```

Add this query before the invoice creation if needed.

## Change 4 of 5: Document change fee policy date logic

Read `src/app/api/bookings/[id]/modify-dates/route.ts` and search for `loadCancellationPolicy`. Find where the policy is loaded (around line 228-229). Add a comment:

```typescript
    // Business rule: change fee is calculated against the ORIGINAL check-in date's
    // cancellation policy. This is because the member's cancellation obligations were
    // established when the booking was first created. Using the new date's policy could
    // allow gaming the system by first moving to a date with a more lenient policy.
    const policy = await loadCancellationPolicy(booking.checkIn);
```

## Change 5 of 5: Add logging for membership refresh skip count

Read `src/lib/xero.ts` and search for `refreshAllMembershipStatuses`. Find the function. Near the start, it queries members with `xeroContactId: { not: null }`. Add logging for visibility:

After the members query, add:

```typescript
  // Log how many members will be refreshed vs skipped
  const totalMembers = await prisma.member.count({ where: { active: true } });
  logger.info(
    {
      job: "xero-membership-refresh",
      withXeroContact: members.length,
      withoutXeroContact: totalMembers - members.length,
    },
    "Membership refresh: members with Xero contact will be checked, others skipped"
  );
```

Make sure `logger` is imported. Check the top of the file.

## Verify

```bash
npm test
npm run build
```

## Commit

```bash
git add -A
git commit -m "Xero edge cases: credit note docs, token buffer, invoice linking, logging

- H2: Document credit note positive amount convention
- M8: Increase token refresh buffer from 5 to 10 minutes
- M10: Add original invoice reference to supplementary invoices
- M16: Document change fee policy date logic
- M7: Add skip count logging to membership refresh"
```
