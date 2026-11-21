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
 *   gone (owner decision 2, 16 Oct 2026). A superseded intent's capture the
 *   machinery is sending back is never cover either, from the moment the
 *   capture commits: until its refund row exists its in-flight cancel row owns
 *   it (`supersededCancelOwnedCents`, `INV-PAY-150`). One behind a dead cancel
 *   with no refund row is handed to nobody, so it is cash the club holds, as
 *   the Xero reading counts it (`superseded-intent-ownership.ts`);
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
  type BookingStatus,
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
import { bookingAmountOwedCents, isCapturedPaymentStatus } from "@/lib/booking-payment-state";
import { DUPLICATE_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
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
import {
  cardRefundSlicesByOperation,
  CARD_REFUND_RECOVERY_OPERATION_TYPES,
  isOpenCardRefundOperationStatus,
  unsentSliceCents,
} from "@/lib/open-card-refund-owed";
import { disputedCaptureCents, paymentDisputedCaptureCents } from "@/lib/stripe-dispute-hold";
import { supersededCaptureHeldBack, type SupersededCaptureOwnership } from "@/lib/superseded-capture-hold-back";
import { readSupersededCaptureOwnership } from "@/lib/superseded-intent-ownership";
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
  /** Refunds exceed a capture or an organiser's share, or a refunded row records less than it took. */
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
  id: string;
  stripePaymentIntentId: string | null;
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
  /**
   * What open or lost disputes hold on the booking's own captures
   * (`paymentDisputedCaptureCents`) and, for an organiser-settled child, on the
   * organiser's combined settlement capture, which has no child rows.
   */
  disputedCaptureCents: number;
  /** `readSupersededCaptureOwnership` on the booking's payment: the superseded captures the machinery still owns. */
  supersededOwnership: SupersededCaptureOwnership;
  /** The child's group, for an organiser-settled child only; null when it has none. */
  group: GroupChildCashEvidence | null;
};

/**
 * The statuses whose money this reader answers for: a real stay, live or
 * finished - not cancelled, bumped or a waitlist placeholder. That rule has a
 * home already (ADR-004's `DUPLICATE_STAY_BOOKING_STATUSES`), so it is read
 * there rather than listed again (`INV-SSOT`).
 */
const COVERS_STATUSES: readonly string[] = DUPLICATE_STAY_BOOKING_STATUSES;

const unknown = (reason: BookingCashUnknownReason): BookingCashCover => ({ kind: "unknown", reason });

/**
 * What a superseded intent's cancel row still in flight owns of its captured
 * charge that no card refund row promises back yet (`INV-PAY-150`). The
 * hand-off commits the capture under that cancel row and writes its refund row
 * afterwards (`handoffSucceededSupersededIntentToRefund`); between the two,
 * Net Collected's card-refund operand reads refund rows only and still counts
 * the capture. Who owns a charge, and how much, is the Xero reading's one rule
 * (`supersededCaptureHeldBack`). What an open card refund row already takes
 * off the same charge (`cardRefundSlicesByOperation`) is not taken twice, so
 * the refund row arriving changes nothing.
 */
function supersededCancelOwnedCents({ payment, supersededOwnership }: BookingCashSnapshot): number {
  if (!payment) return 0;
  const cancels = supersededOwnership.owning.filter(
    (row) => !(CARD_REFUND_RECOVERY_OPERATION_TYPES as readonly string[]).includes(row.type),
  );
  if (cancels.length === 0) return 0;
  const owned = supersededCaptureHeldBack(
    { owning: cancels, owedAgainByIntent: new Map() },
    payment.transactions.map((row) => ({ ...row, paymentId: payment.id })),
  ).byTransaction;
  const promised = new Map<string, number>();
  for (const { operation, slices } of cardRefundSlicesByOperation(payment)) {
    if (!isOpenCardRefundOperationStatus(operation.status)) continue;
    for (const slice of slices) {
      promised.set(slice.paymentTransactionId, (promised.get(slice.paymentTransactionId) ?? 0) + unsentSliceCents(slice));
    }
  }
  let cents = 0;
  for (const [transactionId, ownedCents] of owned) cents += Math.max(0, ownedCents - (promised.get(transactionId) ?? 0));
  return cents;
}

/** What a live booking still owes once the cash its payment holds is taken off. */
function owedNetOfHeldCash(snapshot: BookingCashSnapshot): number {
  const { booking, payment } = snapshot;
  const netCollectedHeldCents = payment ? getNetCollectedCashParts({ ...payment, booking }).heldCashCents : 0;
  // Taken off last and capped at what is left, as each Net Collected operand is.
  const heldCashCents = Math.max(0, netCollectedHeldCents - supersededCancelOwnedCents(snapshot));
  return (
    bookingAmountOwedCents({
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: payment?.changeFeeCents ?? null,
      appliedCreditCents: snapshot.appliedCreditCents,
    }) - heldCashCents
  );
}

