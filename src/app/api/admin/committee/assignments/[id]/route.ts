import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { shallowChangedFields } from "@/lib/audit-changed-fields";
import {
  committeeAssignmentSelect,
  normalizeCommitteeEmail,
  normalizeCommitteeText,
  serializeCommitteeAssignment,
} from "@/lib/committee";
import { syncBookingOfficerForRole } from "@/lib/committee-booking-officer-sync";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const patchSchema = z
  .object({
    blurb: z.string().trim().max(1000).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    published: z.boolean().optional(),
    showPhone: z.boolean().optional(),
    contactable: z.boolean().optional(),
    contactEmailMode: z.enum(["ROLE", "MEMBER", "CUSTOM"]).optional(),
    contactEmailOverride: z
      .string()
      .trim()
      .max(320)
      .email("Invalid committee email")
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "At least one committee assignment field is required" },
      { status: 400 },
    );
  }

  const existing = await prisma.committeeAssignment.findUnique({
    where: { id: parsedParams.data.id },
    select: committeeAssignmentSelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Committee assignment not found" },
      { status: 404 },
    );
  }

  if (parsed.data.isActive && !existing.committeeRole.isActive) {
    return NextResponse.json(
      { error: "Archived committee roles cannot receive active assignments" },
      { status: 409 },
    );
  }

  const data: Prisma.CommitteeAssignmentUpdateInput = {
    assignedBy: { connect: { id: session.user.id } },
  };
  if (parsed.data.blurb !== undefined) {
    data.blurb = normalizeCommitteeText(parsed.data.blurb);
  }
  if (parsed.data.sortOrder !== undefined) {
    data.sortOrder = parsed.data.sortOrder;
  }
  if (parsed.data.published !== undefined) {
    data.published = parsed.data.published;
  }
  if (parsed.data.showPhone !== undefined) {
    data.showPhone = parsed.data.showPhone;
  }
  if (parsed.data.contactable !== undefined) {
    data.contactable = parsed.data.contactable;
  }
  if (parsed.data.isActive !== undefined) {
    data.isActive = parsed.data.isActive;
  }

  const modeProvided = parsed.data.contactEmailMode !== undefined;
  const overrideProvided = parsed.data.contactEmailOverride !== undefined;
  const nextMode = parsed.data.contactEmailMode ?? existing.contactEmailMode;
  if (modeProvided) {
    data.contactEmailMode = parsed.data.contactEmailMode;
  }
  if (nextMode === "CUSTOM") {
    const resolvedOverride = normalizeCommitteeEmail(
      parsed.data.contactEmailOverride ?? existing.contactEmailOverride,
    );
    if (!resolvedOverride) {
      return NextResponse.json(
        {
          error:
            "A custom committee email is required when contact email mode is CUSTOM",
        },
        { status: 400 },
      );
    }
    if (overrideProvided || modeProvided) {
      data.contactEmailOverride = resolvedOverride;
    }
  } else if (modeProvided) {
    // Mode moved away from CUSTOM: drop any stale custom address.
    data.contactEmailOverride = null;
  }
  // If only contactEmailOverride was supplied under a non-CUSTOM mode, it is
  // intentionally ignored so a custom address can't linger under ROLE/MEMBER.

  const updated = await prisma.$transaction(async (tx) => {
    const assignment = await tx.committeeAssignment.update({
      where: { id: existing.id },
      data,
      select: committeeAssignmentSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: parsed.data.isActive === false
          ? "COMMITTEE_ASSIGNMENT_DEACTIVATED"
          : parsed.data.isActive === true && !existing.isActive
            ? "COMMITTEE_ASSIGNMENT_REACTIVATED"
            : "COMMITTEE_ASSIGNMENT_UPDATED",
        actor: { memberId: session.user.id },
        subject: { memberId: existing.memberId },
        entity: { type: "CommitteeAssignment", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Committee assignment updated",
        metadata: {
          changedFields: shallowChangedFields(existing, data as Record<string, unknown>),
          previousCommitteeAssignment: serializeCommitteeAssignment(existing),
          newCommitteeAssignment: serializeCommitteeAssignment(assignment),
        },
        request: getAuditRequestContext(request),
      }),
    );

    // If this is the Booking Officer role, refresh the OtherLodge registry's
    // booking-officer contact from the current holder (no-op for other roles).
    await syncBookingOfficerForRole(tx, existing.committeeRoleId);

    return assignment;
  });

  return NextResponse.json({ assignment: serializeCommitteeAssignment(updated) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsedParams.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.committeeAssignment.findUnique({
    where: { id: parsedParams.data.id },
    select: committeeAssignmentSelect,
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Committee assignment not found" },
      { status: 404 },
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const assignment = await tx.committeeAssignment.update({
      where: { id: existing.id },
      data: {
        isActive: false,
        published: false,
        showPhone: false,
        contactable: false,
        assignedByMemberId: session.user.id,
      },
      select: committeeAssignmentSelect,
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "COMMITTEE_ASSIGNMENT_DEACTIVATED",
        actor: { memberId: session.user.id },
        subject: { memberId: existing.memberId },
        entity: { type: "CommitteeAssignment", id: existing.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Committee assignment deactivated",
        metadata: {
          previousCommitteeAssignment: serializeCommitteeAssignment(existing),
          newCommitteeAssignment: serializeCommitteeAssignment(assignment),
        },
        request: getAuditRequestContext(request),
      }),
    );

    // Deactivating the Booking Officer clears (or reassigns to the next active
    // holder) the OtherLodge registry's booking-officer contact.
    await syncBookingOfficerForRole(tx, existing.committeeRoleId);

    return assignment;
  });

  return NextResponse.json({ assignment: serializeCommitteeAssignment(updated) });
}
