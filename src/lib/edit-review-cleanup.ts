import "server-only";

import { ManualRefundTaskKind, type Prisma, type PrismaClient } from "@prisma/client";

import { hasIssuedPrimaryXeroInvoice, hasCapturedPayment } from "@/lib/booking-payment-state";
import {
  rebaseDivergesFromIssuedInvoice,
  type BookingPriceRebase,
} from "@/lib/booking-review-price-rebase";
import { calculateModificationChangeFee } from "@/lib/booking-modify-plan";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";
import { censusBookingMoneyReconciliation } from "@/lib/booking-money-reconciliation-store";
import type { ClubFormat } from "@/lib/club-format";
import {
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
  type CalendarDate,
  type ClubTimeZone,
} from "@/lib/club-time";
import {
  EDIT_FINANCIAL_REVIEW_ADDITIONAL_INTENT_RECOVERY_PREFIX,
  EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX,
} from "@/lib/payment-recovery-keys";
import { exactContains, exactPrefix } from "@/lib/prisma-exact-prefix";
import type { ManualRefundTaskResolution } from "@/lib/manual-refund-task-resolution-input";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { prisma } from "@/lib/prisma";
import { withReadOnlySnapshot } from "@/lib/read-only-snapshot";
import { recordReviewClosurePricing } from "@/lib/stored-night-price-repair-store";
import { rerunnableOperationWhere } from "@/lib/xero-active-operation-statuses";
import type { BookingJournalContext } from "@/lib/member-money/doors";
import type { LedgerNightValueCensus } from "@/lib/ledger-night-value-census";
import { summarizeEditFinancialReviews } from "@/lib/night-price-provenance-census";
import {
  addedNightPriceKey,
  decideOpenEditReview,
  guestStoredTotalCents,
  isFrozenEditReviewHeadline,
  listDismissedShortenings,
  modificationCheckInChange,
  type CleanupBooking,
  type CleanupGuest,
  type CleanupMoneyColumns,
  type D7Row,
  type OpenEditReviewDecision,
  type OpenEditReviewInput,
} from "@/lib/edit-review-cleanup-plan";

/**
 * Wave B (#4343): settle or close every still-OPEN edit review, and re-base
 * frozen headlines. The owner runs it; nothing here runs itself.
 *
 * Money for an OPEN review goes through `resolveManualRefundTask` only. The
 * headline pass calls `recordReviewClosurePricing` with an empty repair list,
 * which is the closure's re-base (`rebaseBookingPriceFromStrands`) and its
 * ledger poster. A second apply finds nothing left to do.
 */

export type EditReviewCleanupMode = "census" | "dry-run" | "apply";

export type LoadedEditReview = {
  id: string;
  bookingId: string;
  status: string;
  reviewContext: unknown;
  createdAt: Date;
  booking: CleanupMoneyColumns & {
    id: string;
    status: string;
    lodgeId: string;
    memberId: string | null;
    checkIn: Date;
    guests: Array<CleanupGuest & { nights: Array<{ stayDate: Date; priceCents: number | null }> }>;
    payment: { id: string; status: string; amountCents: number | null; xeroInvoiceId: string | null } | null;
  };
  modification: { id: string; changeFeeCents: number; previousData: unknown; newData: unknown } | null;
  /** What the normal change-fee function would charge. The decision may still add nothing. */
  prospectiveChangeFeeCents: number;
};

export type CleanupGate = {
  /** Review-keyed recovery rows that have not succeeded. */
  paymentRecoveryNotSucceeded: number;
  /** Charge-raise leases still holding a token. */
  chargeClaimsHoldingToken: number;
  /** Rerunnable Xero operations anchored on a review task, its modification, or a review key. */
  xeroOutstandingOrFailed: number;
};

export type HeadlinePassResult =
  | { kind: "unchanged"; bookingId: string; before: CleanupMoneyColumns }
  | {
      kind: "declined";
      bookingId: string;
      before: CleanupMoneyColumns;
      message: string;
    }
  | {
      kind: "raced";
      bookingId: string;
      message: string;
    }
  | {
      kind: "rebased";
      bookingId: string;
      before: CleanupMoneyColumns;
      after: CleanupMoneyColumns;
      invoiceDiverged: boolean;
      /** False when the closure poster wrote no line for the new history row. */
      ledgerPosted: boolean;
    };

export type LeftOpenRow = {
  bookingId: string;
  taskId: string;
  message: string;
};

