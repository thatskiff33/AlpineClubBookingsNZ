import { ManualRefundTaskKind, ManualRefundTaskStatus, Prisma } from "@prisma/client";

import { groupSettlementRefundKey } from "@/lib/booking-ledger-posting-keys";
import { BOOKING_OWNER_NAME_SELECT, bookingOwnerName } from "@/lib/booking-owner-name";
import { ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES } from "@/lib/booking-status";
import { NOT_NON_CANCELLATION_HAND_BACK_WHERE } from "@/lib/manual-refund-task-settlement-rules";
import type { ClubFormat } from "@/lib/club-format";
import {
  GROUP_HAND_BACK_ALERT_MAX_UNDELIVERED,
  GROUP_ORGANISER_HAND_BACK_WHERE,
  groupOrganiserHandBackOccurrenceKey,
  groupOrganiserHandBackTasksWhere,
  readGroupOrganiserHandBackShares,
  type GroupOrganiserHandBackShares,
} from "@/lib/group-organiser-hand-back-rules";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { sendAdminManualRefundTaskAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { decodeRawRows } from "@/lib/raw-sql-rows";
import { z } from "zod";
import { formatCents } from "@/lib/utils";

/**
 * #4042 (`INV-PAY-124`): THE HAND-BACK AN ORGANISER'S INTERNET BANKING GROUP
 * CANCEL OWES THE ORGANISER.
 *
 * When the organiser cancels a group they paid for with one Internet Banking
 * settlement, `group-cancel.ts` records each joiner's share as refunded in the
 * app - the child payment's mirror and its `BANK_REFUND` ledger line - but no
 * Stripe refund can back it: the club repays the organiser by bank transfer.
 * This keeps the one `ManualRefundTask` that asks an officer to do so, the same
 * kind the cash cancel raises (`CANCELLED_BOOKING_HAND_BACK`), on the
 * organiser's booking.
 *
 * - **Where.** Inside each per-child claim transaction that books a joiner's
 *   share, after its `lock(1)` (which the task's completion also takes), so
 *   every refund the ledger records commits with the task that makes it real.
 * - **What it holds is DERIVED, never incremented.** Each claim recomputes the
 *   joiners owed: every planned joiner whose settlement refund line is on its
 *   ledger (`groupSettlementRefundKey` - the proof, so a joiner since
 *   soft-deleted, one a previous release claimed without growing the task, and
 *   one a cancel interrupted across releases refunded all count), every joiner
 *   a group task already records, and this claim's joiner. The open task holds
 *   that total less what closed group tasks already repaid, written by a
 *   status-guarded update; once the task is closed, a later share raises a
 *   SUPPLEMENTARY task keyed per joiner for only what no task covers.
 * - **Its shares are data** (`reviewContext.groupOrganiserHandBack`), and the
 *   reason is written from them, so a name with a comma in it cannot skew
 *   anything.
 * - **No `paymentId`.** The refund is already recorded on each joiner's own
 *   payment, so completing the task takes no settlement route: it writes no
 *   second allocation, ledger line, Xero note or booking event.
 */
export type GroupOrganiserHandBack = {
  id: string;
  amountCents: number;
  /** True when this call created the task, so its run alerts once, after the children. */
  created: boolean;
};

type Share = GroupOrganiserHandBackShares["shares"][number];

/**
 * The task's reason: the lead, what to repay, and each joiner's share, listed
 * while they fit the column and then counted (`… and N more`). Pure, and built
 * from the structured shares, so the count is the shares left unlisted.
 */
export function composeGroupHandBackReason(input: {
  totalCents: number;
  shares: ReadonlyArray<Pick<Share, "name" | "cents">>;
  supplementary: boolean;
  format: ClubFormat;
}): string {
  const total = formatCents(input.totalCents, input.format);
  const lead = "Group cancelled by its organiser - paid by Internet Banking.";
  const head = input.supplementary
    ? `${lead} A joiner's refund was recorded after the group's repayment task was closed: repay the organiser ${total} by bank transfer. Joiners' shares: `
    : `${lead} Repay the organiser ${total} by bank transfer. Joiners' shares: `;
  const labels = input.shares.map((share) => `${share.name} ${formatCents(share.cents, input.format)}`);
  for (let listed = labels.length; listed >= 0; listed -= 1) {
    const hidden = labels.length - listed;
    const tail = hidden > 0 ? ` … and ${hidden} more (see each joiner's booking).` : ".";
    const reason = `${head}${labels.slice(0, listed).join(", ")}${tail}`;
    if (reason.length <= MANUAL_REFUND_TASK_REASON_MAX) return reason;
  }
  return head.slice(0, MANUAL_REFUND_TASK_REASON_MAX);
}

/**
 * Book one joiner's share on the organiser's hand-back, inside that joiner's
 * claim transaction and after its `lock(1)`. Returns the task it created or
 * updated, or null when nothing more is owed.
 */
export async function recordGroupOrganiserHandBackShare(
  tx: Prisma.TransactionClient,
  input: {
    settlementId: string;
    organiserBookingId: string;
    /** The settlement's frozen `{childId: cents}` plan. */
    plan: ReadonlyMap<string, number>;
    /** The joiner whose claim, in this transaction, books its share. */
    claimedChildId: string;
    format: ClubFormat;
  },
): Promise<GroupOrganiserHandBack | null> {
  const shareCents = input.plan.get(input.claimedChildId) ?? 0;
  if (shareCents <= 0) return null;

  const tasks = await tx.manualRefundTask.findMany({
    where: groupOrganiserHandBackTasksWhere(input.settlementId),
    select: { id: true, occurrenceKey: true, status: true, amountCents: true, reviewContext: true },
  });
  const owed = await joinersOwed(tx, input, tasks);
  const owedCents = [...owed.values()].reduce((sum, share) => sum + share.cents, 0);
  const mainKey = groupOrganiserHandBackOccurrenceKey(input.settlementId);
  const main = tasks.find((task) => task.occurrenceKey === mainKey);

  if (!main || main.status === ManualRefundTaskStatus.OPEN) {
    // The open task holds everything owed less what closed group tasks repaid.
    const repaidCents = tasks
      .filter((task) => task.status !== ManualRefundTaskStatus.OPEN)
      .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
    const amountCents = owedCents - repaidCents;
    if (amountCents <= 0) return null;
    const shares = [...owed.values()];
    const data = {
      amountCents,
      raisedAmountCents: amountCents,
      reason: composeGroupHandBackReason({ totalCents: amountCents, shares, supplementary: false, format: input.format }),
      // Growing keeps the alert's record and lease, read fresh under this claim's lock(1).
      reviewContext: sharesContext(input.settlementId, shares, main ? alertRecordOf(main.reviewContext) : {}),
    };
    if (!main) {
      const created = await tx.manualRefundTask.create({
        data: { ...data, bookingId: input.organiserBookingId, kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK, occurrenceKey: mainKey },
        select: { id: true },
      });
      return { id: created.id, amountCents, created: true };
    }
    const updated = await tx.manualRefundTask.updateMany({
      where: { id: main.id, status: ManualRefundTaskStatus.OPEN },
      data,
    });
    if (updated.count === 1) return { id: main.id, amountCents, created: false };
  }

  // The settlement's task was closed before this share was booked: what no
  // group task covers yet goes on a task of its own, keyed by this joiner.
  const supplementaryKey = groupOrganiserHandBackOccurrenceKey(input.settlementId, input.claimedChildId);
  if (tasks.some((task) => task.occurrenceKey === supplementaryKey)) return null;
  const coveredCents = tasks.reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
  const amountCents = owedCents - coveredCents;
  if (amountCents <= 0) return null;
  const recorded = new Set(tasks.flatMap((task) => readGroupOrganiserHandBackShares(task.reviewContext)?.shares.map((share) => share.bookingId) ?? []));
  const shares = [...owed.values()].filter((share) => !recorded.has(share.bookingId));
  const created = await tx.manualRefundTask.create({
    data: {
      bookingId: input.organiserBookingId,
      amountCents,
      raisedAmountCents: amountCents,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: supplementaryKey,
      reason: composeGroupHandBackReason({ totalCents: amountCents, shares, supplementary: true, format: input.format }),
      reviewContext: sharesContext(input.settlementId, shares),
    },
    select: { id: true },
  });
  return { id: created.id, amountCents, created: true };
}

/**
 * Every joiner the organiser is owed for, by booking: those the ledger proves
 * this settlement refunded (its refund line; no `deletedAt` filter, because the
 * line is the proof), those a group task already records, and this claim's.
 */
async function joinersOwed(
  tx: Prisma.TransactionClient,
  input: { settlementId: string; plan: ReadonlyMap<string, number>; claimedChildId: string },
  tasks: ReadonlyArray<{ reviewContext: unknown }>,
): Promise<Map<string, Share>> {
  const plannedIds = [...input.plan].filter(([, cents]) => cents > 0).map(([id]) => id);
  const lines = await tx.bookingLedgerLine.findMany({
    where: { postingKey: { in: plannedIds.map((id) => groupSettlementRefundKey(input.settlementId, id)) } },
    select: { bookingId: true, amountCents: true },
  });
  const ledgerCents = new Map<string, number>();
  for (const line of lines) ledgerCents.set(line.bookingId, (ledgerCents.get(line.bookingId) ?? 0) + Math.abs(line.amountCents));

  const owed = new Map<string, Share>();
  for (const task of tasks) {
    for (const share of readGroupOrganiserHandBackShares(task.reviewContext)?.shares ?? []) owed.set(share.bookingId, share);
  }
  const unnamed = [...new Set([...ledgerCents.keys(), input.claimedChildId])].filter((id) => !owed.has(id));
  const names = unnamed.length
    ? await tx.booking.findMany({ where: { id: { in: unnamed } }, select: { id: true, ...BOOKING_OWNER_NAME_SELECT } })
    : [];
  const nameOf = new Map(names.map((booking) => [booking.id, bookingOwnerName(booking)]));
  for (const [bookingId, cents] of ledgerCents) {
    const known = owed.get(bookingId);
    owed.set(bookingId, { bookingId, name: known?.name ?? nameOf.get(bookingId) ?? "a joiner", cents });
  }
  if (!owed.has(input.claimedChildId)) {
    owed.set(input.claimedChildId, {
      bookingId: input.claimedChildId,
      name: nameOf.get(input.claimedChildId) ?? "a joiner",
      cents: input.plan.get(input.claimedChildId) ?? 0,
    });
  }
  return new Map([...owed].sort(([a], [b]) => a.localeCompare(b)));
}

type AlertRecord = Pick<GroupOrganiserHandBackShares, "alertSentAt" | "alertClaimedAt" | "alertUndeliveredCount">;

function alertRecordOf(reviewContext: unknown): AlertRecord {
  const { alertSentAt, alertClaimedAt, alertUndeliveredCount } = readGroupOrganiserHandBackShares(reviewContext) ?? {};
  return {
    ...(alertSentAt ? { alertSentAt } : {}),
    ...(alertClaimedAt ? { alertClaimedAt } : {}),
    ...(alertUndeliveredCount ? { alertUndeliveredCount } : {}),
  };
}

/** Whether no run should try this alert again: sent, or given up on after repeated sends that reached nobody. */
function alertSettled(record: AlertRecord): boolean {
  return Boolean(record.alertSentAt) || (record.alertUndeliveredCount ?? 0) >= GROUP_HAND_BACK_ALERT_MAX_UNDELIVERED;
}

function sharesContext(settlementId: string, shares: ReadonlyArray<Share>, alert: AlertRecord = {}): Prisma.InputJsonValue {
  const groupOrganiserHandBack: GroupOrganiserHandBackShares = { settlementId, shares: [...shares], ...alert };
  return { groupOrganiserHandBack } as unknown as Prisma.InputJsonValue;
}

/**
 * How long a run's claim on an alert stands before another run may send it. Far
 * longer than one send can take (the SMTP relay's own connection and socket
 * timeouts are minutes, not half an hour), so a live sender is never overtaken;
 * a run that died holds the alert back for at most this long.
 */
const ALERT_CLAIM_LEASE_MS = 30 * 60 * 1000;
const DATABASE_NOW_ROW = z.object({ now: z.date() });

/**
 * #4042: the finance alert for every OPEN organiser hand-back of this
 * settlement whose alert has not gone out - the cash cancel's "Manual refund
 * needed" email in its group wording, with the task's amount and reason read
 * when it is claimed. Run once the children loop ends (the reaper's resumed
 * run included), and by the reaper's own task-keyed sweep
 * (`resendUnsentGroupOrganiserHandBackAlerts`), always outside a transaction.
 *
 * AT LEAST ONCE; a crash between sending and recording can repeat it. A run
 * first CLAIMS the alert: under `lock(1)` it re-reads the task and writes a
 * lease (`alertClaimedAt`, the database's own time), and only when the task is
 * still OPEN, unsent, not given up on and unleased (or its lease has expired).
 * Only the run that won the claim sends, after its transaction commits; so two
 * runs never send at once. It then records the send (`alertSentAt`, lease
 * cleared, retried up to three times) under the same lock with a re-read. If
 * that record is never written - the write keeps failing, the process dies
 * between the send and the record - the lease expires and a later run sends
 * again. A send that reached nobody ("undelivered") gives the lease back and is
 * counted; after `GROUP_HAND_BACK_ALERT_MAX_UNDELIVERED` of them no run sends
 * again (logged once) and the task on the queue is the record. Every write to
 * the record - claim, release, record, and a claim's growth of the task - runs
 * under `lock(1)` and re-reads first, so none drops another's fields. Each task
 * is handled on its own, so one failure never stops the rest. Never throws.
 */
export async function alertUnsentGroupOrganiserHandBacks(input: {
  settlementId: string;
  organiserBookingId: string;
  format: ClubFormat;
}): Promise<number> {
  let sent = 0;
  try {
    const tasks = await prisma.manualRefundTask.findMany({
      where: { ...groupOrganiserHandBackTasksWhere(input.settlementId), status: ManualRefundTaskStatus.OPEN },
      select: { id: true, reviewContext: true },
    });
    const unsent = tasks.filter((task) => !alertSettled(alertRecordOf(task.reviewContext)));
    if (unsent.length === 0) return 0;
    const organiserBooking = await prisma.booking.findUniqueOrThrow({
      where: { id: input.organiserBookingId },
      select: { checkIn: true, checkOut: true, ...BOOKING_OWNER_NAME_SELECT },
    });
    for (const { id: taskId } of unsent) {
      try {
        const claimed = await updateGroupHandBackAlertRecord(taskId, (record, task, now) => {
          const leased = record.alertClaimedAt && Date.parse(record.alertClaimedAt) > now.getTime() - ALERT_CLAIM_LEASE_MS;
          return task.status !== ManualRefundTaskStatus.OPEN || alertSettled(record) || leased ? null : { alertClaimedAt: now.toISOString() };
        });
        if (!claimed) continue;
        const claimedAt = claimed.record.alertClaimedAt;
        const outcome = await sendAdminManualRefundTaskAlert(
          {
            memberName: bookingOwnerName(organiserBooking),
            checkIn: organiserBooking.checkIn,
            checkOut: organiserBooking.checkOut,
            refundAmountCents: claimed.amountCents ?? 0,
            bookingId: input.organiserBookingId,
            reason: claimed.reason,
            situation: "group-organiser-internet-banking",
          },
          input.format,
        );
        if (outcome === "undelivered") {
          // Reached nobody: give the lease back (only if it is still ours) and count it, so a later sweep retries.
          const released = await updateGroupHandBackAlertRecord(taskId, (record) =>
            record.alertClaimedAt === claimedAt ? { alertUndeliveredCount: (record.alertUndeliveredCount ?? 0) + 1 } : null,
          );
          if ((released?.record.alertUndeliveredCount ?? 0) >= GROUP_HAND_BACK_ALERT_MAX_UNDELIVERED) {
            logger.error({ manualRefundTaskId: taskId, attempts: released?.record.alertUndeliveredCount }, "A group organiser's hand-back alert reached nobody after every attempt; no more are sent, and the task on the payments board is the record");
          }
          continue;
        }
        sent += 1;
        await recordAlertSent(taskId);
      } catch (err) {
        logger.error({ err, manualRefundTaskId: taskId, settlementId: input.settlementId }, "Failed to alert admins about a group organiser's hand-back task; a later sweep retries");
      }
    }
  } catch (err) {
    logger.error(
      { err, organiserBookingId: input.organiserBookingId, settlementId: input.settlementId },
      "Failed to alert admins about a group organiser's hand-back task; a later sweep retries",
    );
  }
  return sent;
}

/** Record a send, retried up to three times; one that never lands leaves the lease to expire and the alert to repeat. */
async function recordAlertSent(taskId: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await updateGroupHandBackAlertRecord(taskId, (_record, _task, now) => ({ alertSentAt: now.toISOString() }));
      return;
    } catch (err) {
      if (attempt >= 3) {
        logger.error({ err, manualRefundTaskId: taskId }, "Sent a group organiser's hand-back alert but could not record it; once its lease expires it may be sent again");
        return;
      }
    }
  }
}

