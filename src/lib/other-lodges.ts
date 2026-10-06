import type { OtherLodge, Prisma } from "@prisma/client";
import { z } from "zod";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { isHttpUrl } from "@/lib/http-url";
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
// fix for that drift, so do not add a second copy. `OTHER_LODGE_BOUNDS` is the
// same rule for the lengths: the zod shapes and the panel's inputs both read it.

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

export type OtherLodgeTextField = (typeof OTHER_LODGE_TEXT_FIELDS)[number];
export type OtherLodgeBooleanField = (typeof OTHER_LODGE_BOOLEAN_FIELDS)[number];
export type OtherLodgeDateField = (typeof OTHER_LODGE_DATE_FIELDS)[number];
export type OtherLodgeDataField = (typeof OTHER_LODGE_DATA_FIELDS)[number];

/**
 * COMPILE-TIME EXHAUSTIVENESS. `Pick<OtherLodge, OtherLodgeDataField>` below
 * already fails when a listed name is not a column; this is the other
 * direction — a column added to the Prisma model and NOT to the lists above
 * would be stored and uploaded by nothing and editable nowhere, silently. The
 * generated `OtherLodge` type is scalar-only (relations such as `amenities` are
 * not on it), so the only columns excused are the identity and timestamp ones.
 * When the check fails, the annotation names the unlisted column.
 */
type UnlistedOtherLodgeColumn = Exclude<
  keyof OtherLodge,
  "id" | "name" | "createdAt" | "updatedAt" | OtherLodgeDataField
>;
const EVERY_OTHER_LODGE_COLUMN_IS_LISTED: [UnlistedOtherLodgeColumn] extends [never]
  ? true
  : { unlistedColumn: UnlistedOtherLodgeColumn } = true;
// Referenced so the compile-time check is not an unused binding; no runtime meaning.
void EVERY_OTHER_LODGE_COLUMN_IS_LISTED;

/**
 * The length bounds, read by the zod shapes AND by the panel's `maxLength`
 * attributes, so the editor cannot quietly hold a different limit from the API.
 * They match the central server's columns, which is what the pull schema is
 * held to as well (see `servernz-api.ts`).
 */
export const OTHER_LODGE_BOUNDS = {
  name: 120,
  location: 300,
  bookingOfficerName: 200,
  bookingOfficerEmail: 320,
  bookingOfficerPhone: 50,
  bedCapacityMax: 100_000,
  siteUrl: 500,
  bookingPath: 300,
  cancellationPeriod: 200,
  amenityName: 120,
  amenityDescription: 1000,
} as const;

export const AMENITIES_PER_LODGE_MAX = 50;

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

/**
 * PostgreSQL text cannot hold U+0000 and raises 22021 on the write — AFTER zod
 * accepted the value. In the download merge that throw lands mid-loop, leaves
 * the cursor unmoved, and stalls every later pull on the same row; on an admin
 * route it is a 500 for a 400. So every text schema here refuses it up front,
 * which on the pull drops that one row (counted) and on the routes is a 400.
 */
const NO_NUL_MESSAGE = "Text cannot contain the NUL character";
const hasNoNul = (value: string) => !value.includes("\u0000");

/** A trimmed string of at most `max` characters, with no NUL. */
function boundedText(max: number) {
  return z.string().trim().max(max).refine(hasNoNul, NO_NUL_MESSAGE);
}

/** The lodge name: required, unique in the registry, bounded like every text. */
export const otherLodgeNameSchema = boundedText(OTHER_LODGE_BOUNDS.name).min(1);

// An optional email that treats blank input as "not set": the admin form sends
// "" for a cleared field, and "" is not a valid email — fold it to null before
// the format check so clearing the field is not a validation error.
const optionalEmail = z.preprocess(
  blankToNull,
  boundedText(OTHER_LODGE_BOUNDS.bookingOfficerEmail).email().nullable().optional(),
);

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

