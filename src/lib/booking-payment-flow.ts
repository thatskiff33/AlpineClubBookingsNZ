import type { Payment, PaymentTransaction, Prisma } from "@prisma/client";
import { CLEAR_SETTLING_TRANSACTION } from "@/lib/payment-settler";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { IMMEDIATE_PAYMENT_BOOKING_STATUSES } from "@/lib/booking-status";

export type BookingPaymentMode = "payment" | "setup";

export interface BookingPaymentFlowState {
  status: string;
  hasNonMembers?: boolean | null;
  // Group booking ORGANISER_PAYS: the organiser settles this booking, so the
  // joiner who owns it must never be offered a self-pay flow.
  organiserSettled?: boolean | null;
}

function normalizeBookingState(
  booking: string | BookingPaymentFlowState
): BookingPaymentFlowState {
  return typeof booking === "string" ? { status: booking } : booking;
}

export function requiresSavedPaymentMethod(
  booking: string | BookingPaymentFlowState
) {
  const state = normalizeBookingState(booking);
  return state.status === "PENDING" && state.hasNonMembers !== false;
}

export function canCreateImmediatePaymentIntent(
  booking: string | BookingPaymentFlowState
) {
  const state = normalizeBookingState(booking);

  // The organiser settles ORGANISER_PAYS bookings as one combined bill; the
  // joiner who owns the booking is never billed and cannot pay it here.
  if (state.organiserSettled) {
    return false;
  }

  if (requiresSavedPaymentMethod(state)) {
    return false;
  }

  return (IMMEDIATE_PAYMENT_BOOKING_STATUSES as readonly string[]).includes(state.status);
}

export function getBookingPaymentMode(
  booking: string | BookingPaymentFlowState
): BookingPaymentMode {
  return requiresSavedPaymentMethod(booking) ? "setup" : "payment";
}

/**
 * Whether a member whole-lodge approval leaves the payment method to the member
 * (#4019): only when the Internet Banking AND Xero modules are on, because the
 * switch route needs both to mint the receivable and raise the invoice later.
 * With either off the approval keeps its legacy shape. The ONE rule shared by
 * the approval, the request page (which offers the credit election only on
 * this path) and the request route (which records it only on this path).
 */
export function memberWholeLodgeChoosesPaymentMethod(modules: {
  xeroIntegration: boolean;
  internetBankingPayments: boolean;
}): boolean {
  return modules.xeroIntegration === true && modules.internetBankingPayments === true;
}

/**
 * Durable Payment facts for a never-collected card attempt (#4019). The mirror
 * projects captured/refunded history, while the settler and manual provenance
 * keep a previously settled payment outside this branch even after reopening.
 * An incomplete payment snapshot is unknown and fails closed. Amount is an ask
 * before capture, so amountCents itself is deliberately not a capture test.
 * Additional asks stay in their existing collection/settlement policy.
 * Runtime and Prisma forms below derive from these same facts (INV-SSOT-001).
 */
const UNCAPTURED_CARD_STATUSES = ["PENDING", "PROCESSING", "FAILED"] as const;
const UNCAPTURED_CARD_FACTS_BASE = { source: "STRIPE", xeroInvoiceId: null, refundedAmountCents: 0 } as const;
const UNCAPTURED_PRIMARY_FACTS = { kind: "PRIMARY", ...UNCAPTURED_CARD_FACTS_BASE } as const;
const UNCAPTURED_CARD_FACTS = {
  ...UNCAPTURED_CARD_FACTS_BASE,
  // Read the same null provenance the canonical reversal clears; this module
  // defines no second setter or standalone copy of that column's null fact.
  ...CLEAR_SETTLING_TRANSACTION,
  manuallyMarkedPaidAt: null,
} as const;

type WholeLodgeUnpaidState = {
  status: string;
  wholeLodgeHold?: boolean | null;
  payment?: (Partial<Payment> & { transactions?: readonly Partial<PaymentTransaction>[] }) | null;
};

