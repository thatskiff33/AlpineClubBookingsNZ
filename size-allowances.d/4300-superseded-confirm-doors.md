# File-size allowances for #4300

A card capture on an intent an edit superseded never settles its booking
(`INV-PAY-138`). The settle refuses it under lock(1) with a new outcome; the
doors ask the same reading first; each caller answers the outcome. The reading
itself, the post-commit hand-off and alert, and the `/pay` page's refusal table
live in their own modules; each file below gains only its call and its answer.

file: src/lib/payment-recovery.ts
lines: 3360
reason: the doors' check needs the module's private hand-off
  (`handoffSucceededSupersededIntentToRefund`), so it cannot move out without
  exporting that writer; the growth is its docblock, the claim result and the
  shared reading's call.

file: src/lib/payment-reconciliation.ts
lines: 3029
reason: the refusal has to sit inside the settle's transaction under lock(1),
  beside the #1765 refund-history refusal it mirrors; the post-commit work is
  one call into superseded-capture-refusal.ts.

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 353
reason: the door's check sits in the route's classification window, between
  the refund-history check and the settle, and the settle's new outcome needs
  its own answer; both are one statement each.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 911
reason: the check joins the existing refund-history discriminator and the
  reuse arm it guards, so the repay mint they share stays one path.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 935
reason: the settle's new outcome needs its own answer among the route's
  existing outcome branches; the body is shared from the recovery contract.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 661
reason: the settle's new outcome needs its own answer among the route's
  existing outcome branches; the body is shared from the recovery contract.

file: src/lib/cron-confirm-pending.ts
lines: 2068
reason: the settle's new outcome needs its own branch among the cron's
  existing outcome branches, counted as failed for the alerted admins.

file: src/lib/email-message-registry.ts
lines: 2369
reason: the alert's own template is registered beside its siblings - audience,
  delivery lock, required tokens, trigger metadata, sample and approved tokens
  are each one entry in the registry's existing tables, as #4211's was.
