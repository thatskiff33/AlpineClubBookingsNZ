import type { ManualRefundTaskKind, ManualRefundTaskStatus, Prisma } from "@prisma/client";
import { isJournalHandBackTask } from "../../manual-refund-task-hand-back-population";
import { isLateCaptureAwaitingDecisionTask, openHandBackOwedCents, openTaskOwedCents } from "../../manual-refund-task-settlement-rules";
import { isOwedCardRefundOperation, OPEN_CARD_REFUND_OPERATION_WHERE } from "../../open-card-refund-owed";
import { exactPrefix } from "../../prisma-exact-prefix";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { memberMoneyChainTip, refundPayableOpenCents } from "./refund-family";
import { refundDoorOfObligationKey, resolveCardRefundObligation } from "./refund-obligation-map";
import type { HandBackCensusClass } from "./refund-census";

/**
 * THE HAND-BACK CENSUS (#4516, Ledger M4d; #5185). Read-only checks over what M4d posts for a bank or cash
 * hand-back, the classes `HAND_BACK_CENSUS_CLASSES` names (`refund-census.ts`). A consistent database reports none.
 * Only a booking whose R01 is in the journal is read: no other posts a hand-back event.
 *
 * - `HAND_BACK_WITHOUT_EVENT`: a journal hand-back task (`isJournalHandBackTask`, with a payment) raised on or
 *   after the hand-back era with no R05 (`refund-obligation|hand-back|<task>`): a raise that skipped the journal.
 * - `HAND_BACK_PAID_WITHOUT_EVENT`: such a task completed on or after the era with no live R14
 *   (`hand-back-paid:<task>`). The payment posts whenever the task was raised, unapplied when it has no debt.
 * - `UNAPPLIED_HAND_BACK`: a live R14 that paid no debt, for a task that has an R05 or was raised in the era. A
 *   task raised before the era is paid unapplied by design, so it is not listed.
 * - `HAND_BACK_OBLIGATION_DRIFT`: a task's R05 has open cents other than what the task still owes
 *   (`openHandBackOwedCents`: an OPEN task its amount, any other nothing), so a debt is open while its task is
 *   closed, or the reverse; or an open hand-back R05 with no journal hand-back task on its booking (the task row
 *   was deleted, #5212). A dismissal's or a dispute reduction's withdrawal lowers both sides alike.
 * - `KEEP_WITHOUT_EVENT`: a late capture's approval task kept (DISMISSED, `INV-PAY-110`) on or after the era
 *   whose capture holds money but has no live `kept-capture:<intent>`.
 *
 * The hand-back era starts at the journal's first M4d event (a hand-back R05 or R14, or a keep), as the charge
 * comparison's starts at the first R01 (`readJournalSince`). What is open of a debt is its refund-payable lines'
 * balance: a hand-back takes no card reservation, so that is its family's open cents (`refundFamilyOpenCents`).
 * Nothing is matched by amount or time, nothing is repaired, and no provider is read. A stated limit: during the
 * blue/green switch that deploys M4d, the old colour can still raise or pay a hand-back after the new one's first
 * event, and such a task is listed as if its door had skipped the journal.
 */

type Db = Pick<Prisma.TransactionClient, "manualRefundTask" | "memberMoneyEvent" | "memberMoneyLine" | "paymentRecoveryOperation" | "paymentTransaction">;

