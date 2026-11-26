/**
 * #5433 PR 4: the template names of the member notices the confirm-pending job
 * owes, used by each sender for its `EmailLog` rows and by the owed notice that
 * reads the email's durable row id (`hold-ended-cancellation-notices.ts`,
 * `saved-card-unusable-notices.ts`). One spelling each (`INV-SSOT-001`),
 * checked against the email registry by `satisfies`. A leaf, so neither side
 * loads a template to read it.
 */
import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";

export const BOOKING_REQUEST_PAYMENT_EXPIRED_TEMPLATE = "booking-request-payment-expired" satisfies EmailAuditTemplateName;
export const SPLIT_GUEST_PORTION_CANCELLED_TEMPLATE = "split-guest-portion-cancelled" satisfies EmailAuditTemplateName;
export const SAVED_CARD_CHARGE_FAILED_TEMPLATE = "saved-card-charge-failed" satisfies EmailAuditTemplateName;
