# File-size allowances for #5008 child A (deposit settle)

The deposit settle is a third kind of settlement through the one settlement
body (`INV-ADDPAY-053`). Its own logic lives in `src/lib/deposit-settle.ts` and
`src/lib/deposit-balance.ts`; what stays in these files is the branch at each
step of the shared body, which has to sit beside the manual settle it mirrors.
`payment-reconciliation.ts` itself stays under its length on the base: the
manual settle's Xero-evidence refusal moved, unchanged, to
`src/lib/manual-settlement-xero-evidence.ts`.

function: src/lib/payment-reconciliation.ts#settleBookingPaymentInTransaction
lines: 966
reason: the deposit's fence, its balance request and its audit row belong
  inside the fenced write and the officer block they extend, under the same
  locks; split out, they would run outside the claim they depend on.

function: src/lib/payment-reconciliation.ts#prepareManualSettlement
lines: 319
reason: the deposit shares every manual refusal and the amount law, then hands
  off to `prepareDepositSplit` in one line; the worth check sits beside the
  amount check it replaces for a deposit.

function: src/lib/payment-reconciliation.ts#reverseManualBookingPayment
lines: 439
reason: the refusal of a deposit-settled booking sits with the reversal's
  other refusals, before anything is written.

function: src/lib/additional-payment-resend-service.ts#resendAdditionalPaymentEmail
lines: 389
reason: the fence that keeps a deposit balance out of the extra's re-send sits
  with the service's other refusals, before anything is claimed.
