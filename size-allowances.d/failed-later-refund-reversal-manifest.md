# Size allowances for #4525 (Ledger M13): the failed-later refund reversal manifest

file: src/lib/xero-operation-retry.ts
lines: 2240
reason: the card-refund reversal invoice's requeue keeps the invoice it sent
  (one read, one spread, one doc line) so a replay's export manifest reads the
  sent lines rather than recording nothing. The rule belongs beside that
  operation's other requeue fields; moving it out would split one payload's
  shape across two modules.
