/**
 * THE XERO TEMPORAL BOUNDARY (CT-5, #2869; epic #2988).
 *
 * Every date or time that crosses between this application and Xero is
 * classified HERE, once, as one of the epic's three concepts — a calendar date,
 * an instant, or a club-local scheduled time — and converted through the CT-2
 * kernel (`@/lib/club-time`). Nothing else on the Xero surface may call
 * `new Date(...)` on a provider payload field;
 * `__tests__/xero-provider-date-boundary-census.test.ts` reads the tree off disk
 * and fails if one does.
 *
 * ## Why a provider needs its own adapter at all
 *
 * The kernel already REFUSES an offset-less ISO string, because
 * `"2019-03-11T00:00:00"` names a wall-clock reading and JavaScript resolves it
 * in whichever zone the host happens to be in. That refusal is right for a
 * general parser and useless at a boundary that must still produce an answer, so
 * this module supplies the missing half: what each Xero FIELD means, so an
 * offset-less string can be read correctly instead of guessed at.
 *
 * ## The wire shapes, and the evidence for them
 *
 * Measured against the vendored `xero-node` in this tree, not assumed:
 *
 * 1. **A `Date` the SDK already built, arriving through a field the SDK TYPES as
 *    `string`.** `ObjectSerializer.deserialize`
 *    (`node_modules/xero-node/dist/gen/model/accounting/models.js`) has a
 *    primitive branch that checks `data.toString().substring(0, 6) === "/Date("`
 *    and, when it matches, returns `deserializeDateFormats(...)` — a `Date`. So
 *    `Invoice.date`, declared `'date'?: string`, is a `Date` object at runtime
 *    whenever the classic Accounting JSON API answers with Microsoft-JSON.
 *    TypeScript cannot see this, which is why every reader here takes `unknown`.
 * 2. **A raw `/Date(1518652800000+0000)/` string**, for a payload the SDK did not
 *    deserialise — a replayed webhook body, a cached response, a fixture. The
 *    epoch is UTC milliseconds; the trailing offset is display metadata, and the
 *    SDK itself ignores it (`/-?\d+/` takes the first run of digits).
 * 3. **`YYYY-MM-DD`**, which is what the Xero documentation states for every
 *    date-only field ("Date invoice was issued – YYYY-MM-DD").
 * 4. **`YYYY-MM-DDTHH:mm:ss` with NO offset**, which the XML-shaped responses
 *    carry. THIS IS THE ANCHOR DEFECT of #2869: `new Date(...)` reads it in the
 *    server's zone, so the same payload means a different day on a developer's
 *    laptop, on a UTC container and on the club's server, and
 *    `Member.joinedDate` moved by a day. For a DATE-ONLY field the date half is
 *    the whole answer and the time half is padding, so this module takes the
 *    date half and never constructs an instant from it.
 *
 * ## Date-only fields versus instant fields
 *
 * Xero's own typings separate them and so does this module:
 *
 * | Xero field                                                        | Concept       |
 * | ----------------------------------------------------------------- | ------------- |
 * | `Invoice.date` / `.dueDate` / `.expectedPaymentDate`                | calendar date |
 * | `Invoice.plannedPaymentDate` / `.fullyPaidOnDate`                   | calendar date |
 * | `CreditNote.date` / `.dueDate` / `.fullyPaidOnDate`                 | calendar date |
 * | `Payment.date`                                                      | calendar date |
 * | `Organisation.periodLockDate` / `.endOfYearLockDate`                | calendar date |
 * | `Contact.companyNumber` (this club's date of birth carrier)         | calendar date |
 * | `updatedDateUTC` (every model) and `updatedDateUTCString`           | instant       |
 *
 * `fullyPaidOnDate` is typed `string` and documented "the date the invoice was
 * fully paid", alongside `updatedDateUTC: Date` on the same model. It is a
 * calendar day, and the one thing this module refuses to do with it is what the
 * old code did: treat it as a moment and store it as one.
 *
 * `Contact.companyNumber` is decoded by `xero-contact-date-of-birth.ts` rather
 * than here, because its `dd/MM/yyyy` shape is this club's convention for a
 * field Xero means as an NZBN, not a Xero date format at all (#2859).
 *
 * ## The one asymmetry, stated so nobody has to rediscover it
 *
 * A date-only field arriving as a `Date` (shapes 1 and 2) is decoded by reading
 * its **UTC** day, because the Microsoft-JSON encoding of a date-only value IS
 * UTC midnight — the same encoding `INV-DATE-010` states for a `@db.Date`
 * column, decoded under `INV-DATE-019`'s first exact boundary with
 * `INV-DATE-026` (cite those for the decode, not `INV-DATE-010`; #3080), by the
 * same `calendarDateOfDateOnlyInstant` a stored column goes through. A date-only field
 * arriving as TEXT (shapes 3 and 4) is decoded by taking its literal date half,
 * with no zone applied at all, because a calendar day is never
 * timezone-converted. The two rules agree on every value Xero actually sends and
 * differ only on one it does not: a date-only field bearing a UTC offset large
 * enough to move the day.
 */

