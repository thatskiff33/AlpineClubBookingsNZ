import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
  transactionContendedResponse,
} from "@/lib/transaction-contended-response";
import logger from "@/lib/logger";
import { isResolvedInXero, XERO_OPERATION_REASON_MAX, XERO_OPERATION_REASON_MIN } from "@/lib/xero-operation-resolution";
import { reconcileHandMadeNoteAfterRecording, type VerifiedHandMadeRefundNote } from "@/lib/bank-refund-void-answer";
import {
  answerExistingResolveMark,
  refundNoteResolveShape,
  resolveRecordingRefundNote,
  withdrawRecordedNoteOrAlert,
} from "@/lib/xero-resolve-refund-note";
import { HAND_MADE_CREDIT_NOTE_NUMBER_MAX, RESOLVE_NOTE_NOT_ASKED_MESSAGE } from "@/lib/bank-refund-void-follow-up-copy";
import {
  claimResolvedInXeroMark,
  findRetryOverlappingMark,
  resolvePrecheckRefusal,
  retryRunningRefusal,
  withdrawResolvedInXeroMark,
} from "@/lib/xero-operation-resolve-guards";

const resolveSchema = z.object({
  reason: z.string().trim().min(XERO_OPERATION_REASON_MIN).max(XERO_OPERATION_REASON_MAX),
  // #4421: the Xero credit note the officer made, asked of a FAILED payment
  // refund note's create that names no note of its own
  // (`refundNoteResolveShape`). Refused for every other row (review, money F5).
  creditNoteNumber: z.string().trim().max(HAND_MADE_CREDIT_NOTE_NUMBER_MAX).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await request.json().catch(() => ({}));
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid resolve payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await params;
  const offeredNumber = parsed.data.creditNoteNumber || undefined;

  /** The route's one audit write: a mark kept, or (#4421) a refusal or a withdrawal. */
  const audit = (entry: { outcome: "success" | "failure"; summary: string; details: string; metadata: Record<string, unknown> }) =>
    createAuditLog({
      action: "xero.operation.manually_resolved",
      memberId: session.user.id,
      actorMemberId: session.user.id,
      targetId: id,
      entityType: "XeroSyncOperation",
      entityId: id,
      category: "xero",
      severity: "important",
      outcome: entry.outcome,
      summary: entry.summary,
      details: entry.details,
      metadata: entry.metadata,
    });
  /** An audit failure is logged, never the officer's answer. */
  const auditFailure = (summary: string, details: string, metadata: Record<string, unknown>) =>
    audit({ outcome: "failure", summary, details, metadata }).catch((error: unknown) =>
      logger.error({ err: error, operationId: id }, "Could not audit a refused resolve (#4421)"),
    );
  /**
   * #4421 review (security F6, round 2): EVERY refusal of a resolve that
   * offered a credit note number, or of a row that needs one, is audited with
   * the number tried and the status - whichever check refused it.
   */
  let auditsRefusals = offeredNumber !== undefined;
  const refuse = async (status: number, message: string) => {
    if (auditsRefusals) {
      await auditFailure("Xero operation not marked resolved: its credit note was refused", message, {
        operationId: id,
        creditNoteNumber: offeredNumber ?? null,
        status,
      });
    }
    return NextResponse.json({ error: message }, { status });
  };
  const answerMark = async (mark: { manuallyResolvedAt: Date; xeroObjectNumber: string | null }) => {
    const answer = await answerExistingResolveMark(id, mark, offeredNumber);
    return "refused" in answer ? refuse(answer.refused.status, answer.refused.message) : NextResponse.json({ ok: true, message: answer.message });
  };

  try {
    // #4421 review (concurrency F1): the instant the row was read. A retry of
    // it that started or finished since is refused under the claim's lock.
    const readAt = new Date();
    const operation = await prisma.xeroSyncOperation.findUnique({
      where: { id },
    });

    if (!operation) {
      return NextResponse.json({ error: "Xero operation not found." }, { status: 404 });
    }

    // #4421 (owner decision 26 Oct 2026, `INV-INT-028`): a FAILED payment
    // refund note's create that names no note of its own is resolved only with
    // the note the officer made, checked in Xero below - before any
    // transaction, so no lock is held across the provider call - and recorded
    // with the resolve. Read first, so every refusal of such a row is audited.
    const shape = refundNoteResolveShape(operation);
    // A refund-note row that needs a number, or is refused outright (unreadable
    // amount; PARTIAL naming no note), audits its refusals even when no number
    // came with the request.
    auditsRefusals ||= shape.kind === "asks-number" || shape.kind === "refused";

    if (isResolvedInXero(operation) && operation.manuallyResolvedAt) {
      return answerMark({ manuallyResolvedAt: operation.manuallyResolvedAt, xeroObjectNumber: operation.xeroObjectNumber });
    }

    // #3635: a running retry, a status that cannot be resolved, an
    // applied-credit operation, or a queued live copy of the same document.
    const precheck = await resolvePrecheckRefusal(operation);
    if (precheck) return refuse(409, precheck);

    if (shape.kind === "refused") {
      return refuse(409, shape.message);
    }
    if (shape.kind !== "asks-number" && offeredNumber) {
      return refuse(409, RESOLVE_NOTE_NOT_ASKED_MESSAGE);
    }
    let recordedNote: VerifiedHandMadeRefundNote | null = null;
    let resolvedAt = new Date();
    let claimed: boolean;
    if (shape.kind === "asks-number") {
      // #4421: checked in Xero, then claimed with the resolve under `lock(1)`
      // and the Payment row (`resolveRecordingRefundNote`).
      const result = await resolveRecordingRefundNote({
        operation,
        shape,
        offeredNumber,
        readAt,
        reason: parsed.data.reason,
        resolvedById: session.user.id,
      });
      if ("refused" in result) return refuse(result.refused.status, result.refused.message);
      claimed = result.claimed;
      if (result.claimed) {
        recordedNote = result.note;
        resolvedAt = result.resolvedAt;
      }
    } else {
      claimed = await claimResolvedInXeroMark({ id, resolvedAt, reason: parsed.data.reason, resolvedById: session.user.id });
    }
    if (!claimed) {
      const current = await prisma.xeroSyncOperation.findUnique({
        where: { id },
        select: { manuallyResolvedAt: true, status: true, startedAt: true, xeroObjectNumber: true },
      });
      if (current?.manuallyResolvedAt) {
        return answerMark({ manuallyResolvedAt: current.manuallyResolvedAt, xeroObjectNumber: current.xeroObjectNumber });
      }
      if (current?.status === "RUNNING") return refuse(409, retryRunningRefusal(current));
      return refuse(409, "This Xero operation changed while it was being resolved. Reload it and check before resolving.");
    }

    // #3635 decision 3: a queued retry of this operation that the drain has
    // claimed runs while the operation row still reads FAILED. Checked AFTER
    // the mark is written: a drain that read the row before the mark landed
    // had already claimed its queued row, so this read sees it - still RUNNING,
    // or finished in the moments since (review N4) - and the mark is withdrawn;
    // a drain that reads after the mark refuses to run.
    const runningRetry = await findRetryOverlappingMark(id, resolvedAt);
    if (runningRetry) {
      if (recordedNote && shape.kind === "asks-number") {
        const withdrawn = await withdrawRecordedNoteOrAlert({
          operationId: id,
          paymentId: shape.paymentId,
          resolvedAt,
          note: recordedNote,
          previousXeroObjectType: operation.xeroObjectType,
          retryRefusal: retryRunningRefusal(runningRetry),
          auditFailure,
        });
        return NextResponse.json({ error: withdrawn.message }, { status: withdrawn.status });
      }
      await withdrawResolvedInXeroMark(id, resolvedAt);
      return refuse(409, retryRunningRefusal(runningRetry));
    }

    // #4421 review (money F1): the recorded note read from Xero once more,
    // outside any lock, so a void that landed since the check marks its new
    // link voided at once - and the coverage readers then count it as nothing.
    if (recordedNote) {
      await reconcileHandMadeNoteAfterRecording(recordedNote, {
        alertKey: "xero-resolve-hand-made-note",
        recordedFor: "a refund credit note resolved by hand",
      });
    }

    await audit({
      outcome: "success",
      summary: "Xero operation marked resolved in Xero",
      details: parsed.data.reason,
      metadata: {
        operationId: operation.id,
        direction: operation.direction,
        entityType: operation.entityType,
        operationType: operation.operationType,
        localModel: operation.localModel,
        localId: operation.localId,
        previousStatus: operation.status,
        ...(recordedNote
          ? { creditNoteId: recordedNote.creditNoteId, creditNoteNumber: recordedNote.creditNoteNumber, amountCents: recordedNote.amountCents }
          : {}),
      },
    });

    return NextResponse.json({
      ok: true,
      message: recordedNote
        ? `Xero operation marked resolved, recording credit note ${recordedNote.creditNoteNumber}; it will drop off the active failure list.`
        : "Xero operation marked resolved; it will drop off the active failure list.",
    });
  } catch (error) {
    const contended = transactionContendedResponse(
      error,
      "Xero operation resolve contended for the lock(1) budget",
      { message: TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE, context: { operationId: id } },
    );
    if (contended) return contended;
    logger.error({ err: error, operationId: id }, "Failed to resolve Xero operation");
    return NextResponse.json(
      { error: "Failed to resolve Xero operation" },
      { status: 500 }
    );
  }
}

