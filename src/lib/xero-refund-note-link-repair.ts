/**
 * Operator-reviewed repair for Stripe per-delta refund credit-note links that
 * the pre-#2901 canonical cleanup wrongly deactivated (and for the local
 * aftermath of cleaning up the Xero-side duplicate notes the resulting loop
 * created). Since #2902 it is also the dry-run-first operator REPORT for
 * payments whose refund-note coverage exceeds their provider-backed cash
 * refunds — the fictitious notes (each usually settled by a Stripe-bank
 * payment) that account-credit cancellations used to mint (INV-PAY-050).
 *
 * What it does — LOCAL ledger rows only, never a provider WRITE (the optional
 * status recorder in `xero-refund-note-status-recorder.ts` performs read-only
 * provider GETs; this module touches no provider at all):
 *
 * - Deactivates ACTIVE links whose recorded Xero status is VOIDED or DELETED —
 *   the local mirror of a note the operator has already voided in Xero. This
 *   is UNCONDITIONAL (#2901 review F2): a cancelled note is never coverage, so
 *   the deactivation applies whether or not reactivations can close the
 *   remaining gap. It never voids or deletes anything in Xero itself.
 * - Reactivates inactive `Payment`/`REFUND_CREDIT_NOTE` links on
 *   `source: STRIPE` payments, oldest first, while doing so cannot push the
 *   active covered cents past the payment's coverage target
 *   (`getRefundNoteCoverageTargetCents` — INV-ADDPAY-020). Since #2902 that
 *   target is the provider-backed CASH refund evidence
 *   (`resolveStripeCashRefundEvidence`, INV-PAY-050): succeeded
 *   `PaymentRefund` cents when the payment has ledger rows, else the
 *   pre-ledger legacy fallback (`refundedAmountCents` minus its
 *   account-credit disposition) — never the raw mirror, which also counts
 *   account credit. A link is reactivated only when its note's live status
 *   has been RECORDED locally and is not cancelled (#2901 review F3): inbound
 *   reconciliation structurally cannot stamp a status onto an inactive link,
 *   so an unrecorded status must be treated as "possibly voided" and refused —
 *   the operator records live statuses first (`--record-statuses`).
 * - When the plan lands SHORT of the target, the planned writes still apply:
 *   once the ledger is honest the daily credit-reconciliation self-heal issues
 *   one note for exactly the uncovered remainder (the executor recomputes
 *   amounts from execution-time cash evidence and coverage), so refusing the
 *   honest state would only preserve the phantom coverage. Landing short is
 *   reported, never silently absorbed.
 * - Reports (manual review, no automatic action) payments whose active,
 *   non-cancelled coverage EXCEEDS the cash target — including the #2902
 *   shape: an account-credit-only cancellation carrying a refund note no
 *   Stripe transaction backs. The operator voids the surplus notes (and their
 *   Stripe-bank refund payments) in Xero, records statuses
 *   (`--record-statuses`), and the next apply run deactivates the local
 *   mirrors.
 *
 * What it refuses, structurally:
 *
 * - Unrelated links: the query is scoped to `localModel: "Payment"`,
 *   `role: "REFUND_CREDIT_NOTE"`, `xeroObjectType: "CREDIT_NOTE"` and the
 *   payment's own id, so contact, invoice, account-credit and allocation links
 *   can never be touched.
 * - Foreign / non-Stripe payments: only `source: STRIPE` payments that carry a
 *   Xero invoice are scanned (a payment never invoiced in Xero expects no
 *   credit note, mirroring `getRefundsMissingXeroCreditNotes`).
 * - Cancelled or unknown-status notes: a link whose recorded status is
 *   VOIDED/DELETED — or whose status was never recorded — is never
 *   reactivated.
 * - Over-coverage: the planner never lets planned coverage exceed the target,
 *   and the apply transaction re-sums coverage AFTER its claims and rolls the
 *   whole payment back on any divergence. (The unique link key also means one
 *   row per note per payment, so reactivation cannot mint a second active row
 *   for the same note.)
 * - Still-executable counterparts: a payment is refused outright while ANY
 *   outbound CREDIT_NOTE operation row that could still drive
 *   `createXeroCreditNote` exists for it — a CREATE in
 *   PENDING/RUNNING/WAITING_PAYMENT (the outbox executor's own lifecycle,
 *   which never reads `replayable`) OR a still-`replayable` CREATE in
 *   FAILED/PARTIAL (the manual-retry and requeue entry points accept
 *   exactly that combination, and the credit-note retry branch performs NO
 *   claim-first status flip, so it mints while the row still reads
 *   FAILED/PARTIAL), or a REQUEUE row in PENDING/RUNNING (the background
 *   retry drain executes the ORIGINAL operation while the original's own row
 *   never changes status). A FAILED/PARTIAL CREATE marked non-replayable is
 *   terminally dead and does NOT block; SUCCEEDED and CANCELLED rows cannot
 *   re-execute and never block. The check is repeated inside the apply
 *   transaction (#2901 review F4, below).
 *
 * Concurrency (#2901 review F4): this writer takes NO advisory lock, and that
 * is a reasoned choice, not an omission. It composes no settlement-money or
 * capacity transition — it flips local link-mirror rows — so INV-LOCK-001
 * places it in no cohort; and the one dangerous counterpart, the outbox
 * executor (`createXeroCreditNote`), reads coverage OUTSIDE any transaction
 * and takes no lock itself, so joining global `lock(1)` here would exclude
 * nothing. The protections that do the work instead:
 *
 * - the transactional still-executable-operation refusal above — every path
 *   that reaches `createXeroCreditNote` does so for an operation row whose
 *   (operationType, status) pair the refusal matches while the provider call
 *   is in flight: the outbox executor holds its CREATE at RUNNING (or
 *   WAITING_PAYMENT before it), the retry drain holds its REQUEUE at RUNNING
 *   while the original CREATE stays FAILED/PARTIAL, and the manual retry
 *   runs with the CREATE still FAILED/PARTIAL — all matched, and re-checked
 *   inside the transaction;
 * - status-guarded `updateMany` claims whose matched counts must equal the
 *   plan exactly (a row a concurrent writer flipped rolls the payment back
 *   rather than committing a partial repair);
 * - an in-transaction post-claim re-sum of coverage that must equal the
 *   plan's promised total (a link a concurrent writer INSERTED after the
 *   re-plan also rolls the payment back);
 * - the runbook instructs the operator not to run the Xero outbox/cron drain
 *   during the apply window, and the reconciliation report's over-coverage
 *   drift class (#2901 fix round) makes the residual sub-second double-write
 *   window detectable and repairable rather than silent.
 *
 * Exposed to operators through `scripts/xero-refund-note-link-repair.ts`
 * (dry-run by default; `--apply` requires the reviewed payment ids). The full
 * operator runbook lives in `docs/xero/ARCHITECTURE.md` → "Repairing Stripe
 * refund-note links (#2901)".
 */