import {
  calendarDateOfDateOnlyInstant,
  clubCalendarDateOf,
  clubToday,
  dateOnlyInstantOf,
  isCalendarDate,
  parseCalendarDate,
  parseInstant,
  type CalendarDate,
  type ClubTimeZone,
  type Instant,
} from "@/lib/club-time";

/**
 * What a raw Xero temporal value turned out to be.
 *
 * Exported because the classification is as much the deliverable of #2869 as the
 * conversion is: a diagnostic, a log line and a test can each name the shape they
 * saw rather than only the value they could not read.
 */
export type XeroWireTemporalShape =
  /** `null`, `undefined`, or an empty/whitespace string. */
  | "absent"
  /** A `Date` the SDK's `ObjectSerializer` already built. */
  | "sdk-date"
  /** A raw Microsoft-JSON `/Date(1518652800000+0000)/` string, or epoch ms. */
  | "microsoft-json"
  /** `YYYY-MM-DD`. */
  | "calendar-date"
  /** `YYYY-MM-DDTHH:mm:ss` with no `Z` and no offset — a wall-clock reading. */
  | "offset-less-date-time"
  /** An ISO 8601 value carrying `Z` or a UTC offset. */
  | "offset-bearing-instant"
  /** Present, and none of the above. */
  | "unreadable";

/** `/Date(<epoch ms><±hhmm>)/`, the classic Accounting API's JSON date. */
const MICROSOFT_JSON_DATE = /^\/Date\((-?\d+)/;

/** An ISO value that pins a moment: it carries `Z` or an offset. */
const OFFSET_BEARING_ISO =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/** An ISO value that names a wall clock and no zone at all. */
const OFFSET_LESS_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Which of the wire shapes `value` is. Pure and total; every reader below routes
 * through it so the shape vocabulary cannot drift between them.
 */
export function classifyXeroWireTemporal(value: unknown): XeroWireTemporalShape {
  if (value === null || value === undefined) return "absent";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "unreadable" : "sdk-date";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? "microsoft-json" : "unreadable";
  }
  if (typeof value !== "string") return "unreadable";

  const trimmed = value.trim();
  if (trimmed === "") return "absent";
  if (MICROSOFT_JSON_DATE.test(trimmed)) return "microsoft-json";
  if (isCalendarDate(trimmed)) return "calendar-date";
  if (OFFSET_BEARING_ISO.test(trimmed)) return "offset-bearing-instant";
  if (OFFSET_LESS_DATE_TIME.test(trimmed)) return "offset-less-date-time";
  return "unreadable";
}

/** The epoch milliseconds a Microsoft-JSON date (or a bare number) carries. */
function microsoftJsonEpochMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = MICROSOFT_JSON_DATE.exec(value.trim());
  if (!match) return null;
  const epochMs = Number(match[1]);
  return Number.isFinite(epochMs) ? epochMs : null;
}

/**
 * The UTC day a date-only ENCODING carries, as a `CalendarDate`, or `null`.
 *
 * `calendarDateOfDateOnlyInstant` throws for a value whose UTC year falls
 * outside the four-digit `CalendarDate` range — which is what a provider typo,
 * a sentinel or a corrupted epoch looks like from here. A boundary reader must
 * answer rather than throw, so the range failure becomes "unreadable".
 */
function utcDayOfEncoding(value: Date): CalendarDate | null {
  try {
    return calendarDateOfDateOnlyInstant(value);
  } catch {
    return null;
  }
}

