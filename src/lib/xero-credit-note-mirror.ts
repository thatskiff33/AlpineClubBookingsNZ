/**
 * #4270 — mirror a credit note that was spent, changed or un-spent in Xero into
 * the app's credit ledger, without waiting for the app to try to use it.
 *
 * The treasurer's entry in Xero is the decision (owner decisions, 17 and 24 Oct
 * 2026). #4219's converge acts when Xero REFUSES an allocation the app tried; this
 * mirror acts on what Xero SHOWS, so credit that no booking has claimed yet is not
 * offered to the member after it is gone, and credit Xero gives back is not lost.
 * Nothing is written to Xero, and the member is not emailed (credit used in Xero
 * is the treasurer's own entry).
 *
 * WHAT IT WRITES, additive rows only (`xero-credit-note-write-down.ts` defines
 * them): a negative `ADMIN_ADJUSTMENT` row stamped with the note, marked so no
 * reader treats it as a lot, for the FREE part of the funding lot; and, when Xero
 * shows that spend undone, a positive row of the same kind that gives the lot back
 * and never more than was written down. The arithmetic is `xero-credit-note-mirror-plan.ts`.
 * Credit already drawn onto a booking is left to the converge, which releases the
 * booking too; the mirror records the amount it left in the audit row.
 *
 * WHAT COUNTS AS SPENT OUTSIDE THE APP is decided by the one comparator the converge
 * uses (`xero-credit-note-outside-spend.ts`). The list Xero gives must account for
 * exactly what the note has lost, and the note must have been last changed at least
 * two minutes ago, so a booking-invoice allocation or refund payment the app made
 * itself and has not finished recording is never read as someone else's.
 *
 * LOCKS (`INV-LOCK-002`): the member's credit-ledger key only, never the global one.
 * The mirror releases no booking's credit and moves no settlement money, and it takes
 * no other key, so it cannot invert the converge's global-then-member order. The
 * member is chosen BEFORE the transaction from the note's funding lot; the lot, its
 * slices, the write-down, the balance and any in-flight allocation work are re-read
 * under the lock. The Xero read happened before, outside any transaction.
 *
 * IT FAILS CLOSED and writes nothing when it cannot account for the note: no single
 * funding lot, a voided or deleted note (alerted, because that is a different class
 * of change), a list that does not add up, a note changed minutes ago, or an
 * allocation or deallocation of this credit in flight. A refusal is returned, never
 * thrown: the caller already has the links and repairs it came for.
 *
 * KILL SWITCH: `creditNoteMirrorWritesDisabled`. While it is on the mirror computes
 * and logs what it would have done and writes nothing.
 */
import { CreditType } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { createAuditLog } from "./audit";
import { exactProviderAmountToCents } from "@/lib/money-provider-amount";
import { getMemberCreditBalance, lockMemberCreditLedger } from "./member-credit";
import { findAppliedCreditDeallocationFence } from "./xero-applied-credit-operation-serialization";
import {
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
} from "./xero-operation-outbox-payload";
import { findFundingLotsForNote } from "./xero-applied-credit-slice-lookup";
import {
  outsideSpendCents,
  spendIsExplained,
  xeroAllocationsOf,
  xeroPaymentsOf,
} from "./xero-credit-note-outside-spend";
import type { XeroNoteAllocation, XeroNotePayment } from "./xero-credit-note-spent-outside-app";
import { planOutsideSpendMirror } from "./xero-credit-note-mirror-plan";
import {
  CREDIT_NOTE_MIRROR_RESTORE_DESCRIPTION,
  CREDIT_NOTE_MIRROR_WRITE_DOWN_DESCRIPTION,
  NOT_A_CONVERGENCE_ROW,
  writtenDownCentsByCreditNote,
} from "./xero-credit-note-write-down";

/** A note changed more recently than this is left for a later look (owner decision, 24 Oct 2026). */
export const CREDIT_NOTE_MIRROR_SETTLE_MS = 2 * 60 * 1000;

/** `CronJobRun.jobName` of the backstop sweep, and the `XeroSyncCursor` rows the mirror keeps. */
export const CREDIT_NOTE_MIRROR_JOB_NAME = "xero-credit-note-outside-spend-mirror";
export const CREDIT_NOTE_MIRROR_CURSOR_RESOURCE = "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR";
const KILL_SWITCH_SCOPE = "WRITES";
const RECHECK_SCOPE_PREFIX = "RECHECK:";