/** An approval or abandoned card attempt still owes its price, net of credit. */
export function isUnpaidConfirmedWholeLodge(booking: WholeLodgeUnpaidState): boolean {
  if (booking.status !== "CONFIRMED" || booking.wholeLodgeHold !== true) return false;
  const payment = booking.payment;
  if (payment == null) return true;
  return (
    Object.entries(UNCAPTURED_CARD_FACTS).every(([field, value]) =>
      payment[field as keyof typeof UNCAPTURED_CARD_FACTS] === value,
    ) &&
    UNCAPTURED_CARD_STATUSES.some((status) => payment.status === status) &&
    typeof payment.stripePaymentIntentId === "string" &&
    payment.stripePaymentIntentId.length > 0 &&
    Array.isArray(payment.transactions) &&
    !payment.transactions.some((row) => CAPTURED_TRANSACTION_STATUS_LIST.some((status) => row.status === status)) &&
    payment.transactions.every((row) =>
      Object.entries(UNCAPTURED_PRIMARY_FACTS).every(([field, value]) =>
        row[field as keyof typeof UNCAPTURED_PRIMARY_FACTS] === value,
      ) && UNCAPTURED_CARD_STATUSES.some((status) => row.status === status),
    ) &&
    payment.transactions.some((row) =>
      Object.entries(UNCAPTURED_PRIMARY_FACTS).every(([field, value]) =>
        row[field as keyof typeof UNCAPTURED_PRIMARY_FACTS] === value,
      ) &&
      UNCAPTURED_CARD_STATUSES.some((status) => row.status === status) &&
      typeof row.stripePaymentIntentId === "string" && row.stripePaymentIntentId.length > 0,
    )
  );
}

/** Query form of the same classification, for the finished-stay collection queue. */
export function buildUnpaidConfirmedWholeLodgeWhere(): Prisma.BookingWhereInput {
  return {
    status: "CONFIRMED",
    wholeLodgeHold: true,
    OR: [
      { payment: null },
      { payment: { is: {
        ...UNCAPTURED_CARD_FACTS,
        status: { in: [...UNCAPTURED_CARD_STATUSES] },
        stripePaymentIntentId: { not: null },
        NOT: { stripePaymentIntentId: "" },
        transactions: {
          none: { OR: [
            { status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
            { NOT: { ...UNCAPTURED_PRIMARY_FACTS, status: { in: [...UNCAPTURED_CARD_STATUSES] } } },
          ] },
          some: {
            ...UNCAPTURED_PRIMARY_FACTS,
            status: { in: [...UNCAPTURED_CARD_STATUSES] },
            stripePaymentIntentId: { not: null },
            NOT: { stripePaymentIntentId: "" },
          },
        },
      } } },
    ],
  };
}

/**
 * Which unpaid bookings may switch from card to Internet Banking at pay time —
 * the ONE rule the booking page's switch button and the switch route share.
 *
 * - `PAYMENT_PENDING`: the ordinary card booking, as always.
 * - `CONFIRMED` with a whole-lodge hold (#4019): an approved
 *   member whole-lodge booking. Its approval leaves the payment method to the
 *   member, so it is CONFIRMED and capacity-holding through its hold yet owes
 *   its whole price with no receivable minted. Every other CONFIRMED booking
 *   already carries its Internet Banking receivable (school approvals, a card
 *   booking that switched with a bed hold) and is refused by the caller's
 *   "not already Internet Banking" check, not by this rule.
 *
 * The caller still applies its own gates (modules on, not deleted, not
 * organiser-settled, not already Internet Banking, a price to pay).
 */
export function isSwitchableToInternetBanking(booking: {
  status: string;
  wholeLodgeHold?: boolean | null;
}): boolean {
  if (booking.status === "PAYMENT_PENDING") return true;
  return booking.status === "CONFIRMED" && booking.wholeLodgeHold === true;
}
