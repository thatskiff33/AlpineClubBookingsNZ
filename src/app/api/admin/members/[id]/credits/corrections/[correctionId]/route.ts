import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { cancelAdminCreditDeductionCorrection } from "@/lib/admin-credit-deduction-cancel";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";

/** Cancel only while Xero has not changed; the service rechecks and claims it. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; correctionId: string }> },
) {
  try {
    const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
    if (!guard.ok) return guard.response;
    const { id, correctionId } = await params;
    await cancelAdminCreditDeductionCorrection({
      memberId: id,
      correctionId,
      adminId: guard.session.user.id,
      ipAddress: getClientIp(request),
    });
    return NextResponse.json({ success: true, message: "Xero correction cancelled and credit restored" });
  } catch (error) {
    if (error instanceof MemberCreditValidationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logger.error({ err: error }, "Error cancelling credit deduction correction");
    return NextResponse.json({ error: "Failed to cancel Xero correction" }, { status: 500 });
  }
}
