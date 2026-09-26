# File-size allowances for #3638 — card first, then bank

The inbound half was split rather than allowed for: the two settlement
conflicts and their shared record now live in
`src/lib/xero-inbound/settlement-conflicts.ts`, inside its own budget, and
`invoice-paid-effects.ts` ends shorter than it started. Two files still grow.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 530
reason: the refusal has to run in this route, before its locked transaction,
  so a refused switch writes nothing and raises no invoice; the under-lock
  check that the payment still points at the intent it cancelled has to sit
  inside that same transaction. The cancel-and-classify helper is private to
  this one caller, and moving it into `stripe.ts` would put a member-facing
  refusal decision in the provider wrapper.

file: src/lib/xero-booking-repair-classify.ts
lines: 1673
reason: one predicate call so the repair tool's late-capture arm no longer
  reads an admin-only settlement marker as a recorded refund decision, plus
  its import and the comment saying why.
