/**
 * The payment signals on Stuck States (#1349, #1351, #4959): how many of each
 * stuck payment state there are and, for a viewer allowed to see them, the
 * named rows behind each count. Each list reads the very `where` its count
 * reads, so the two cannot drift. Split out of `stuck-state-dashboard.ts`,
 * which builds the cards; this module only reads.
 */
import type { PaymentRecoveryOperationType, Prisma } from "@prisma/client";
import { BOOKING_OWNER_NAME_SELECT, bookingOwnerName } from "@/lib/booking-owner-name";
import { formatBookingReference } from "@/lib/booking-reference";
import { groupSettlementReapDeadline } from "@/lib/cron-group-settlement-reaper";
import { SETTLEMENT_MARKER_EVENT_REASONS } from "@/lib/manual-settlement-reversal-event";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS, PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";

export const PAYMENT_PROCESSING_STALE_MINUTES = 30;
export const PAYMENT_PENDING_OVERDUE_MINUTES = 15;
// #1349 (F2): lookback window for the cancelled-with-unrecorded-refund
// detector. Bounds noise from historical deliberate zero-refund cancellations
// that predate BookingEvent narratives while still catching any recent cancel
// that crashed between its claim commit and the Stripe refund.
export const CANCELLED_REFUND_UNRECORDED_LOOKBACK_DAYS = 90;
/**
 * #4959: the most named rows one signal lists. Its count stays the full total,
 * and the page says how many more there are.
 */
export const STUCK_STATE_DETAIL_ROW_CAP = 50;

/** One named row under a signal: a booking, its owner, and a plain line. */
export interface StuckStateDetail {
  id: string;
  title: string;
  summary: string;
  href: string;
}

/** How a detail row prints money and an instant (#4959), in the club's format and zone. */
export interface StuckStateDetailFormat {
  cents(cents: number): string;
  instantDate(instant: Date): string;
}

export type CountDelegate = {
  count(args: unknown): Promise<number>;
};

export type FindManyDelegate = {
  findMany(args: unknown): Promise<unknown[]>;
};

/** What the payment signals read; the dashboard's dependencies satisfy it. */
interface PaymentSignalDependencies {
  db: {
    paymentRecoveryOperation: CountDelegate & FindManyDelegate;
    booking: CountDelegate & FindManyDelegate;
    groupBookingSettlement: FindManyDelegate;
  };
  listDeadCardRefundOperationIds: () => Promise<ReadonlySet<string>>;
  loadDetailFormat: () => Promise<StuckStateDetailFormat>;
}

export type OwnedBooking = Prisma.BookingGetPayload<{
  select: typeof OWNED_BOOKING_SELECT;
}>;

/** What a named row selects of its booking: the id and the owner's name. */
export const OWNED_BOOKING_SELECT = {
  id: true,
  ...BOOKING_OWNER_NAME_SELECT,
} satisfies Prisma.BookingSelect;

/**
 * #4959: one named row — the booking's reference and owner (`bookingOwnerName`,
 * an organisation as well as a member), a plain line, and the booking's page.
 */
export function bookingDetailRow(
  id: string,
  booking: OwnedBooking,
  summary: string,
): StuckStateDetail {
  return {
    id,
    title: `${formatBookingReference(booking.id)} - ${bookingOwnerName(booking)}`,
    summary,
    href: `/bookings/${booking.id}`,
  };
}

export type PaymentSignal =
  | "exhaustedFailed"
  | "staleProcessing"
  | "overduePending"
  | "staleSettlements"
  | "cancelledUnrecordedRefunds"
  | "unexecutedSettlementRefunds";

/** #4959: what a recovery operation is for, in words an officer reads. */
const RECOVERY_OPERATION_PURPOSE: Record<PaymentRecoveryOperationType, string> = {
  CANCEL_PAYMENT_INTENT: "Cancel an unused card payment",
  REFUND_SUPERSEDED_PAYMENT: "Refund a replaced card payment",
  REFUND_BOOKING_MODIFICATION: "Card refund",
  CREATE_ADDITIONAL_PAYMENT_INTENT: "Create a card request",
};

/**
 * What a recovery operation's named row reads (#4959). Never `lastError`, a
 * Stripe id or an idempotency key: the row names the booking, not the provider.
 */
const RECOVERY_OPERATION_ROW_SELECT = {
  id: true,
  type: true,
  amountCents: true,
  createdAt: true,
  booking: { select: OWNED_BOOKING_SELECT },
} satisfies Prisma.PaymentRecoveryOperationSelect;

type RecoveryOperationRow = Prisma.PaymentRecoveryOperationGetPayload<{
  select: typeof RECOVERY_OPERATION_ROW_SELECT;
}>;

