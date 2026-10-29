# File-size allowances for #4299

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1605
reason: Keep the organiser invoice check and enqueue at the existing guest-add money claim, and carry the organiser-billed figure to the joiner's email and the response (review F1); the new billing policy is already in shared modules. Moving these call sites would split the transaction boundary.

file: src/lib/booking-batch-modification-service.ts
lines: 2755
reason: The shared invoice queue must be invoked beside creation of the change inside the existing edit transaction, the organiser-billed figure carried to the result and the joiner's email (review F1), and the organiser-place flag passed to its Xero leg (review N-b). Extracting these integration lines would hide their required atomicity.

file: src/lib/booking-date-modification-service.ts
lines: 2263
reason: The shared invoice queue must be invoked beside creation of the date change inside its existing money claim, the organiser-billed figure carried to the result and the joiner's email (review F1), and the organiser-place flag passed to its Xero leg (review N-b). The organiser policy lives outside this service already.

file: src/lib/booking-guest-removal-service.ts
lines: 1247
reason: The shared invoice queue must be invoked beside creation of the guest-removal change inside its existing money claim, and its result carries the organiser-billed figure (review F1). Extracting the call would obscure the commit boundary.

file: src/lib/booking-cancel.ts
lines: 2861
reason: Only the state read, fee adjustment and shared reservation/binding calls join the existing paid-cancel claim. Moving that claim is a separate lifecycle refactor; all invoice policy and provider execution are in new modules. Review N1 freezes the tier's fixed fee with that same reservation.

file: src/lib/email-message-registry.ts
lines: 2417
reason: This is the existing authoritative template catalogue: required tokens, default wording and audit metadata belong beside the other entries. Splitting this one template would introduce a second registration path.

file: src/lib/group-cancel.ts
lines: 1067
reason: Freeze invoice debts beside the existing durable group refund plan with its one planner, record each refund on the child's payment rows and bind the debts at its child hand-back claim (review F2, N-e). Splitting that money claim would obscure lock ownership and restart behavior; invoice arithmetic and execution already live in shared modules.

file: src/lib/xero-operation-outbox.ts
lines: 3446
reason: Keep queue dispatch and the transaction-aware wrapper beside the existing supplementary-anchor enqueue implementation. The new adjustment executor is a separate module; exporting a private enqueue solely to relocate its wrapper would widen its API. Review B1 and S1 add two refusals at the existing choke points they guard - the booking-invoice enqueue (no invoice of its own for an organiser-paid bank place) and the anchor-locked supplementary decision (no invoice for an extra waived before it was raised) - where every enqueuer already funnels; elsewhere they could be bypassed.

file: src/lib/xero-operation-retry.ts
lines: 2104
reason: The existing retry dispatcher must recognize the new typed operation and re-use the shared executor. Extracting only this dispatch arm would distribute retry ownership without moving any business logic. The booking-invoice retry also reads which fence closed its row, so an organiser-paid bank place is not reported as a cash settlement (fix-delta review).

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 554
reason: The guest-removal route passes the organiser-billed figure to the joiner's email and its response beside the other money fields (review F1); a separate module for two fields would split one response from its email.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2382
reason: The quote answers the save's own refusal for an organiser place with no combined invoice (review N-a) on the same line as its other refusals, so the quote cannot offer a change the save refuses. Review N4 adds the organiser-billed flag to the same response, from the same predicate the save bills by.

file: src/lib/email/booking.ts
lines: 1855
reason: The Booking Modified sender composes its money note in one place for the HTML and editable bodies; the organiser-billed sentence (review F1) belongs beside the other settlement sentences, and its wording lives in the shared copy module already.

file: src/lib/xero-booking-repair-classify.ts
lines: 2417
reason: Review B1: the organiser-paid bank place's "settled on the combined invoice" arm sits beside the manually-settled arm it mirrors, inside the one sequential classifier, so the missing-primary-invoice arm can never be reached for such a place. A separate pass could not stop that arm firing.

file: src/lib/xero-booking-invoices.ts
lines: 1681
reason: Review B1, defence in depth: the primary-invoice handler refuses an organiser-paid bank place beside the manual-settlement handler fence it mirrors, before any provider work, so a row that reached it without the enqueue's choke point still raises no invoice to the joiner. A fence outside the handler could be bypassed by the very rows it exists for.
