import { NextResponse } from "next/server";
import { Prisma as PrismaErrors, type Prisma } from "@prisma/client";
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
import { renameInOwnedNames } from "@/lib/other-lodge-central-id";
import { loadServerNzSettings, renameOwnedOtherLodgeName } from "@/lib/servernz-settings";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({ id: z.string().min(1) });

// Strict: an unknown key is a 400, so every data column has to be named in the
// shared `otherLodgeDataShape` (the one field list) to be accepted here. A key
// left out leaves that column alone; `amenities`, when present, replaces the
// lodge's whole set. `name` may be sent (the panel sends the whole form); a
// DIFFERENT name renames the lodge (#64), but only once the row carries the
// central server's id: the upload then sends that id, and the server renames
// its lodge. Before the id is known a new name would reach the server as a
// second lodge and strand the first (#52), so it is refused.
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
  const newName = parsed.data.name?.trim();
  const renameTo = newName !== undefined && newName !== existing.name ? newName : null;
  if (renameTo !== null && !existing.centralId) {
    return NextResponse.json(
      {
        error:
          "This lodge can be renamed once it has been downloaded from the Alpine Central Server. Run Download, then try again.",
      },
      { status: 400 },
    );
  }

  const data: Prisma.OtherLodgeUpdateInput = {
    ...otherLodgeDataColumns(parsed.data),
    ...(renameTo !== null ? { name: renameTo } : {}),
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

  // An amenity-only edit changes no column on the lodge row, so `@updatedAt`
  // would not fire — and the central-server upload watermark is keyed on this
  // column, so the edit would never be sent. Moved explicitly.
  if (amenitiesChanged) data.updatedAt = new Date();

  // A plain edit is one write. With amenities or a rename, one transaction:
  // the lodge row FIRST (its lock makes a concurrent amenity replacement of the
  // same lodge — the nightly download, an admin's Download button — queue
  // behind this one rather than interleave), then the amenities, then, for a
  // rename, the stored owned list, so the lodge never stops being this site's
  // own between the two writes (#64). The response is re-read after it lands.
  let updated;
  try {
    updated =
      amenitiesChanged || renameTo !== null
        ? await prisma.$transaction(async (tx) => {
            await tx.otherLodge.update({ where: { id: existing.id }, data, select: { id: true } });
            if (amenitiesChanged && amenities) {
              await replaceOtherLodgeAmenities(tx, existing.id, amenities);
            }
            if (renameTo !== null) await renameOwnedOtherLodgeName(tx, existing.name, renameTo);
            return tx.otherLodge.findUniqueOrThrow({
              where: { id: existing.id },
              select: otherLodgeSelect,
            });
          })
        : await prisma.otherLodge.update({
            where: { id: existing.id },
            data,
            select: otherLodgeSelect,
          });
  } catch (error) {
    if (
      renameTo !== null &&
      error instanceof PrismaErrors.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: `Another lodge is already named "${renameTo}".` },
        { status: 409 },
      );
    }
    throw error;
  }
  const ownedAfter =
    renameTo !== null && owned !== null ? renameInOwnedNames(owned, existing.name, renameTo) : owned;

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

  return NextResponse.json({ otherLodge: serializeOtherLodgeForAdmin(updated, ownedAfter) });
}
