# Size allowances for the capture-receipt manifest (#4525, Ledger M13)

Each capture sender gains the one call that records its stored Xero payment's
capture receipt, at the point it stores the payment id. The helpers that read
what a sender stored live in `src/lib/capture-receipt-senders.ts`; what is left
in each sender is the call itself, which belongs beside the payment it records.

function: src/lib/xero-operation-retry.ts#retryXeroSyncOperation
lines: 758
reason: the PARTIAL invoice repair records its payment's capture receipt on both of its paths (sent now, or already linked), beside the payment each stores.

function: src/lib/additional-capture-xero-receipt.ts#recordAdditionalCaptureReceipt
lines: 415
reason: the receipt's reference and per-leg payment key are handed to the completion that records each leg's capture receipt.

function: src/lib/xero-supplementary-invoices.ts#createXeroSupplementaryInvoice
lines: 569
reason: the supplementary payment's id, key, reference and bank code are kept once Xero returns it, and its capture receipt is recorded after the row completes.
