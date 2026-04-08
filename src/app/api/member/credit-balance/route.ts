import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getMemberCreditBalance, getMemberCreditHistory } from "@/lib/member-credit";
import logger from "@/lib/logger";

/**
 * GET /api/member/credit-balance
 * Returns the authenticated member's credit balance and transaction history.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const [balanceCents, history] = await Promise.all([
      getMemberCreditBalance(session.user.id),
      getMemberCreditHistory(session.user.id),
    ]);

    return NextResponse.json({ balanceCents, history });
  } catch (error) {
    logger.error({ err: error }, "Error fetching credit balance");
    return NextResponse.json(
      { error: "Failed to fetch credit balance" },
      { status: 500 }
    );
  }
}
