// Shared payment-recovery constants kept in a dependency-light module so health
// and visibility code can reuse them without importing the full payment-recovery
// service (which pulls in Stripe and the email/transaction layers).

// A recovery operation is retried while attempts < this maximum; once attempts
// reach it the operation is terminal and will never be reclaimed.
export const MAX_PAYMENT_RECOVERY_ATTEMPTS = 5;
