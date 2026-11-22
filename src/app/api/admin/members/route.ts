import { NextRequest, NextResponse } from "next/server";
import {
  adminMembersQuerySchema,
  createAdminMember,
  createMemberSchema,
  listAdminMembers,
} from "@/lib/admin-members-service";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import {
  grantMembershipAdminDietaryAccess,
  isDietaryFieldEnabled,
} from "@/lib/member-dietary";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_LIST_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-members";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

/**
 * GET /api/admin/members
 * List members with search, filtering, sorting, and pagination. An AI app
 * connection is sent each member's identity and membership standing only
 * (ALP-720).
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  // Every field the schema names, so a filter the screen sends cannot be
  // dropped by a hand-kept list of keys (ALP-720: `contactability` was).
  const parsed = adminMembersQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await listAdminMembers(parsed.data);
  return connectionJson(req, result.body, MEMBER_LIST_CONNECTION_SHAPE, result.init);
}

/**
 * POST /api/admin/members
 * Create a new member.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = createMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const result = await createAdminMember(parsed.data, {
    accessRoles: guard.session.user.accessRoles,
    canLogin: guard.session.user.canLogin,
    // #2941: only asked for (a database read) while the field is collected.
    dietaryGrant: (await isDietaryFieldEnabled())
      ? await grantMembershipAdminDietaryAccess(guard, "edit")
      : null,
  });
  return NextResponse.json(result.body, result.init);
}
