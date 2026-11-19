/**
 * IS THIS BOOKING COVERED BY MONEY THE CLUB ACTUALLY HOLDS? One home (#4069,
 * `INV-PAY-159`; owner decisions of 15 and 16 Oct 2026; blueprint
 * `docs/design/paid-from-cash.md`).
 *
 * A booking's status is its lifecycle, never proof of payment: CONFIRMED can
 * owe a whole bank transfer (the bed-holding switch, an approved whole-lodge
 * booking), and PAID with a PARTIALLY_REFUNDED payment can be fully covered at
 * a lower price. This reader decides from the cash records instead:
 *
 * - owed side: `bookingAmountOwedCents` - worth (price plus the recorded change
 *   fee) less applied credit, read once from its ledger rows;
 * - paid side: the cash the payment still holds, Net Collected's cash half
 *   (`getNetCollectedCashParts`): what it took, less recorded refunds, open
 *   hand-backs, card refunds not yet paid (failed, owed or superseded) and late
 *   captures awaiting the treasurer, each counted once. Refunds owed count as
 *   gone (owner decision 2, 16 Oct 2026);
 * - evidence: that payment mirror counts only when its captured
 *   `PaymentTransaction` rows agree with it, so a pending face amount never
 *   counts. Where the records cannot prove the figure the answer is `unknown`
 *   (owner decision 3), never a status fallback.
 *
 * `deriveBookingCashCover` is pure; `readBookingCashCover` loads its snapshot
 * through the caller's transaction client and nothing else. Run it inside one
 * `withReadOnlySnapshot` with whatever else the answer is shown beside. It
 * writes nothing, takes no lock and calls no provider. It never reads the
 * booking ledger's balance (`INV-MONEY-037`) or `readBookingAmountOwed`, whose
 * pay-step contract (`INV-PAY-119`) is unchanged; `amount-owed-one-home.test.ts`
 * pins both. Ledger M11 (#4523) extends this reader; it adds no second one.
 */
