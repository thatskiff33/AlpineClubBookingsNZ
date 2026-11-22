import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { getFirstAccessibleAdminHref } from "@/lib/admin-permissions";

// Post-login landing preference (#2090). A dedicated self-contained route in the
// profile API surface (mirrors /api/notifications/preferences): the profile card
// component reads and writes it here. null clears the preference back to the
// role default. The control is offered only to members with an accessible admin
// page, and the write is gated the same way server-side — a member whose matrix
// grants no admin area has no meaningful landing choice, and the stored value
// is inert for them regardless.
const LANDING_VALUES = ["MEMBER_DASHBOARD", "ADMIN_DASHBOARD"] as const;

const updateSchema = z.object({
  // null (or omitted) clears the preference to the role default.
  postLoginLanding: z.enum(LANDING_VALUES).nullable().optional(),
});

async function loadMemberWithAccess(memberId: string) {
  return prisma.member.findUnique({
    where: { id: memberId },
    select: {
      postLoginLanding: true,
      canLogin: true,
      role: true,
      financeAccessLevel: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    },
  });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const member = await loadMemberWithAccess(session.user.id);
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  return NextResponse.json({
    postLoginLanding: member.postLoginLanding,
    // The client only renders the control when this is true; echoed so the card
    // can hide itself if access changed since the page rendered.
    canChoose: getFirstAccessibleAdminHref(member) !== null,
  });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await loadMemberWithAccess(session.user.id);
  if (!existing) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  // Only members with an accessible admin page can meaningfully choose a
  // landing; reject others so the stored state matches the offered UI.
  if (getFirstAccessibleAdminHref(existing) === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const nextValue = parsed.data.postLoginLanding ?? null;
  const before = existing.postLoginLanding;

  if (before !== nextValue) {
    await prisma.$transaction([
      prisma.member.update({
        where: { id: session.user.id },
        data: { postLoginLanding: nextValue },
      }),
      prisma.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "member.post_login_landing.updated",
          actor: { memberId: session.user.id },
          subject: { memberId: session.user.id },
          entity: { type: "Member", id: session.user.id },
          category: "account",
          severity: "important",
          outcome: "success",
          summary: "Post-login landing preference updated",
          metadata: { before, after: nextValue },
          request: getAuditRequestContext(req),
        }),
      ),
    ]);
  }

  return NextResponse.json({
    postLoginLanding: nextValue,
    canChoose: true,
  });
}
