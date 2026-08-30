# File-size allowances for #3194

file: src/lib/payment-link.ts
lines: 1336
reason: the payment-link page and the booking page had to stop giving one
  member two answers about one booking's money, and the only place that can be
  fixed is where this file builds the public context. What was added is one
  injected read, one second resolution of a pure function, and the paragraphs
  saying why the wording state and the link state have to stay apart — a reader
  who cannot see that distinction will re-derive `payable` from the review-aware
  state, which hands a member a page saying "pay below" with nothing below it
  and costs them the booking when the hold expires. The reasoning has to sit on
  the two statements it governs. Splitting is not available cheaply either: this
  module is the single home for tokenised payment links — mint, resolve, revoke,
  re-issue, take payment, build the public context — and every one of those
  paths shares `loadPaymentLinkRecord` and the same booking include, so a seam
  through it is a refactor of its own and was already 561 lines over its 700-line
  budget before this change.
