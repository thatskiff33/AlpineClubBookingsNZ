/**
 * What `POST /api/bookings` does differently for an AI app connection
 * (ALP-653, ALP-718, `INV-MCP-006`). Kept out of the route, whose create path
 * is long enough already, and out of `src/lib/mcp/`, which the route must not
 * import (`mcp-module-off.test.ts`).
 */
import { NextResponse } from "next/server";

import { MEMBER_DRAFT_SUMMARY_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";
import { getMemberDraftSummary } from "@/lib/member-draft-summary";

/**
 * A connection only saves a draft, for the member it belongs to.
 * `create_draft_booking` always sends `draft: true`; the route refuses
 * anything else from a connection too, so a booking that holds beds or takes
 * payment is never made from one. On-behalf reach (#1313) is already gone:
 * the route decides with `memberOnlySessionUser`.
 */
export function refuseConnectionUnlessOwnDraft(
  request: Request,
  isMember: boolean,
  draft: boolean | undefined,
): NextResponse | null {
  if (!arrivesAsMcpConnection(request) || (isMember && draft === true)) return null;
  return NextResponse.json(
    {
      error: isMember
        ? "An AI app can only save a draft booking. Finish and pay for it on the club website."
        : "This account is not a member, so an AI app cannot book for it.",
      code: "MCP_DRAFT_ONLY",
    },
    { status: 403 },
  );
}

/**
 * `create_draft_booking` is sent the draft's narrow summary, projected onto
 * its shape; the website's answer is the created booking, unchanged.
 */
export async function draftCreatedForConnection(
  request: Request,
  memberId: string,
  bookingId: string,
): Promise<NextResponse> {
  const summary = await getMemberDraftSummary(memberId, bookingId);
  return connectionJson(request, summary ?? { id: bookingId }, MEMBER_DRAFT_SUMMARY_CONNECTION_SHAPE, { status: 201 });
}