/**
 * A Xero **date-only** field as a club calendar day, or `null`.
 *
 * `null` covers an absent value AND one this module cannot read — including a
 * day that does not exist, because `parseCalendarDate` refuses to roll
 * `2026-02-30` forward into March the way `new Date` does. A caller that has to
 * tell "Xero sent nothing" from "Xero sent something unreadable" asks
 * {@link classifyXeroWireTemporal}; giving every reader a second return channel
 * almost none of them uses would cost more than it explains.
 */
export function xeroCalendarDate(value: unknown): CalendarDate | null {
  switch (classifyXeroWireTemporal(value)) {
    case "absent":
    case "unreadable":
      return null;
    case "sdk-date":
      // The Microsoft-JSON encoding of a DATE-ONLY field is UTC midnight, so its
      // UTC day is the day Xero meant. Reading it in the club's zone would be the
      // INV-DATE-010 error from the other direction.
      return utcDayOfEncoding(value as Date);
    case "microsoft-json": {
      const epochMs = microsoftJsonEpochMs(value);
      if (epochMs === null) return null;
      const asDate = new Date(epochMs);
      return Number.isNaN(asDate.getTime()) ? null : utcDayOfEncoding(asDate);
    }
    case "calendar-date":
      return parseCalendarDate((value as string).trim());
    case "offset-less-date-time":
    case "offset-bearing-instant":
      // The literal date half, with NO zone applied. A calendar day is never
      // timezone-converted, and this is the shape whose `new Date(...)` reading
      // moved `Member.joinedDate` by a day (#2869).
      return parseCalendarDate((value as string).trim().slice(0, 10));
  }
}

/**
 * A Xero date-only field as the canonical `YYYY-MM-DD` wire text, or `null`.
 *
 * This is the identity a date-only value crosses a JSON, CSV or dataset boundary
 * as, so a consumer never has to guess whether an ISO-looking column is a
 * calendar day or an instant: a column built through this is always exactly ten
 * characters, whatever shape Xero happened to send for it.
 */
export function xeroCalendarDateText(value: unknown): string | null {
  return xeroCalendarDate(value);
}

/**
 * A Xero date-only field as the UTC-midnight `Date` that a `@db.Date` column —
 * and every date-only comparison in this codebase — round-trips through.
 *
 * The result is an ENCODING of a calendar day and not a moment, which is what
 * `INV-DATE-010` rules and the only thing it is cited for here. Reading the day
 * back out of it in UTC is `INV-DATE-019`'s first exact boundary plus
 * `INV-DATE-026` — cite those for a decode, not `INV-DATE-010`, which forbids
 * deriving a rule from one of these values read as a MOMENT and expressly says
 * not to be cited as a prohibition on decoding one in UTC. This docblock used to
 * carry that prohibition as its own line ("nothing may read the result in any
 * zone but UTC"), which is the inverse paraphrase #3080 swept up.
 */
export function xeroCalendarDateAsDateOnly(value: unknown): Instant | null {
  const date = xeroCalendarDate(value);
  return date === null ? null : dateOnlyInstantOf(date);
}

/**
 * A Xero **instant** field — `updatedDateUTC` and its siblings — as an exact
 * moment, or `null`.
 *
 * AN OFFSET-LESS STRING IS READ AS UTC HERE, and that is not the guess the
 * kernel's `parseInstant` refuses to make. These fields are named and documented
 * by the provider as UTC (`'updatedDateUTC'`, "UTC timestamp of last update to
 * the invoice"), so the zone comes from the FIELD's contract rather than from the
 * host — which is exactly the classification the epic asks each integration to
 * perform at its adapter boundary. A bare `YYYY-MM-DD` is read as UTC midnight,
 * for the same reason.
 */
export function xeroInstant(value: unknown): Instant | null {
  switch (classifyXeroWireTemporal(value)) {
    case "absent":
    case "unreadable":
      return null;
    case "sdk-date":
      return value as Date;
    case "microsoft-json": {
      const epochMs = microsoftJsonEpochMs(value);
      if (epochMs === null) return null;
      const asDate = new Date(epochMs);
      return Number.isNaN(asDate.getTime()) ? null : asDate;
    }
    case "offset-bearing-instant":
      return parseInstant((value as string).trim());
    case "calendar-date":
      return parseInstant(`${(value as string).trim()}T00:00:00.000Z`);
    case "offset-less-date-time":
      return parseInstant(`${(value as string).trim()}Z`);
  }
}

