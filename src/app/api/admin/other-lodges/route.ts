import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  normalizeOtherLodgeText,
  otherLodgeOrderBy,
  otherLodgeSelect,
  serializeOtherLodge,
} from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

// An optional email that treats blank input as "not set": the admin form sends
// "" for a cleared field, and "" is not a valid email — fold it to null before
// the format check so clearing the field is not a validation error.
const optionalEmail = z
  .preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().max(320).email().nullable().optional(),
  );

const otherLodgeCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    location: z.string().trim().max(300).nullable().optional(),
    bookingOfficerName: z.string().trim().max(200).nullable().optional(),
    bookingOfficerEmail: optionalEmail,
    bookingOfficerPhone: z.string().trim().max(50).nullable().optional(),
    // Informational bed count of the partner lodge; non-negative, capped well
    // above any real lodge so a fat-fingered value is caught but real ones pass.
    bedCapacity: z.number().int().min(0).max(100000).nullable().optional(),
    active: z.boolean().optional().default(true),
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
    created = await prisma.otherLodge.create({
      data: {
        name: parsed.data.name.trim(),
        location: normalizeOtherLodgeText(parsed.data.location),
        bookingOfficerName: normalizeOtherLodgeText(
          parsed.data.bookingOfficerName,
        ),
        bookingOfficerEmail: normalizeOtherLodgeText(
          parsed.data.bookingOfficerEmail,
        ),
        bookingOfficerPhone: normalizeOtherLodgeText(
          parsed.data.bookingOfficerPhone,
        ),
        bedCapacity: parsed.data.bedCapacity ?? null,
        active: parsed.data.active,
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
      severity: "informational",
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