import { PaymentSource, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  resolveStripeCashRefundEvidence,
  type StripeCashRefundEvidence,
} from "@/lib/stripe-cash-refund-evidence";
import {
  isIncludedRefundCreditNoteStatus,
  readRefundCreditNoteLinkStatus,
} from "@/lib/xero-refund-note-status";
import {
  recoverRefundCreditNoteLinkAmountCents,
  sumCoveredRefundCreditNoteCents,
} from "@/lib/xero-sync";
import { formatCents } from "@/lib/utils";

export type StripeRefundNoteLinkPlannedAction =
  | "keep-active"
  | "reactivate"
  | "deactivate-cancelled"
  | "leave-inactive";

export interface StripeRefundNoteLinkAssessment {
  linkId: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  active: boolean;
  /** Recorded Xero status (e.g. AUTHORISED, VOIDED), or null when never recorded. */
  xeroStatus: string | null;
  /** Recovered contribution in cents; null when the note is cancelled or no amount is recoverable. */
  amountCents: number | null;
  createdAt: Date;
  plannedAction: StripeRefundNoteLinkPlannedAction;
  reason: string;
}

export interface StripeRefundNoteLinkRepairPlan {
  paymentId: string;
  bookingId: string;
  /** The aggregate settlement mirror (cash + account-credit dispositions). */
  refundedAmountCents: number;
  /**
   * The cents active coverage must equal — see
   * getRefundNoteCoverageTargetCents. Since #2902 this is the provider-backed
   * CASH refund target (INV-PAY-050): succeeded PaymentRefund cents when
   * ledger rows exist, else the pre-ledger legacy fallback (mirror minus
   * account-credit disposition).
   */
  coverageTargetCents: number;
  /** Which rule produced the target ("provider-ledger" | "legacy-mirror"). */
  cashEvidenceSource: StripeCashRefundEvidence["source"];
  /** Active covered cents exactly as `sumCoveredRefundCreditNoteCents` sees them today. */
  activeCoveredCents: number;
  /** Active covered cents after the planned actions. */
  plannedCoveredCents: number;
  /** True when the plan proposes writes (deactivations and/or reactivations). */
  repairable: boolean;
  /**
   * Why the payment still needs operator attention — beside the planned
   * writes (a shortfall the self-heal will fill, a surplus to void in Xero)
   * or instead of them (a still-executable outbox operation, nothing
   * recoverable).
   */
  manualReviewReason: string | null;
  /**
   * True when a still-executable outbound CREDIT_NOTE operation blocked the
   * payment (a CREATE in PENDING/RUNNING/WAITING_PAYMENT, a still-replayable
   * CREATE in FAILED/PARTIAL, or a REQUEUE in PENDING/RUNNING — see
   * findBlockingRefundCreditNoteOperationId).
   */
  blockedByPendingOperation: boolean;
  links: StripeRefundNoteLinkAssessment[];
  reactivateLinkIds: string[];
  deactivateLinkIds: string[];
}

