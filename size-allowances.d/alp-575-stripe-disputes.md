# Stripe-dispute integration additions (ALP-575, prerequisite #5061)

file: src/app/(admin)/admin/finance/payments/page.tsx
lines: 1434
reason: The dispute marker belongs beside each existing payment status chip; extracting the eleven-line addition would split the row presentation and its shared formatting context.

file: src/lib/booking-batch-modification-service.ts
lines: 2766
reason: The hold read and flag propagation belong at the existing locked settlement and post-commit Xero boundaries; those few lines cannot be separated without hiding the lock context.

file: src/lib/booking-cancel.ts
lines: 2893
reason: The disputed disposition and treasurer hand-back reuse the existing cancellation claim and side-effect branches. Extracting these small branches would separate the hold decision from the claim it protects.

file: src/lib/booking-date-modification-service.ts
lines: 2266
reason: Three added lines propagate the hold result through the existing transaction result and Xero boundary; a separate module for field propagation would obscure that contract.

file: src/lib/booking-guest-removal-service.ts
lines: 1256
reason: Three added lines carry the hold decision from the locked edit to its Xero refund classification; retaining them together keeps the financial outcome reviewable.

file: src/lib/email-message-registry.ts
lines: 2503
reason: The dispute template must participate in the existing centralized recipient, delivery-lock, token and preview registries. A dispute-only second registry would duplicate the registry structure.

file: src/lib/email-message-renderer.ts
lines: 964
reason: The dispute subject-token guidance is one entry in the existing shared guidance map; a separate map would add an extra lookup solely for this template.

file: src/lib/payment-recovery.ts
lines: 3620
reason: The dispute refusal must run immediately before the existing refund reservation. Extracting that guard would hide its order relative to the reservation it protects.

file: src/lib/payment-transactions.ts
lines: 1873
reason: The dispute preflight must examine every derived refund slice before any reservation or provider send. Keeping the refusal beside that boundary makes the all-or-nothing ordering explicit.

file: src/lib/stripe-webhook-service.ts
lines: 1804
reason: The dispute event cases and late-capture hold exception belong in the existing webhook dispatch and refund exception branches, preserving their ordering and retry semantics.

