import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  OTHER_LODGE_DATE_FIELDS,
  OTHER_LODGE_NOT_OWNED_CODE,
  OTHER_LODGE_RATE_FIELDS,
  amenitiesInputSchema,
  otherLodgeAmenitiesDiffer,
  otherLodgeDataColumns,
  otherLodgeDataShape,
  otherLodgeNameSchema,
  otherLodgeSelect,
  canRenameOtherLodge,
  ownsOtherLodge,
  replaceOtherLodgeAmenities,
  serializeOtherLodge,
  serializeOtherLodgeForAdmin,
  visibleOtherLodgeWhere,
} from "@/lib/other-lodges";
import { isSafeHttpUrl, SAFE_HTTP_URL_MESSAGE } from "@/lib/http-url";
import { FEES_FILL_PROBLEM_TEXT, syncOwnOtherLodgesFromFees } from "@/lib/other-lodge-fees-sync";
import { seasonDatesProblem } from "@/lib/other-lodge-seasons";
import { prisma } from "@/lib/prisma";
import { loadServerNzSettings } from "@/lib/servernz-settings";
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
    // Stricter than the pull's: the address must be one the central server
    // accepts (#55). A request that leaves it out leaves the stored one alone.
    siteUrl: otherLodgeDataShape.siteUrl.refine(
      (v) => v == null || isSafeHttpUrl(v),
      SAFE_HTTP_URL_MESSAGE,
    ),
    amenities: amenitiesInputSchema.optional(),
    // This club's own lodge only (#77): fill its rates and season dates from
    // the Fees page. While on, rates and dates sent here are ignored.
    ratesFromFees: z.boolean().optional(),
  })
  .strict();

// The delete handler that lived here was removed by #52 along with create: a
// site changes only the lodge(s) the central server says it owns, and it never
// removes an entry from the shared registry. A DELETE now answers 405. Nothing
// removes a row: `./hide` (#58) hides one the server does NOT list.

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

  // A hidden lodge (#58) is kept only for the bookings that name it: not edited.
  const existing = await prisma.otherLodge.findFirst({
    where: { id: parsedParams.data.id, ...visibleOtherLodgeWhere },
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
  const { otherLodgesOwnedLodges: owned } = await loadServerNzSettings();
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
  if (!ownsOtherLodge(owned, existing)) {
    return NextResponse.json(
      {
        error:
          "Only this site's own lodge can be changed here. Another club's lodge is changed by that club and arrives by download.",
        code: OTHER_LODGE_NOT_OWNED_CODE,
      },
      { status: 403 },
    );
  }
  // While the switch is on (#77) the Fees page owns the rates and dates, so the
  // ones the form sends (shown read-only) are dropped, not saved over them.
  const { ratesFromFees, ...input } = parsed.data;
  const fromFees = ratesFromFees ?? existing.ratesFromFees;
  if (fromFees) {
    for (const field of [...OTHER_LODGE_RATE_FIELDS, ...OTHER_LODGE_DATE_FIELDS]) delete input[field];
  }
  // The seasons as this save would leave them (#75): the dates it sends over
  // the stored ones. The central server applies the same rule to the upload.
  const stored = serializeOtherLodge(existing);
  const seasons = Object.fromEntries(
    OTHER_LODGE_DATE_FIELDS.map((f) => [f, input[f] !== undefined ? input[f] : stored[f]]),
  );
  const seasonProblem = seasonDatesProblem(seasons);
  if (seasonProblem) return NextResponse.json({ error: seasonProblem }, { status: 400 });

  const newName = input.name?.trim();
  const renameTo = newName !== undefined && newName !== existing.name ? newName : null;
  if (renameTo !== null && !canRenameOtherLodge(owned, existing)) {
    return NextResponse.json(
      {
        error:
          "This lodge can be renamed after the next Download from the Alpine Central Server. Run Download, then try again.",
      },
      { status: 400 },
    );
  }

  const data: Prisma.OtherLodgeUpdateManyMutationInput = {
    ...otherLodgeDataColumns(input),
    ...(renameTo !== null ? { name: renameTo } : {}),
    ...(ratesFromFees !== undefined && ratesFromFees !== existing.ratesFromFees ? { ratesFromFees } : {}),
  };
  const changedFields = Object.keys(data);

  const amenities = input.amenities;
  const amenitiesChanged =
    amenities !== undefined &&
    otherLodgeAmenitiesDiffer(existing.amenities, amenities);
  if (amenitiesChanged) changedFields.push("amenities");

  if (changedFields.length === 0 && !fromFees) {
    // The panel shows what it is handed, so the row goes back in the LIST shape
    // (with its `owned` flag), not the bare serializer the audit row uses.
    return NextResponse.json({ otherLodge: serializeOtherLodgeForAdmin(existing, owned) });
  }
  if (changedFields.length === 0) return respondFilledFromFees(existing.id, owned, session.user.id);

  // An amenity-only edit changes no column on the lodge row, so `@updatedAt`
  // would not fire — and the central-server upload watermark is keyed on this
  // column, so the edit would never be sent. Moved explicitly.
  if (amenitiesChanged) data.updatedAt = new Date();

  // A plain edit, a rename included, is one write (#69: the owned list is kept
  // by central id, so a rename touches nothing else). With amenities, one
  // transaction: the lodge row FIRST (its lock makes a concurrent amenity
  // replacement of the same lodge — the nightly download, an admin's Download
  // button — queue behind this one rather than interleave), then the
  // amenities. The response is re-read after it lands. A name another lodge
  // already has is allowed: two lodges may share a name.
  const updated = amenitiesChanged
    ? await prisma.$transaction(async (tx) => {
        await tx.otherLodge.update({ where: { id: existing.id }, data, select: { id: true } });
        if (amenities) await replaceOtherLodgeAmenities(tx, existing.id, amenities);
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
        // A local setting, so not in the serialized lodge (#77): recorded here.
        ratesFromFees: { previous: existing.ratesFromFees, next: updated.ratesFromFees },
        previousOtherLodge: serializeOtherLodge(existing),
        newOtherLodge: serializeOtherLodge(updated),
      },
      request: getAuditRequestContext(request),
    }),
  );

  if (fromFees) return respondFilledFromFees(updated.id, owned, session.user.id);
  return NextResponse.json({ otherLodge: serializeOtherLodgeForAdmin(updated, owned) });
}

/**
 * Fill the lodge from the Fees page (#77; audited there), then answer with the
 * row as it is now, and why it could not be filled, when it could not.
 */
async function respondFilledFromFees(id: string, owned: Parameters<typeof serializeOtherLodgeForAdmin>[1], actor: string) {
  const results = await syncOwnOtherLodgesFromFees("lodge saved", actor);
  const problem = results.find((r) => r.otherLodgeId === id)?.problem;
  const row = await prisma.otherLodge.findUniqueOrThrow({ where: { id }, select: otherLodgeSelect });
  const otherLodge = serializeOtherLodgeForAdmin(row, owned);
  return NextResponse.json({ otherLodge: problem ? { ...otherLodge, feesProblem: FEES_FILL_PROBLEM_TEXT[problem] } : otherLodge });
}
