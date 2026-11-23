import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { committeeRoleOrderBy } from "@/lib/committee";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * Club Contact selector (Site Appearance & Content → Club Identity). Chooses
 * which committee role's member(s) appear in the public Contact page "Club
 * Details" block. Content permission area, like the other appearance settings.
 * Returns the active committee roles alongside the current value so the panel
 * needs no membership-area access to populate its dropdown.
 */

const bodySchema = z
  .object({
    contactCommitteeRoleKey: z.string().min(1).nullable(),
  })
  .strict();

async function loadActiveRoles() {
  const roles = await prisma.committeeRole.findMany({
    where: { isActive: true },
    orderBy: committeeRoleOrderBy(),
    select: { key: true, name: true },
  });
  return roles;
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const [settings, roles] = await Promise.all([
    prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: { contactCommitteeRoleKey: true },
    }),
    loadActiveRoles(),
  ]);

  return NextResponse.json({
    contactCommitteeRoleKey: settings?.contactCommitteeRoleKey ?? null,
    roles,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }

  // A chosen key must name an active committee role. Null (no selection) is
  // always allowed and restores the default booking-officer fallback.
  if (parsed.data.contactCommitteeRoleKey) {
    const role = await prisma.committeeRole.findFirst({
      where: { key: parsed.data.contactCommitteeRoleKey, isActive: true },
      select: { id: true },
    });
    if (!role) {
      return NextResponse.json(
        { error: "Select an active committee role." },
        { status: 400 },
      );
    }
  }

  const contactCommitteeRoleKey = parsed.data.contactCommitteeRoleKey;

  const settings = await prisma.$transaction(async (tx) => {
    const before = await tx.publicContentSettings.findUnique({
      where: { id: "default" },
      select: { contactCommitteeRoleKey: true },
    });
    const saved = await tx.publicContentSettings.upsert({
      where: { id: "default" },
      update: {
        contactCommitteeRoleKey,
        updatedByMemberId: guard.session.user.id,
      },
      create: {
        id: "default",
        contactCommitteeRoleKey,
        updatedByMemberId: guard.session.user.id,
      },
      select: { contactCommitteeRoleKey: true },
    });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "PUBLIC_CONTACT_ROLE_UPDATED",
        actor: { memberId: guard.session.user.id },
        entity: { type: "PublicContentSettings", id: "default" },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Public contact committee role updated",
        metadata: {
          before: before?.contactCommitteeRoleKey ?? null,
          after: contactCommitteeRoleKey,
        },
        request: getAuditRequestContext(request),
      }),
    );
    return saved;
  });

  revalidatePath("/", "layout");
  return NextResponse.json({
    contactCommitteeRoleKey: settings.contactCommitteeRoleKey,
  });
}
