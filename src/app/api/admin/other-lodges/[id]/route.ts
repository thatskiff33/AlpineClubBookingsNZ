import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  amenitiesInputSchema,
  otherLodgeAmenitiesDiffer,
  otherLodgeDataColumns,
  otherLodgeDataShape,
  otherLodgeNameSchema,
  otherLodgeSelect,
  replaceOtherLodgeAmenities,
  serializeOtherLodge,
} from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({ id: z.string().min(1) });

// Strict: an unknown key is a 400, so every data column has to be named in the
// shared `otherLodgeDataShape` (the one field list) to be accepted here. A key
// left out leaves that column alone; `amenities`, when present, replaces the
// lodge's whole set.
const patchSchema = z
  .object({
    name: otherLodgeNameSchema.optional(),
    ...otherLodgeDataShape,
    amenities: amenitiesInputSchema.optional(),
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

  const data: Prisma.OtherLodgeUpdateInput = {
    ...otherLodgeDataColumns(parsed.data),
  };
  if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
  const changedFields = Object.keys(data);

  const amenities = parsed.data.amenities;
  const amenitiesChanged =
    amenities !== undefined &&
    otherLodgeAmenitiesDiffer(existing.amenities, amenities);
  if (amenitiesChanged) changedFields.push("amenities");

  if (changedFields.length === 0) {
    return NextResponse.json({ otherLodge: serializeOtherLodge(existing) });
  }

  let updated;
  try {
    if (amenitiesChanged && amenities) {
      // Moved explicitly: an amenity-only edit changes no column on the lodge
      // row, so `@updatedAt` would not fire — and the central-server upload
      // watermark is keyed on this column, so the edit would never be sent.
      data.updatedAt = new Date();
      // One transaction so the lodge row and its amenities change together, and
      // the LODGE ROW IS WRITTEN FIRST: that update holds the row's lock for the
      // rest of the transaction, so a concurrent replacement of the same lodge's
      // amenities (the nightly download, an admin's Download button) queues
      // behind this one instead of interleaving its deletes and upserts with
      // ours and leaving a stale row behind. The response is re-read after the
      // amenities land, so it shows the set that was saved.
      updated = await prisma.$transaction(async (tx) => {
        await tx.otherLodge.update({
          where: { id: existing.id },
          data,
          select: { id: true },
        });
        await replaceOtherLodgeAmenities(tx, existing.id, amenities);
        return tx.otherLodge.findUniqueOrThrow({
          where: { id: existing.id },
          select: otherLodgeSelect,
        });
      });
    } else {
      updated = await prisma.otherLodge.update({
        where: { id: existing.id },
        data,
        select: otherLodgeSelect,
      });
    }
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
        changedFields,
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

  try {
    await prisma.otherLodge.delete({ where: { id: existing.id } });
  } catch (error) {
    // Restrict FK from BookingRequest.otherLodgeId (#2749): a lodge a requester
    // has cited cannot be deleted out from under the approval process.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json(
        {
          error:
            "This lodge is referenced by one or more booking requests and can't be deleted.",
        },
        { status: 409 },
      );
    }
    throw error;
  }

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
