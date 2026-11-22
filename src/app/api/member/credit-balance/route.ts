import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getMemberCreditBalance, getMemberCreditHistory } from "@/lib/member-credit";
import logger from "@/lib/logger";
import { servingMcpConnection } from "@/lib/mcp-connection-request";
import { projectForConnection } from "@/lib/connection-projection";
import { CREDIT_BALANCE_CONNECTION_SHAPE } from "@/lib/connection-shapes";

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
    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    const [balanceCents, history] = await Promise.all([
      getMemberCreditBalance(session.user.id),
      getMemberCreditHistory(session.user.id),
    ]);

    // ALP-653: an AI app connection is sent the balance only, which is what
    // `get_my_credit_balance` offers; the website's answer is unchanged.
    const body = { balanceCents, history };
    if (await servingMcpConnection()) {
      return NextResponse.json(projectForConnection(body, CREDIT_BALANCE_CONNECTION_SHAPE));
    }
    return NextResponse.json(body);
  } catch (error) {
    logger.error({ err: error }, "Error fetching credit balance");
    return NextResponse.json(
      { error: "Failed to fetch credit balance" },
      { status: 500 }
    );
  }
}
