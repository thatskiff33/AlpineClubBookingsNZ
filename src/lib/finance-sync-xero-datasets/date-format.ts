/**
 * The temporal boundary of the finance-sync datasets (CT-5, #2869; epic #2988).
 *
 * These datasets are the machine-facing half of the finance surface: JSON
 * snapshots and monthly facts that other tools read long after the sync ran. So
 * two rules govern everything here.
 *
 * **Provider values are classified once, at the Xero boundary.** Every reader
 * below delegates to `@/lib/xero-provider-dates`, which carries the measured
 * evidence for the four wire shapes `xero-node` can hand back for a field it
 * TYPES as a string. Nothing in this directory calls `new Date(...)` on a Xero
 * payload field.
 *
 * **A serialised value says which kind it is.** A date-only column is exactly
 * `YYYY-MM-DD`; an instant column is a full ISO instant. Before #2869 the
 * date-only text helper passed a provider string through VERBATIM, so the same
 * column was `"2019-03-11"` on one deployment and `"2019-03-11T00:00:00"` on
 * another, purely by which Xero response shape arrived — and a consumer had no
 * way to tell a calendar day from a timestamp.
 *
 * **"When did this sync run, and what month is that?" is club civil time.** The
 * report window and the month key are the club's calendar day and month, read
 * from the PERSISTED club timezone (`INV-CONFIG-002`) rather than from
 * `process.env.TZ`. A container moved to another region must not re-date a
 * finance snapshot.
 */

import {
  clubCalendarDateOf,
  dateOnlyInstantOf,
  parseCalendarDate,
  requireCalendarDate,
  type ClubTimeZone,
} from "@/lib/club-time";
import {
  xeroCalendarDateAsDateOnly,
  xeroCalendarDateText,
  xeroInstant,
} from "@/lib/xero-provider-dates";

export function parseRequiredDateOnly(value: string, fieldName: string): Date {
  const parsed = parseCalendarDate(value);

  if (parsed === null) {
    throw new Error(`${fieldName} must be a valid date-only string`);
  }

  return dateOnlyInstantOf(parsed);
}

/**
 * A Xero date-only field as the UTC-midnight date-only `Date` the aging-bucket
 * and days-overdue arithmetic works in, or `null`.
 *
 * #2105 added the `Date` branch this used to carry by hand, because the SDK
 * coerces a Microsoft-JSON payload into a `Date` even for a field it types as a
 * string, and without it a real due date silently parsed to `null` and dropped
 * out of the aging buckets. #2869 found the same hole one shape further on: an
 * offset-less `"2019-03-11T00:00:00"` is not `YYYY-MM-DD`, so it also parsed to
 * `null`. Both are now the Xero boundary's business rather than this module's.
 */
export function parseOptionalDateOnly(
  value: string | Date | null | undefined,
): Date | null {
  return xeroCalendarDateAsDateOnly(value);
}

/**
 * The club's calendar day, month key and period start for a sync that began at
 * `startedAt`.
 *
 * `startedAt` is an INSTANT, so it has no calendar day until a zone is chosen,
 * and the zone is the club's — required, with no default, because the previous
 * `APP_TIME_ZONE` default was `process.env.TZ` and therefore the HOST's zone
 * (`INV-DATE-019`, `INV-CONFIG-002`).
 */
export function getFinanceReportWindow(startedAt: Date, zone: ClubTimeZone) {
  const asOfDate = clubCalendarDateOf(startedAt, zone);
  const periodStart = requireCalendarDate(`${asOfDate.slice(0, 7)}-01`);

  return {
    asOfDate: dateOnlyInstantOf(asOfDate),
    asOfDateString: asOfDate as string,
    periodStart: dateOnlyInstantOf(periodStart),
    periodStartString: periodStart as string,
  };
}

/** Month key ("YYYY-MM") for an instant, in the club's calendar. */
export function getFinanceMonthKeyForDate(
  date: Date,
  zone: ClubTimeZone,
): string {
  return clubCalendarDateOf(date, zone).slice(0, 7);
}

export function monthStartString(monthKey: string): string {
  return `${monthKey}-01`;
}

export function monthEndString(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * A Xero INSTANT field (`updatedDateUTC` and its siblings) as an exact moment.
 *
 * The name is historic; the semantics are now explicit. It used to be
 * `new Date(value)` for a string, which resolved an offset-less UTC timestamp in
 * the container's zone — up to thirteen hours out — and it is the reason a
 * dataset's `sourceUpdatedAt` could disagree with Xero's own by a working day.
 */
export function toOptionalDate(value: Date | string | null | undefined): Date | null {
  return xeroInstant(value);
}

export function toOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const text = String(value).trim();
  return text ? text : null;
}

/**
 * A Xero date-only field as the canonical `YYYY-MM-DD` text a dataset column
 * carries, or `null`.
 *
 * ALWAYS TEN CHARACTERS, whatever Xero sent. The old implementation returned a
 * provider string verbatim, so one deployment's `invoiceDate` column read
 * `"2019-03-11"` and another's `"2019-03-11T00:00:00"` for the same invoice, and
 * a consumer could not tell a calendar day from a timestamp without knowing
 * which Xero API shape had answered. A value this cannot read as a real calendar
 * day is `null` rather than passed through as prose (#2869).
 */
export function toOptionalDateOnlyText(value: unknown): string | null {
  return xeroCalendarDateText(value);
}

/**
 * A Xero REPORT's `reportDate`, which is a label as often as it is a date.
 *
 * Xero renders this field for humans — `"30 September 2020"` on a balance sheet
 * — and the only consumer in this codebase (`readPnlPeriodLabel`) uses it as the
 * last-resort period caption. So it cannot simply go through
 * {@link toOptionalDateOnlyText}: that would answer `null` for the ordinary case
 * and delete the caption.
 *
 * But it was passed through VERBATIM, which broke this module's other rule — a
 * serialised value says which kind it is — for the case where Xero DOES send a
 * temporal shape: `"2019-03-11T00:00:00"` was stored as a timestamp-looking
 * string in a field a reader has to guess about (#2869 review). So: a value this
 * boundary can read as a calendar day is stored as the canonical ten characters,
 * and anything else is kept as the human label it is.
 */
export function toOptionalReportDateText(value: unknown): string | null {
  return xeroCalendarDateText(value) ?? toOptionalText(value);
}
