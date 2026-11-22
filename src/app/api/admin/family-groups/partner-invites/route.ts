import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import {
  listOutstandingPartnerInviteTokens,
  revokePartnerInviteToken,
} from "@/lib/partner-invite-token";
import { revokePartnerInviteQuerySchema } from "@/lib/admin-membership-api/family-groups";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  FAMILY_GROUP_SUCCESS_CONNECTION_SHAPE,
  PARTNER_INVITE_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-family-groups";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

/**
 * GET /api/admin/family-groups/partner-invites
 * List outstanding (unconfirmed, unexpired) partner invitations (#1682).
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) return guard.response;

  const invites = await listOutstandingPartnerInviteTokens();
  return connectionJson(request, { invites }, PARTNER_INVITE_LIST_CONNECTION_SHAPE);
}

/**
 * DELETE /api/admin/family-groups/partner-invites?id=TOKEN_ID
 * Revoke an outstanding partner invitation.
 */
export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) return guard.response;

  const query = revokePartnerInviteQuerySchema.safeParse({
    id: req.nextUrl.searchParams.get("id") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: "Invitation id required" }, { status: 400 });
  }
  const tokenId = query.data.id;

  const revoked = await revokePartnerInviteToken({
    tokenId,
    adminMemberId: guard.session.user.id,
  });

  if (!revoked) {
    return NextResponse.json(
      { error: "Invitation not found or already resolved" },
      { status: 404 }
    );
  }

  return connectionJson(req, { success: true }, FAMILY_GROUP_SUCCESS_CONNECTION_SHAPE);
}