export interface StripeRefundNoteLinkRepairReport {
  generatedAt: Date;
  scannedPayments: number;
  /** Payments whose active coverage diverges from the target, or with planned writes. */
  plans: StripeRefundNoteLinkRepairPlan[];
}

export interface StripeRefundNoteLinkRepairApplyResult {
  report: StripeRefundNoteLinkRepairReport;
  appliedPayments: number;
  reactivatedLinks: number;
  deactivatedLinks: number;
  skippedPayments: Array<{ paymentId: string; reason: string }>;
}

interface AssessableLink {
  id: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  active: boolean;
  metadata: unknown;
  createdAt: Date;
}

type AssessedLink = AssessableLink & {
  xeroStatus: string | null;
  amountCents: number | null;
};

interface RepairPayment {
  id: string;
  bookingId: string;
  refundedAmountCents: number;
}

/**
 * The cents this payment's ACTIVE refund-note coverage must equal
 * (INV-ADDPAY-020). THE named seam for the target figure: since #2902 it is
 * the provider-backed CASH refund evidence (INV-PAY-050, resolved by
 * `resolveStripeCashRefundEvidence` — already capped at the mirror and never
 * negative), NOT `refundedAmountCents`, which also counts account-credit
 * dispositions. Every comparison in this module must go through it and
 * nothing may read `refundedAmountCents` directly for a target.
 */
function getRefundNoteCoverageTargetCents(
  evidence: StripeCashRefundEvidence
): number {
  return evidence.cashRefundCents;
}

function isCancelledStatus(status: string | null): boolean {
  return status !== null && !isIncludedRefundCreditNoteStatus(status);
}

async function assessLinks(
  paymentId: string,
  links: AssessableLink[],
  db: Prisma.TransactionClient
): Promise<AssessedLink[]> {
  const assessed: AssessedLink[] = [];
  for (const link of links) {
    assessed.push({
      ...link,
      xeroStatus: readRefundCreditNoteLinkStatus(link.metadata),
      amountCents: await recoverRefundCreditNoteLinkAmountCents(
        paymentId,
        link,
        db
      ),
    });
  }
  return assessed;
}

/**
 * Pure planner over an assessed snapshot. Deterministic: given the same
 * payment state (including its cash-evidence resolution) it always produces
 * the same plan, which is what lets apply rebuild it inside the transaction
 * and refuse when the state moved.
 */
