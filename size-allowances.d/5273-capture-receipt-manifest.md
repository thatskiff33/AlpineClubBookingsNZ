# Size allowances for the capture-receipt manifest (#4525, Ledger M13)

Each capture sender gains the one call that records its stored Xero payment's
capture receipt, at the point it stores the payment id. The helpers that read
what a sender stored live in `src/lib/capture-receipt-senders.ts`; what is left
in each sender is the call itself, which belongs beside the payment it records.

file: src/lib/xero-booking-invoices.ts
lines: 1573
reason: primary replay must read its stored payment before completion, record
  its capture receipt at once, then preserve it in the completion payload. The reader and
  recorder already live in capture-receipt-senders.ts; extracting the remaining
  sequencing would separate completion from the evidence it must preserve.

function: src/lib/xero-operation-retry.ts#retryXeroSyncOperation
lines: 757
reason: the PARTIAL invoice repair records its payment's capture receipt on both of its paths (sent now, or already linked), beside the payment each stores.

function: src/lib/additional-capture-xero-receipt.ts#recordAdditionalCaptureReceipt
lines: 415
reason: the receipt's reference and per-leg payment key are handed to the completion that records each leg's capture receipt.

function: src/lib/xero-supplementary-invoices.ts#createXeroSupplementaryInvoice
lines: 596
reason: the supplementary payment's id, key, reference and bank code are kept once Xero returns it, and its capture receipt is recorded after the row completes.

file: src/lib/xero-operation-retry.ts
lines: 2066
reason: the inline retry of a FAILED supplementary invoice passes its queued
  capture to the sender (#4525 review), so the receipt names it; one argument
  beside the call it belongs to, in a file already over its limit before this
  change, and lifting it apart is a refactor of its own.

function: src/lib/xero-booking-invoices.ts#createXeroInvoiceForBooking
lines: 963
reason: the Stripe payment Xero returned, and its capture receipt's input, are
  held outside the try, so a run failing after the payment and its link records
  the receipt before failing the row, and also keeps the payment on the FAILED
  row for an inline retry (#4525 review); the function was already over its limit before this
  change, and lifting it apart is a refactor of its own.
