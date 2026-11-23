import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

const createLockerSchema = z.object({
  name: z
    .string()
    .trim()
    .transform((value) => value.replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(200)),
  allocatedToMemberId: z.string().trim().min(1).max(191).nullable().optional(),
  lodgeId: z.string().min(1).optional(),
});

async function findDuplicateLockerName(name: string, lodgeId: string) {
  // Per-lodge uniqueness with null tolerance: a null-lodge row is visible
  // at every lodge, so it clashes here (case-insensitive, matching the
  // pre-rescope behaviour).
  return prisma.locker.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
      lodgeId,
    },
    select: { id: true },
  });
}

/**
 * GET /api/admin/lockers
 * Returns lockers and active members for allocation dropdown.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  // Null-tolerant filter: rows without a lodgeId (pre-backfill or written by
  // a draining old colour during the expand deploy) show under every lodge.
  const lodgeId = request.nextUrl.searchParams.get("lodgeId");
  const [lockers, members] = await Promise.all([
    prisma.locker.findMany({
      where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
      include: {
        allocatedTo: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.member.findMany({
      where: { active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
  ]);

  return NextResponse.json({ lockers, members });
}

/**
 * POST /api/admin/lockers
 * Creates a new locker, optionally allocated to a member.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = createLockerSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const allocatedToMemberId = parsed.data.allocatedToMemberId ?? null;
  if (allocatedToMemberId) {
    const member = await prisma.member.findFirst({
      where: { id: allocatedToMemberId, active: true },
      select: { id: true },
    });
    if (!member) {
      return NextResponse.json(
        { error: "Allocated member not found" },
        { status: 404 },
      );
    }
  }

  const lodgeId = await resolveOptionalActiveLodgeId(prisma, parsed.data.lodgeId);
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 },
    );
  }

  if (await findDuplicateLockerName(parsed.data.name, lodgeId)) {
    return NextResponse.json(
      { error: "A locker with that name already exists at this lodge" },
      { status: 409 },
    );
  }

  try {
    const locker = await prisma.$transaction(async (tx) => {
      const created = await tx.locker.create({
        data: {
          name: parsed.data.name,
          allocatedToMemberId,
          lodgeId,
        },
        include: {
          allocatedTo: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      });

      await createAuditLog(
        {
          action: "locker.created",
          memberId: guard.session.user.id,
          entityType: "Locker",
          entityId: created.id,
          category: "admin",
          outcome: "success",
          summary: "Locker created",
          metadata: {
            lockerId: created.id,
            name: created.name,
            allocatedToMemberId,
          },
        },
        tx,
      );

      return created;
    });

    return NextResponse.json({ locker }, { status: 201 });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A locker with that name already exists" },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: "Failed to create locker" },
      { status: 500 },
    );
  }
}
