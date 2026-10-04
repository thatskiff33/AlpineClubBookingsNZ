import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  amenitiesInputSchema,
  otherLodgeAmenityRows,
  otherLodgeDataColumns,
  otherLodgeDataShape,
  otherLodgeNameSchema,
  otherLodgeOrderBy,
  otherLodgeSelect,
  serializeOtherLodge,
} from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

// Strict: an unknown key is a 400, so every data column has to be named in the
// shared `otherLodgeDataShape` (the one field list) to be accepted here.
const otherLodgeCreateSchema = z
  .object({
    name: otherLodgeNameSchema,
    ...otherLodgeDataShape,
    amenities: amenitiesInputSchema.optional(),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const otherLodges = await prisma.otherLodge.findMany({
    orderBy: otherLodgeOrderBy(),
    select: otherLodgeSelect,
  });

  return NextResponse.json({
    otherLodges: otherLodges.map(serializeOtherLodge),
  });
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = otherLodgeCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let created;
  try {
    // The nested amenity create is part of the same statement, so the lodge and
    // its amenities land together or not at all.
    created = await prisma.otherLodge.create({
      data: {
        name: parsed.data.name.trim(),
        ...otherLodgeDataColumns(parsed.data),
        ...(parsed.data.amenities
          ? { amenities: { create: otherLodgeAmenityRows(parsed.data.amenities) } }
          : {}),
      },
      select: otherLodgeSelect,
    });
  } catch (error) {
    // Unique(name): a concurrent create of the same name, or a duplicate typed
    // by the admin, surfaces as a friendly 409 rather than a 500.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "A lodge with that name already exists." },
        { status: 409 },
      );
    }
    throw error;
  }

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "OTHER_LODGE_CREATED",
      actor: { memberId: session.user.id },
      entity: { type: "OtherLodge", id: created.id },
      category: "admin",
      severity: "info",
      outcome: "success",
      summary: "Other lodge created",
      metadata: { newOtherLodge: serializeOtherLodge(created) },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json(
    { otherLodge: serializeOtherLodge(created) },
    { status: 201 },
  );
}
