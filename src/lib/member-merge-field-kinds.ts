import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";

/**
 * What a member-merge comparison value MEANS, declared per field (#2860).
 *
 * The merge screen renders every field of two member records side by side so a
 * Full Admin can decide which record survives an IRREVERSIBLE merge. It used to
 * format each value by looking at its runtime type:
 *
 * ```ts
 * if (value instanceof Date) return value.toISOString().slice(0, 10);
 * if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
 * ```
 *
 * Both arms are a UTC truncation, and a runtime type cannot tell the two kinds
 * of date apart — which is the whole defect, not an implementation detail of it:
 *
 * - `photoUpdatedAt` and `hutLeaderEligibleAt` are real INSTANTS (`new Date()`
 *   at the moment of the event). New Zealand runs 12-13 hours ahead of UTC, so
 *   truncating one to its UTC day dated it to the PREVIOUS day for roughly the
 *   first half of every club day — on the screen whose whole purpose is to let a
 *   human judge which record is more recent, where `photoUpdatedAt` is a recency
 *   signal by construction (`INV-DATE-019`).
 * - `dateOfBirth`, `joinedDate` and `lifeMemberDate` are CALENDAR DAYS — their
 *   writers mean to pin them to UTC midnight as an encoding and not a moment
 *   (`INV-DATE-010`), and for a value stored that way the same truncation is
 *   exactly right (`INV-DATE-019`'s first exact boundary, with `INV-DATE-026`;
 *   those are the citation for a decode, not 010 — #3080). Reading one through
 *   the club-zone formatter would happen to agree in New Zealand — UTC midnight
 *   is midday NZ, still the same day — and be wrong by a day for any club
 *   sitting behind UTC.
 *
 *   ONE WRITER DOES NOT HONOUR THAT INTENT, so do not read the line above as a
 *   promise about the stored data. `parseXeroCompanyNumberDate`
 *   (`xero-contacts.ts`) builds SERVER-LOCAL midnight, so some Xero-imported
 *   dates of birth are STORED a day early and this screen faithfully shows the
 *   day-early value. That is a storage defect on a calendar-day field
 *   (**#2859**, open), not a second meaning, and it is fixed by fixing the
 *   write — see the `dateOfBirth` entry below.
 *
 * So the kind is declared here, once, next to the evidence for it, and the
 * renderer is told which one it holds. The classification below is proved from
 * `prisma/schema.prisma` plus every write path, never from the field name.
 *
 * SINCE #2872 THE SCHEMA AGREES, AND THAT IS WORTH NOTING. All three calendar
 * days below are now `DateTime? @db.Date`: the database holds them as a `date`
 * with no time in it, so the column type settles what the writers used to have
 * to prove on their own. The writer evidence stays on each row anyway, because
 * it is what the migration was decided on and because a column type cannot tell
 * you that `parseXeroCompanyNumberDate` once stored some rows a day early. The
 * two instants below stay bare `DateTime`, which is the whole distinction this
 * module exists to render.
 *
 * THIS IS NOT A SECOND OPINION ON THOSE COLUMNS. #2684's guard keeps the
 * reviewed record of which bare-`DateTime` columns hold a calendar day
 * (`DATE_ONLY_IN_DATETIME_COLUMN`, in
 * `src/lib/__tests__/support/date-only-reviewed-fields.ts`), and all three of
 * the calendar days below were on it from #2860 until #2872 narrowed the
 * columns and emptied it. The guard cannot reach this screen — its scanner
 * classifies a site by the field name written in the argument, and here the
 * values arrive as `unknown` with the field as a runtime string — so the
 * judgement has to be restated where the renderer can act on it.
 * `member-merge-field-kinds.test.ts` binds this list to BOTH that reviewed
 * record and the schema's own `@db.Date` columns: a `calendarDay` here that
 * neither settles, or an `instant` here that either one does, fails. None of the
 * three can move without the others.
 */