export const CREDIT_NOTE_MIRROR_MIRRORED_ACTION = "xero.credit_note.outside_spend_mirrored";
export const CREDIT_NOTE_MIRROR_RESTORED_ACTION = "xero.credit_note.outside_spend_restored";

/** What a read of one Xero credit note brings, in exact cents. */
export interface CreditNoteMirrorEvidence {
  creditNoteId: string;
  status: string | null;
  totalCents: number | null;
  remainingCents: number | null;
  allocations: XeroNoteAllocation[];
  payments: XeroNotePayment[];
  /** Xero's `UpdatedDateUTC`, or null when it is missing or unreadable (which defers). */
  updatedAt: Date | null;
}

export interface XeroCreditNoteLike {
  creditNoteID?: string | null;
  status?: unknown;
  total?: unknown;
  remainingCredit?: unknown;
  updatedDateUTC?: unknown;
  allocations?: Parameters<typeof xeroAllocationsOf>[0];
  payments?: Parameters<typeof xeroPaymentsOf>[0];
}

function readInstant(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** The mirror's evidence from a `getCreditNote` body; the caller's own read, never a second one. */
export function creditNoteMirrorEvidenceFrom(note: XeroCreditNoteLike): CreditNoteMirrorEvidence | null {
  if (!note.creditNoteID) return null;
  return {
    creditNoteId: note.creditNoteID,
    status: typeof note.status === "string" ? note.status.trim().toUpperCase() : null,
    totalCents: exactProviderAmountToCents(note.total),
    remainingCents: exactProviderAmountToCents(note.remainingCredit),
    allocations: xeroAllocationsOf(note.allocations),
    payments: xeroPaymentsOf(note.payments),
    updatedAt: readInstant(note.updatedDateUTC),
  };
}

export type CreditNoteMirrorRefusal =
  | "no-funding-lot"
  | "shared-credit-note"
  | "note-not-active"
  | "unexplained-spend"
  | "unsettled"
  | "in-flight-operation"
  | "lot-changed"
  | "nothing-to-do"
  | "none-free"
  | "writes-disabled";

export type CreditNoteMirrorResult =
  | { acted: true; action: "written-down" | "restored"; cents: number; leftForAllocationCents: number }
  | { acted: false; reason: CreditNoteMirrorRefusal; wouldWriteCents?: number; wouldRestoreCents?: number; leftForAllocationCents?: number };

export interface CreditNoteMirrorDeps {
  now?: Date;
  db?: typeof prisma;
}

const KILL_SWITCH_KEY = { resourceType: CREDIT_NOTE_MIRROR_CURSOR_RESOURCE, scope: KILL_SWITCH_SCOPE } as const;

/**
 * The kill switch: a row in `XeroSyncCursor` (string-keyed, so no migration), read
 * live, so it takes effect on the next note with no deploy and no restart. Unset
 * means writes are ON. A row that exists turns them off unless it says
 * `writesDisabled: false`, so a malformed row fails toward writing nothing.
 */
export async function creditNoteMirrorWritesDisabled(db: Pick<typeof prisma, "xeroSyncCursor"> = prisma): Promise<boolean> {
  const row = await db.xeroSyncCursor.findUnique({
    where: { resourceType_scope: KILL_SWITCH_KEY },
    select: { metadata: true },
  });
  if (!row) return false;
  const metadata = row.metadata;
  const disabled =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).writesDisabled
      : undefined;
  return disabled !== false;
}

/** Defer a note changed too recently to be read: the sweep looks again once it has settled. */
async function scheduleRecheck(db: typeof prisma, creditNoteId: string, at: Date): Promise<void> {
  await db.xeroSyncCursor.upsert({
    where: {
      resourceType_scope: {
        resourceType: CREDIT_NOTE_MIRROR_CURSOR_RESOURCE,
        scope: `${RECHECK_SCOPE_PREFIX}${creditNoteId}`,
      },
    },
    create: { resourceType: CREDIT_NOTE_MIRROR_CURSOR_RESOURCE, scope: `${RECHECK_SCOPE_PREFIX}${creditNoteId}`, cursorDateTime: at },
    update: { cursorDateTime: at },
  });
}

/** The credit notes the mirror deferred whose recheck time has come (oldest first). */
export async function dueCreditNoteMirrorRechecks(db: typeof prisma, now: Date, limit: number): Promise<string[]> {
  const rows = await db.xeroSyncCursor.findMany({
    where: {
      resourceType: CREDIT_NOTE_MIRROR_CURSOR_RESOURCE,
      scope: { startsWith: RECHECK_SCOPE_PREFIX },
      cursorDateTime: { lte: now },
    },
    orderBy: { cursorDateTime: "asc" },
    take: limit,
    select: { scope: true },
  });
  return rows.map((row) => row.scope.slice(RECHECK_SCOPE_PREFIX.length));
}

