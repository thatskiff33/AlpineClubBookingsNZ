# File-size allowances for #5034

The refund-note gap pre-filter (#4936) needs one bulk read of the links' recorded
amounts. It is documented as a lower bound on `sumCoveredRefundCreditNoteCents`
and shares `readRefundCreditNoteLinkRecordedCents` with
`recoverRefundCreditNoteLinkAmountCents`, so it sits beside them in the same
module. Keeping the bound next to the exact sum means one cannot drift from the
other unseen.

file: src/lib/xero-sync.ts
lines: 1206
reason: the bulk lower-bound read sits beside the exact per-payment sum it must never exceed, and shares its recorded-amount helper; splitting it would separate the bound from the sum it is proved against.
