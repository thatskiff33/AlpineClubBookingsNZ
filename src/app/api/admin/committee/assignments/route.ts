import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  committeeAssignmentOrderBy,
  committeeAssignmentSelect,
  normalizeCommitteeEmail,
  normalizeCommitteeText,
  serializeCommitteeAssignment,
} from "@/lib/committee";
import { syncBookingOfficerForRole } from "@/lib/committee-booking-officer-sync";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

const assignmentSchema = z
  .object({
    memberId: z.string().min(1),
    committeeRoleId: z.string().min(1),
    blurb: z.string().trim().max(1000).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional().default(0),
    published: z.boolean().optional().default(false),
    showPhone: z.boolean().optional().default(false),
    contactable: z.boolean().optional().default(false),
    contactEmailMode: z
      .enum(["ROLE", "MEMBER", "CUSTOM"])
      .optional()
      .default("ROLE"),
    contactEmailOverride: z
      .string()
      .trim()
      .max(320)
      .email("Invalid committee email")
      .nullable()
      .optional(),
    isActive: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.contactEmailMode === "CUSTOM" && !value.contactEmailOverride) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contactEmailOverride"],
        message:
          "A custom committee email is required when contact email mode is CUSTOM",
      });
    }
  });

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const memberId = url.searchParams.get("memberId");
  const roleId = url.searchParams.get("committeeRoleId");
  const includeInactive = url.searchParams.get("includeInactive") === "1";

  const assignments = await prisma.committeeAssignment.findMany({
    where: {
      ...(memberId ? { memberId } : {}),
      ...(roleId ? { committeeRoleId: roleId } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: committeeAssignmentOrderBy(),
    select: committeeAssignmentSelect,
  });

  return NextResponse.json({
    assignments: assignments.map(serializeCommitteeAssignment),
  });
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = assignmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const [member, role] = await Promise.all([
    prisma.member.findUnique({
      where: { id: parsed.data.memberId },
      select: { id: true, firstName: true, lastName: true, email: true },
    }),
    prisma.committeeRole.findUnique({
      where: { id: parsed.data.committeeRoleId },
      select: { id: true, name: true, isActive: true },
    }),
  ]);
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (!role) {
    return NextResponse.json(
      { error: "Committee role not found" },
      { status: 404 },
    );
  }
  if (!role.isActive && parsed.data.isActive) {
    return NextResponse.json(
      { error: "Archived committee roles cannot receive active assignments" },
      { status: 409 },
    );
  }

  const data = {
    blurb: normalizeCommitteeText(parsed.data.blurb),
    sortOrder: parsed.data.sortOrder,
    published: parsed.data.published,
    showPhone: parsed.data.showPhone,
    contactable: parsed.data.contactable,
    contactEmailMode: parsed.data.contactEmailMode,
    contactEmailOverride:
      parsed.data.contactEmailMode === "CUSTOM"
        ? normalizeCommitteeEmail(parsed.data.contactEmailOverride)
        : null,
    isActive: parsed.data.isActive,
    assignedByMemberId: session.user.id,
  };

  const saved = await prisma.$transaction(async (tx) => {
    const existing = await tx.committeeAssignment.findUnique({
      where: {
        memberId_committeeRoleId: {
          memberId: parsed.data.memberId,
          committeeRoleId: parsed.data.committeeRoleId,
        },
      },
      select: committeeAssignmentSelect,
    });

    const assignment = existing
      ? await tx.committeeAssignment.update({
          where: { id: existing.id },
          data,
          select: committeeAssignmentSelect,
        })
      : await tx.committeeAssignment.create({
          data: {
            memberId: parsed.data.memberId,
            committeeRoleId: parsed.data.committeeRoleId,
            ...data,
          },
          select: committeeAssignmentSelect,
        });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: existing
          ? "COMMITTEE_ASSIGNMENT_UPDATED"
          : "COMMITTEE_ASSIGNMENT_CREATED",
        actor: { memberId: session.user.id },
        subject: { memberId: parsed.data.memberId },
        entity: { type: "CommitteeAssignment", id: assignment.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: existing
          ? "Committee assignment updated"
          : "Committee assignment created",
        metadata: {
          previousCommitteeAssignment: existing
            ? serializeCommitteeAssignment(existing)
            : null,
          newCommitteeAssignment: serializeCommitteeAssignment(assignment),
        },
        request: getAuditRequestContext(request),
      }),
    );

    // If this is the Booking Officer role, refresh the OtherLodge registry's
    // booking-officer contact from the current holder (no-op for other roles).
    await syncBookingOfficerForRole(tx, parsed.data.committeeRoleId);

    return assignment;
  });

  return NextResponse.json(
    { assignment: serializeCommitteeAssignment(saved) },
    { status: 201 },
  );
}