export type EditReviewCleanupReport = {
  mode: EditReviewCleanupMode;
  reviewsByStatus: Record<string, number>;
  openCount: number;
  frozen: Array<{ bookingId: string; totalPriceCents: number; guestSumCents: number }>;
  d7: D7Row[];
  decisions: OpenEditReviewDecision[];
  settled: OpenEditReviewDecision[];
  closedWithNoMoney: OpenEditReviewDecision[];
  leftOpen: LeftOpenRow[];
  headlines: HeadlinePassResult[];
  ledgerNightValues: LedgerNightValueCensus;
  gate: CleanupGate;
};

const HEADLINE_NOTE =
  "Wave B cleanup: re-set the booking's headline to the sum of its guests' stored totals. No money was moved.";

class HeadlineDryRun extends Error {
  constructor(readonly result: HeadlinePassResult) {
    super("edit-review headline dry-run");
    this.name = "HeadlineDryRun";
  }
}

function moneyColumns(booking: CleanupMoneyColumns): CleanupMoneyColumns {
  return {
    totalPriceCents: booking.totalPriceCents,
    discountCents: booking.discountCents,
    promoAdjustmentCents: booking.promoAdjustmentCents,
    finalPriceCents: booking.finalPriceCents,
  };
}

/** One loaded review as the pure decision sees it. */
export function toOpenEditReviewInput(row: LoadedEditReview): OpenEditReviewInput {
  const checkIn = row.modification
    ? modificationCheckInChange(row.modification.previousData, row.modification.newData)
    : { changed: false, previousCheckIn: null, newCheckIn: null, unreadable: false };
  const addedNightPrices = new Map<string, number | null>();
  for (const guest of row.booking.guests) {
    for (const night of guest.nights) {
      addedNightPrices.set(
        addedNightPriceKey(guest.id, calendarDateOfDateOnlyInstant(night.stayDate)),
        night.priceCents,
      );
    }
  }
  return {
    taskId: row.id,
    bookingId: row.bookingId,
    reviewContext: row.reviewContext,
    currentGuestIds: new Set(row.booking.guests.map((guest) => guest.id)),
    addedNightPrices,
    checkInChanged: checkIn.changed,
    changeFeeAlreadyChargedCents: row.modification?.changeFeeCents ?? 0,
    prospectiveChangeFeeCents: row.prospectiveChangeFeeCents,
    changeFeeUnreadable: row.modification !== null && checkIn.unreadable,
    bookingStatus: row.booking.status,
    paymentCaptured: hasCapturedPayment(row.booking.payment),
  };
}

function bookingOf(row: LoadedEditReview): CleanupBooking {
  return {
    ...moneyColumns(row.booking),
    id: row.booking.id,
    guests: row.booking.guests.map((guest) => ({ id: guest.id, priceCents: guest.priceCents })),
  };
}

export function planEditReviewCleanup(rows: readonly LoadedEditReview[]): {
  decisions: OpenEditReviewDecision[];
  frozen: Array<{ bookingId: string; totalPriceCents: number; guestSumCents: number }>;
  d7: D7Row[];
} {
  const tasks = rows.map((row) => ({
    id: row.id,
    bookingId: row.bookingId,
    status: row.status,
    reviewContext: row.reviewContext,
  }));
  const decisions = rows
    .filter((row) => row.status === "OPEN")
    .map((row) => decideOpenEditReview(toOpenEditReviewInput(row)));
  const seen = new Set<string>();
  const frozen: Array<{ bookingId: string; totalPriceCents: number; guestSumCents: number }> = [];
  for (const row of rows) {
    if (seen.has(row.bookingId)) continue;
    seen.add(row.bookingId);
    const booking = bookingOf(row);
    if (!isFrozenEditReviewHeadline(booking, tasks)) continue;
    frozen.push({
      bookingId: booking.id,
      totalPriceCents: booking.totalPriceCents,
      guestSumCents: guestStoredTotalCents(booking.guests),
    });
  }
  const guestsByBooking = new Map<string, readonly CleanupGuest[]>();
  for (const row of rows) {
    if (!guestsByBooking.has(row.bookingId)) {
      guestsByBooking.set(
        row.bookingId,
        row.booking.guests.map((guest) => ({ id: guest.id, priceCents: guest.priceCents })),
      );
    }
  }
  return { decisions, frozen, d7: listDismissedShortenings(tasks, guestsByBooking) };
}

