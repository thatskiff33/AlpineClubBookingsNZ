import type { OtherLodge, Prisma } from "@prisma/client";
import { z } from "zod";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";

// Helpers for the external / partner lodge registry (Admin -> Lodges). These
// rows are NOT the club's own lodges (see @/lib/lodges) — they carry no slug,
// booking capacity, scoping, or relations. `bedCapacity` is informational only.
// The registry feeds the non-member "which lodge are you a member of"
// drop-down, which is why the name column is unique.
//
// THE FIELD LISTS BELOW ARE THE ONE PLACE A LODGE'S DATA COLUMNS ARE NAMED
// (`INV-SSOT-001`, #50). The admin select, the serializer, the admin create and
// PATCH schemas, the central-server upload projection, the pull schema, the
// download merge and its "differs" comparison all derive from them, so a column
// added here is carried by every one of those, and a column added anywhere else
// is carried by none. Before #50 the sync named the five original columns by
// hand in four places and the admin panel kept a hand-copied type; this is the
// fix for that drift, so do not add a second copy.

/** The free-text columns: trimmed, blank folds to null. */
export const OTHER_LODGE_TEXT_FIELDS = [
  "location",
  "bookingOfficerName",
  "bookingOfficerEmail",
  "bookingOfficerPhone",
  "siteUrl",
  "bookingPath",
  "cancellationPeriod",
] as const;

/** The yes/no facilities. Every one defaults to no on an existing row. */
export const OTHER_LODGE_BOOLEAN_FIELDS = [
  "requiresLodgeCustodian",
  "freeWifi",
  "quietRoom",
  "dryingRoom",
  "sharedKitchen",
  "wheelchairAccessible",
  "breakfastIncluded",
  "lunchIncluded",
  "dinnerIncluded",
] as const;

/** The `@db.Date` season starts: calendar dates, never instants (`INV-DATE-026`). */
export const OTHER_LODGE_DATE_FIELDS = [
  "winterSeasonStart",
  "summerSeasonStart",
] as const;

/** Every data column a lodge carries besides its id, name and timestamps. */
export const OTHER_LODGE_DATA_FIELDS = [
  ...OTHER_LODGE_TEXT_FIELDS,
  "bedCapacity",
  ...OTHER_LODGE_BOOLEAN_FIELDS,
  ...OTHER_LODGE_DATE_FIELDS,
] as const;

type OtherLodgeTextField = (typeof OTHER_LODGE_TEXT_FIELDS)[number];
export type OtherLodgeBooleanField = (typeof OTHER_LODGE_BOOLEAN_FIELDS)[number];
type OtherLodgeDateField = (typeof OTHER_LODGE_DATE_FIELDS)[number];
export type OtherLodgeDataField = (typeof OTHER_LODGE_DATA_FIELDS)[number];

/** `{ column: true }` for every data column, for a Prisma `select`. */
export const OTHER_LODGE_DATA_SELECT = Object.fromEntries(
  OTHER_LODGE_DATA_FIELDS.map((field) => [field, true] as const),
) as { readonly [K in OtherLodgeDataField]: true } satisfies Prisma.OtherLodgeSelect;

/** The amenity relation as every reader selects it: name-ordered, two columns. */
export const otherLodgeAmenitiesSelect = {
  select: { name: true, description: true },
  orderBy: { name: "asc" },
} as const;