/**
 * THE one writer of a group hand-back's alert record outside the claim that
 * grows the task: a short transaction that takes `lock(1)` first (the key every
 * group-cancel claim holds when it rewrites `reviewContext`), reads the
 * database's time, re-reads the task, and writes `next(record)` over the fresh
 * shares. The send's record and the undelivered count survive every write; the
 * lease survives none but the claim that sets it. `next` returning null writes
 * nothing and returns null; otherwise the task's amount and reason as they
 * stood, and the record as written.
 */
async function updateGroupHandBackAlertRecord(
  taskId: string,
  next: (record: AlertRecord, task: { status: ManualRefundTaskStatus }, now: Date) => AlertRecord | null,
): Promise<{ amountCents: number | null; reason: string; record: AlertRecord } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    // The database's clock, so every replica's lease is measured on one time.
    const [clock] = decodeRawRows(await tx.$queryRaw`SELECT now() AS now`, DATABASE_NOW_ROW, "group hand-back alert clock");
    if (!clock) throw new Error("The database returned no time");
    const { now } = clock;
    const task = await tx.manualRefundTask.findUniqueOrThrow({
      where: { id: taskId },
      select: { status: true, amountCents: true, reason: true, reviewContext: true },
    });
    const shares = readGroupOrganiserHandBackShares(task.reviewContext);
    if (!shares) return null;
    const current = alertRecordOf(task.reviewContext);
    const change = next(current, task, now);
    if (!change) return null;
    const alertSentAt = change.alertSentAt ?? current.alertSentAt;
    const alertUndeliveredCount = change.alertUndeliveredCount ?? current.alertUndeliveredCount;
    const record: AlertRecord = {
      ...(alertSentAt ? { alertSentAt } : {}),
      ...(change.alertClaimedAt ? { alertClaimedAt: change.alertClaimedAt } : {}),
      ...(alertUndeliveredCount ? { alertUndeliveredCount } : {}),
    };
    await tx.manualRefundTask.update({
      where: { id: taskId },
      data: { reviewContext: sharesContext(shares.settlementId, shares.shares, record) },
    });
    return { amountCents: task.amountCents, reason: task.reason, record };
  });
}

