import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";
import {
  TokenEmailRecoveryError,
  reissueTokenBearingEmailFailure,
} from "@/lib/token-email-recovery";
import logger from "@/lib/logger";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  try {
    const result = await reissueTokenBearingEmailFailure({
      emailLogId: id,
      adminMemberId: session.user.id,
      ipAddress: getClientIp(request),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TokenEmailRecoveryError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error(
      { err, emailLogId: id },
      "Failed to reissue token-bearing lifecycle email",
    );
    return NextResponse.json(
      { error: "Failed to reissue token-bearing lifecycle email" },
      { status: 500 },
    );
  }
}