export const otherLodgeSelect = {
  id: true,
  name: true,
  ...OTHER_LODGE_DATA_SELECT,
  amenities: otherLodgeAmenitiesSelect,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OtherLodgeSelect;

export interface OtherLodgeAmenity {
  name: string;
  description: string | null;
}

/** A lodge's data columns as Prisma reads them (dates as `Date`). */
export type OtherLodgeDataRecord = Pick<OtherLodge, OtherLodgeDataField>;

export type OtherLodgeRecord = Pick<
  OtherLodge,
  "id" | "name" | OtherLodgeDataField | "createdAt" | "updatedAt"
> & { amenities: OtherLodgeAmenity[] };

/**
 * A lodge's data columns on the wire: what the admin API returns, what the
 * panel edits, and what is uploaded to the central server. Dates are
 * `YYYY-MM-DD` strings so a calendar day crosses JSON without a time zone.
 */
export type SerializedOtherLodgeData = { [K in OtherLodgeTextField]: string | null } & {
  bedCapacity: number | null;
} & { [K in OtherLodgeBooleanField]: boolean } & {
  [K in OtherLodgeDateField]: string | null;
};

export interface SerializedOtherLodge extends SerializedOtherLodgeData {
  id: string;
  name: string;
  amenities: OtherLodgeAmenity[];
  createdAt: string;
  updatedAt: string;
}

export function serializeOtherLodgeData(
  lodge: OtherLodgeDataRecord,
): SerializedOtherLodgeData {
  const data: Record<string, unknown> = {};
  for (const field of OTHER_LODGE_TEXT_FIELDS) data[field] = lodge[field];
  data.bedCapacity = lodge.bedCapacity;
  for (const field of OTHER_LODGE_BOOLEAN_FIELDS) data[field] = lodge[field];
  for (const field of OTHER_LODGE_DATE_FIELDS) {
    // A `@db.Date` read is a date-only value, which is `formatDateOnly`'s
    // receiver contract (INV-DATE-026); it is never an instant.
    const value = lodge[field];
    data[field] = value ? formatDateOnly(value) : null;
  }
  return data as SerializedOtherLodgeData;
}

export function serializeOtherLodgeAmenities(
  amenities: ReadonlyArray<OtherLodgeAmenity>,
): OtherLodgeAmenity[] {
  return amenities.map((a) => ({ name: a.name, description: a.description }));
}

export function serializeOtherLodge(
  lodge: OtherLodgeRecord,
): SerializedOtherLodge {
  return {
    id: lodge.id,
    name: lodge.name,
    ...serializeOtherLodgeData(lodge),
    amenities: serializeOtherLodgeAmenities(lodge.amenities),
    createdAt: lodge.createdAt.toISOString(),
    updatedAt: lodge.updatedAt.toISOString(),
  };
}

// Alphabetical: the registry is presented as a name-first list and will back a
// name-ordered drop-down. Tie-break on id so paging/order is deterministic.
export function otherLodgeOrderBy() {
  return [{ name: "asc" }, { id: "asc" }] satisfies Prisma.OtherLodgeOrderByWithRelationInput[];
}

// Trim to a stored value, folding blank/whitespace-only input to null so an
// "empty" optional field never persists as "".
export function normalizeOtherLodgeText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// ── Validation ─────────────────────────────────────────────────────────────
//
// One shape for the admin create and PATCH routes AND for the rows the central
// server sends: the remote is held to exactly the bounds the club's own officer
// is held to, no looser and no tighter (see `servernz-api.ts` for why).

const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

// An optional email that treats blank input as "not set": the admin form sends
// "" for a cleared field, and "" is not a valid email — fold it to null before
// the format check so clearing the field is not a validation error.
const optionalEmail = z.preprocess(
  blankToNull,
  z.string().trim().max(320).email().nullable().optional(),
);

/** `http:` or `https:` only — the value is rendered as a link. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// A real calendar date as `YYYY-MM-DD`: the kernel's check refuses `2026-02-30`,
// which a bare pattern would pass and `Date.parse` would roll into March.
const dateOnlyField = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .refine(isDateOnlyString, "Use a real calendar date as YYYY-MM-DD")
    .nullable()
    .optional(),
);

export const AMENITIES_PER_LODGE_MAX = 50;

const amenityInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.preprocess(
      blankToNull,
      z.string().trim().max(1000).nullable().optional(),
    ),
  })
  .strict();

/** The whole amenity set for a lodge. Names are unique, ignoring case. */
export const amenitiesInputSchema = z
  .array(amenityInputSchema)
  .max(AMENITIES_PER_LODGE_MAX)
  .refine(
    (list) =>
      new Set(list.map((a) => a.name.trim().toLowerCase())).size === list.length,
    "Amenity names must be unique within a lodge",
  );

export type OtherLodgeAmenityInput = z.infer<typeof amenityInputSchema>;

const booleanShape = Object.fromEntries(
  OTHER_LODGE_BOOLEAN_FIELDS.map((field) => [field, z.boolean().optional()]),
) as { [K in OtherLodgeBooleanField]: z.ZodOptional<z.ZodBoolean> };

/**
 * Every data column, each OPTIONAL: a key left out means "leave the stored
 * value alone" — on a PATCH, and on a pull from a central server that does not
 * yet send that field. It never means "set to null/false".
 */
export const otherLodgeDataShape = {
  location: z.string().trim().max(300).nullable().optional(),
  bookingOfficerName: z.string().trim().max(200).nullable().optional(),
  bookingOfficerEmail: optionalEmail,
  bookingOfficerPhone: z.string().trim().max(50).nullable().optional(),
  // Informational bed count of the partner lodge; non-negative, capped well
  // above any real lodge so a fat-fingered value is caught but real ones pass.
  bedCapacity: z.number().int().min(0).max(100000).nullable().optional(),
  siteUrl: z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .max(500)
      .refine(isHttpUrl, "Site URL must start with http:// or https://")
      .nullable()
      .optional(),
  ),
  bookingPath: z.string().trim().max(300).nullable().optional(),
  cancellationPeriod: z.string().trim().max(200).nullable().optional(),
  ...booleanShape,
  winterSeasonStart: dateOnlyField,
  summerSeasonStart: dateOnlyField,
};

