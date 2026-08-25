/**
 * A stored calendar day, decoded and re-encoded — the shared form of a line six
 * modules had each written out (CT-4, #2870; epic #2988).
 *
 * ## What it is for
 *
 * A `@db.Date` column holds a club calendar day, pinned to UTC midnight as an
 * internal encoding and nothing more (`INV-DATE-010`), in a column the schema
 * itself declares date-only rather than one its writers merely agree to keep at
 * midnight (`INV-DATE-026`). Prisma hands that back as a `Date`, and a caller comparing
 * two such values — a booking's `checkIn` against a guest's `stayStart`, an
 * edit's requested window against the stored one — needs both sides normalised
 * the same way, or the comparison is between a day and a moment.
 *
 * `storedDateOnly` is that normalisation: read the day the column holds, encode
 * it again. It is the identity for a value that already is a `@db.Date`
 * encoding, which is why it is safe to apply twice, and it is what makes a
 * caller holding a mixture of freshly-read rows and values it built itself able
 * to compare them at all.
 *
 * ## Why it is here rather than in the kernel
 *
 * Because its type signature is the thing the kernel exists to retire. `Date` in
 * and `Date` out keeps the working value a `Date`; the kernel's own answer is
 * that a stored day becomes a `CalendarDate` at the boundary and stays one
 * (`docs/CLUB_TIME_KERNEL.md`). Putting this in `src/lib/club-time/**` would
 * make the round trip look like the recommended shape, which it is not — it is a
 * bridge for call sites whose comparisons are still written in `Date`s, and CT-6
 * (#2991) is where those comparisons become calendar-date comparisons and this
 * module goes away.
 *
 * ## Why it is here rather than in `date-only.ts`
 *
 * That module is the legacy adapter CT-6 deletes, and it reads `APP_TIME_ZONE`.
 * Adding a new helper to it would put six more files onto the module CT-4's last
 * group is trying to leave, for no gain.
 *
 * ## The defect the six copies were fixing
 *
 * Each replaced `normalizeDateOnlyForTimeZone`, which projected the stored value
 * through the environment zone FIRST: the identity for a club ahead of
 * Greenwich, the PREVIOUS day for one behind it. Group B measured what happens
 * when only some of a comparison's sides move — a frozen policy-exception
 * proposal became permanently unapprovable, and a member who changed nothing was
 * quoted a date-change charge — so the whole set moves together and stays
 * together.
 *
 * ## The seventh instance, and why it is NOT collapsed into this one
 *
 * `normalizeBookingDate` in `src/lib/policies/pricing.ts` (F2, #3076) has the
 * same body wearing two pre-guards: it refuses an Invalid Date, and it refuses any
 * value whose time is not an exact multiple of a day. Its docblock names this
 * hoist and asks that whatever the hoist becomes keep those guards.
 *
 * **BE PRECISE ABOUT WHY THEY ARE NOT MERGED, because the obvious reason is
 * wrong.** Adopting the modulus guard here would NOT break a live call site.
 * Traced through every producer that currently reaches this function's 32 call
 * sites, none can deliver a non-midnight value:
 *
 * - `parseDateOnly` returns `dateOnlyInstantOf(day)` — exact UTC midnight — or
 *   `new Date(NaN)`, never a value carrying a time;
 * - a `@db.Date` column read is midnight by construction (`INV-DATE-026`);
 * - `modify-quote`'s `finalRequested*` locals come from `parseDateOnly` or from
 *   `booking.checkIn`, behind an explicit `Number.isNaN` refusal;
 * - and an Invalid Date already throws here, through
 *   `requireCalendarDate("0NaN-NaN-NaN")` — so the NaN guard would change the
 *   message and not the outcome.
 *
 * So a merged strict function would be observationally identical today. The two
 * stay separate on narrower ground:
 *
 * - **A TYPED HOLE, not a live throw.** `StayRangeDeltaInput.checkIn` and
 *   `StayRangeDeltaEntry.stayStart` are both `Date | string | null`, and `toDate`
 *   in `booking-modification-stay-ranges.ts` returns a `Date` UNCHANGED
 *   (`if (value instanceof Date) return value`). No live caller passes a raw
 *   `Date` — every one supplies a string or an already-parsed midnight value — but
 *   the signature invites one, and a timestamped `Date` walking through it reaches
 *   `storedDateOnly(finalRequestedCheckIn)` inside the largest money-adjacent
 *   route in the tree. Under the permissive function that floors; under a merged
 *   strict one it throws mid-quote.
 * - **Dropping the guards there** would remove a control F2 added on measured
 *   evidence: removing the zone projection also removed a safety net that had been
 *   making a mis-typed instant accidentally right for a New Zealand club.
 *
 * So the pricing engine holds the stricter contract its own inputs justify, and
 * this holds the permissive one, for callers whose input types are wider than
 * their callers currently are. A later lane that wants one function should close
 * the type hole FIRST — narrow those two fields to `string | null` — and then the
 * merge is free rather than a behaviour change waiting for a new caller. Both
 * names are listed in `DATE_ONLY_RENORMALISERS` so the encoding census follows
 * either.
 *
 * ## It is a census participant, not just a helper
 *
 * `date-only-encoding-guard.test.ts` follows this function by name, so a call
 * site written through it is classified as if it called
 * `calendarDateOfDateOnlyInstant` directly. Without that entry the guard cannot
 * see what is being handed in, and `storedDateOnly(booking.createdAt)` — a real
 * instant, read as its UTC day, which is `INV-DATE-019` — would be invisible to
 * it. Read `DATE_ONLY_RENORMALISERS` in that file before renaming this function.
 *
 * Four of the 32 sites hand it a bare local or parameter rather than a field
 * access, so the census can classify nothing there in either direction:
 * `modify-quote/route.ts` at the three `finalRequested*` reads, and
 * `booking-edit-policy.ts:167`. That is a limit of a scanner that resolves field
 * names, not a gap this entry opened.
 */

import {
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
} from "@/lib/club-time";

/**
 * The calendar day a `@db.Date` column stores, back as a date-only `Date`.
 *
 * Decoded and re-encoded in UTC, taking no timezone at all. The DECODE is
 * `INV-DATE-019`'s first exact boundary — truncating an existing `@db.Date` value
 * is fine, because it already encodes a calendar day rather than an instant —
 * plus `INV-DATE-026`, which is what says the column is one. The RE-ENCODE is
 * `INV-DATE-026`'s corollary: a bound against a `@db.Date` column must be a
 * calendar day at UTC midnight, because the adapter narrows whatever instant it
 * is handed. **Do not cite `INV-DATE-010` for the decode** — it names these two
 * ids rather than itself as the decode authority, and what it forbids is
 * deriving a rule from one of these values read as a MOMENT. The six docblocks
 * this function replaces all cited it for the decode anyway, and
 * `club-time/instant.ts` records where the paraphrase started.
 *
 * Idempotent, so a caller that has already normalised its rows hands in values
 * this leaves alone.
 *
 * THROWS for a value whose UTC year falls outside `0001`-`9999`, which is what a
 * `@db.Date` holding something other than a club calendar day looks like from
 * here — and for an Invalid Date, which is what a failed parse upstream looks
 * like. Both are refusals rather than a plausible wrong day.
 */
export function storedDateOnly(value: Date): Date {
  return dateOnlyInstantOf(calendarDateOfDateOnlyInstant(value));
}
