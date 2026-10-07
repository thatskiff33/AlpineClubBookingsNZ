import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  OTHER_LODGE_NOT_OWNED_CODE,
  amenitiesInputSchema,
  otherLodgeAmenitiesDiffer,
  otherLodgeDataColumns,
  otherLodgeDataShape,
  otherLodgeNameSchema,
  otherLodgeSelect,
  ownsOtherLodge,
  replaceOtherLodgeAmenities,
  serializeOtherLodge,
  serializeOtherLodgeForAdmin,
} from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({ id: z.string().min(1) });

// Strict: an unknown key is a 400, so every data column has to be named in the
// shared `otherLodgeDataShape` (the one field list) to be accepted here. A key
// left out leaves that column alone; `amenities`, when present, replaces the
// lodge's whole set. `name` may be sent (the panel sends the whole form) but it
// must equal the stored name: the central server matches lodges BY NAME, so a
// rename here would not rename the lodge there — it would create a second one
// and strand the first (#52).
const patchSchema = z
  .object({
    name: otherLodgeNameSchema.optional(),
    ...otherLodgeDataShape,
    amenities: amenitiesInputSchema.optional(),
  })
  .strict();

// The delete handler that lived here was removed by #52 along with create: a
// site changes only the lodge(s) the central server says it owns, and it never
// removes an entry from the shared registry. A DELETE now answers 405.

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

  // OWNERSHIP, enforced here and not only by hiding buttons (#52). The one rule
  // is `ownsOtherLodge` over the list the central server last sent; an unknown
  // list (never received) refuses everything, because "we have not been told"
  // is not "we own it". The `code` lets the panel show this text rather than
  // the generic permissions message, since the administrator's role is fine.
  const { otherLodgesOwnedNames: owned } = await loadServerNzSettings();
  if (owned === null) {
    return NextResponse.json(
      {
        error:
          "This site has not yet been told by the Alpine Central Server which lodge is its own. Connect to the central server and run Download, then try again.",
        code: OTHER_LODGE_NOT_OWNED_CODE,
      },
      { status: 403 },
    );
  }
  if (!ownsOtherLodge(owned, existing.name)) {
    return NextResponse.json(
      {
        error:
          "Only this site's own lodge can be changed here. Another club's lodge is changed by that club and arrives by download.",
        code: OTHER_LODGE_NOT_OWNED_CODE,
      },
      { status: 403 },
    );
  }
  if (parsed.data.name !== undefined && parsed.data.name.trim() !== existing.name) {
    return NextResponse.json(
      {
        error:
          "The lodge name cannot be changed here: the central server matches lodges by name, so a new name would create a second lodge there.",
      },
      { status: 400 },
    );
  }

  const data: Prisma.OtherLodgeUpdateInput = {
    ...otherLodgeDataColumns(parsed.data),
  };
  const changedFields = Object.keys(data);

  const amenities = parsed.data.amenities;
  const amenitiesChanged =
    amenities !== undefined &&
    otherLodgeAmenitiesDiffer(existing.amenities, amenities);
  if (amenitiesChanged) changedFields.push("amenities");

  if (changedFields.length === 0) {
    // The panel shows what it is handed, so the row goes back in the LIST shape
    // (with its `owned` flag), not the bare serializer the audit row uses.
    return NextResponse.json({ otherLodge: serializeOtherLodgeForAdmin(existing, owned) });
  }

  let updated;
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

  return NextResponse.json({ otherLodge: serializeOtherLodgeForAdmin(updated, owned) });
}