const amenityInputSchema = z
  .object({
    name: boundedText(OTHER_LODGE_BOUNDS.amenityName).min(1),
    description: z.preprocess(
      blankToNull,
      boundedText(OTHER_LODGE_BOUNDS.amenityDescription).nullable().optional(),
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
  location: boundedText(OTHER_LODGE_BOUNDS.location).nullable().optional(),
  bookingOfficerName: boundedText(OTHER_LODGE_BOUNDS.bookingOfficerName)
    .nullable()
    .optional(),
  bookingOfficerEmail: optionalEmail,
  bookingOfficerPhone: boundedText(OTHER_LODGE_BOUNDS.bookingOfficerPhone)
    .nullable()
    .optional(),
  // Informational bed count of the partner lodge; non-negative, capped well
  // above any real lodge so a fat-fingered value is caught but real ones pass.
  bedCapacity: z
    .number()
    .int()
    .min(0)
    .max(OTHER_LODGE_BOUNDS.bedCapacityMax)
    .nullable()
    .optional(),
  siteUrl: z.preprocess(
    blankToNull,
    boundedText(OTHER_LODGE_BOUNDS.siteUrl)
      .refine(isHttpUrl, "Site URL must start with http:// or https://")
      .nullable()
      .optional(),
  ),
  bookingPath: boundedText(OTHER_LODGE_BOUNDS.bookingPath).nullable().optional(),
  cancellationPeriod: boundedText(OTHER_LODGE_BOUNDS.cancellationPeriod)
    .nullable()
    .optional(),
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

// ── Ownership (#52) ────────────────────────────────────────────────────────
//
// Which lodges are THIS club's own is decided on the central server, mapped to
// the API key this site uses, and handed back on every pull as `ownLodgeNames`.
// The site stores that list on `ServerNzSettings.otherLodgesOwnedNames` and
// everything that asks "may this lodge be changed here?" asks `ownsOtherLodge`
// below — the admin PATCH route, the upload projection and the panel's buttons
// — so there is one answer (INV-SSOT-001). By NAME, exactly as stored: the
// server keys lodges by name and so does this registry (`name` is unique).

/** Upper bound on the owned list, so a hostile server cannot stream forever. */
export const OWNED_OTHER_LODGE_NAMES_MAX = 100;

/**
 * The owned list as it travels and as it is stored: bounded in count, each name
 * held to the lodge-name bound (a longer or NUL-bearing name could never match
 * a local row anyway). Used by the pull envelope AND by the settings loader, so
 * a stored value that no longer parses reads back as unknown rather than as a
 * list of something else.
 */
export const ownedOtherLodgeNamesSchema = z
  .array(otherLodgeNameSchema)
  .max(OWNED_OTHER_LODGE_NAMES_MAX);

/**
 * The owned list in its three states: `null` when the server has never said
 * (not connected, never downloaded, or an older server that does not send it),
 * `[]` when it said the club owns nothing, otherwise the editable names.
 */
export type OwnedOtherLodgeNames = string[] | null;

/** True when the central server has said this lodge is the club's own. */
export function ownsOtherLodge(
  owned: ReadonlyArray<string> | null,
  name: string,
): boolean {
  return owned !== null && owned.includes(name);
}

/**
 * The label of the button that opens the editor for an owned lodge: "Edit my
 * Lodge" when the club owns exactly one, otherwise the lodge is named so the
 * buttons can be told apart.
 */
export function ownedOtherLodgeEditLabel(
  owned: ReadonlyArray<string>,
  name: string,
): string {
  return owned.length === 1 ? "Edit my Lodge" : `Edit ${name}`;
}

/**
 * The `code` on the PATCH route's 403 when the refusal is about ownership
 * rather than the administrator's permissions, so the panel can show the
 * route's own explanation instead of the generic view-only message.
 */
export const OTHER_LODGE_NOT_OWNED_CODE = "OTHER_LODGE_NOT_OWNED";

/**
 * A lodge as the ADMIN list carries it: every serialized field, but the
 * booking officer's PHONE only for a lodge this club owns — another club's
 * officer's number is not sent to the browser at all (#52). `owned` is the
 * route's answer from `ownsOtherLodge`, so the panel never re-derives it.
 */
export type AdminOtherLodge = Omit<SerializedOtherLodge, "bookingOfficerPhone"> & {
  bookingOfficerPhone?: string | null;
  owned: boolean;
};

/**
 * The admin list response: the rows, the owned list in its three states, and
 * whether syncing with the central server is paused for version (#49) - the
 * panel shows a note linking to setup while it is. Read from the stored
 * answer; this route never contacts the server.
 */
export interface AdminOtherLodgesResponse {
  otherLodges: AdminOtherLodge[];
  ownedLodgeNames: OwnedOtherLodgeNames;
  serverVersionStatus: "no-key" | "unchecked" | "match" | "mismatch";
}

export function serializeOtherLodgeForAdmin(
  lodge: OtherLodgeRecord,
  owned: ReadonlyArray<string> | null,
): AdminOtherLodge {
  const { bookingOfficerPhone, ...rest } = serializeOtherLodge(lodge);
  return ownsOtherLodge(owned, lodge.name)
    ? { ...rest, bookingOfficerPhone, owned: true }
    : { ...rest, owned: false };
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
 * upserted on the (otherLodgeId, name) unique key.
 *
 * ORDER MATTERS, AND THE CALLER OWNS IT: write the LODGE ROW FIRST, then call
 * this. The admin Upload/Download buttons and the nightly cron share no advisory
 * lock, so two writers can replace one lodge's amenities at once; at READ
 * COMMITTED their deleteMany/upserts interleave and the loser can leave a stale
 * row behind. The lodge-row update takes that row's lock for the rest of the
 * transaction, so a second writer blocks on it until the first commits and then
 * sees the finished set — the row write is the lock. The caller also owes the
 * row's `updatedAt` move: an amenity-only change touches no column on the lodge
 * row, and the upload watermark is keyed on that column.
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
