/**
 * What the paid-booking import's routes share (#5005, child C): the
 * two-permission gate (O4), the upload body and how it is read, and the
 * club's day and format resolved once per request.
 *
 * O4: confirming and reversing a batch need ONE officer holding both finance
 * edit and bookings edit. `requireAdmin` takes one area, so each route checks
 * finance through it (the route map files `/api/admin/bookings/import` under
 * finance) and bookings with `bookingImportBookingsRefusal`; reads need view
 * on both.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminAreaAccess, type AdminPermissionLevel } from "@/lib/admin-permissions";
import { BOOKING_IMPORT_COLUMNS, type BookingImportColumnMapping } from "@/lib/booking-import/columns";
import { parseBookingImportCsv, type ParsedImportBooking } from "@/lib/booking-import/parse";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { clubFormatValues } from "@/lib/club-format-server";
import { clubTime } from "@/lib/club-time/server";
import { MEMBER_IMPORT_DATE_FORMAT_VALUES } from "@/lib/member-csv-import";

/** The largest file the import takes: well above its 500-row cap. */
export const BOOKING_IMPORT_CSV_MAX_CHARS = 1_000_000;

/** Bookings one confirm or reverse call writes; the screen repeats it until none remain. */
export const BOOKING_IMPORT_SLICE = 20;

/**
 * The second half of the two-permission gate, after `requireAdmin` has passed
 * finance at the same level: a refusal when the officer lacks bookings access,
 * or null. A route that writes also calls `requireRecentAuth` itself.
 */
export function bookingImportBookingsRefusal(
  user: Parameters<typeof hasAdminAreaAccess>[0],
  level: Exclude<AdminPermissionLevel, "none">,
): NextResponse | null {
  if (hasAdminAreaAccess(user, { area: "bookings", level })) return null;
  return NextResponse.json(
    { error: `Importing paid bookings needs both finance ${level} and bookings ${level} access` },
    { status: 403 },
  );
}

const columnIndexSchema = z.number().int().min(0).nullable();

const columnMappingSchema = z
  .object(
    Object.fromEntries(BOOKING_IMPORT_COLUMNS.map((column) => [column.key, columnIndexSchema.optional()])) as Record<
      (typeof BOOKING_IMPORT_COLUMNS)[number]["key"],
      z.ZodOptional<typeof columnIndexSchema>
    >,
  )
  .strict();

/** The upload: one lodge, the file's text, its date format and the officer's column mapping. */
export const bookingImportFileSchema = z.object({
  lodgeId: z.string().trim().min(1).max(100),
  csvText: z.string().min(1).max(BOOKING_IMPORT_CSV_MAX_CHARS),
  dateFormat: z.enum(MEMBER_IMPORT_DATE_FORMAT_VALUES),
  columnMapping: columnMappingSchema.optional(),
});

export const bookingImportConfirmSchema = bookingImportFileSchema.extend({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Reads the uploaded file into bookings, or the plain reason it cannot be read. */
export function readBookingImportFile(
  body: z.infer<typeof bookingImportFileSchema>,
): { ok: true; bookings: ParsedImportBooking[] } | { ok: false; error: string } {
  const parsed = parseBookingImportCsv(body.csvText, {
    dateFormat: body.dateFormat,
    ...(body.columnMapping ? { columnMapping: body.columnMapping as BookingImportColumnMapping } : {}),
  });
  if (!parsed.ok) {
    return { ok: false, error: parsed.lineNumber ? `${parsed.error} (line ${parsed.lineNumber})` : parsed.error };
  }
  if (parsed.bookings.length === 0) return { ok: false, error: "The file has no bookings in it" };
  return { ok: true, bookings: parsed.bookings };
}

/**
 * The club's day as a stored date-only instant and its format, resolved once,
 * before any transaction opens (`INV-LOCK-004`).
 */
export async function bookingImportClubContext() {
  const [time, format] = await Promise.all([clubTime(), clubFormatValues()]);
  return { today: dateOnlyInstantOf(time.today()), format };
}