function buildPlan(
  payment: RepairPayment,
  assessedLinks: AssessedLink[],
  options: {
    pendingOperationId: string | null;
    evidence: StripeCashRefundEvidence;
  }
): StripeRefundNoteLinkRepairPlan {
  const target = getRefundNoteCoverageTargetCents(options.evidence);
  const ordered = [...assessedLinks].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id)
  );

  // Exactly what sumCoveredRefundCreditNoteCents returns today: active links'
  // recovered amounts, where a cancelled note already contributes null.
  const activeCoveredCents = ordered
    .filter((link) => link.active)
    .reduce((sum, link) => sum + (link.amountCents ?? 0), 0);

  const assessments: StripeRefundNoteLinkAssessment[] = [];
  const reactivateLinkIds: string[] = [];
  const deactivateLinkIds: string[] = [];

  if (options.pendingOperationId !== null) {
    // #2901 review F4: every path that reaches createXeroCreditNote (the
    // outbox executor, the background REQUEUE drain, the manual retry)
    // derives its amounts from a coverage read taken OUTSIDE any
    // transaction, so changing coverage while any of them could still run
    // can race one into minting another duplicate provider note. Refuse the
    // whole payment; a queued/running state drains, and a still-replayable
    // FAILED/PARTIAL row is retried to completion or marked non-replayable
    // in the admin Xero panel first (marking "resolved" alone changes
    // neither status nor replayability, so it does not clear this).
    for (const link of ordered) {
      assessments.push({
        linkId: link.id,
        xeroObjectId: link.xeroObjectId,
        xeroObjectNumber: link.xeroObjectNumber,
        active: link.active,
        xeroStatus: link.xeroStatus,
        amountCents: link.amountCents,
        createdAt: link.createdAt,
        plannedAction: link.active ? "keep-active" : "leave-inactive",
        reason:
          "Blocked: a credit-note operation for this payment could still execute.",
      });
    }
    return {
      paymentId: payment.id,
      bookingId: payment.bookingId,
      refundedAmountCents: payment.refundedAmountCents,
      coverageTargetCents: target,
      cashEvidenceSource: options.evidence.source,
      activeCoveredCents,
      plannedCoveredCents: activeCoveredCents,
      repairable: false,
      manualReviewReason: `A Xero credit-note operation (${options.pendingOperationId}) for this payment could still execute — it is queued, running, awaiting payment confirmation, or failed-but-still-retryable. Every execution path computes its amounts from live coverage, so changing links now could mint a duplicate note. Let the outbox and retry queue drain, or retry the failed operation to completion, or mark it non-replayable in the admin Xero panel (marking it "resolved" alone does not clear this), then re-run.`,
      blockedByPendingOperation: true,
      links: assessments,
      reactivateLinkIds,
      deactivateLinkIds,
    };
  }

  // Step 1: active links. A cancelled-in-Xero note contributes nothing in
  // Xero, so its local mirror is deactivated UNCONDITIONALLY — lowering
  // coverage is the safe direction (it re-arms the self-heal, which
  // recomputes at execution time). Every other active link is the multi-delta
  // contract and is kept.
  let baselineCents = 0;
  for (const link of ordered) {
    if (!link.active) {
      continue;
    }
    if (isCancelledStatus(link.xeroStatus)) {
      deactivateLinkIds.push(link.id);
      assessments.push({
        linkId: link.id,
        xeroObjectId: link.xeroObjectId,
        xeroObjectNumber: link.xeroObjectNumber,
        active: true,
        xeroStatus: link.xeroStatus,
        amountCents: link.amountCents,
        createdAt: link.createdAt,
        plannedAction: "deactivate-cancelled",
        reason: `The Xero note is ${link.xeroStatus}; its local mirror must not count as coverage.`,
      });
      continue;
    }
    baselineCents += link.amountCents ?? 0;
    assessments.push({
      linkId: link.id,
      xeroObjectId: link.xeroObjectId,
      xeroObjectNumber: link.xeroObjectNumber,
      active: true,
      xeroStatus: link.xeroStatus,
      amountCents: link.amountCents,
      createdAt: link.createdAt,
      plannedAction: "keep-active",
      reason: "Active per-delta coverage is kept (INV-ADDPAY-020).",
    });
  }

  // Step 2: inactive links, oldest first. Reactivate only notes whose live
  // status is recorded and not cancelled, and only while doing so cannot push
  // coverage past the cash refund-note target.
  let plannedCoveredCents = baselineCents;
  for (const link of ordered) {
    if (link.active) {
      continue;
    }
    let plannedAction: StripeRefundNoteLinkPlannedAction = "leave-inactive";
    let reason: string;
    if (isCancelledStatus(link.xeroStatus)) {
      reason = `The Xero note is ${link.xeroStatus}; a cancelled note is never reactivated.`;
    } else if (link.xeroStatus === null) {
      reason =
        "The note's live Xero status has never been recorded locally, so it is not reactivated (it could be voided in Xero). Record live statuses first (--record-statuses), then re-run.";
    } else if (link.amountCents === null) {
      reason =
        "No amount is recoverable from the link metadata or the persisted create-operation payload.";
    } else if (link.amountCents <= 0) {
      reason = "The recovered amount is zero, so reactivation would add no coverage.";
    } else if (plannedCoveredCents + link.amountCents <= target) {
      plannedAction = "reactivate";
      plannedCoveredCents += link.amountCents;
      reactivateLinkIds.push(link.id);
      reason = "Reactivated to restore the per-delta coverage this note settles.";
    } else {
      reason =
        "Reactivating this note would push coverage past the provider-backed cash refund target (a Xero-side duplicate to void manually in Xero).";
    }
    assessments.push({
      linkId: link.id,
      xeroObjectId: link.xeroObjectId,
      xeroObjectNumber: link.xeroObjectNumber,
      active: false,
      xeroStatus: link.xeroStatus,
      amountCents: link.amountCents,
      createdAt: link.createdAt,
      plannedAction,
      reason,
    });
  }

  const repairable =
    reactivateLinkIds.length > 0 || deactivateLinkIds.length > 0;

  let manualReviewReason: string | null = null;
  if (plannedCoveredCents > target) {
    // Only reachable through the baseline: the greedy step never exceeds the
    // target, so active, non-cancelled coverage is already above it.
    manualReviewReason =
      target === 0
        ? "This payment's refunded amount is an account-credit disposition, not Stripe cash (no provider-backed refund evidence), yet active refund notes exist — the #2902 fictitious cash documents. Verify in Xero and void those notes and their Stripe-bank refund payments THERE (nothing is voided automatically), record statuses (--record-statuses), then re-run."
        : "Active, non-cancelled coverage exceeds the provider-backed cash refund target. Verify the notes in Xero and void the surplus duplicates THERE (nothing is voided automatically), record statuses (--record-statuses), then re-run. Until then Xero over-credits the member and further refund notes are suppressed.";
  } else if (plannedCoveredCents < target) {
    const remainderCents = target - plannedCoveredCents;
    manualReviewReason = repairable
      ? `Planned coverage still lands ${remainderCents} cents short of the provider-backed cash refund target; no recoverable local note fills it. The planned changes are safe to apply — once the ledger is honest, the daily credit-reconciliation self-heal issues one note for exactly the uncovered remainder. Never void anything to force an exact landing.`
      : `Active coverage is ${remainderCents} cents short of the provider-backed cash refund target and no recoverable inactive note fills it. If the notes exist in Xero, record their statuses (--record-statuses) and re-run; otherwise the daily credit-reconciliation self-heal issues the missing note.`;
  }

  return {
    paymentId: payment.id,
    bookingId: payment.bookingId,
    refundedAmountCents: payment.refundedAmountCents,
    coverageTargetCents: target,
    cashEvidenceSource: options.evidence.source,
    activeCoveredCents,
    plannedCoveredCents,
    repairable,
    manualReviewReason,
    blockedByPendingOperation: false,
    links: assessments,
    reactivateLinkIds,
    deactivateLinkIds,
  };
}

