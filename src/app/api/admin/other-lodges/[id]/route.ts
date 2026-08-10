import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  normalizeOtherLodgeText,
  otherLodgeSelect,
  serializeOtherLodge,
} from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({ id: z.string().min(1) });

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().max(320).email().nullable().optional(),
);

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    location: z.string().trim().max(300).nullable().optional(),
    bookingOfficerName: z.string().trim().max(200).nullable().optional(),
    bookingOfficerEmail: optionalEmail,
    bookingOfficerPhone: z.string().trim().max(50).nullable().optional(),
    bedCapacity: z.number().int().min(0).max(100000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.otherLodge.findUnique({
    where: { id: parsedParams.data.id },
    select: otherLodgeSelect,
  });
  if (!existing) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  const data: Prisma.OtherLodgeUpdateInput = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
  if (parsed.data.location !== undefined) {
    data.location = normalizeOtherLodgeText(parsed.data.location);
  }
  if (parsed.data.bookingOfficerName !== undefined) {
    data.bookingOfficerName = normalizeOtherLodgeText(
      parsed.data.bookingOfficerName,
    );
  }
  if (parsed.data.bookingOfficerEmail !== undefined) {
    data.bookingOfficerEmail = normalizeOtherLodgeText(
      parsed.data.bookingOfficerEmail,
    );
  }
  if (parsed.data.bookingOfficerPhone !== undefined) {
    data.bookingOfficerPhone = normalizeOtherLodgeText(
      parsed.data.bookingOfficerPhone,
    );
  }
  if (parsed.data.bedCapacity !== undefined) {
    data.bedCapacity = parsed.data.bedCapacity;
  }
  if (parsed.data.active !== undefined) data.active = parsed.data.active;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ otherLodge: serializeOtherLodge(existing) });
  }

  let updated;
  try {
    updated = await prisma.otherLodge.update({
      where: { id: existing.id },
      data,
      select: otherLodgeSelect,
    });
  } catch (error) {
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
      action: "OTHER_LODGE_UPDATED",
      actor: { memberId: session.user.id },
      entity: { type: "OtherLodge", id: updated.id },
      category: "admin",
      severity: "info",
      outcome: "success",
      summary: "Other lodge updated",
      metadata: {
        changedFields: Object.keys(data),
        previousOtherLodge: serializeOtherLodge(existing),
        newOtherLodge: serializeOtherLodge(updated),
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ otherLodge: serializeOtherLodge(updated) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  const existing = await prisma.otherLodge.findUnique({
    where: { id: parsedParams.data.id },
    select: otherLodgeSelect,
  });
  if (!existing) {
    return NextResponse.json({ error: "Lodge not found" }, { status: 404 });
  }

  await prisma.otherLodge.delete({ where: { id: existing.id } });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "OTHER_LODGE_DELETED",
      actor: { memberId: session.user.id },
      entity: { type: "OtherLodge", id: existing.id },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Other lodge deleted",
      metadata: { deletedOtherLodge: serializeOtherLodge(existing) },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ ok: true });
}