export type MergeFieldValueKind = "calendarDay" | "instant" | "plain";

/**
 * Every field `mergeMemberFields` emits, with its kind and the evidence.
 *
 * `src/lib/__tests__/member-merge-field-kinds.test.ts` pins this map to that
 * function's actual output in both directions: a merged field with no declared
 * kind fails, and a declared kind for a field no longer merged fails too.
 */
export const MERGE_FIELD_VALUE_KINDS: Readonly<
  Record<string, MergeFieldValueKind>
> = {
  // --- FILL_IF_BLANK_FIELDS ------------------------------------------------
  title: "plain", // `Title?` enum (schema.prisma:510)
  gender: "plain", // `Gender?` enum (schema.prisma:513)
  // `DateTime? @db.Date` (schema.prisma:514) since #2872, and a calendar day in
  // every writer before that: the
  // admin services validate `^\d{4}-\d{2}-\d{2}$` and hand it to `new Date`,
  // which is UTC midnight (admin-member-detail-service.ts:1197,
  // admin-members-service.ts:1432); the member-facing routes call
  // `parseDateOnly` (api/profile/route.ts:241, api/members/family/*); the CSV
  // importer normalises to `yyyy-MM-dd` and calls `parseDateOnly`
  // (api/admin/members/import/route.ts:209). #2859 says it plainly: "a date of
  // birth is a calendar day, never an instant".
  //
  // The one writer that disagrees is `parseXeroCompanyNumberDate`
  // (xero-contacts.ts:364), which builds SERVER-LOCAL midnight and so stores a
  // Xero-imported DOB a day early. That is a STORAGE defect on a calendar-day
  // field (#2859, still open), not a second meaning: this screen keeps showing
  // what is stored, and #2859 fixes what is stored.
  dateOfBirth: "calendarDay",
  occupation: "plain", // `String?` (schema.prisma:517)
  // `DateTime? @db.Date` (schema.prisma:573) since #2872. Same calendar-day
  // writers as `joinedDate`:
  // `^\d{4}-\d{2}-\d{2}$` -> `new Date` (admin-members-service.ts:1465,
  // admin-member-detail-service.ts:1173) and `parseDateOnly` on import. It is
  // never stamped from a clock, and no other writer exists in src/, scripts/ or
  // prisma/. (#2860's issue body called this one an instant; the writers say
  // otherwise, so it is classified as what its writers store.)
  lifeMemberDate: "calendarDay",
  comments: "plain", // `String? @db.Text` (schema.prisma:580)
  familyGroupId: "plain", // `String?` FK (schema.prisma:630)

  // --- GROUP_FILL_SPECS: phone ---------------------------------------------
  phoneCountryCode: "plain", // `String?` (schema.prisma:530)
  phoneAreaCode: "plain", // `String?` (schema.prisma:531)
  phoneNumber: "plain", // `String?` (schema.prisma:532)

  // --- GROUP_FILL_SPECS: photo ---------------------------------------------
  photoImageId: "plain", // `String?` FK (schema.prisma:525)
  // `DateTime?` (schema.prisma:526), stamped `now` when a photo is stored or
  // replaced (api/members/[id]/photo/route.ts:410,517). A true instant.
  photoUpdatedAt: "instant",
  photoUpdatedByMemberId: "plain", // `String?` audit snapshot (schema.prisma:527)

  // --- GROUP_FILL_SPECS: street address ------------------------------------
  streetAddressLine1: "plain", // `String?` (schema.prisma:540)
  streetAddressLine2: "plain", // `String?` (schema.prisma:541)
  streetCity: "plain", // `String?` (schema.prisma:542)
  streetRegion: "plain", // `String?` (schema.prisma:543)
  streetPostalCode: "plain", // `String?` (schema.prisma:544)
  streetCountry: "plain", // `String?` (schema.prisma:545)

  // --- GROUP_FILL_SPECS: postal address ------------------------------------
  postalAddressLine1: "plain", // `String?` (schema.prisma:548)
  postalAddressLine2: "plain", // `String?` (schema.prisma:549)
  postalCity: "plain", // `String?` (schema.prisma:550)
  postalRegion: "plain", // `String?` (schema.prisma:551)
  postalPostalCode: "plain", // `String?` (schema.prisma:552)
  postalCountry: "plain", // `String?` (schema.prisma:553)

  // --- OR booleans ----------------------------------------------------------
  requiresInduction: "plain", // `Boolean` (schema.prisma:574)
  hutLeaderEligible: "plain", // `Boolean` (schema.prisma:575)

  // --- Derived rows ---------------------------------------------------------
  // `DateTime?` (schema.prisma:576). One writer: the hut-leader induction's
  // completion side effect (induction.ts:147), whose `completedAt` is
  // `new Date()` (induction.ts:222,284). A true instant.
  hutLeaderEligibleAt: "instant",
  // `DateTime? @db.Date` (schema.prisma:570) since #2872. Admin-editable through
  // a date input,
  // validated `^\d{4}-\d{2}-\d{2}$` and parsed to UTC midnight
  // (admin-member-detail-service.ts:1161, admin-members-service.ts:1458);
  // `parseDateOnly` on CSV import; and on the Xero backfill it is the first
  // invoice's date (xero-bulk-contact-sync.ts:440). A membership START DATE,
  // not a moment.
  //
  // On that last path, be precise about WHAT makes it safe, because "it is a
  // Xero date-only field" is a claim about Xero and the risk is in the PARSE.
  // `getContactFirstInvoiceDate` does `new Date(invoices[0].date)`
  // (xero-contacts.ts). The hazard being ruled out is the one
  // `parseXeroCompanyNumberDate` already realised on `dateOfBirth`: an
  // offset-less `yyyy-MM-dd HH:mm:ss` string parses as SERVER-LOCAL midnight,
  // which east of UTC is the previous UTC day. Neither shape this value can
  // take is that one, and the SDK's own types settle it:
  //
  //   * `Invoice.date` is typed `string` and documented "Date invoice was issued
  //     - YYYY-MM-DD" (node_modules/xero-node/.../accounting/invoice.d.ts). A
  //     bare `yyyy-MM-dd` takes ECMAScript's DATE-ONLY branch, which is UTC:
  //     `new Date("2019-03-04")` is `2019-03-04T00:00:00.000Z`.
  //   * If a tenant returns the Microsoft `/Date(1551657600000+0000)/` wire form
  //     instead, that string never reaches `new Date` at all — xero-node's
  //     `ObjectSerializer.deserialize` intercepts any `string`-typed field
  //     beginning `/Date(` and converts it to a `Date` at that exact epoch
  //     (accounting/models.js, `deserializeDateFormats`), which for a Xero date
  //     field is UTC midnight. `new Date(aDate)` then clones it.
  //
  // Measured, because the obvious reading is wrong: `new Date("/Date(1551657600000+0000)/")`
  // is an Invalid Date, so an earlier version of this note — which said the SDK
  // hands back that wire form and `new Date` honours its offset — described a
  // path that would have produced `NaN`, not a correct day. The conclusion
  // survives; the reason did not. This no longer defers to #2869: the SDK's
  // types and serialiser answer it here.
  joinedDate: "calendarDay",
};

