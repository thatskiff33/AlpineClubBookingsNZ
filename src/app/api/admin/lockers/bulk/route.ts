import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { bulkCreateLockersSchema } from "@/lib/admin-membership-api/lockers";
import { connectionJson } from "@/lib/mcp-connection-request";
import { LOCKER_BULK_CREATED_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-lockers";

/**
 * POST /api/admin/lockers/bulk
 * Seed N unallocated lockers ("<prefix> 1..N") in one transaction (ADR-003
 * bulk seeding). Locker names are still globally unique until the phase-2
 * contract release, so a clashing prefix rejects the whole batch.
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

  const parsed = bulkCreateLockersSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const namePrefix = parsed.data.namePrefix ?? "Locker";
  const names = Array.from(
    { length: parsed.data.count },
    (_, index) => `${namePrefix} ${index + 1}`,
  );

  const lodgeId = await resolveOptionalActiveLodgeId(
    prisma,
    parsed.data.lodgeId,
  );
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 },
    );
  }

  const clash = await prisma.locker.findFirst({
    where: {
      name: { in: names, mode: "insensitive" },
      lodgeId,
    },
    select: { name: true },
  });
  if (clash) {
    return NextResponse.json(
      {
        error: `A locker named "${clash.name}" already exists at this lodge. Choose a different name prefix.`,
      },
      { status: 409 },
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.locker.createMany({
      data: names.map((name) => ({ name, lodgeId })),
    });

    await createAuditLog(
      {
        action: "locker.bulk_created",
        memberId: guard.session.user.id,
        entityType: "Locker",
        entityId: lodgeId,
        category: "admin",
        outcome: "success",
        summary: "Lockers bulk created",
        metadata: { lodgeId, count: names.length, namePrefix },
      },
      tx,
    );

    return names.length;
  });

  return connectionJson(
    request,
    { createdCount: created },
    LOCKER_BULK_CREATED_CONNECTION_SHAPE,
    { status: 201 },
  );
}
