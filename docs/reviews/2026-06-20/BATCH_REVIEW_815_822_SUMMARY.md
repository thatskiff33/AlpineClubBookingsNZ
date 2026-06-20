# Batch Review Summary: Issues #815-#822

## Issues reviewed

- #815 Stripe/Xero/SES idempotency and replay review.
- #816 Booking capacity, waitlist, bed allocation, and recovery review.
- #817 Membership, family, dependent, cancellation, archive/delete lifecycle review.
- #818 Payment, refund, credit, and accounting consistency review.
- #819 Xero operational outbox and reconciliation review.
- #820 Email, notification, retry, and suppression review.
- #821 Admin, finance, and lodge recovery/visibility review.
- #822 UI/UX journey clarity and accessibility review.
- #823 was not reviewed for final release readiness; only a blocked note was created.

## Files created

- `docs/reviews/2026-06-20/issue-815-provider-idempotency-replay-review.md`
- `docs/reviews/2026-06-20/issue-816-capacity-waitlist-bed-recovery-review.md`
- `docs/reviews/2026-06-20/issue-817-membership-family-delete-lifecycle-review.md`
- `docs/reviews/2026-06-20/issue-818-payment-refund-credit-accounting-review.md`
- `docs/reviews/2026-06-20/issue-819-xero-outbox-reconciliation-review.md`
- `docs/reviews/2026-06-20/issue-820-email-notification-retry-suppression-review.md`
- `docs/reviews/2026-06-20/issue-821-admin-finance-lodge-visibility-review.md`
- `docs/reviews/2026-06-20/issue-822-ux-journey-accessibility-review.md`
- `docs/reviews/2026-06-20/issue-823-final-release-readiness-blocked.md`
- `docs/reviews/2026-06-20/BATCH_REVIEW_815_822_SUMMARY.md`

## Cross-cutting risks

- Stale provider/background work can become hard to recover if `RUNNING` or `PROCESSING` states are not reset or counted in health views.
- Some high-value lifecycle emails are intentionally non-retryable for redaction reasons, but state changes can already be committed when delivery fails.
- Provider-local mismatch visibility is uneven across Stripe refunds, Xero invoices/credit notes, SES feedback, and local booking/payment state.
- Several flows use best-effort post-transaction side effects; operator recovery needs to be explicit wherever the side effect is important to the user journey.
- Refund and credit paths are mostly cents-based and bounded, but legacy refund paths do not all appear to share the same durable recovery pattern.
- Capacity-holding and bed-allocatable status sets differ; this may be valid, but it needs tests and clear operator semantics.
- Admin repair surfaces exist, but there is no single consolidated stuck-state queue across payment, Xero, email, waitlist, bed allocation, membership, and lodge operations.
- User-facing next-step guidance depends partly on email delivery, especially for waitlist, nomination, setup, confirmation, and cancellation flows.
- Finance reporting and operational Xero repair are separated, but stale sync and failed operational work need clear operator-facing boundaries.
- Accessibility cannot be proven statically; dense admin/lodge/finance flows require manual keyboard, focus, screen-reader, and contrast validation.

## Highest priority follow-up candidates

- Fix or prove safe the refund request approval sequence where external refund work can happen before the pending request is atomically claimed.
- Add stale recovery and health visibility for Xero outbound `RUNNING` operations and inbound `PROCESSING` events.
- Add recovery for failed non-retryable lifecycle emails, including token reissue/resend flows where applicable.
- Add nomination expiry recovery so `PENDING_NOMINATORS` applications cannot stay stuck indefinitely and block fresh applications.
- Add a booking status matrix test covering capacity-holding, bed-allocation, waitlist, payment, draft, and cleanup semantics.
- Add durable recovery for legacy guest-removal refund failure and verify all refund-producing paths use a consistent recovery model.
- Add a consolidated admin stuck-state view or expand the dashboard/health pages to cover all critical queues and failure states.

## Findings to keep out of public issue bodies

- Exact refund race or double-processing reproduction details.
- Exact provider replay, webhook, stale-claim, and stuck-queue trigger sequences.
- Any token, webhook signature, provider object, payment method, email address, member, booking, or PII examples.
- Specific hard-delete/orphaned-PII object graph details if confirmed.
- Detailed admin repair bypass or privilege boundary mechanics if discovered during follow-up.

## Recommended next implementation/test issue order

1. Payment/refund recovery and race hardening from #818.
2. Xero outbox/inbound stale-state recovery and health visibility from #819.
3. Email non-retryable lifecycle recovery and scheduler verification from #820.
4. Booking capacity/waitlist/bed-allocation status matrix and stale cleanup from #816.
5. Membership nomination expiry and family/delete lifecycle blocker tests from #817.
6. Consolidated admin/operator stuck-state visibility from #821.
7. UX copy, page-level recovery guidance, and accessibility validation from #822.
8. Provider idempotency/replay policy checks from #815, coordinated with private security handling where needed.

## Why #823 final release-readiness remains blocked

#823 is blocked because release readiness depends on completed #812 through #822 review reports and triage of their follow-up implementation/test issues. This batch completes the #815 through #822 review-only reports, but final readiness cannot be assessed until the #812 through #822 findings are triaged, private-sensitive items are handled appropriately, and any release-blocking implementation or test work is resolved.