/**
 * Can these ledger rows be read as cash at all? Null when they can. Asked of
 * whatever rows a payment has, an organiser-settled child's included: a proved
 * share does not make a backfilled row or an over-refunded one evidence.
 */
function rowEvidenceProblem(rows: CashEvidencePayment["transactions"]): BookingCashUnknownReason | null {
  if (rows.some((row) => row.reason !== null && LEGACY_BACKFILL_REASONS.includes(row.reason))) {
    return "legacy-history";
  }
  if (rows.some(isStoredFigureBankReceipt)) return "stored-figure-bank-receipt";
  return rows.some((row) => isCapturedTransactionStatus(row.status) && refundsUnproven(row))
    ? "refunds-unproven"
    : null;
}

/** Refunds above what was taken, or a refunded status recording less than it took (`captureRefundState`). */
function refundsUnproven(taken: { status: PaymentStatus; amountCents: number; refundedAmountCents: number }): boolean {
  return (
    taken.refundedAmountCents > taken.amountCents ||
    captureRefundState(taken).heldCents !== taken.amountCents - taken.refundedAmountCents
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
  const rowProblem = rowEvidenceProblem(rows);
  if (rowProblem) return rowProblem;
  const captured = rows.filter((row) => isCapturedTransactionStatus(row.status));
  const capturedCents = grossCapturedCents(rows);
  const tookMoney = netCollectedPaymentTookMoney({ ...payment, booking });
  if (!tookMoney && capturedCents === 0) {
    // A refunded status no captured row backs is not proof that nothing was
    // paid: the inbound reconcile's credit-note fold on a never-paid bank
    // payment and cash taken before the ledger leave the same mirror
    // (`stripeRefundMirrorShowsCapture`). Never "owes its whole worth".
    return isCapturedPaymentStatus(payment.status) && payment.amountCents > 0 ? "rows-disagree-with-payment" : null;
  }
  const rowRefundedCents = captured.reduce((sum, row) => sum + row.refundedAmountCents, 0);
  return tookMoney && capturedCents === payment.amountCents && rowRefundedCents === payment.refundedAmountCents
    ? null
    : "rows-disagree-with-payment";
}

/**
 * An organiser-settled child (`INV-PAY-109`, `INV-PAY-114`, `INV-PAY-137`). Its
 * money is the organiser's: the parent's cash is never counted for it, and a
 * share is counted only where the frozen settlement proves it.
 *
 * Who pays and what is held are two proofs. An organiser who has not paid
 * (`organiserPaysForNewJoiner`) is proved by the group alone: no share exists
 * yet, and `organiser_pays` claims no money. `covered` needs the share
 * (`planGroupChildLines`) and a mirror whose refunds the share can carry. The
 * settle writes that mirror with no rows of its own, so it is excused the
 * rows-to-mirror reconciliation and nothing else.
 */
function deriveGroupChildCover(snapshot: BookingCashSnapshot): BookingCashCover {
  const { booking, payment, group } = snapshot;
  if (!group) return unknown("organiser-share-unproven");
  // A fully refunded settlement may already have paid this child. Prove its
  // share before deciding whether anything remains, rather than treating it as
  // a new joiner whose organiser has never paid.
  if ((!payment || !isCapturedPaymentStatus(payment.status)) && organiserPaysForNewJoiner(group)) {
    return { kind: "organiser_pays" };
  }
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
  const rowProblem = rowEvidenceProblem(payment.transactions);
  if (rowProblem) return unknown(rowProblem);
  // The share is the mirror's `amountCents`; refunds above it are not this child's money.
  if (refundsUnproven(payment)) return unknown("refunds-unproven");
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
    select: {
      id: true,
      stripePaymentIntentId: true,
      kind: true,
      source: true,
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      reason: true,
    },
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
  const ownDisputedCents = payment ? (await paymentDisputedCaptureCents(tx, payment)).cents : 0;
  const supersededOwnership = payment
    ? await readSupersededCaptureOwnership(tx, payment.id)
    : { owning: [], owedAgainByIntent: new Map<string, number>() };
  const group =
    booking.organiserSettled && parentBooking ? await readGroupChildEvidence(tx, booking) : null;
  // A dispute on the organiser's combined capture is recorded against that
  // intent with no child payment (`readDisputesByBookingId`), so it is read here.
  const settlementDisputedCents = (await disputedCaptureCents(tx, [group?.settlement?.stripePaymentIntentId])).cents;
  return deriveBookingCashCover({
    booking: bookingFields,
    payment,
    appliedCreditCents,
    disputedCaptureCents: ownDisputedCents + settlementDisputedCents,
    supersededOwnership,
    group,
  });
}