import {
  BookingStatus,
  type GroupBookingPaymentMode,
  type PaymentSource,
  type PaymentStatus,
  type PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";

import { netCollectedCaptureEvidenceSelect, netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import {
  groupChildHandBacksFromRows,
  organiserCardAppealRefundsFromRows,
  planGroupChildLines,
  type GroupChildSettlement,
  type GroupChildSibling,
} from "@/lib/booking-ledger-group-child-plan";
import { bookingAmountOwedCents } from "@/lib/booking-payment-state";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import { paidByOrganiser, paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { organiserPaysForNewJoiner } from "@/lib/group-late-joiner";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import {
  getNetCollectedCashParts,
  netCollectedPaymentTookMoney,
  type NetCollectedCashRow,
} from "@/lib/payment-net-collected";
import {
  captureRefundState,
  grossCapturedCents,
  isCapturedTransactionStatus,
  LEGACY_BACKFILL_REASONS,
} from "@/lib/payment-transaction-status";
import { paymentDisputedCaptureCents } from "@/lib/stripe-dispute-hold";
import { isStoredFigureBankReceipt } from "@/lib/xero-inbound/ib-receipt-reasons";

/** Why the records cannot prove what a booking holds. */
export type BookingCashUnknownReason =
  /** Cancelled, bumped, waitlisted or deleted: its money is the cancellation's question. */
  | "booking-not-live"
  /** A ledger row seeded from the payment's columns, not from a capture. */
  | "legacy-history"
  /** A bank receipt holding the figure the payment was born with, not cash read from Xero. */
  | "stored-figure-bank-receipt"
  /** The payment mirror and its captured rows disagree (or a capture has no rows). */
  | "rows-disagree-with-payment"
  /** A row's refunds exceed its capture, or a refunded row records less than it took. */
  | "refunds-unproven"
  /** An open or lost dispute holds a capture (`INV-PAY-154`). */
  | "disputed"
  /** An organiser-settled child whose share the frozen settlement cannot prove. */
  | "organiser-share-unproven";

/**
 * The one answer (`INV-PAY-159`). `owes.cents` is above zero. `organiser_pays`
 * is a group child whose organiser pays: the member is never asked. `unknown`
 * never becomes paid, unpaid, zero due or a personal demand.
 */
export type BookingCashCover =
  | { kind: "covered" }
  | { kind: "owes"; cents: number }
  | { kind: "organiser_pays" }
  | { kind: "unknown"; reason: BookingCashUnknownReason };

/** A `PaymentTransaction` row, as the evidence check reads it. */
export type CashEvidenceTransactionRow = {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
  reason: string | null;
};

/** The booking's one payment: Net Collected's cash row, its change fee and its rows. */
export type CashEvidencePayment = Omit<NetCollectedCashRow, "booking" | "source" | "status"> & {
  id: string;
  source: PaymentSource;
  status: PaymentStatus;
  changeFeeCents: number | null;
  transactions: ReadonlyArray<CashEvidenceTransactionRow>;
};

/** What an organiser-settled child's share is proved from (`planGroupChildLines`). */
export type GroupChildCashEvidence = {
  paymentMode: GroupBookingPaymentMode;
  settlement: (GroupChildSettlement & { status: PaymentStatus }) | null;
  siblings: readonly GroupChildSibling[];
  handBacks: Parameters<typeof planGroupChildLines>[0]["handBacks"];
  appealRefunds: Parameters<typeof planGroupChildLines>[0]["appealRefunds"];
};

/** Everything the answer reads, from one snapshot. */
export type BookingCashSnapshot = {
  booking: NetCollectedCashRow["booking"] & {
    id: string;
    status: BookingStatus;
    lodgeId: string;
    finalPriceCents: number;
  };
  payment: CashEvidencePayment | null;
  /** `deriveBookingAppliedCreditCents`: the ledger's applied credit, read once. */
  appliedCreditCents: number;
  /** `paymentDisputedCaptureCents`: what open or lost disputes hold. */
  disputedCaptureCents: number;
  /** The child's group, for an organiser-settled child only; null when it has none. */
  group: GroupChildCashEvidence | null;
};

const COVERS_STATUSES: readonly string[] = [...ACTIVE_BOOKING_STATUSES, BookingStatus.COMPLETED];

const unknown = (reason: BookingCashUnknownReason): BookingCashCover => ({ kind: "unknown", reason });

/** What a live booking still owes once the cash its payment holds is taken off. */
function owedNetOfHeldCash(snapshot: BookingCashSnapshot): number {
  const { booking, payment } = snapshot;
  const heldCashCents = payment ? getNetCollectedCashParts({ ...payment, booking }).heldCashCents : 0;
  return (
    bookingAmountOwedCents({
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: payment?.changeFeeCents ?? null,
      appliedCreditCents: snapshot.appliedCreditCents,
    }) - heldCashCents
  );
}

/**
 * Do the payment's ledger rows prove its mirror? Null when they do. The mirror
 * is what Net Collected reads; it counts here only as the cash its captured
 * rows record.
 */
function paymentEvidenceProblem(
  payment: CashEvidencePayment,
  booking: BookingCashSnapshot["booking"],
): BookingCashUnknownReason | null {
  const rows = payment.transactions;
  if (rows.some((row) => row.reason !== null && LEGACY_BACKFILL_REASONS.includes(row.reason))) {
    return "legacy-history";
  }
  if (rows.some(isStoredFigureBankReceipt)) return "stored-figure-bank-receipt";
  const captured = rows.filter((row) => isCapturedTransactionStatus(row.status));
  if (
    captured.some(
      (row) =>
        row.refundedAmountCents > row.amountCents ||
        captureRefundState(row).heldCents !== row.amountCents - row.refundedAmountCents,
    )
  ) {
    return "refunds-unproven";
  }
  const capturedCents = grossCapturedCents(rows);
  const tookMoney = netCollectedPaymentTookMoney({ ...payment, booking });
  if (!tookMoney && capturedCents === 0) return null;
  const rowRefundedCents = captured.reduce((sum, row) => sum + row.refundedAmountCents, 0);
  return tookMoney && capturedCents === payment.amountCents && rowRefundedCents === payment.refundedAmountCents
    ? null
    : "rows-disagree-with-payment";
}

/**
 * An organiser-settled child (`INV-PAY-109`, `INV-PAY-114`, `INV-PAY-137`). Its
 * money is the organiser's: the parent's cash is never counted for it, and a
 * share is counted only where the frozen settlement proves it.
 */
function deriveGroupChildCover(snapshot: BookingCashSnapshot): BookingCashCover {
  const { booking, payment, group } = snapshot;
  if (!group) return unknown("organiser-share-unproven");
  if (organiserPaysForNewJoiner(group)) return { kind: "organiser_pays" };
  const child = { ...booking, payment };
  if (!payment || !group.settlement || !paidByOrganiser(child)) return unknown("organiser-share-unproven");
  const plan = planGroupChildLines({
    child: { id: booking.id, lodgeId: booking.lodgeId, status: booking.status, cancelledWithoutSnapshot: false },
    payment,
    settlement: group.settlement,
    siblings: group.siblings,
    perChildCommittedRefundCents: null,
    handBacks: group.handBacks,
    appealRefunds: group.appealRefunds,
  });
  if (plan?.kind !== "plan") return unknown("organiser-share-unproven");
  if (owedNetOfHeldCash(snapshot) <= 0) return { kind: "covered" };
  // A rise after the settle on a child paid by bank transfer is invoiced to
  // the organiser (`organiser-extra-invoice-queue.ts`); a card child's rise is
  // refused (`ORGANISER_CHILD_CHARGE_REFUSAL`), so a shortfall there is unproven.
  return paidByOrganiserInternetBanking(child) ? { kind: "organiser_pays" } : unknown("organiser-share-unproven");
}

/** THE answer, from one snapshot (`INV-PAY-159`). Pure. */
export function deriveBookingCashCover(snapshot: BookingCashSnapshot): BookingCashCover {
  const { booking, payment } = snapshot;
  if (booking.deletedAt !== null || !COVERS_STATUSES.includes(booking.status)) return unknown("booking-not-live");
  if (snapshot.disputedCaptureCents > 0) return unknown("disputed");
  if (booking.organiserSettled && booking.parentBookingId !== null) return deriveGroupChildCover(snapshot);
  const problem = payment ? paymentEvidenceProblem(payment, booking) : null;
  if (problem) return unknown(problem);
  const owedCents = owedNetOfHeldCash(snapshot);
  return owedCents > 0 ? { kind: "owes", cents: owedCents } : { kind: "covered" };
}

const cashEvidencePaymentSelect = {
  ...netCollectedCaptureEvidenceSelect,
  ...netCollectedCardRefundSelect,
  id: true,
  status: true,
  source: true,
  amountCents: true,
  refundedAmountCents: true,
  changeFeeCents: true,
  stripePaymentIntentId: true,
  additionalPaymentIntentId: true,
  transactions: {
    select: { kind: true, source: true, status: true, amountCents: true, refundedAmountCents: true, reason: true },
  },
} satisfies Prisma.PaymentSelect;

const cashEvidenceBookingSelect = {
  id: true,
  lodgeId: true,
  status: true,
  deletedAt: true,
  finalPriceCents: true,
  organiserSettled: true,
  parentBookingId: true,
  creditsFromCancellation: {
    select: { type: true, amountCents: true, description: true, restoredFromBookingId: true },
  },
  manualRefundTasks: {
    select: {
      status: true,
      kind: true,
      amountCents: true,
      partPaymentReviewPaymentId: true,
      occurrenceKey: true,
      reason: true,
      paymentId: true,
      settlementDirection: true,
    },
  },
  payment: { select: cashEvidencePaymentSelect },
  parentBooking: {
    select: {
      id: true,
      groupBookingAsOrganiser: {
        select: {
          paymentMode: true,
          settlement: {
            select: { id: true, source: true, amountCents: true, stripePaymentIntentId: true, refundPlan: true, status: true },
          },
        },
      },
    },
  },
} satisfies Prisma.BookingSelect;

/** The group evidence an organiser-settled child's share is proved from, through `tx`. */
async function readGroupChildEvidence(
  tx: Prisma.TransactionClient,
  booking: Prisma.BookingGetPayload<{ select: typeof cashEvidenceBookingSelect }>,
): Promise<GroupChildCashEvidence | null> {
  const parent = booking.parentBooking;
  const group = parent?.groupBookingAsOrganiser;
  if (!parent || !group) return null;
  const settlement = group.settlement;
  const siblings = settlement
    ? await tx.booking.findMany({
        where: { parentBookingId: parent.id, organiserSettled: true },
        orderBy: { id: "asc" },
        select: { id: true, lodgeId: true, payment: { select: { amountCents: true, status: true, source: true } } },
      })
    : [];
  const operations =
    booking.payment && settlement?.stripePaymentIntentId
      ? await tx.paymentRecoveryOperation.findMany({
          where: { paymentId: booking.payment.id },
          select: { status: true, amountCents: true, idempotencyKey: true, paymentId: true, paymentIntentId: true },
        })
      : [];
  return {
    paymentMode: group.paymentMode,
    // A live child holds no plan refund, so whether one was paid by bank does
    // not arise (the live settlement sync passes false the same way).
    settlement: settlement ? { ...settlement, refundPaidByBank: false } : null,
    siblings,
    handBacks: groupChildHandBacksFromRows(booking.payment?.id ?? "", booking.manualRefundTasks),
    appealRefunds: organiserCardAppealRefundsFromRows({
      paymentId: booking.payment?.id ?? "",
      paymentIntentId: settlement?.stripePaymentIntentId ?? null,
      operations,
    }),
  };
}

/**
 * Load the snapshot and answer (`INV-PAY-159`). Every read goes through `tx`,
 * so a caller's `withReadOnlySnapshot` makes the answer, and whatever it reads
 * beside it, one moment's. Null when no such booking exists.
 */
export async function readBookingCashCover(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<BookingCashCover | null> {
  const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: cashEvidenceBookingSelect });
  if (!booking) return null;
  const { payment, parentBooking, ...bookingFields } = booking;
  // One after another: an interactive transaction runs one statement at a time.
  const appliedCreditCents = await deriveBookingAppliedCreditCents(bookingId, tx);
  const disputedCaptureCents = payment ? (await paymentDisputedCaptureCents(tx, payment)).cents : 0;
  const group =
    booking.organiserSettled && parentBooking ? await readGroupChildEvidence(tx, booking) : null;
  return deriveBookingCashCover({ booking: bookingFields, payment, appliedCreditCents, disputedCaptureCents, group });
}
