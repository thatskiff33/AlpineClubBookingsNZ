# File-size allowance for #4713

file: src/lib/payment-recovery.ts
lines: 3604
reason: refresh the booking-modification refund balance after preflight and
  retry when a newly captured Stripe charge has not been checked. These checks
  belong beside the existing preflight and plan-freezing sequence; splitting
  the recovery module would broaden this focused money-writer correction.
