import { NextRequest, NextResponse } from "next/server";
import {
  listAdminFamilyGroupRequests,
  reviewAdminFamilyGroupRequest,
} from "@/lib/admin-family-group-requests-service";
import { reviewFamilyGroupRequestSchema } from "@/lib/admin-membership-api/family-groups";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  FAMILY_GROUP_REQUEST_LIST_CONNECTION_SHAPE,
  FAMILY_GROUP_REQUEST_REVIEWED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-family-groups";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

/**
 * GET /api/admin/family-groups/requests
 * List pending family group change requests.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const result = await listAdminFamilyGroupRequests();
  return connectionJson(request, result.body, FAMILY_GROUP_REQUEST_LIST_CONNECTION_SHAPE, result.init);
}

/**
 * PUT /api/admin/family-groups/requests
 * Approve or reject a family group change request.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = reviewFamilyGroupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const result = await reviewAdminFamilyGroupRequest({
    adminMemberId: guard.session.user.id,
    data: parsed.data,
  });
  return connectionJson(req, result.body, FAMILY_GROUP_REQUEST_REVIEWED_CONNECTION_SHAPE, result.init);
}
