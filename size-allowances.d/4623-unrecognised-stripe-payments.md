# File-size allowances for #4532

file: src/lib/email-message-registry.ts
lines: 2446
reason: a new email template is registered in this file's five parallel
  tables (admin set, delivery lock, required tokens, trigger summary, approved
  tokens and their preview samples); splitting one template's entries out
  would leave the registry's lists incomplete in the one place they are read.

file: src/lib/stripe-webhook-service.ts
lines: 1767
reason: the payment_intent.succeeded dispatcher gains one first branch that
  hands a payment the app did not create to its own module
  (unrecognised-stripe-payment.ts); the branch belongs beside the dispatch it
  precedes, and everything else lives in the new module.

file: src/lib/group-settlement.ts
lines: 1667
reason: the organiser settlement now imports GROUP_SETTLEMENT_INTENT_TYPE so
  the charge and the webhook share one symbol. That is one import in a module
  already over the ceiling; splitting the settlement writer to absorb it would
  be a refactor of its own.