const LINK_SELECT = {
  id: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  active: true,
  metadata: true,
  createdAt: true,
} as const;

const REFUND_NOTE_LINK_WHERE = (paymentId: string) =>
  ({
    localModel: "Payment",
    localId: paymentId,
    xeroObjectType: "CREDIT_NOTE",
    role: "REFUND_CREDIT_NOTE",
  }) as const;

/**
 * CREATE statuses the outbox executor's own lifecycle still executes. The
 * drain claims and runs these REGARDLESS of `replayable` (it never reads the
 * column), so they block unconditionally.
 */
const EXECUTOR_LIFECYCLE_CREATE_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_PAYMENT",
];

/**
 * CREATE statuses the manual-retry and requeue entry points accept — but
 * only while the row is still `replayable: true`: `getXeroOperationRetryMeta`
 * refuses a non-replayable row before anything else, so a FAILED/PARTIAL
 * CREATE an operator marked non-replayable is terminally dead and must NOT
 * block (nothing else ever changes its status, so blocking on it would fence
 * the payment's link repair forever). The credit-note retry branch performs
 * NO claim-first status flip (unlike the invoice branch's FAILED→RUNNING
 * claim), so a retrying row still reads FAILED/PARTIAL during its provider
 * call — which is why these statuses must block at all. PARTIAL is
 * conservative rather than a proven mint path: a supported Payment-scoped
 * PARTIAL retry routes to the follow-up repair, which reuses the existing
 * note instead of calling `createXeroCreditNote`. `manuallyResolvedAt` is
 * deliberately NOT mirrored here — resolving gates nothing in the retry
 * machinery, so a resolved-but-replayable FAILED row can still mint and
 * still blocks. SUCCEEDED and CANCELLED rows cannot re-execute and never
 * block.
 */
const RETRYABLE_CREATE_STATUSES = ["FAILED", "PARTIAL"];

