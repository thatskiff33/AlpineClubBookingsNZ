# Issue #822: UI/UX Journey Clarity and Accessibility Review

## Issue

Review user-facing process clarity, next-step guidance, payment options, pending/review/waitlist/cancellation states, admin/lodge/finance clarity, error/empty/loading states, and accessibility. Static review only.

## Scope reviewed

- Static review of representative member, booking, payment, waitlist, admin, finance, health, Xero, lodge, and accessibility documentation surfaces.
- No production browser automation, broad endpoint scan, DAST, load test, or live session was used.

## Files/directories inspected

- `src/app/(authenticated)/book/page.tsx`
- `src/app/(authenticated)/bookings/[id]/page.tsx`
- `src/lib/booking-narrative.ts`
- `src/components/booking/booking-payment-section.tsx`
- `src/app/(admin)/admin/dashboard/page.tsx`
- `src/app/(admin)/admin/waitlist/page.tsx`
- `src/app/(admin)/admin/bed-allocation/page.tsx`
- `src/app/(admin)/admin/payments/page.tsx`
- `src/app/(admin)/admin/xero/**`
- `src/app/(admin)/admin/health/**`
- `src/app/(finance)/finance/page.tsx`
- `src/app/(lodge)/lodge/page.tsx`
- `docs/STAGING_ACCESSIBILITY.md`
- `docs/END_TO_END_TEST_MATRIX.md`

## Main observations

- Booking form copy explains important non-member/provisional behavior, including that no beds are reserved and no payment is charged up front for relevant flows.
- Booking detail pages include waitlist position, offer expiry handling, payment-on-hold messaging, Internet Banking payment instructions, saved-payment-method prompts, credit-applied summaries, and additional-payment prompts.
- `booking-narrative.ts` centralizes plain-language booking/payment/cancellation narratives with concrete next steps.
- Admin pages generally include filters, empty/loading/error states, and repair actions for waitlist, bed allocation, payments, Xero, email deliverability, and health.
- Accessibility documentation exists in `docs/STAGING_ACCESSIBILITY.md`, but this review did not execute axe, keyboard, screen reader, or browser checks.

## Top risks to verify

- Users can be left unclear when a critical non-retryable email fails, for example nomination, setup, cancellation confirmation, booking confirmation, or payment-link style emails.
- Some operator UI wording may not match backend counts, such as Xero health copy that refers to queued/running work while the backend count appears pending-only.
- Payment, refund, credit, and Xero/accounting follow-up states may be technically visible to admins but still unclear to users when money has moved and accounting work is pending.
- Dense admin tables and repair screens need manual keyboard, focus, screen-reader, and contrast testing. Static review cannot prove accessibility.
- Waitlist and provisional-booking language depends heavily on email delivery; verify page-level next steps are sufficient when email is missed.

## Likely follow-up issues

- Add user-facing recovery guidance for failed or expired lifecycle-token emails.
- Align Xero/payment/email health wording with exact backend state semantics.
- Add UX checks for provider-local mismatch states: paid but accounting pending, refunded but credit note pending, waitlist offered but email failed.
- Run the staging accessibility checklist for booking, booking detail, admin payments, Xero operations, waitlist, bed allocation, lodge, and finance pages.
- Add focused tests for loading, empty, error, and disabled states on high-risk repair actions.

## Recommended tests/static checks

- Component tests for booking status cards, waitlist offer, Internet Banking payment, payment-on-hold, credit-applied, and additional-payment states.
- Admin component tests for empty/error/loading states in payments, Xero operations, email deliverability, waitlist, and bed allocation.
- Manual accessibility pass following `docs/STAGING_ACCESSIBILITY.md`.
- Static copy check for status labels that imply stronger guarantees than backend state provides.
- End-to-end journey checks in staging for member booking, waitlist, cancellation, refund appeal, and admin repair flows.

## Sensitive findings requiring private handling, if any

- Keep exact user confusion paths tied to payments, refunds, provider mismatch, or token recovery private until triaged.
- Do not include real user, booking, payment, email, or provider identifiers in public follow-up text.

## Uncertainty/to-verify list

- To verify: actual mobile and desktop rendering under representative real data.
- To verify: keyboard and screen-reader behavior on tables, dialogs, menus, and repair actions.
- To verify: whether every critical state has both email guidance and page-level guidance.
- To verify: whether finance/lodge users understand stale sync and repair ownership from current UI copy.

## Validation notes

- Static review only.
- No browser automation, axe scan, production session, or app-code edit was performed.