const REVIEW_SELECT = {
  id: true,
  bookingId: true,
  status: true,
  reviewContext: true,
  createdAt: true,
  booking: {
    select: {
      id: true,
      status: true,
      lodgeId: true,
      memberId: true,
      checkIn: true,
      totalPriceCents: true,
      discountCents: true,
      promoAdjustmentCents: true,
      finalPriceCents: true,
      guests: {
        select: {
          id: true,
          priceCents: true,
          nights: { select: { stayDate: true, priceCents: true } },
        },
      },
      payment: { select: { id: true, status: true, amountCents: true, xeroInvoiceId: true } },
    },
  },
} as const;

type ReviewRow = Prisma.ManualRefundTaskGetPayload<{ select: typeof REVIEW_SELECT }>;

async function prospectiveFee(
  row: ReviewRow,
  modification: LoadedEditReview["modification"],
  store: Prisma.TransactionClient,
  todayAtClub: CalendarDate,
): Promise<number> {
  if (modification === null) return 0;
  const checkIn = modificationCheckInChange(modification.previousData, modification.newData);
  // Whether a stored fee is added again is the decision function's rule. This
  // only prices the move, and it prices it from the day the edit left behind.
  if (!checkIn.changed || checkIn.previousCheckIn === null || checkIn.newCheckIn === null) return 0;
  // The fee function reads status, check-in, lodge and final price only.
  // The live booking check-in is already the new day, so it is not the original.
  const booking = {
    status: row.booking.status,
    checkIn: dateOnlyInstantOf(checkIn.previousCheckIn),
    lodgeId: row.booking.lodgeId,
    finalPriceCents: row.booking.finalPriceCents,
  } as LoadedBookingForModify;
  return calculateModificationChangeFee({
    booking,
    newCheckIn: dateOnlyInstantOf(checkIn.newCheckIn),
    checkInChanged: true,
    skipBookingLifecycleRules: false,
    db: store,
    todayAtClub,
  });
}

