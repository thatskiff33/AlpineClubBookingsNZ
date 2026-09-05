# File-size allowances for #3266

Four already-over-budget files grow. The new logic itself went into new modules
(`src/lib/setup-intent-card.ts` for the verdict, `src/lib/stripe-references.ts`
for the expandable-reference fold) rather than into any of them; what remains in
the over-budget files is the call sites, the guard on an existing writer, and
the comments saying why. The route handler stays inside its 250-line budget.

file: src/app/(authenticated)/bookings/[id]/page.tsx
lines: 2793
reason: the "Save Payment Method" card's condition moves from "no SetupIntent
  yet" to the shared `needsSavedCardEntry` predicate, and the four-line comment
  beside it records why (an abandoned replacement or a retired card must show
  the form again). The predicate itself lives in `booking-payment-flow.ts`;
  what remains here is the one call site and its reasoning, which belongs next
  to the other owner/status gates in the same expression.

  #3269 (same epic) grows the same page: its query selects the split parent's
  three card columns and derives the admin button's will-charge wording from
  the shared predicate — declared here because one path gets one allowance.

file: src/lib/payment-reconciliation.ts
lines: 2927
reason: `markBookingSetupIntentSucceeded` already lives here beside the
  PaymentIntent settlement writer; the fix round makes it a status-guarded
  `updateMany` and documents why (a redelivered `setup_intent.succeeded` must not
  write an old card back). Moving one SetupIntent stamp out of the module that
  owns every other Payment-row write would split the row's writers across two
  files for eighteen lines.

file: src/lib/payment-recovery.ts
lines: 2507
reason: `getStripePaymentMethodId` is kept here under its own name as a one-line
  derivation of `stripeReferenceId` (`stripe-references.ts`, the new one home),
  so its charge-site callers did not all have to move in this lane; #3267
  routes them when it edits those sites. The five lines are the docblock saying
  exactly that.

file: src/lib/stripe-webhook-service.ts
lines: 1704
reason: the `setup_intent.succeeded` handler now reads the Payment row and
  refuses to stamp when the row no longer names the intent, then dispatches on
  the shared verdict from `setup-intent-card.ts`; `setup_intent.canceled` loses
  its write and gains the comment explaining the idempotency-key replay it
  caused. The verdict itself lives in the new module; what grows here is the
  handler's guard, its four outcome branches and their logging, which belong
  beside the other event handlers and their dedupe.
