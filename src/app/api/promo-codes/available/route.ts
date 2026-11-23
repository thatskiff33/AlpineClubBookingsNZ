import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getAvailablePromoCodesForMember } from "@/lib/promo";
import { MEMBER_PROMO_CODES_CONNECTION_SHAPE } from "@/lib/connection-shapes-bookings";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";

/**
 * The promo codes assigned to the signed-in member that they can see. Also the
 * AI app action `list_my_promo_codes` (ALP-794): a connection's answer is an
 * object, `{ promoCodes }`, because a projection keeps fields of an object;
 * the website's answer is the bare list, unchanged.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const availableCodes = await getAvailablePromoCodesForMember(session.user.id);

  if (arrivesAsMcpConnection(request)) {
    return connectionJson(request, { promoCodes: availableCodes }, MEMBER_PROMO_CODES_CONNECTION_SHAPE);
  }
  return NextResponse.json(availableCodes);
}