/** A booking's task, as the census reads it. */
export interface HandBackCensusTask {
  id: string;
  kind: ManualRefundTaskKind | null;
  status: ManualRefundTaskStatus;
  amountCents: number | null;
  paymentId: string | null;
  occurrenceKey: string | null;
  partPaymentReviewPaymentId: string | null;
  reason: string;
  lateCaptureApprovalIntentId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** What the journal holds of one booking's hand-backs and refund debts, read in one snapshot. */
export interface BookingHandBackJournal {
  /** When the journal recorded its first M4d event, for any booking; null before it. The same for every booking in one read. */
  handBackSince: Date | null;
  tasks: readonly HandBackCensusTask[];
  /** What is open of each hand-back debt ever posted on the booking, by task id. Present once its R05 posted, even if withdrawn since. */
  debts: ReadonlyMap<string, number>;
  /** Each task whose R14 is live, and whether it paid a debt (carries an application). */
  payments: ReadonlyMap<string, { applied: boolean }>;
  /** Each late capture approval task's capture that holds money, by intent: whether its keep is live. */
  keeps: ReadonlyMap<string, boolean>;
  /** The booking's open refund payable: every refund debt's refund-payable lines, credits less debits. */
  openRefundPayableCents: number;
  /** The idempotency keys of the booking's open card refund rows whose debt is live in the journal (the live end of its chain). */
  journalCardRefundKeys: ReadonlySet<string>;
  /** Each capture intent whose capture-return debt the journal holds (an R05 posted, even if reversed since). */
  captureReturnDebts: ReadonlySet<string>;
  /** Each capture intent whose capture-return debt an open card refund row in `journalCardRefundKeys` pays. */
  captureReturnsWithRow: ReadonlySet<string>;
}

export interface HandBackCensusFinding { bookingId: string; identity: string; kind: HandBackCensusClass; cents: number; detail: string }

/** The prefix of every key a builder makes for any id, read off the builder itself (`INV-SSOT`). */
const prefixOf = (build: (id: string) => string) => build("x").slice(0, -1);
const M4D_EVENT_PREFIXES = [
  prefixOf((id) => memberMoneyEventKeys.refundObligation("hand-back", id)),
  prefixOf(memberMoneyEventKeys.handBackPaid),
  prefixOf(memberMoneyEventKeys.keptCapture),
];

/** When the journal recorded its first M4d event; null before any. */
async function readHandBackSince(db: Pick<Db, "memberMoneyEvent">): Promise<Date | null> {
  const first = await db.memberMoneyEvent.aggregate({ where: { OR: M4D_EVENT_PREFIXES.map((prefix) => ({ eventKey: exactPrefix(prefix) })) }, _min: { recordedAt: true } });
  return first._min.recordedAt ?? null;
}

const TASK_SELECT = {
  id: true, bookingId: true, kind: true, status: true, amountCents: true, paymentId: true, occurrenceKey: true,
  partPaymentReviewPaymentId: true, reason: true, lateCaptureApprovalIntentId: true, createdAt: true, completedAt: true,
} as const;

const isPopulationTask = (task: HandBackCensusTask) => task.paymentId !== null && isJournalHandBackTask(task);

/** The live tip of an event chain, if posted, with whether it applied anything. */
async function liveEvent(db: Db, base: MemberMoneyEventKey) {
  const tip = await memberMoneyChainTip(db, base);
  return db.memberMoneyEvent.findUnique({ where: { eventKey: tip }, select: { journal: { select: { applications: { select: { id: true }, take: 1 } } } } });
}

/**
 * The booking's open card refund rows whose debt is live in the journal: the live end of its chain, so a debt
 * reversed since (a kept late capture's, `closeKeptCaptureReturn`; a withdrawal) no longer counts its row. With the
 * capture intents those rows pay, for the capture-return term of report v3.
 */
async function journalCardRefunds(db: Db, bookingIds: readonly string[]): Promise<Map<string, { keys: Set<string>; captureReturns: Set<string> }>> {
  const operations = await db.paymentRecoveryOperation.findMany({ where: { bookingId: { in: [...bookingIds] }, ...OPEN_CARD_REFUND_OPERATION_WHERE },
    orderBy: { id: "asc" }, select: { type: true, idempotencyKey: true, bookingId: true, paymentIntentId: true, amountCents: true } });
  const result = new Map<string, { keys: Set<string>; captureReturns: Set<string> }>();
  for (const operation of operations.filter(isOwedCardRefundOperation)) {
    const ref = await resolveCardRefundObligation(db, operation);
    if (!ref || !(await liveEvent(db, memberMoneyEventKeys.refundObligation(ref.scope, ref.id)))) continue;
    const own = result.get(operation.bookingId) ?? { keys: new Set<string>(), captureReturns: new Set<string>() };
    own.keys.add(operation.idempotencyKey);
    if (ref.scope === "capture-return") own.captureReturns.add(ref.id);
    result.set(operation.bookingId, own);
  }
  return result;
}

/**
 * What the journal holds of these bookings' hand-backs, inside the caller's read-only snapshot. Pass only bookings
 * whose R01 is in the journal. The per-task reads (a live R14, a live keep) are made only for the tasks that can
 * have one, so a page with no hand-back, late capture or open card refund makes four reads.
 */
export async function readBookingHandBackJournal(db: Db, bookingIds: readonly string[]): Promise<Map<string, BookingHandBackJournal>> {
  const result = new Map<string, BookingHandBackJournal>();
  if (bookingIds.length === 0) return result;
  const ids = [...bookingIds];
  const handBackSince = await readHandBackSince(db);
  const tasks = await db.manualRefundTask.findMany({ where: { bookingId: { in: ids } }, orderBy: { id: "asc" }, select: TASK_SELECT });
  const lines = await db.memberMoneyLine.findMany({ where: { bookingId: { in: ids }, account: "REFUND_PAYABLE" }, orderBy: { id: "asc" },
    select: { bookingId: true, side: true, amountCents: true, obligation: { select: { obligationKey: true } } } });
  const cards = await journalCardRefunds(db, ids);
  // A keep posts only for a dismissed approval task with a payment (`prepareLateCaptureDecision`).
  const keptIntent = (task: HandBackCensusTask) => (task.status === "DISMISSED" && task.paymentId !== null ? task.lateCaptureApprovalIntentId : null);
  const intents = tasks.flatMap((task) => keptIntent(task) ?? []);
  const captures = intents.length === 0 ? [] : await db.paymentTransaction.findMany({ where: { stripePaymentIntentId: { in: intents }, amountCents: { gt: 0 } },
    select: { stripePaymentIntentId: true } });

  for (const bookingId of ids) {
    const own = tasks.filter((task) => task.bookingId === bookingId);
    const bookingLines = lines.filter((candidate) => candidate.bookingId === bookingId);
    const debtLines = new Map<string, typeof bookingLines>();
    const captureReturnDebts = new Set<string>();
    for (const line of bookingLines) {
      const door = line.obligation ? refundDoorOfObligationKey(line.obligation.obligationKey) : null;
      if (door?.scope === "hand-back") debtLines.set(door.id, [...(debtLines.get(door.id) ?? []), line]);
      if (door?.scope === "capture-return") captureReturnDebts.add(door.id);
    }
    const debts = new Map([...debtLines].map(([taskId, own]) => [taskId, refundPayableOpenCents(own)]));
    const openRefundPayableCents = refundPayableOpenCents(bookingLines);
    const payments = new Map<string, { applied: boolean }>();
    for (const task of own.filter((candidate) => candidate.status === "COMPLETED" && isPopulationTask(candidate))) {
      const event = await liveEvent(db, memberMoneyEventKeys.handBackPaid(task.id));
      if (event?.journal) payments.set(task.id, { applied: event.journal.applications.length > 0 });
    }
    const keeps = new Map<string, boolean>();
    for (const task of own) {
      const intent = keptIntent(task);
      if (!intent || !captures.some((capture) => capture.stripePaymentIntentId === intent)) continue;
      keeps.set(intent, Boolean((await liveEvent(db, memberMoneyEventKeys.keptCapture(intent)))?.journal));
    }
    const card = cards.get(bookingId);
    result.set(bookingId, { handBackSince, tasks: own, debts, payments, keeps, openRefundPayableCents,
      journalCardRefundKeys: card?.keys ?? new Set(), captureReturnDebts, captureReturnsWithRow: card?.captureReturns ?? new Set() });
  }
  return result;
}

/** What a task still owes by hand, the legacy figure its debt is compared with. */
const owedCents = (task: HandBackCensusTask) => openHandBackOwedCents([task]);

/**
 * What the booking's journal hand-back debts stand for on the legacy side: each task whose R05 the journal holds,
 * at what it still owes. Report v3 (`JOURNAL_REFUND_PAYABLE`) adds the open card refund rows to it.
 */
export function heldHandBackOwedCents(facts: BookingHandBackJournal): number {
  return facts.tasks.filter((task) => facts.debts.has(task.id) && isJournalHandBackTask(task)).reduce((sum, task) => sum + owedCents(task), 0);
}

/**
 * What the booking's journal capture-return debts with no open card refund row stand for on the legacy side: each
 * late capture held OPEN for the treasurer (`lateCaptureApprovalIntentId`) whose capture-return R05 the journal
 * holds, at the task's amount, what its approval sends. That debt posts when an automatic refund of the capture
 * reserves its slice; Stripe's refusal then holds the capture on the task until the treasurer approves it (a row
 * takes over) or keeps it (the debt is reversed, the task dismissed). Report v3 adds it beside the card rows.
 */
export function heldCaptureReturnOwedCents(facts: BookingHandBackJournal): number {
  const held = facts.tasks.filter((task) => isLateCaptureAwaitingDecisionTask(task) && task.lateCaptureApprovalIntentId !== null
    && facts.captureReturnDebts.has(task.lateCaptureApprovalIntentId) && !facts.captureReturnsWithRow.has(task.lateCaptureApprovalIntentId));
  return openTaskOwedCents(held).lateCaptureCents;
}

/** The five classes for one booking. Pure: the facts read above in, findings out, in task order. */
export function classifyHandBacks(bookingId: string, facts: BookingHandBackJournal): HandBackCensusFinding[] {
  const findings: HandBackCensusFinding[] = [];
  const add = (kind: HandBackCensusClass, identity: string, cents: number, detail: string) => findings.push({ bookingId, identity, kind, cents, detail });
  const since = facts.handBackSince;
  // On or after: the first M4d event's own task is written in the same transaction, so its time can equal the era's start.
  const inEra = (at: Date | null) => since !== null && at !== null && at.getTime() >= since.getTime();
  const journalTasks = new Set<string>();
  for (const task of facts.tasks) {
    const amount = task.amountCents ?? 0;
    const intent = task.lateCaptureApprovalIntentId;
    if (intent && facts.keeps.get(intent) === false && inEra(task.completedAt ?? task.createdAt)) {
      add("KEEP_WITHOUT_EVENT", task.id, amount, `late capture ${intent} was kept, but no keep is live in the journal`);
    }
    if (!isJournalHandBackTask(task)) continue;
    journalTasks.add(task.id);
    const open = facts.debts.get(task.id);
    if (open !== undefined && open !== owedCents(task)) {
      add("HAND_BACK_OBLIGATION_DRIFT", task.id, open - owedCents(task), `the journal holds ${open} open of its debt; the ${task.status} task owes ${owedCents(task)}`);
    }
    if (!isPopulationTask(task)) continue;
    if (open === undefined && inEra(task.createdAt)) add("HAND_BACK_WITHOUT_EVENT", task.id, amount, "raised in the hand-back era with no refund debt (R05) in the journal");
    const paid = facts.payments.get(task.id);
    if (task.status === "COMPLETED" && amount > 0 && !paid && inEra(task.completedAt ?? task.createdAt)) {
      add("HAND_BACK_PAID_WITHOUT_EVENT", task.id, amount, "paid back in the hand-back era with no hand-back payment (R14) in the journal");
    }
    if (paid && !paid.applied && (open !== undefined || inEra(task.createdAt))) {
      add("UNAPPLIED_HAND_BACK", task.id, amount, "its hand-back payment (R14) paid no refund debt, though the task's debt is the journal's");
    }
  }
  for (const [taskId, open] of facts.debts) {
    if (open !== 0 && !journalTasks.has(taskId)) add("HAND_BACK_OBLIGATION_DRIFT", taskId, open, `the journal holds ${open} open of a hand-back debt whose task is not on this booking`);
  }
  return findings;
}
