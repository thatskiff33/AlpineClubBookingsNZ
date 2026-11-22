import { NextResponse } from "next/server";
import { getMemberFamily } from "@/lib/member-family-service";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { servingMcpConnection } from "@/lib/mcp-connection-request";
import { projectForConnection } from "@/lib/connection-projection";
import { MEMBER_FAMILY_CONNECTION_SHAPE } from "@/lib/connection-shapes";

/**
 * GET /api/members/family
 * Returns self + all active members from all family groups the user belongs to.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const result = await getMemberFamily(session.user.id);
  // ALP-653: an AI app connection is sent who can go on a booking and nothing
  // else; the website's answer is unchanged.
  const ok = (result.init?.status ?? 200) === 200;
  if (ok && (await servingMcpConnection())) {
    return NextResponse.json(projectForConnection(result.body, MEMBER_FAMILY_CONNECTION_SHAPE), result.init);
  }
  return NextResponse.json(result.body, result.init);
}