/** An operation PROCESSING longer than a worker run can last. One where for the count and its rows. */
function staleProcessingRecoveryWhere(now: Date) {
  return {
    status: "PROCESSING",
    processingStartedAt: {
      lt: new Date(now.getTime() - PAYMENT_PROCESSING_STALE_MINUTES * 60 * 1000),
    },
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/** A retryable PENDING operation nobody claimed past its retry time. One where for the count and its rows. */
function overduePendingRecoveryWhere(now: Date) {
  return {
    status: "PENDING",
    nextRetryAt: {
      lte: new Date(now.getTime() - PAYMENT_PENDING_OVERDUE_MINUTES * 60 * 1000),
    },
    attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/**
 * #1349 (F2) crash-window detector: a CANCELLED booking that kept a fully
 * captured, unrefunded payment with NO refund-recovery operation and NO
 * cancellation narrative event can only be a cancel that died between the
 * claim commit and Phase 2 (deliberate zero-refund cancels write their
 * CANCELLED BookingEvent; refunds bump refundedAmountCents; the #1349
 * in-transaction enqueue leaves a recovery operation). Before #1349 NOTHING
 * fired for this state — the member's refund was silently lost. #4959: the
 * count and the named rows both read this one where.
 */
function cancelledRefundUnrecordedWhere(now: Date) {
  return {
    status: "CANCELLED",
    deletedAt: null,
    updatedAt: {
      gte: new Date(
        now.getTime() -
          CANCELLED_REFUND_UNRECORDED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      ),
    },
    payment: {
      is: {
        status: "SUCCEEDED",
        refundedAmountCents: 0,
        amountCents: { gt: 0 },
      },
    },
    paymentRecoveryOperations: {
      none: { type: "REFUND_BOOKING_MODIFICATION" },
    },
    events: {
      // #2262 — the admin-only settlement markers are stored as
      // CANCELLED events (reversal / reciprocal-fence conflict, and
      // #3638's second-instrument conflict) but cancel
      // nothing, so they must not count as "the cancel wrote its
      // narrative event" here: a genuinely crashed cancel on a booking
      // that once hit a marker would otherwise be invisible. The DB-level
      // twin of booking-narrative's isManualSettlementMarkerEvent
      // exclusion, keyed on the markers' constant `reason` strings (the
      // snapshot discriminator is not expressible in this relation
      // filter). The OR keeps a NULL-reason genuine cancel event counted —
      // a bare notIn would drop NULL rows under SQL three-valued logic.
      // #2008's duplicate-capture marker does NOT share this shape (it is
      // a REFUNDED event), so it needs no exclusion here.
      none: {
        type: "CANCELLED",
        OR: [
          { reason: null },
          {
            reason: {
              notIn: [...SETTLEMENT_MARKER_EVENT_REASONS],
            },
          },
        ],
      },
    },
  } satisfies Prisma.BookingWhereInput;
}

/** The organiser's booking behind a group settlement, for its named row. */
const SETTLEMENT_ORGANISER_SELECT = {
  groupBooking: { select: { organiserBooking: { select: OWNED_BOOKING_SELECT } } },
} satisfies Prisma.GroupBookingSettlementSelect;

type SettlementOrganiser = Prisma.GroupBookingSettlementGetPayload<{
  select: typeof SETTLEMENT_ORGANISER_SELECT;
}>;

export async function getPaymentSignals(
  deps: PaymentSignalDependencies,
  now: Date,
  // #4959 (#2823): read and name the rows only for a viewer allowed to see them.
  showRows: boolean,
): Promise<{
  counts: Record<PaymentSignal, number>;
  details: Record<PaymentSignal, StuckStateDetail[]> | undefined;
}> {
  // F3 (#1351): a SUCCEEDED settlement under a CANCELLED group whose persisted
  // refund plan was never executed — the organiser's settlement refund has not
  // completed. The recovery queue retries it (and alerts on exhaustion); this
  // tile keeps the state visible to operators the whole time, including for
  // incidents that predate the durable retry. #4959: the rows are this same
  // filtered read, oldest first, so they cannot drift from the count.
  const unexecuted = (
    (await deps.db.groupBookingSettlement.findMany({
      where: {
        status: "SUCCEEDED",
        groupBooking: { status: "CANCELLED" },
      },
      select: showRows
        ? { refundPlan: true, id: true, amountCents: true, ...SETTLEMENT_ORGANISER_SELECT }
        : { refundPlan: true },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    })) as Array<{ refundPlan: unknown } & Partial<{ id: string; amountCents: number } & SettlementOrganiser>>
  ).filter((settlement) => settlement.refundPlan != null);

  const stale = (
    (await deps.db.groupBookingSettlement.findMany({
      where: { status: { in: ["PENDING", "FAILED"] } },
      select: {
        updatedAt: true,
        ...(showRows ? { id: true, amountCents: true } : {}),
        groupBooking: {
          select: {
            organiserBooking: {
              select: { checkIn: true, ...(showRows ? OWNED_BOOKING_SELECT : {}) },
            },
          },
        },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    })) as Array<{
      updatedAt: Date;
      id?: string;
      amountCents?: number;
      groupBooking: { organiserBooking: { checkIn: Date } & Partial<OwnedBooking> };
    }>
  )
    .map((settlement) => ({
      settlement,
      deadline: groupSettlementReapDeadline(
        settlement.updatedAt,
        settlement.groupBooking.organiserBooking.checkIn,
      ),
    }))
    .filter(({ deadline }) => now >= deadline);

  const [
    exhaustedFailed,
    staleProcessing,
    overduePending,
    cancelledUnrecordedRefunds,
  ] = await Promise.all([
    // #4104: a card refund raised dead is PENDING with its attempts spent.
    deps.db.paymentRecoveryOperation.count({ where: PAYMENT_RECOVERY_EXHAUSTED_WHERE }),
    deps.db.paymentRecoveryOperation.count({ where: staleProcessingRecoveryWhere(now) }),
    deps.db.paymentRecoveryOperation.count({ where: overduePendingRecoveryWhere(now) }),
    deps.db.booking.count({ where: cancelledRefundUnrecordedWhere(now) }),
  ]);

  const counts = {
    exhaustedFailed,
    staleProcessing,
    overduePending,
    staleSettlements: stale.length,
    cancelledUnrecordedRefunds,
    unexecutedSettlementRefunds: unexecuted.length,
  };
  if (!showRows) return { counts, details: undefined };

  const recoveryRows = (where: Prisma.PaymentRecoveryOperationWhereInput, count: number) =>
    count > 0
      ? (deps.db.paymentRecoveryOperation.findMany({
          where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: STUCK_STATE_DETAIL_ROW_CAP,
          select: RECOVERY_OPERATION_ROW_SELECT,
        }) as Promise<RecoveryOperationRow[]>)
      : Promise.resolve([]);
  const [format, exhaustedRows, staleRows, overdueRows, cancelledRows, deadCardRefunds] =
    await Promise.all([
      deps.loadDetailFormat(),
      recoveryRows(PAYMENT_RECOVERY_EXHAUSTED_WHERE, exhaustedFailed),
      recoveryRows(staleProcessingRecoveryWhere(now), staleProcessing),
      recoveryRows(overduePendingRecoveryWhere(now), overduePending),
      cancelledUnrecordedRefunds > 0
        ? (deps.db.booking.findMany({
            where: cancelledRefundUnrecordedWhere(now),
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: STUCK_STATE_DETAIL_ROW_CAP,
            select: {
              ...OWNED_BOOKING_SELECT,
              updatedAt: true,
              lodge: { select: { name: true } },
              payment: { select: { amountCents: true } },
            },
          }) as Promise<Array<OwnedBooking & {
            updatedAt: Date;
            lodge: { name: string } | null;
            payment: { amountCents: number } | null;
          }>>)
        : Promise.resolve([]),
      exhaustedFailed > 0 ? deps.listDeadCardRefundOperationIds() : Promise.resolve(new Set<string>()),
    ]);

  const recoveryDetail = (operation: RecoveryOperationRow, close?: string) =>
    bookingDetailRow(
      operation.id,
      operation.booking,
      `${RECOVERY_OPERATION_PURPOSE[operation.type]} of ${format.cents(operation.amountCents)}, raised ${format.instantDate(operation.createdAt)}.${close ? ` ${close}` : ""}`,
    );
  const settlementDetail = (
    settlement: { id?: string; amountCents?: number } & { groupBooking: { organiserBooking: Partial<OwnedBooking> } },
    summary: string,
  ) =>
    bookingDetailRow(
      settlement.id as string,
      settlement.groupBooking.organiserBooking as OwnedBooking,
      summary,
    );

  return {
    counts,
    details: {
      exhaustedFailed: exhaustedRows.map((operation) =>
        recoveryDetail(
          operation,
          deadCardRefunds.has(operation.id)
            ? 'Settle it under "Card refunds Stripe gave up on" on this page.'
            : undefined,
        ),
      ),
      staleProcessing: staleRows.map((operation) => recoveryDetail(operation)),
      overduePending: overdueRows.map((operation) => recoveryDetail(operation)),
      cancelledUnrecordedRefunds: cancelledRows.map((booking) =>
        bookingDetailRow(
          booking.id,
          booking,
          `${booking.lodge?.name ?? "Lodge"}; ${format.cents(booking.payment?.amountCents ?? 0)} captured and not refunded; cancelled, last changed ${format.instantDate(booking.updatedAt)}.`,
        ),
      ),
      unexecutedSettlementRefunds: unexecuted
        .slice(0, STUCK_STATE_DETAIL_ROW_CAP)
        .map((settlement) =>
          settlementDetail(
            settlement as typeof settlement & SettlementOrganiser,
            `Group cancelled; the organiser's ${format.cents(settlement.amountCents ?? 0)} settlement has a refund plan not yet carried out.`,
          ),
        ),
      staleSettlements: stale
        .slice(0, STUCK_STATE_DETAIL_ROW_CAP)
        .map(({ settlement, deadline }) =>
          settlementDetail(
            settlement,
            `Group settlement of ${format.cents(settlement.amountCents ?? 0)} unpaid since its reap deadline, ${format.instantDate(deadline)}.`,
          ),
        ),
    },
  };
}