export async function clearCreditNoteMirrorRecheck(db: typeof prisma, creditNoteId: string): Promise<void> {
  await db.xeroSyncCursor.deleteMany({
    where: { resourceType: CREDIT_NOTE_MIRROR_CURSOR_RESOURCE, scope: `${RECHECK_SCOPE_PREFIX}${creditNoteId}` },
  });
}

const ACTIVE_NOTE_STATUSES = ["AUTHORISED", "PAID"];

export async function mirrorCreditNoteOutsideSpend(
  evidence: CreditNoteMirrorEvidence,
  deps: CreditNoteMirrorDeps = {},
): Promise<CreditNoteMirrorResult> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? new Date();
  const { creditNoteId } = evidence;

  // Most notes fund no lot at all (an invoice's, a refund's): one indexed read, then out.
  const lots = await db.memberCredit.findMany({
    where: { xeroCreditNoteId: creditNoteId, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    select: { id: true, memberId: true },
    take: 2,
  });
  const [firstLot, ...otherLots] = lots;
  if (!firstLot) return { acted: false, reason: "no-funding-lot" };
  if (otherLots.length > 0) {
    logger.warn({ creditNoteId }, "Credit note funds more than one lot; the outside-spend mirror leaves it alone");
    return { acted: false, reason: "shared-credit-note" };
  }
  const memberId = firstLot.memberId;

  if (!evidence.status || !ACTIVE_NOTE_STATUSES.includes(evidence.status)) {
    // Voided or deleted in Xero is a different class of change from credit spent: the ledger
    // may owe the member something that no rule here knows, so an officer is told.
    const log = evidence.status === "VOIDED" || evidence.status === "DELETED" ? logger.error : logger.warn;
    log.call(logger, { creditNoteId, status: evidence.status }, "A credit note funding a member's credit is not active in Xero; the credit ledger was not changed");
    return { acted: false, reason: "note-not-active" };
  }
  if (!spendIsExplained(evidence)) {
    logger.warn({ creditNoteId }, "Xero's list for a credit note does not add up to what it has lost; not mirrored");
    return { acted: false, reason: "unexplained-spend" };
  }
  const settledAt = evidence.updatedAt ? new Date(evidence.updatedAt.getTime() + CREDIT_NOTE_MIRROR_SETTLE_MS) : null;
  if (!settledAt || settledAt.getTime() > now.getTime()) {
    await scheduleRecheck(db, creditNoteId, settledAt ?? new Date(now.getTime() + CREDIT_NOTE_MIRROR_SETTLE_MS));
    return { acted: false, reason: "unsettled" };
  }
  await clearCreditNoteMirrorRecheck(db, creditNoteId);

  const writesDisabled = await creditNoteMirrorWritesDisabled(db);

  const outcome = await db.$transaction(async (tx): Promise<CreditNoteMirrorResult> => {
    await lockMemberCreditLedger(memberId, tx);

    const funding = await findFundingLotsForNote(tx, memberId, creditNoteId);
    const [lot, ...extraLots] = funding;
    if (!lot || lot.id !== firstLot.id || extraLots.length > 0) return { acted: false, reason: "lot-changed" };

    const slices = await tx.memberCreditNoteAllocation.findMany({
      where: { memberCreditId: lot.id },
      select: { appliedToBookingId: true, amountCents: true },
    });
    // Credit drawn onto a booking is mid-allocation or mid-deallocation in Xero right now:
    // the note's remaining credit is moving, so what it shows is not settled evidence.
    const payments = slices.length
      ? await tx.payment.findMany({
          where: { bookingId: { in: [...new Set(slices.map((s) => s.appliedToBookingId))] } },
          select: { id: true },
        })
      : [];
    for (const payment of payments) {
      if (await findAppliedCreditDeallocationFence(payment.id, tx)) return { acted: false, reason: "in-flight-operation" };
    }
    if (payments.length > 0) {
      const inFlight = await tx.xeroSyncOperation.findFirst({
        where: {
          localModel: "Payment",
          localId: { in: payments.map((p) => p.id) },
          queueType: { in: [XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE, XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE] },
          status: { in: ["PENDING", "RUNNING"] },
        },
        select: { id: true },
      });
      if (inFlight) return { acted: false, reason: "in-flight-operation" };
    }

    const writtenDownCents = (await writtenDownCentsByCreditNote(tx, memberId, [creditNoteId])).get(creditNoteId) ?? 0;
    const spentCents = await outsideSpendCents(tx, evidence.allocations, evidence.payments);
    const plan = planOutsideSpendMirror({
      lotCents: lot.amountCents,
      sliceCents: slices.reduce((sum, s) => sum + s.amountCents, 0),
      writtenDownCents,
      outsideSpendCents: spentCents,
      balanceCents: await getMemberCreditBalance(memberId, tx),
    });
    if (plan.kind === "none") {
      return { acted: false, reason: plan.leftForAllocationCents > 0 ? "none-free" : "nothing-to-do", leftForAllocationCents: plan.leftForAllocationCents };
    }
    if (writesDisabled) {
      return {
        acted: false,
        reason: "writes-disabled",
        ...(plan.kind === "write-down" ? { wouldWriteCents: plan.cents } : { wouldRestoreCents: plan.cents }),
        leftForAllocationCents: plan.leftForAllocationCents,
      };
    }

    const at = new Date();
    const metadata = {
      creditNoteId,
      lotId: lot.id,
      lotCents: lot.amountCents,
      outsideSpendCents: spentCents,
      writtenDownBeforeCents: writtenDownCents,
      noteUpdatedAt: evidence.updatedAt?.toISOString() ?? null,
    };
    if (plan.kind === "write-down") {
      await tx.memberCredit.create({
        data: {
          memberId,
          amountCents: -plan.cents,
          type: CreditType.ADMIN_ADJUSTMENT,
          description: CREDIT_NOTE_MIRROR_WRITE_DOWN_DESCRIPTION,
          xeroCreditNoteId: creditNoteId,
          outsideSpendConvergedAt: at,
        },
      });
      await createAuditLog(
        {
          action: CREDIT_NOTE_MIRROR_MIRRORED_ACTION,
          // The system did this, not the member: the member is the subject.
          subjectMemberId: memberId,
          targetId: lot.id,
          entityType: "MemberCredit",
          entityId: lot.id,
          category: "xero",
          severity: "important",
          outcome: "success",
          summary: "Credit note used in Xero outside the app: credit written down to match Xero",
          details: CREDIT_NOTE_MIRROR_WRITE_DOWN_DESCRIPTION,
          metadata: { ...metadata, writtenDownCents: plan.cents, leftForAllocationCents: plan.leftForAllocationCents },
        },
        tx,
      );
      return { acted: true, action: "written-down", cents: plan.cents, leftForAllocationCents: plan.leftForAllocationCents };
    }

    // Bookings the converge released for this note are named so an officer can see whose credit was
    // released while the lot was written down; the restore gives back the lot, not the booking's credit.
    const released = await tx.auditLog.findMany({
      where: {
        action: "xero.credit_note.spent_outside_app_converged",
        subjectMemberId: memberId,
        metadata: { path: ["creditNoteId"], equals: creditNoteId },
      },
      select: { targetId: true },
    });
    await tx.memberCredit.create({
      data: {
        memberId,
        amountCents: plan.cents,
        type: CreditType.ADMIN_ADJUSTMENT,
        description: CREDIT_NOTE_MIRROR_RESTORE_DESCRIPTION,
        xeroCreditNoteId: creditNoteId,
        outsideSpendConvergedAt: at,
      },
    });
    await createAuditLog(
      {
        action: CREDIT_NOTE_MIRROR_RESTORED_ACTION,
        subjectMemberId: memberId,
        targetId: lot.id,
        entityType: "MemberCredit",
        entityId: lot.id,
        category: "xero",
        severity: "important",
        outcome: "success",
        summary: "Credit note use in Xero was reversed: credit restored to match Xero",
        details: CREDIT_NOTE_MIRROR_RESTORE_DESCRIPTION,
        metadata: {
          ...metadata,
          restoredCents: plan.cents,
          releasedBookingIds: [...new Set(released.flatMap((row) => (row.targetId ? [row.targetId] : [])))],
        },
      },
      tx,
    );
    return { acted: true, action: "restored", cents: plan.cents, leftForAllocationCents: 0 };
  });

  if (outcome.acted) {
    logger.info({ creditNoteId, action: outcome.action, cents: outcome.cents, leftForAllocationCents: outcome.leftForAllocationCents }, "Mirrored a credit note spent or un-spent in Xero");
  } else if (outcome.reason === "writes-disabled") {
    logger.warn({ creditNoteId, ...outcome }, "Credit-note mirror writes are switched off; this is what it would have done");
  }
  return outcome;
}
