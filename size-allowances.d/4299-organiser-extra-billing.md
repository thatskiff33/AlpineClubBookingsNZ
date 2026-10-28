# File-size allowances for #4299

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1600
reason: Keep the organiser invoice check and enqueue at the existing guest-add money claim; the new billing policy is already in shared modules. Moving these call sites would split the transaction boundary.

file: src/lib/booking-batch-modification-service.ts
lines: 2746
reason: The shared invoice queue must be invoked beside creation of the change inside the existing edit transaction. Extracting two integration lines would hide their required atomicity.

file: src/lib/booking-date-modification-service.ts
lines: 2254
reason: The shared invoice queue must be invoked beside creation of the date change inside its existing money claim. The organiser policy lives outside this service already.

file: src/lib/booking-guest-removal-service.ts
lines: 1244
reason: The shared invoice queue must be invoked beside creation of the guest-removal change inside its existing money claim. Extracting the call would obscure the commit boundary.

file: src/lib/booking-cancel.ts
lines: 2858
reason: Only the state read, fee adjustment and shared reservation/binding calls join the existing paid-cancel claim. Moving that claim is a separate lifecycle refactor; all invoice policy and provider execution are in new modules.

file: src/lib/email-message-registry.ts
lines: 2415
reason: This is the existing authoritative template catalogue: required tokens, default wording and audit metadata belong beside the other entries. Splitting this one template would introduce a second registration path.

file: src/lib/group-cancel.ts
lines: 1006
reason: Freeze invoice debts beside the existing durable group refund plan and bind them at its child hand-back claim. Splitting that money claim would obscure lock ownership and restart behavior; invoice arithmetic and execution already live in shared modules.

file: src/lib/xero-operation-outbox.ts
lines: 3419
reason: Keep queue dispatch and the transaction-aware wrapper beside the existing supplementary-anchor enqueue implementation. The new adjustment executor is a separate module; exporting a private enqueue solely to relocate its wrapper would widen its API.

file: src/lib/xero-operation-retry.ts
lines: 2097
reason: The existing retry dispatcher must recognize the new typed operation and re-use the shared executor. Extracting only this dispatch arm would distribute retry ownership without moving any business logic.
