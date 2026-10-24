# File-size allowances for #4318 (#4285 review 7)

file: src/lib/payment-transactions.ts
lines: 1695
reason: what one capture's card still holds is its amount less its recorded
  card refunds, matched by row or intent (`sumRecordedRefundsForCapture`). It
  must share the one private reader (`sumRecordedRefundRows`) and its
  refused-status filter with the per-charge and per-payment sums beside it, so
  the three can never count refunds differently. Moving that family to a module
  of its own would re-route two suites' mocks of this module for a two-line
  addition.
