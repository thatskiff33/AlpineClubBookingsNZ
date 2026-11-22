import { revalidateAdminPage } from "@/lib/admin-page-revalidation";
import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { bankRefundVoidAnsweredBodySchema } from "@/lib/bank-refund-void-answered-body";
import {
  BANK_REFUND_VOID_ANSWERED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-payments";
import { connectionJson } from "@/lib/mcp-connection-request";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";
import {
  BankRefundVoidAnswerRefusal,
  markUnmatchedBankRefundVoidAnswered,
} from "@/lib/bank-refund-void-follow-up";

/**
 * POST /api/admin/payments/bank-refund-voids/[id]/answered
 *
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): a person answers a
 * voided bank-transfer refund note the nightly follow-up could not match to
 * one refund (Stuck States). It moves no money and raises nothing in Xero: it
 * records who answered and their note on the voided note's link, so the item
 * leaves the list. `[id]` is the link id. Gated `finance:edit`, the permission
 * that completes a refund paid back by hand.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON.",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = bankRefundVoidAnsweredBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const note = normaliseManualPaymentNote(parsed.data.note);
  if (!note) {
    return NextResponse.json({ error: "Say what you did - a note is required." }, { status: 400 });
  }

  try {
    const result = await markUnmatchedBankRefundVoidAnswered({
      linkId: id,
      note,
      actingMemberId: guard.session.user.id,
    });
    revalidateAdminPage("stuck-states");
    return connectionJson(request, { success: true, ...result }, BANK_REFUND_VOID_ANSWERED_CONNECTION_SHAPE);
  } catch (error) {
    if (error instanceof BankRefundVoidAnswerRefusal) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isPostgresLockNotAvailable(error)) {
      return NextResponse.json(
        { error: "This voided refund note is being updated right now. Try again in a minute." },
        { status: 409 },
      );
    }
    const contended = transactionContendedResponse(
      error,
      "Bank refund void answer contended for the lock(1) budget",
      { context: { linkId: id } },
    );
    if (contended) return contended;
    logger.error({ err: error, linkId: id }, "Answering a voided bank-transfer refund note failed");
    return NextResponse.json({ error: "Could not record the answer." }, { status: 500 });
  }
}
