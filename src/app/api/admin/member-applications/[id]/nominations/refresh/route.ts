import { NextResponse } from "next/server";
import { MembershipApplicationError } from "@/lib/member-application-fields";
import { refreshMemberApplicationNominations } from "@/lib/nomination";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { NOMINATIONS_REFRESHED_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-requests";
import { connectionJson } from "@/lib/mcp-connection-request";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  try {
    const result = await refreshMemberApplicationNominations(
      id,
      guard.session.user.id
    );

    return connectionJson(
      req,
      {
        success: true,
        refreshedCount: result.refreshedCount,
        warnings: result.emailWarnings,
      },
      NOMINATIONS_REFRESHED_CONNECTION_SHAPE
    );
  } catch (err) {
    if (err instanceof MembershipApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error(
      { err, applicationId: id },
      "Unexpected error refreshing membership nomination workflow"
    );
    return NextResponse.json(
      { error: "Could not refresh the nomination workflow right now" },
      { status: 500 }
    );
  }
}
