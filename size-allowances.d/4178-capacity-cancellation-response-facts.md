# Display-only refund facts for #4178

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 338
reason: One additive response field forwards the existing reconciliation facts beside the existing cancellation status and confirmation flag. Moving a single property to another response builder would separate this HTTP boundary from its payload without reducing any behavior; the formatting and validation logic is already extracted into booking-card-refund-copy.ts.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 896
reason: One additive response field forwards the same cancellation facts at the initialization boundary. Splitting this property would add an otherwise unnecessary response abstraction; the shared client-safe display module owns all new interpretation and copy.

file: src/lib/payment-reconciliation.ts
lines: 3113
reason: A type-only import, optional display-result field and two return projections preserve the existing refund writers while exposing facts already in scope at each outcome. Their correct home is beside those return values; extracting the reconciliation state machine would widen a display-only fix. All new formatting and interpretation is in the separate pure module.