/**
 * REQUEUE rows (`XERO_OPERATION_REQUEUE_TYPE`, `xero-operation-queue.ts`)
 * carry the original operation's entityType/localModel/localId; the
 * background retry drain claims them PENDING→RUNNING and executes the
 * ORIGINAL operation via `retryXeroSyncOperation` — minting while the
 * original CREATE's own row never changes status. A requeue row is created
 * `replayable: false`, so once FAILED it is dead and does not block.
 */
const BLOCKING_REQUEUE_STATUSES = ["PENDING", "RUNNING"];

/**
 * The id of any operation row that could still drive `createXeroCreditNote`
 * for this payment, or null. Scoped to OUTBOUND CREDIT_NOTE operations on
 * THIS payment only: a same-payment account-credit-note CREATE matches too
 * (conservative in the safe direction — telling the two apart means parsing
 * payloads), but invoice/contact/allocation operations and other payments
 * never block.
 */
async function findBlockingRefundCreditNoteOperationId(
  paymentId: string,
  db: Prisma.TransactionClient
): Promise<string | null> {
  const operation = await db.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      localModel: "Payment",
      localId: paymentId,
      OR: [
        {
          operationType: "CREATE",
          status: { in: EXECUTOR_LIFECYCLE_CREATE_STATUSES },
        },
        {
          operationType: "CREATE",
          status: { in: RETRYABLE_CREATE_STATUSES },
          replayable: true,
        },
        {
          operationType: "REQUEUE",
          status: { in: BLOCKING_REQUEUE_STATUSES },
        },
      ],
    },
    select: { id: true },
  });
  return operation?.id ?? null;
}

async function planForPayment(
  payment: RepairPayment,
  db: Prisma.TransactionClient
): Promise<StripeRefundNoteLinkRepairPlan> {
  const pendingOperationId = await findBlockingRefundCreditNoteOperationId(
    payment.id,
    db
  );
  const evidence = await resolveStripeCashRefundEvidence(payment, db);
  const links = await db.xeroObjectLink.findMany({
    where: REFUND_NOTE_LINK_WHERE(payment.id),
    select: LINK_SELECT,
  });
  const assessed = await assessLinks(payment.id, links, db);
  return buildPlan(payment, assessed, { pendingOperationId, evidence });
}

/**
 * True when this payment needs to appear in the operator report at all:
 * either the planner proposes actions, or coverage diverges from the cash
 * refund-note target with nothing automatic to do about it.
 */
function planNeedsAttention(plan: StripeRefundNoteLinkRepairPlan): boolean {
  return (
    plan.repairable ||
    plan.manualReviewReason !== null ||
    plan.activeCoveredCents !== plan.coverageTargetCents
  );
}

/**
 * Dry run: assess every refunded, Xero-invoiced Stripe payment (or the given
 * ids) and report the payments whose refund-note link coverage needs repair
 * or review. Read-only — writes nothing anywhere. The `xeroInvoiceId` filter
 * mirrors `getRefundsMissingXeroCreditNotes`: a payment never invoiced in
 * Xero expects no credit note, and scanning those buried the real findings in
 * noise (#2901 review F6).
 */
