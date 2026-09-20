import { NextRequest, NextResponse } from "next/server";
import { withdrawAdditionalPaymentAsk } from "@/lib/additional-payment-withdraw";
import { getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

/**
 * POST /api/admin/bookings/[id]/additional-payment/withdraw — withdraw an
 * unpaid additional-payment request a completed financial review raised
 * (#3528, `INV-ADDPAY-040`).
 *
 * `finance:edit`, not `bookings:edit` like the sibling reminder re-send: the
 * re-send changes nothing about the money, this retires a card request and a
 * held Xero document, which is the authority the payments board's task
 * completion carries. Any other caller gets a 403 from `requireAdmin`.
 *
 * Refusals are specific because each means something different to the officer
 * looking at the screen: 409 nothing is owed / the booking is not collectable /
 * the request is already paid (a refund, not a withdrawal) / the request was
 * raised by a price change rather than a review (edit the booking instead) /
 * the request changed under them (the fence) / a background retry is mid-mint;
 * 502 the card provider would not cancel the request and nothing was changed.
 * Every refusal leaves the ledger exactly as it was.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  try {
    const result = await withdrawAdditionalPaymentAsk({
      bookingId,
      actorMemberId: session.user.id,
      auditRequest: getAuditRequestContext(request),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      withdrawnAmountCents: result.withdrawnAmountCents,
      retired: result.retired,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to withdraw the additional payment request",
    );
    return NextResponse.json(
      { error: "Failed to withdraw the payment request" },
      { status: 500 },
    );
  }
}