function modificationIdOf(context: unknown): string | null {
  if (context === null || typeof context !== "object") return null;
  const id = (context as { bookingModificationId?: unknown }).bookingModificationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function hydrateReview(
  task: ReviewRow,
  modification: LoadedEditReview["modification"],
  store: Prisma.TransactionClient,
  todayAtClub: CalendarDate,
): Promise<LoadedEditReview> {
  return {
    id: task.id,
    bookingId: task.bookingId,
    status: task.status,
    reviewContext: task.reviewContext,
    createdAt: task.createdAt,
    booking: task.booking,
    modification,
    prospectiveChangeFeeCents: await prospectiveFee(task, modification, store, todayAtClub),
  };
}

async function reloadOpenDecision(
  store: Prisma.TransactionClient,
  taskId: string,
  todayAtClub: CalendarDate,
): Promise<OpenEditReviewDecision | "closed"> {
  const task = await store.manualRefundTask.findUnique({
    where: { id: taskId },
    select: REVIEW_SELECT,
  });
  if (task === null || task.status !== "OPEN") return "closed";
  const modificationId = modificationIdOf(task.reviewContext);
  const modification =
    modificationId === null
      ? null
      : await store.bookingModification.findUnique({
          where: { id: modificationId },
          select: { id: true, changeFeeCents: true, previousData: true, newData: true },
        });
  const row = await hydrateReview(task, modification, store, todayAtClub);
  return decideOpenEditReview(toOpenEditReviewInput(row));
}

async function loadRows(
  store: Prisma.TransactionClient,
  todayAtClub: CalendarDate,
): Promise<{ rows: LoadedEditReview[]; gate: CleanupGate }> {
  const tasks = await store.manualRefundTask.findMany({
    where: { kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW },
    orderBy: { id: "asc" },
    select: REVIEW_SELECT,
  });
  const modificationIds = [...new Set(tasks.map((task) => modificationIdOf(task.reviewContext)).filter((id): id is string => id !== null))];
  const modifications =
    modificationIds.length === 0
      ? []
      : await store.bookingModification.findMany({
          where: { id: { in: modificationIds } },
          select: { id: true, changeFeeCents: true, previousData: true, newData: true },
        });
  const modificationById = new Map(modifications.map((row) => [row.id, row]));
  const rows: LoadedEditReview[] = [];
  for (const task of tasks) {
    const modificationId = modificationIdOf(task.reviewContext);
    const modification = modificationId ? (modificationById.get(modificationId) ?? null) : null;
    rows.push(await hydrateReview(task, modification, store, todayAtClub));
  }
  const taskIds = tasks.map((task) => task.id);
  const recoveryWhere = [
    { idempotencyKey: exactPrefix(EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX) },
    { idempotencyKey: exactPrefix(EDIT_FINANCIAL_REVIEW_ADDITIONAL_INTENT_RECOVERY_PREFIX) },
  ];
  const xeroAnchors: Prisma.XeroSyncOperationWhereInput[] = [
    { idempotencyKey: exactContains("edit_financial_review") },
  ];
  if (taskIds.length > 0) xeroAnchors.push({ localId: { in: taskIds } });
  if (modificationIds.length > 0) xeroAnchors.push({ localId: { in: modificationIds } });
  const [paymentRecoveryNotSucceeded, chargeClaimsHoldingToken, xeroOutstandingOrFailed] = await Promise.all([
    store.paymentRecoveryOperation.count({
      where: { status: { not: "SUCCEEDED" }, OR: recoveryWhere },
    }),
    store.editReviewChargeRaiseClaim.count({ where: { claimToken: { not: null } } }),
    store.xeroSyncOperation.count({
      where: { AND: [rerunnableOperationWhere(), { OR: xeroAnchors }] },
    }),
  ]);
  return {
    rows,
    gate: { paymentRecoveryNotSucceeded, chargeClaimsHoldingToken, xeroOutstandingOrFailed },
  };
}

export async function applyOpenEditReviews({
  decisions,
  actingMemberId,
  format,
  resolveTask,
  refreshDecision,
}: {
  decisions: readonly OpenEditReviewDecision[];
  actingMemberId: string;
  format: ClubFormat;
  resolveTask: (input: ManualRefundTaskResolution, format: ClubFormat) => Promise<unknown>;
  /**
   * Re-read one task immediately before it is settled. A consent removal can
   * commit while earlier tasks are being closed; the snapshot those decisions
   * were planned from would otherwise refund a guest that removal already
   * credited. `"closed"` means the row is no longer OPEN, so nothing is written.
   */
  refreshDecision?: (planned: OpenEditReviewDecision) => Promise<OpenEditReviewDecision | "closed">;
}): Promise<{
  settled: OpenEditReviewDecision[];
  closedWithNoMoney: OpenEditReviewDecision[];
  leftOpen: LeftOpenRow[];
}> {
  const settled: OpenEditReviewDecision[] = [];
  const closedWithNoMoney: OpenEditReviewDecision[] = [];
  const leftOpen: LeftOpenRow[] = [];
  for (const planned of decisions) {
    try {
      const decision = refreshDecision ? await refreshDecision(planned) : planned;
      if (decision === "closed") {
        leftOpen.push({
          bookingId: planned.bookingId,
          taskId: planned.taskId,
          message: "This refund task has already been closed.",
        });
        continue;
      }
      if (decision.action === "dismiss") {
        await resolveTask(
          {
            taskId: decision.taskId,
            resolution: "dismissed",
            note: decision.note,
            actingMemberId,
            recordedNightPrices: null,
          },
          format,
        );
        closedWithNoMoney.push(decision);
      } else {
        await resolveTask(
          {
            taskId: decision.taskId,
            resolution: "completed",
            note: decision.note,
            actingMemberId,
            confirmedAmountCents: decision.amountCents,
            direction: decision.direction,
            recordedNightPrices: null,
          },
          format,
        );
        settled.push(decision);
      }
    } catch (error) {
      if (error instanceof ManualBookingPaymentError) {
        leftOpen.push({ bookingId: planned.bookingId, taskId: planned.taskId, message: error.message });
        continue;
      }
      throw error;
    }
  }
  return { settled, closedWithNoMoney, leftOpen };
}

function anchorTaskId(rows: readonly LoadedEditReview[], bookingId: string): string | null {
  const reviews = rows.filter((row) => row.bookingId === bookingId && row.status !== "OPEN");
  return reviews.length === 0 ? null : reviews[reviews.length - 1]!.id;
}

/**
 * Re-base one frozen headline. `commit: false` runs the same writes and rolls
 * them back, so the report shows the figures apply would store.
 *
 * `editReviewHeadlineRebase#1`: global settlement key first (`INV-LOCK-001`).
 * The booking is re-read under that key. The closure poster compare-and-sets
 * the four money columns; a miss rolls this booking back.
 */
export async function editReviewHeadlineRebase({
  bookingId,
  anchorTaskId: taskId,
  actingMemberId,
  todayAtClub,
  format,
  journal,
  commit,
  client = prisma,
}: {
  bookingId: string;
  anchorTaskId: string;
  actingMemberId: string;
  todayAtClub: CalendarDate;
  format: ClubFormat;
  journal: BookingJournalContext;
  commit: boolean;
  client?: Pick<PrismaClient, "$transaction">;
}): Promise<HeadlinePassResult> {
  try {
    return await client.$transaction(async (tx) => {
      // editReviewHeadlineRebase#1 (INV-LOCK-001): settlement-money authority,
      // taken first. No lodge key: this pass does not admit capacity.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          status: true,
          lodgeId: true,
          memberId: true,
          totalPriceCents: true,
          discountCents: true,
          promoAdjustmentCents: true,
          finalPriceCents: true,
          guests: { select: { id: true, priceCents: true } },
          payment: { select: { id: true, xeroInvoiceId: true } },
        },
      });
      if (booking === null) {
        return { kind: "raced", bookingId, message: "The booking was not there when the re-base ran." };
      }
      const reviews = await tx.manualRefundTask.findMany({
        where: { bookingId, kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW },
        select: { id: true, bookingId: true, status: true },
      });
      const before = moneyColumns(booking);
      const candidate: CleanupBooking = {
        ...before,
        id: booking.id,
        guests: booking.guests.map((guest) => ({ id: guest.id, priceCents: guest.priceCents })),
      };
      if (!isFrozenEditReviewHeadline(candidate, reviews)) {
        return { kind: "unchanged", bookingId, before };
      }
      const historyBefore = await tx.bookingModification.count({
        where: { bookingId, modificationType: "PRICE_REBASE" },
      });
      await recordReviewClosurePricing({
        plans: [],
        task: {
          id: taskId,
          bookingId,
          booking: { memberId: booking.memberId, lodgeId: booking.lodgeId },
        },
        actingMemberId,
        resolution: "dismissed",
        note: HEADLINE_NOTE,
        todayAtClub,
        hasIssuedXeroInvoice: hasIssuedPrimaryXeroInvoice(booking),
        paymentLinkRead: booking.payment,
        settlementRoute: null,
        settlementAmountCents: null,
        settlementDirection: null,
        settleAgainstRebase: null,
        store: tx,
        format,
        journal,
      });
      const afterRow = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          totalPriceCents: true,
          discountCents: true,
          promoAdjustmentCents: true,
          finalPriceCents: true,
        },
      });
      if (afterRow === null) {
        return { kind: "raced", bookingId, message: "The booking disappeared during the re-base." };
      }
      const after = moneyColumns(afterRow);
      if (
        after.totalPriceCents === before.totalPriceCents &&
        after.discountCents === before.discountCents &&
        after.promoAdjustmentCents === before.promoAdjustmentCents &&
        after.finalPriceCents === before.finalPriceCents
      ) {
        const declined: HeadlinePassResult = {
          kind: "declined",
          bookingId,
          before,
          message: "The re-base left the headline as it was.",
        };
        if (!commit) throw new HeadlineDryRun(declined);
        return declined;
      }
      const history = await tx.bookingModification.findFirst({
        where: { bookingId, modificationType: "PRICE_REBASE" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const historyCount = await tx.bookingModification.count({
        where: { bookingId, modificationType: "PRICE_REBASE" },
      });
      const createdId = historyCount > historyBefore ? (history?.id ?? null) : null;
      const ledgerPosted =
        createdId !== null &&
        (await tx.bookingLedgerLine.count({ where: { anchorId: createdId } })) > 0;
      const rebase: BookingPriceRebase = {
        previousTotalPriceCents: before.totalPriceCents,
        previousDiscountCents: before.discountCents,
        previousPromoAdjustmentCents: before.promoAdjustmentCents,
        previousFinalPriceCents: before.finalPriceCents,
        newTotalPriceCents: after.totalPriceCents,
        newDiscountCents: after.discountCents,
        newPromoAdjustmentCents: after.promoAdjustmentCents,
        newFinalPriceCents: after.finalPriceCents,
        promoRemoved: false,
      };
      const rebased: HeadlinePassResult = {
        kind: "rebased",
        bookingId,
        before,
        after,
        invoiceDiverged: rebaseDivergesFromIssuedInvoice({
          rebase,
          hasIssuedXeroInvoice: hasIssuedPrimaryXeroInvoice(booking),
          settlement: { issuesXeroDocument: false },
        }),
        ledgerPosted,
      };
      if (!commit) throw new HeadlineDryRun(rebased);
      return rebased;
    });
  } catch (error) {
    if (error instanceof HeadlineDryRun) return error.result;
    if (error instanceof ManualBookingPaymentError) {
      return { kind: "raced", bookingId, message: error.message };
    }
    throw error;
  }
}