export type OtherLodgeDataInput = z.infer<z.ZodObject<typeof otherLodgeDataShape>>;

/** The Prisma column values for whichever data fields were PROVIDED. */
export type OtherLodgeDataColumns = Partial<OtherLodgeDataRecord>;

/**
 * Validated input to column values: text trimmed with blank folded to null,
 * dates parsed to the UTC-midnight encoding a `@db.Date` column stores. A key
 * absent from the input stays absent, so a partial update never clears a
 * column it did not mention.
 */
export function otherLodgeDataColumns(
  input: OtherLodgeDataInput,
): OtherLodgeDataColumns {
  const data: Record<string, unknown> = {};
  for (const field of OTHER_LODGE_TEXT_FIELDS) {
    if (input[field] !== undefined) data[field] = normalizeOtherLodgeText(input[field]);
  }
  if (input.bedCapacity !== undefined) data.bedCapacity = input.bedCapacity;
  for (const field of OTHER_LODGE_BOOLEAN_FIELDS) {
    if (input[field] !== undefined) data[field] = input[field];
  }
  for (const field of OTHER_LODGE_DATE_FIELDS) {
    const value = input[field];
    if (value !== undefined) data[field] = value ? parseDateOnly(value) : null;
  }
  return data as OtherLodgeDataColumns;
}

/**
 * True when the PROVIDED columns would change what is stored. Only keys present
 * in `data` are compared, so an omitted field never counts as a change. Dates
 * compare as the calendar day they encode, through `storedDateOnly`, never as
 * two `Date` object identities.
 */
export function otherLodgeDataDiffers(
  data: OtherLodgeDataColumns,
  existing: OtherLodgeDataRecord,
): boolean {
  return (Object.keys(data) as OtherLodgeDataField[]).some((key) => {
    const next = data[key];
    const current = existing[key];
    if (next instanceof Date || current instanceof Date) {
      const a = next instanceof Date ? storedDateOnly(next).getTime() : null;
      const b = current instanceof Date ? storedDateOnly(current).getTime() : null;
      return a !== b;
    }
    return next !== current;
  });
}

// ── Amenities ──────────────────────────────────────────────────────────────

/** The rows to store for an amenity list (names already validated unique). */
export function otherLodgeAmenityRows(
  list: ReadonlyArray<OtherLodgeAmenityInput>,
): OtherLodgeAmenity[] {
  return list.map((a) => ({
    name: a.name.trim(),
    description: normalizeOtherLodgeText(a.description),
  }));
}

/** True when two amenity lists are not the same set of (name, description). */
export function otherLodgeAmenitiesDiffer(
  existing: ReadonlyArray<OtherLodgeAmenity>,
  incoming: ReadonlyArray<OtherLodgeAmenityInput>,
): boolean {
  const rows = otherLodgeAmenityRows(incoming);
  if (existing.length !== rows.length) return true;
  const current = new Map(existing.map((a) => [a.name, a.description] as const));
  return rows.some((row) => !current.has(row.name) || current.get(row.name) !== row.description);
}

/**
 * Make a lodge's stored amenities equal `incoming`, inside the caller's
 * transaction so the lodge row and its amenities change together or not at
 * all. Rows whose name is not in the new set are deleted; every other row is
 * upserted on the (otherLodgeId, name) unique key. That key is what makes two
 * overlapping replacements converge instead of racing — the admin Upload and
 * Download buttons and the nightly cron share no advisory lock.
 *
 * The CALLER moves the lodge's own `updatedAt`: an amenity-only change touches
 * no column on the lodge row, and the upload watermark is keyed on that column.
 */
export async function replaceOtherLodgeAmenities(
  tx: Prisma.TransactionClient,
  otherLodgeId: string,
  incoming: ReadonlyArray<OtherLodgeAmenityInput>,
): Promise<void> {
  const rows = otherLodgeAmenityRows(incoming);
  await tx.amenity.deleteMany({
    where: { otherLodgeId, name: { notIn: rows.map((r) => r.name) } },
  });
  for (const row of rows) {
    await tx.amenity.upsert({
      where: { otherLodgeId_name: { otherLodgeId, name: row.name } },
      create: { otherLodgeId, ...row },
      update: { description: row.description },
    });
  }
}