// ---------------------------------------------------------------------------
// Outbound: the document dates this application SENDS Xero
// ---------------------------------------------------------------------------

/**
 * A document date from a `@db.Date` column — a lodge night, a season edge.
 *
 * The column holds UTC midnight as an ENCODING and not a moment
 * (`INV-DATE-010`), so the day is read back in UTC and no zone is involved —
 * `INV-DATE-019`'s first exact boundary with `INV-DATE-026`, which are the
 * citation for a decode rather than `INV-DATE-010` (#3080).
 */
export function xeroDocumentDateFromDateOnlyColumn(value: Date): string {
  return calendarDateOfDateOnlyInstant(value);
}

/**
 * A document date from a real INSTANT — `Booking.createdAt`, a settlement's
 * `createdAt`, the moment a refund was taken.
 *
 * The club's zone is REQUIRED and there is no default, because truncating the
 * instant instead is `INV-DATE-019`: for a club at UTC+12/+13 the UTC day is
 * yesterday for roughly the first half of every club day, and a document's issue
 * date decides which GST period and financial year it falls in (#2697, #2834).
 */
export function xeroDocumentDateFromInstant(
  instant: Instant,
  zone: ClubTimeZone,
): string {
  return clubCalendarDateOf(instant, zone);
}

/**
 * A document date meaning "today", in the club's calendar and nobody else's.
 *
 * The zone is required for the same reason as above, and it must be the
 * PERSISTED club timezone (`INV-CONFIG-002`) rather than `process.env.TZ`: moving
 * a container to another region must not re-date the club's invoices.
 */
export function xeroDocumentDateForClubToday(zone: ClubTimeZone): string {
  return clubToday(zone);
}

/**
 * AN INVOICE'S ISSUE AND DUE DATES, WHICH ARE TWO DIFFERENT KINDS OF VALUE.
 *
 * Two dates, two different kinds of value, so two different derivations. They
 * are derived together, here, because they are only correct TOGETHER: side by
 * side the asymmetry reads as deliberate, where a reader who meets one of them
 * alone is most likely to "tidy" it into the shape of the other.
 *
 * The ISSUE date is a `@db.Date` column — for the group-settlement caller, the
 * organiser booking's check-in: a lodge night, an abstract calendar day already
 * pinned to UTC midnight (INV-DATE-010), so truncating it reads back the day it
 * encodes — INV-DATE-019's first exact boundary with INV-DATE-026, which is the
 * authority for that decode rather than INV-DATE-010 (#3080).
 *
 * The DUE date is derived from a `DateTime` — for that caller,
 * `GroupBookingSettlement.createdAt` — which is a real instant. Truncating an
 * instant to its UTC day is the pattern INV-DATE-019 forbids: New Zealand runs
 * 12-13 hours ahead of UTC, so for roughly the first half of every club day the
 * UTC day is still yesterday, and a settlement invoice raised at 09:00 NZ on 1
 * July carried a due date of 30 June (#2834). It therefore needs the club's
 * calendar, and gets it from the PERSISTED zone (CT-5, #2869; INV-DATE-019 and
 * INV-CONFIG-002) rather than from the container's.
 */
export function xeroDocumentDatesFromColumnAndInstant(
  issuedOnColumn: Date,
  dueFromInstant: Instant,
  zone: ClubTimeZone,
): { issueDate: string; dueDate: string } {
  return {
    issueDate: xeroDocumentDateFromDateOnlyColumn(issuedOnColumn),
    dueDate: xeroDocumentDateFromInstant(dueFromInstant, zone),
  };
}

// `seasonYearOfCalendarDate(date, seasonStartMonth)` USED TO LIVE HERE (#2869) and
// has converged into `seasonYearOfCalendarDate` in `@/lib/financial-year` (CT-4
// group F1, #2870). Two functions of the same name whose second argument was the
// season START month in one and the financial YEAR-END month in the other is a
// silent off-by-one-month waiting for the first caller to import the wrong one, and
// the season rule belongs beside the year-end configuration that decides it. This
// module still applies the club's financial-year configuration and never reads it.
