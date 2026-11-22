import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { serializeLodgeAccessRows } from "@/lib/lodge-access";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

// Admin surface for managing a member's per-lodge access grants (phase 4 of
// docs/multi-lodge/implementation-plan.md). BOOKING_RESTRICTION rows narrow
// which lodges a member may book; STAFF rows bind a lodge-operational
// (kiosk) account to a lodge. See src/lib/lodge-access.ts for enforcement.

const putSchema = z
  .object({
    bookingRestrictionLodgeIds: z.array(z.string().min(1)).max(50),
    staffLodgeIds: z.array(z.string().min(1)).max(50),
  })
  .strict();

async function loadMember(memberId: string) {
  return prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const { id: memberId } = await params;

  const member = await loadMember(memberId);
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const rows = await prisma.memberLodgeAccess.findMany({
    where: { memberId },
    select: { id: true, lodgeId: true, kind: true, createdAt: true },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
  });

  const serialized = serializeLodgeAccessRows(rows);

  return NextResponse.json({
    lodgeAccess: serialized,
    bookingRestrictions: serialized.filter(
      (row) => row.kind === "BOOKING_RESTRICTION",
    ),
    staffGrants: serialized.filter((row) => row.kind === "STAFF"),
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: memberId } = await params;

  const member = await loadMember(memberId);
  if (!member) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const bookingRestrictionLodgeIds = [
    ...new Set(parsed.data.bookingRestrictionLodgeIds),
  ];
  const staffLodgeIds = [...new Set(parsed.data.staffLodgeIds)];
  const requestedLodgeIds = [
    ...new Set([...bookingRestrictionLodgeIds, ...staffLodgeIds]),
  ];

  if (requestedLodgeIds.length > 0) {
    const existingLodges = await prisma.lodge.findMany({
      where: { id: { in: requestedLodgeIds } },
      select: { id: true },
    });
    const existingLodgeIds = new Set(existingLodges.map((l) => l.id));
    const unknownLodgeIds = requestedLodgeIds.filter(
      (id) => !existingLodgeIds.has(id),
    );
    if (unknownLodgeIds.length > 0) {
      return NextResponse.json(
        { error: "Unknown lodge id", details: { unknownLodgeIds } },
        { status: 400 },
      );
    }
  }

  const previousRows = await prisma.memberLodgeAccess.findMany({
    where: { memberId },
    select: { lodgeId: true, kind: true },
  });
  const previousBookingRestrictionLodgeIds = previousRows
    .filter((row) => row.kind === "BOOKING_RESTRICTION")
    .map((row) => row.lodgeId);
  const previousStaffLodgeIds = previousRows
    .filter((row) => row.kind === "STAFF")
    .map((row) => row.lodgeId);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.memberLodgeAccess.deleteMany({
      where: { memberId, kind: "BOOKING_RESTRICTION" },
    });
    if (bookingRestrictionLodgeIds.length > 0) {
      await tx.memberLodgeAccess.createMany({
        data: bookingRestrictionLodgeIds.map((lodgeId) => ({
          memberId,
          lodgeId,
          kind: "BOOKING_RESTRICTION" as const,
          createdById: session.user.id,
        })),
      });
    }

    await tx.memberLodgeAccess.deleteMany({
      where: { memberId, kind: "STAFF" },
    });
    if (staffLodgeIds.length > 0) {
      await tx.memberLodgeAccess.createMany({
        data: staffLodgeIds.map((lodgeId) => ({
          memberId,
          lodgeId,
          kind: "STAFF" as const,
          createdById: session.user.id,
        })),
      });
    }

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBER_LODGE_ACCESS_UPDATED",
        actor: { memberId: session.user.id },
        entity: { type: "Member", id: memberId },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Member lodge access updated",
        metadata: {
          bookingRestriction: {
            previousLodgeIds: previousBookingRestrictionLodgeIds,
            newLodgeIds: bookingRestrictionLodgeIds,
          },
          staff: {
            previousLodgeIds: previousStaffLodgeIds,
            newLodgeIds: staffLodgeIds,
          },
        },
        request: getAuditRequestContext(request),
      }),
    );

    return tx.memberLodgeAccess.findMany({
      where: { memberId },
      select: { id: true, lodgeId: true, kind: true, createdAt: true },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
    });
  });

  const serialized = serializeLodgeAccessRows(updated);

  return NextResponse.json({
    lodgeAccess: serialized,
    bookingRestrictions: serialized.filter(
      (row) => row.kind === "BOOKING_RESTRICTION",
    ),
    staffGrants: serialized.filter((row) => row.kind === "STAFF"),
  });
}