export async function runEditReviewCleanup({
  mode,
  actingMemberId,
  format,
  zone,
  todayAtClub,
  journal,
  client = prisma,
}: {
  mode: EditReviewCleanupMode;
  actingMemberId: string | null;
  format: ClubFormat;
  zone: ClubTimeZone;
  todayAtClub: CalendarDate;
  journal: BookingJournalContext;
  client?: PrismaClient;
}): Promise<EditReviewCleanupReport> {
  if (mode === "apply" && !actingMemberId) {
    throw new Error("--apply needs --actor <memberId>, the person this run records as having settled the reviews.");
  }
  if (mode === "apply" && actingMemberId) {
    const actor = await client.member.findUnique({ where: { id: actingMemberId }, select: { id: true } });
    if (actor === null) {
      throw new Error(`--actor ${actingMemberId} is not a member, so the run was not started.`);
    }
  }
  const { rows, gate } = await withReadOnlySnapshot(client, (tx) => loadRows(tx, todayAtClub), {
    maxWait: 10_000,
    timeout: 120_000,
  });
  const ledgerNightValues = (await censusBookingMoneyReconciliation(client, zone)).ledgerNightValues;
  const planned = planEditReviewCleanup(rows);
  const reviewsByStatus = summarizeEditFinancialReviews(
    rows.map((row) => ({ createdAt: row.createdAt, status: row.status, reviewContext: row.reviewContext })),
    zone,
  ).byStatus;
  const report: EditReviewCleanupReport = {
    mode,
    reviewsByStatus,
    openCount: rows.filter((row) => row.status === "OPEN").length,
    frozen: planned.frozen,
    d7: planned.d7,
    decisions: mode === "census" ? [] : planned.decisions,
    settled: [],
    closedWithNoMoney: [],
    leftOpen: [],
    headlines: [],
    ledgerNightValues,
    gate,
  };
  if (mode === "census") return report;

  if (mode === "apply" && actingMemberId) {
    const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
    const applied = await applyOpenEditReviews({
      decisions: planned.decisions,
      actingMemberId,
      format,
      resolveTask: resolveManualRefundTask,
      refreshDecision: (plannedDecision) =>
        client.$transaction((tx) => reloadOpenDecision(tx, plannedDecision.taskId, todayAtClub)),
    });
    report.settled = applied.settled;
    report.closedWithNoMoney = applied.closedWithNoMoney;
    report.leftOpen = applied.leftOpen;
  }

  const headlineRows = mode === "apply"
    ? (await withReadOnlySnapshot(client, (tx) => loadRows(tx, todayAtClub), { maxWait: 10_000, timeout: 120_000 })).rows
    : rows;
  const headlinePlan = mode === "apply" ? planEditReviewCleanup(headlineRows) : planned;
  for (const frozen of headlinePlan.frozen) {
    const anchor = anchorTaskId(headlineRows, frozen.bookingId);
    const booking = headlineRows.find((row) => row.bookingId === frozen.bookingId);
    if (anchor === null || booking === undefined) {
      report.headlines.push({
        kind: "declined",
        bookingId: frozen.bookingId,
        before: moneyColumns(booking?.booking ?? { totalPriceCents: 0, discountCents: 0, promoAdjustmentCents: 0, finalPriceCents: 0 }),
        message: "No closed review remains to name on the history row.",
      });
      continue;
    }
    report.headlines.push(
      await editReviewHeadlineRebase({
        bookingId: frozen.bookingId,
        anchorTaskId: anchor,
        // A dry-run rolls the history row back, so the placeholder is never stored.
        // Apply has already required a real member.
        actingMemberId: actingMemberId ?? "dry-run",
        todayAtClub,
        format,
        journal,
        commit: mode === "apply",
        client,
      }),
    );
  }
  return report;
}
