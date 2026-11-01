# File-size allowances for #4624

file: src/lib/email-message-registry.ts
lines: 2464
reason: a new email template (admin-unmatched-app-stripe-payment) is registered
  in this file's parallel tables (admin set, delivery lock, required tokens,
  trigger summary, approved tokens and their preview samples), beside #4532's
  entries for the alert it pairs with; splitting one template's entries out
  would leave the registry's lists incomplete in the one place they are read.