/**
 * #4042: the reaper's task-keyed retry. The cancel's own run (and the reaper's
 * resume, which only re-drives a group with a joiner still active) is the
 * ordinary sender; a run that died or reached nobody after the LAST claim has
 * nothing to re-drive it. So every OPEN group hand-back untouched for the grace
 * (`updatedAt`, which every growth moves), with no alert sent and not given up
 * on, is swept here through the same claim - except while its group still has
 * an active organiser-settled joiner, when the cancel is still under way and
 * the resume will finish it first. Returns how many alerts went out.
 */
export async function resendUnsentGroupOrganiserHandBackAlerts(cutoff: Date, format: ClubFormat): Promise<number> {
  const tasks = await prisma.manualRefundTask.findMany({
    where: {
      ...GROUP_ORGANISER_HAND_BACK_WHERE,
      // Redundant beside the group prefix, spread as the readers census asks of every hand-back read.
      ...NOT_NON_CANCELLATION_HAND_BACK_WHERE,
      status: ManualRefundTaskStatus.OPEN,
      updatedAt: { lt: cutoff },
    },
    select: { bookingId: true, reviewContext: true },
  });
  const settlements = new Map<string, string>();
  for (const task of tasks) {
    const shares = readGroupOrganiserHandBackShares(task.reviewContext);
    if (shares && !alertSettled(alertRecordOf(task.reviewContext))) settlements.set(shares.settlementId, task.bookingId);
  }
  let sent = 0;
  for (const [settlementId, organiserBookingId] of settlements) {
    const midCancel = await prisma.booking.count({
      where: {
        parentBookingId: organiserBookingId,
        organiserSettled: true,
        deletedAt: null,
        status: { in: [...ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES] },
      },
    });
    if (midCancel > 0) continue;
    sent += await alertUnsentGroupOrganiserHandBacks({ settlementId, organiserBookingId, format });
  }
  return sent;
}