export async function findStripeRefundNoteLinkRepairs(options?: {
  paymentIds?: string[];
}): Promise<StripeRefundNoteLinkRepairReport> {
  const payments = await prisma.payment.findMany({
    where: {
      source: PaymentSource.STRIPE,
      refundedAmountCents: { gt: 0 },
      xeroInvoiceId: { not: null },
      ...(options?.paymentIds && options.paymentIds.length > 0
        ? { id: { in: options.paymentIds } }
        : {}),
    },
    select: {
      id: true,
      bookingId: true,
      refundedAmountCents: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const plans: StripeRefundNoteLinkRepairPlan[] = [];
  for (const payment of payments) {
    const plan = await planForPayment(payment, prisma);
    if (planNeedsAttention(plan)) {
      plans.push(plan);
    }
  }

  return {
    generatedAt: new Date(),
    scannedPayments: payments.length,
    plans,
  };
}

type ApplyTransactionOutcome =
  | { skipped: string }
  | { reactivated: number; deactivated: number };

/**
 * Apply the repairable plans, each payment in its own transaction. The apply
 * is BOUND to what the operator reviewed: the caller passes the reviewed
 * payment ids (the operator script requires them), the plan is rebuilt from a
 * fresh in-transaction snapshot (including the still-executable-operation
 * guard) and
 * applied only when it proposes the same link ids the dry run showed; the
 * claims must match the plan exactly and coverage is re-summed after them —
 * any divergence rolls that payment back and reports it, applying nothing.
 */
export async function applyStripeRefundNoteLinkRepairs(options?: {
  paymentIds?: string[];
}): Promise<StripeRefundNoteLinkRepairApplyResult> {
  const report = await findStripeRefundNoteLinkRepairs(options);

  let appliedPayments = 0;
  let reactivatedLinks = 0;
  let deactivatedLinks = 0;
  const skippedPayments: Array<{ paymentId: string; reason: string }> = [];

  for (const plan of report.plans) {
    if (!plan.repairable) {
      skippedPayments.push({
        paymentId: plan.paymentId,
        reason: plan.manualReviewReason ?? "Nothing automatic to apply.",
      });
      continue;
    }

    let outcome: ApplyTransactionOutcome;
    try {
      outcome = await prisma.$transaction(
        async (tx): Promise<ApplyTransactionOutcome> => {
          // Re-read the payment and links inside the transaction and rebuild
          // the plan from that snapshot: the guarded updates below only ever
          // run against state the planner has just seen, and the
          // still-executable-operation guard is re-checked transactionally.
          const payment = await tx.payment.findUnique({
            where: { id: plan.paymentId },
            select: {
              id: true,
              bookingId: true,
              source: true,
              refundedAmountCents: true,
              xeroRefundCreditNoteId: true,
            },
          });
          if (!payment || payment.source !== PaymentSource.STRIPE) {
            return {
              skipped: "The payment no longer exists or is not Stripe-sourced.",
            };
          }
          const freshPlan = await planForPayment(payment, tx);
          if (!freshPlan.repairable) {
            return {
              skipped:
                freshPlan.manualReviewReason ??
                "The payment's link state changed and is no longer automatically repairable.",
            };
          }
          const sameSets =
            freshPlan.reactivateLinkIds.join(",") ===
              plan.reactivateLinkIds.join(",") &&
            freshPlan.deactivateLinkIds.join(",") ===
              plan.deactivateLinkIds.join(",");
          if (!sameSets) {
            return {
              skipped:
                "The payment's link state changed since the dry-run plan; re-run the dry run and review again.",
            };
          }

          // Status-guarded claims. The matched counts must equal the plan: a
          // row a concurrent writer already flipped means the snapshot is
          // stale, and a partial repair must never commit.
          let reactivated = 0;
          if (freshPlan.reactivateLinkIds.length > 0) {
            const result = await tx.xeroObjectLink.updateMany({
              where: {
                id: { in: freshPlan.reactivateLinkIds },
                ...REFUND_NOTE_LINK_WHERE(payment.id),
                active: false,
              },
              data: { active: true },
            });
            reactivated = result.count;
          }
          if (reactivated !== freshPlan.reactivateLinkIds.length) {
            throw new Error(
              `Reactivation claim matched ${reactivated} of ${freshPlan.reactivateLinkIds.length} links (a concurrent writer moved the state); rolled back.`
            );
          }
          let deactivated = 0;
          if (freshPlan.deactivateLinkIds.length > 0) {
            const result = await tx.xeroObjectLink.updateMany({
              where: {
                id: { in: freshPlan.deactivateLinkIds },
                ...REFUND_NOTE_LINK_WHERE(payment.id),
                active: true,
              },
              data: { active: false },
            });
            deactivated = result.count;
          }
          if (deactivated !== freshPlan.deactivateLinkIds.length) {
            throw new Error(
              `Deactivation claim matched ${deactivated} of ${freshPlan.deactivateLinkIds.length} links (a concurrent writer moved the state); rolled back.`
            );
          }

          // Post-claim verification (#2901 review F4/F10): re-sum coverage
          // through the shared seam. A racing writer that INSERTED an active
          // link after the re-plan (the outbox executor completing) shows up
          // here, and the payment rolls back instead of compounding with it.
          const verifiedCoveredCents = await sumCoveredRefundCreditNoteCents(
            payment.id,
            tx
          );
          if (verifiedCoveredCents !== freshPlan.plannedCoveredCents) {
            throw new Error(
              `Coverage verification after the claims found ${verifiedCoveredCents} cents where the plan promised ${freshPlan.plannedCoveredCents}; a concurrent writer changed the links, rolled back.`
            );
          }

          // #2901 review F8: never leave the scalar pointing at a link this
          // repair just deactivated — the report reads the scalar as "an
          // active link must exist for this note", which would otherwise be
          // permanent, unfixable drift. Repoint at the newest remaining
          // active note, or clear it.
          const deactivatedNoteIds = new Set(
            freshPlan.links
              .filter((link) => link.plannedAction === "deactivate-cancelled")
              .map((link) => link.xeroObjectId)
          );
          if (
            payment.xeroRefundCreditNoteId &&
            deactivatedNoteIds.has(payment.xeroRefundCreditNoteId)
          ) {
            const remainingActive = await tx.xeroObjectLink.findMany({
              where: {
                ...REFUND_NOTE_LINK_WHERE(payment.id),
                active: true,
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: { xeroObjectId: true },
              take: 1,
            });
            const newest = remainingActive.length > 0 ? remainingActive[0] : null;
            await tx.payment.update({
              where: { id: payment.id },
              data: {
                xeroRefundCreditNoteId: newest ? newest.xeroObjectId : null,
              },
            });
          }

          return { reactivated, deactivated };
        }
      );
    } catch (error) {
      // Per-payment isolation (#2901 review F11): one failed transaction must
      // not discard the applied/skipped record of the rest of the run.
      const message = error instanceof Error ? error.message : String(error);
      skippedPayments.push({
        paymentId: plan.paymentId,
        reason: `The repair transaction failed and was rolled back: ${message}`,
      });
      logger.error(
        { err: error, paymentId: plan.paymentId },
        "Stripe refund-note link repair transaction failed (#2901)"
      );
      continue;
    }

    if ("skipped" in outcome) {
      skippedPayments.push({ paymentId: plan.paymentId, reason: outcome.skipped });
      continue;
    }

    appliedPayments += 1;
    reactivatedLinks += outcome.reactivated;
    deactivatedLinks += outcome.deactivated;
    logger.info(
      {
        paymentId: plan.paymentId,
        reactivatedLinks: outcome.reactivated,
        deactivatedLinks: outcome.deactivated,
        refundedAmountCents: plan.refundedAmountCents,
        coverageTargetCents: plan.coverageTargetCents,
        cashEvidenceSource: plan.cashEvidenceSource,
      },
      "Repaired Stripe refund credit-note link coverage (#2901/#2902)"
    );
  }

  return {
    report,
    appliedPayments,
    reactivatedLinks,
    deactivatedLinks,
    skippedPayments,
  };
}

/**
 * The report already reads as a bare decimal delta ("refunded mirror 1.00,
 * cash refund-note target 1.00"), pinned by
 * `xero-refund-note-link-repair.test.ts` — no `$`, no thousands grouping — so
 * this stays `formatCents`'s `{ style: "plain" }` (#3302) rather than the
 * currency-formatted default every other caller uses. `null` (amount not yet
 * known) renders as "unknown" rather than a formatted zero, which the same
 * fixture also pins.
 */
function formatRefundLinkCents(cents: number | null): string {
  if (cents === null) {
    return "unknown";
  }
  return formatCents(cents, { style: "plain" });
}

/** Plain-text report for the operator script. */
export function formatStripeRefundNoteLinkRepairReport(
  report: StripeRefundNoteLinkRepairReport
): string {
  const lines: string[] = [
    `Scanned ${report.scannedPayments} refunded Stripe payment(s); ${report.plans.length} need repair or review.`,
  ];
  for (const plan of report.plans) {
    lines.push("");
    const status = plan.repairable
      ? plan.manualReviewReason
        ? `REPAIRABLE, WITH FOLLOW-UP: ${plan.manualReviewReason}`
        : "REPAIRABLE"
      : `MANUAL REVIEW: ${plan.manualReviewReason ?? "see links"}`;
    lines.push(
      `Payment ${plan.paymentId} (booking ${plan.bookingId}): refunded mirror ${formatRefundLinkCents(plan.refundedAmountCents)}, cash refund-note target ${formatRefundLinkCents(plan.coverageTargetCents)} (${plan.cashEvidenceSource}), active coverage ${formatRefundLinkCents(plan.activeCoveredCents)}, planned coverage ${formatRefundLinkCents(plan.plannedCoveredCents)} — ${status}`
    );
    for (const link of plan.links) {
      lines.push(
        `  [${link.plannedAction}] note ${link.xeroObjectNumber ?? link.xeroObjectId} (${
          link.active ? "active" : "inactive"
        }, ${link.xeroStatus ?? "status unknown"}, ${formatRefundLinkCents(link.amountCents)}) — ${link.reason}`
      );
    }
  }
  return lines.join("\n");
}
