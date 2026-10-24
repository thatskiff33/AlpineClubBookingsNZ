# File-size allowances for #4211 (PR #4228)

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2072
reason: the Xero bank-receipt settle's PAID claim records its own receipt row
  as the booking's settler (`INV-PAY-043`), and that write has to sit inside
  the claim, in the same lock(1) transaction, directly after the status flip
  it belongs to; a call and its import, with the rule itself in
  `payment-settler.ts`. Moving the claim out to make room would split the
  settle's one transaction across modules.

file: src/lib/email-message-registry.ts
lines: 2348
reason: the kept-capture alert (`admin-duplicate-capture-kept`) is registered
  where every template is: the admin-system and delivery-locked sets, its
  required tokens, its trigger summary, its two tokens' preview samples and the
  approved-token list. Each is one row in the single table its kind lives in;
  a second file would split the registry the email censuses read as one.
