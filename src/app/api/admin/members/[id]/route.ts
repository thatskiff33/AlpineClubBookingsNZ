import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getAdminMemberDetail,
  updateAdminMember,
  updateMemberSchema,
} from "@/lib/admin-member-detail-service";
import { requireAdmin } from "@/lib/session-guards";
import { grantMembershipAdminDietaryAccess } from "@/lib/member-dietary";

const paramsSchema = z.object({
  id: z.string().min(1),
});

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

/**
 * GET /api/admin/members/[id]
 * Get full member detail including subscriptions, bookings, audit logs, and stats.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await getAdminMemberDetail({
    id: parsed.data.id,
    currentAdminMemberId: guard.session.user.id,
    dietaryGrant: grantMembershipAdminDietaryAccess(guard.session.user, "view"),
  });
  return NextResponse.json(result.body, result.init);
}

/**
 * PUT /api/admin/members/[id]
 * Update a member's details. Syncs changes to Xero if connected.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedBody = updateMemberSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsedBody.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const result = await updateAdminMember({
    id: parsedParams.data.id,
    currentAdminMemberId: guard.session.user.id,
    currentAdminAccessRoles: guard.session.user.accessRoles,
    request: req,
    data: parsedBody.data,
    dietaryGrant: grantMembershipAdminDietaryAccess(guard.session.user, "edit"),
  });
  return NextResponse.json(result.body, result.init);
}

/**
 * DELETE /api/admin/members/[id]
 * Direct member deletion is intentionally disabled.
 */
export async function DELETE() {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  return NextResponse.json(
    {
      error:
        "Direct member deletion is disabled. Create a member delete lifecycle request and have a different admin approve it.",
    },
    { status: 405 }
  );
}
