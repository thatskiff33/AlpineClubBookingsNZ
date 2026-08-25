/**
 * A membership application's dates of birth, and what to do with one that names
 * no real day (#3082).
 *
 * ## WHY THIS IS ITS OWN MODULE
 *
 * Four callers share it — the approval, the approval preview, the submit route
 * and the applications API's own validator — and two of them, `nomination.ts`
 * and `member-application-mapping.ts`, already import each other. Putting the
 * decode in either would have deepened that cycle, and both are far over the
 * file-size budget. Here it is one small file with one dependency, `club-time`.
 *
 * ## THE HOLE IT CLOSES
 *
 * `MemberApplication.familyMembers` is a `Json` column, so PostgreSQL validates
 * nothing inside it, and the UNAUTHENTICATED `POST /api/applications` validated
 * each date of birth with `/^\d{4}-\d{2}-\d{2}$/` and nothing else.
 * `1990-13-01`, `1990-06-32`, `1990-00-15` and `0000-05-05` were all stored
 * verbatim; `1990-02-31` was stored and then silently answered as 3 March by
 * `new Date`.
 *
 * The consequence changed shape with #3082, and both shapes are bad:
 *
 * - **Before**, `new Date("1990-13-01")` was an Invalid Date, `computeAge`
 *   answered `NaN`, no configured tier matched `NaN`, and
 *   `computeAgeTierWithSettings` fell through to its ADULT default. A wrong
 *   price band, silently, from a value nobody could read as a birthday.
 * - **After**, the same input reaches `requireStoredCalendarDay` and throws a
 *   `RangeError` — inside `approveMemberApplication`'s `prisma.$transaction`,
 *   where the admin route only special-cases `MembershipApplicationError`. So
 *   the committee got a bare 500 with no cause, on every retry, and no admin
 *   screen edits a dependent's date on a pending application. A NEW liveness
 *   failure, not a newly surfaced one.
 *
 * ## THE WRITE PATHS WERE TIGHTENED; THE READ SCHEMA WAS DELIBERATELY NOT
 *
 * `isoDateSchema` in `nomination.ts` is the READ schema —
 * `parseApplicationFamilyMembers` runs it over already-stored JSON on four
 * surfaces, including the admin application list and the nominating member's own
 * landing page. That page is an async server component with no `error.tsx` above
 * it, so a throw there replaces the whole page and the member can no longer
 * confirm OR decline, with no admin action that clears it.
 * `nominations/[token]/page.tsx` states the rule in its own docblock: reading a
 * value must not be able to take a page down whatever was written. Tightening
 * that schema would trade this liveness failure for a worse one.
 *
 * So the value is refused where it ARRIVES — the route's validator and
 * `createMemberApplication` — and, for a value already in the database, refused
 * with a message that names WHO it belongs to rather than answering wrongly.
 * `application-date-of-birth-refusal.test.ts` pins both halves and the
 * asymmetry between them.
 */

import { parseCalendarDate, type CalendarDate } from "@/lib/club-time";

/**
 * The calendar day an application's stored date of birth names, or `null`.
 *
 * `parseCalendarDate` is the kernel's own predicate, so "a real day" means
 * exactly what it means everywhere else here: a four-digit year from 0001, a
 * month of 1-12, and a day that exists in that month. It NEVER rolls, which is
 * the property that matters most for this input — `new Date("1990-02-31")`
 * answers 3 March, so a typo becomes a real, plausible, WRONG birthday with
 * nothing to notice.
 *
 * IT ANSWERS THE DAY RATHER THAN A `Date`, deliberately. The value stays text
 * until a caller encodes it with `dateOnlyInstantOf`, so nothing between here
 * and the database can shift it by a zone, and the tier and the stored date can
 * be derived from one decode instead of two readings of one string.
 */
export function applicationDateOfBirthDay(
  value: string | null | undefined,
): CalendarDate | null {
  return value == null ? null : parseCalendarDate(value);
}

/** A dependent named for a refusal: their position, and their name if it is set. */
export function dependentSubject(
  familyMember: { firstName: string; lastName: string },
  index: number,
): string {
  const name = `${familyMember.firstName} ${familyMember.lastName}`.trim();
  const ordinal = `Dependent ${index + 1}`;
  return name ? `${ordinal} (${name})` : ordinal;
}

/**
 * The refusal an unreadable date of birth earns: the person, the field, and
 * NEVER the value.
 *
 * A date of birth is personal information and an error string travels further
 * than the request that produced it — into a log, a screenshot, a support
 * thread. Every existing refusal in `nomination.ts` reports a subject rather
 * than a stored value, and this keeps that. The admin does not need the bad
 * value in order to act: there is no screen that edits a dependent's date on a
 * pending application, so rejecting it and asking for a fresh one is the repair,
 * and the message says so.
 */
export function unreadableDateOfBirthRefusal(subject: string): string {
  return (
    `${subject} has a date of birth that is not a real calendar day, so an age tier — ` +
    "and therefore a price band — cannot be worked out for them. This application cannot be " +
    "approved until it is resubmitted with a date that names a real day; reject it and ask the " +
    "applicant to apply again."
  );
}