/**
 * The declared kind for a merged field. Unknown fields fall back to `"plain"`,
 * which renders the raw value: visibly odd for a date, and impossible to be
 * quietly a day wrong. The exhaustiveness test is what stops a new merged field
 * reaching that fallback in the first place.
 */
export function mergeFieldValueKind(field: string): MergeFieldValueKind {
  return MERGE_FIELD_VALUE_KINDS[field] ?? "plain";
}

/** Shown for a value that is absent or empty. */
const EMPTY_DISPLAY = "—";

function toInstant(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Render one merge-comparison value, given what it means.
 *
 * Dates come back as `yyyy-MM-dd` either way — the fix changes WHICH day an
 * instant lands on, not the shape of the column:
 *
 * - `instant` reads the club's calendar day (`formatDateOnlyForTimeZone`,
 *   `INV-DATE-019`), which is correct in every zone.
 * - `calendarDay` reads the UTC-midnight encoding by truncation
 *   (`formatDateOnly`, `INV-DATE-019`'s first exact boundary with
 *   `INV-DATE-026`), which is also correct in every zone —
 *   and deliberately NOT routed through the club-zone formatter, which would
 *   agree in New Zealand and be a day wrong for a club behind UTC.
 *
 * Values arrive over JSON as ISO strings, and in server-side/unit contexts as
 * `Date`s; both are accepted, and both take the same branch, so the two cannot
 * drift apart.
 *
 * `timeZone` IS PASSED IN PRODUCTION, and the default is a fallback rather than
 * the convention. The merge comparison screen
 * (`src/app/(admin)/admin/members/[id]/merge/page.tsx`) hands all three of its
 * columns the club's persisted zone. The `= APP_TIME_ZONE` default behind them is
 * the ENVIRONMENT's zone, which is not the club's, and it survives only because
 * this is a client component and the zone has to arrive as data — which is
 * exactly the reason this module sits on `ENVIRONMENT_ZONE_ADAPTERS` in
 * `eslint.config.mjs` with an entry saying so.
 *
 * THIS PARAGRAPH USED TO CLAIM the parameter "follows the same convention as
 * every helper in `date-only.ts`: it defaults to the club's zone and production
 * never passes it". Every part of that was wrong, and worth recording rather
 * than quietly overwriting: those helpers have no zone defaults left at all
 * (#3123 deleted the last six), `APP_TIME_ZONE` is the environment's answer and
 * not the club's, and production passes this argument at every call site. A
 * convention cited from ANOTHER module is the shape nothing checks — the other
 * module changes, and the citation reads exactly as it always did.
 *
 * The parameter exists so the two branches are DECIDABLE. New Zealand sits ahead
 * of UTC, where truncation and the club-zone formatter agree on a calendar day,
 * so a test run only in the club's own zone cannot fail the mutation that routes
 * calendar days through the club-zone formatter. Passing a zone behind UTC is
 * what separates them — and it is passed rather than set via `TZ`, which would
 * move `APP_TIME_ZONE` itself (docs/TESTING.md rule 6).
 *
 * EVERY BRANCH IS NAMED, INCLUDING THE IMPOSSIBLE ONE. `kind` is a closed union
 * to TypeScript and an arbitrary string at runtime: this is a client component,
 * and during a rolling deploy a NEW server can stamp a kind an OLD bundle has
 * never heard of. A trailing `else` would have truncated that value silently,
 * which is the one outcome this module exists to prevent — a date quietly a day
 * wrong. An unrecognised kind therefore renders the RAW value: visibly odd, and
 * never a day wrong. It is the same choice `mergeFieldValueKind` makes for an
 * unknown field, for the same reason.
 */
export function formatMergeFieldValue(
  value: unknown,
  kind: MergeFieldValueKind,
  timeZone: string = APP_TIME_ZONE,
): string {
  if (value === null || value === undefined || value === "") {
    return EMPTY_DISPLAY;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (kind === "plain") return String(value);

  const instant = toInstant(value);
  if (!instant) return String(value);

  if (kind === "instant") return formatDateOnlyForTimeZone(instant, timeZone);
  // `formatDateOnly` takes no zone on purpose: a calendar day is already pinned
  // to UTC midnight, so truncation names the same day from anywhere.
  if (kind === "calendarDay") return formatDateOnly(instant);

  // Unreachable for TypeScript; reachable across a rolling deploy. See above.
  return String(value);
}
