import { z } from "zod";
import { isCalendarDate } from "@/lib/club-time";
import type { CalendarDate } from "@/lib/club-time";

/**
 * #3030 (epic #2797, owner decision D3): the shape of
 * `ManualRefundTask.reviewContext`, and the only definition of it.
 *
 * WHY THIS FILE EXISTS AT ALL. `reviewContext` is a `Json?` column, so Prisma
 * hands it back as `JsonValue` — which is to say untyped. A schema-typed field
 * whose contents nothing describes is untyped in practice, and this one is the
 * evidence an admin prices real money from. So the shape is declared once, here,
 * and every reader parses through `parseEditFinancialReviewContext` rather than
 * indexing into an `any`.
 *
 * WHY IT IS SEPARATE FROM `edit-financial-review.ts`. That module is
 * `server-only` (it mints the occurrence key with `node:crypto` and writes rows).
 * The pending-review admin surface (#3033) is a client component and needs the
 * type and the parser without dragging the writer across the boundary, which
 * `client-server-boundary-census.test.ts` would fail. Nothing here imports
 * `node:`, Prisma, or `@/lib/prisma`.
 *
 * WHAT IS DELIBERATELY NOT IN HERE, per the column's own contract: the booking's
 * payment and rate history. D3 asks for "a link to the booking's payment and rate
 * history", not a copy of it — a copy taken at raise time would be stale by the
 * time an admin reads it, and would be a second home for facts the payment
 * tables already own (`INV-SSOT`). What IS captured is only what the edit
 * DESTROYS: the stored night-price rows for the nights it surrenders are gone the
 * moment the edit commits, so if they are not recorded here they cannot be
 * recovered at all.
 */

/**
 * WHY the exact sold price could not be proven. A closed vocabulary rather than
 * prose, because #3033 renders a "safe diagnostic category" to an admin and the
 * occurrence key (`edit-financial-review.ts`) hashes this value — English cannot
 * do either job.
 *
 * Deliberately about the EVIDENCE, never about the member: none of these is a
 * fault of theirs, and none of them may reach member-facing copy (#3033 forbids
 * "corruption terminology" and blaming the member).
 */
export const EDIT_FINANCIAL_REVIEW_CAUSES = [
  /** The guest strand carries no stored per-night price at all. */
  "NO_STORED_NIGHT_PRICES",
  /** Some of the surrendered nights carry a stored price and some do not. */
  "PARTIAL_STORED_NIGHT_PRICES",
  /** Stored night prices exist but do not reconcile to the stored guest total. */
  "STORED_TOTAL_MISMATCH",
] as const;

export type EditFinancialReviewCause =
  (typeof EDIT_FINANCIAL_REVIEW_CAUSES)[number];

/**
 * One stored night-price row as it existed BEFORE the edit. `priceCents` is null
 * where the row existed with no usable price, or where no row existed for that
 * night at all — the distinction an admin needs, and the reason this is
 * `number | null` rather than a number defaulted to zero. Zero is a real price
 * (a comped night); null is an absence.
 *
 * A NUMBER HERE IS NOT PROOF OF A SOLD PRICE, and the field deliberately says
 * nothing about where it came from. Two backfill migrations populated
 * `BookingGuestNight.priceCents` by DIVIDING a stored guest total by the night
 * count — 20260704150000 (#1098) and 20260810010000, whose own header says it
 * "deliberately does NOT reprice anything: it reads the stored total and
 * divides" — and nothing in the schema distinguishes such a derived row from a
 * genuinely-sold one. So this type records the number that is stored, and claims
 * only that. No provenance field is added: there is no honest value to put in
 * one, and this shape is hashed into the occurrence key, so widening it would
 * re-identify every future occurrence.
 *
 * That indistinguishability is not a gap in this feature — it is the CASE FOR
 * it. A figure whose provenance cannot be established is exactly the figure a
 * human must confirm rather than the machine compute. Separating derived rows
 * from sold ones is #3031's.
 */
export type StoredNightPriceEvidence = {
  date: CalendarDate;
  priceCents: number | null;
};

/**
 * The IDENTITY of one unpriceable structural edit — the material the occurrence
 * key is derived from, and nothing else. Anything an admin merely wants to LOOK
 * at belongs on `EditFinancialReviewContext` below instead: adding a display
 * field here would silently change the identity of every future occurrence.
 *
 * `storedEvidence` is part of the identity on purpose, and the reasoning is in
 * `editFinancialReviewOccurrenceKey`.
 */
export type EditFinancialReviewOccurrence = {
  bookingId: string;
  /** The guest strand whose nights were given back. */
  bookingGuestId: string;
  cause: EditFinancialReviewCause;
  /** Nights leaving the occupancy set. Order-insensitive; the key sorts them. */
  surrenderedNightDates: readonly CalendarDate[];
  /**
   * Nights the same edit ADDS. Priced normally under current policy, so they are
   * not part of the unknown amount — but two edits that surrender the same
   * nights and add different ones are two different edits, so they are part of
   * the identity.
   */
  addedNightDates: readonly CalendarDate[];
  /**
   * The stored night-price rows this edit was judged against, as they stood
   * before it. Evidence of what the database HELD, not proof of what was sold —
   * see `StoredNightPriceEvidence`.
   */
  storedEvidence: {
    /** `BookingGuest.priceCents` as stored, or null where absent. */
    guestTotalCents: number | null;
    /** The guest strand's stored night rows as they were before the edit. */
    nightPrices: readonly StoredNightPriceEvidence[];
  };
};

/**
 * What is written to `ManualRefundTask.reviewContext`: the identity above, plus
 * the display-only evidence D3 asks for.
 *
 * `version` is a real gate, not decoration. `parseEditFinancialReviewContext`
 * refuses anything else, so a row written by a future shape cannot be read as if
 * it were this one — which for money evidence is the difference between "we
 * cannot read this, ask a human" and "we read the wrong number".
 */
export type EditFinancialReviewContext = {
  version: 1;
  occurrence: EditFinancialReviewOccurrence;
  /** The member behind the guest strand, or null for a non-member guest. */
  guestMemberId: string | null;
  /** The booking's own stay window, for the "which rates applied then" question. */
  bookingCheckIn: CalendarDate;
  bookingCheckOut: CalendarDate;
  /**
   * #3032 (owner decision D-3032-1): the `BookingModification` row the edit that
   * raised this review wrote, and the anchor a confirmed amount settles against
   * later.
   *
   * WHY IT IS CARRIED AT ALL. Two of the three ways money can go back key their
   * exactly-once on a modification id and nothing else: `MemberCredit`
   * `.sourceBookingModificationId` is `@unique`, and the Stripe refund
   * idempotency key is `${prefix}_${bookingModificationId}`. A completion that
   * did not know the id would have to mint a fresh anchor - a second history row
   * per edited booking, which the owner weighed and rejected - or invent a
   * fourth settlement path, which the epic forbids outright.
   *
   * DELIBERATELY NOT ON `EditFinancialReviewOccurrence`. The occurrence is the
   * identity the key is hashed from, and this value is a POINTER to a row, not a
   * fact about which edit happened: two replays of one edit are the same
   * occurrence whether or not they landed the same modification row. Putting it
   * in the identity would re-identify every future occurrence and, worse, make a
   * replay of one edit hash differently from the first attempt.
   *
   * NULL is legitimate and is the shape of a raise that had no modification row
   * to point at. A completion that needs an anchor and finds none refuses before
   * it claims anything, rather than guessing which row to settle against.
   */
  bookingModificationId: string | null;
};

const calendarDateSchema = z.custom<CalendarDate>(isCalendarDate, {
  message: "Expected a yyyy-mm-dd calendar date.",
});

/**
 * Integer cents, non-negative — `INV-MONEY-001`, and the same rule the
 * `ManualRefundTask_amount_nonnegative` CHECK enforces in the database.
 *
 * `INV-SSOT`, and this is the ONE home for it across this feature. #3030 needed
 * the rule in four places — the raise (`edit-financial-review.ts`), the
 * completion (`manual-refund-task-resolution.ts`), the stored-evidence parser
 * below, and the admin route's request body — and there was no existing exported
 * predicate to route to: the idiom is inline at ten pre-existing sites, none of
 * them named, and `money-input.ts` is a PARSER for money a person typed, not a
 * validator for an amount that is already a number. Four callers is the second
 * clause of the rule ("if two places need it, move it to one module"), so it
 * lives here — in the client-safe half of the feature, which every one of the
 * four can import.
 *
 * The ten pre-existing inline sites are deliberately NOT refactored onto this;
 * that is a wider change than this issue, and doing it half-way would leave the
 * rule looking centralised when it is not.
 */
export const nonNegativeCentsSchema = z.number().int().nonnegative();

/**
 * The same rule as a predicate, for the two server callers that validate a
 * number they already hold and throw their own domain error. Derived FROM the
 * schema rather than re-implemented beside it, so there is one definition and
 * not two that agree today.
 */
export function isNonNegativeIntegerCents(value: unknown): value is number {
  return nonNegativeCentsSchema.safeParse(value).success;
}

/**
 * Null is accepted where the evidence is genuinely absent, which is not the same
 * as zero (see `StoredNightPriceEvidence`).
 */
const nonNegativeCentsOrNull = nonNegativeCentsSchema.nullable();

const occurrenceSchema: z.ZodType<EditFinancialReviewOccurrence> = z
  .object({
    bookingId: z.string().min(1),
    bookingGuestId: z.string().min(1),
    cause: z.enum(EDIT_FINANCIAL_REVIEW_CAUSES),
    surrenderedNightDates: z.array(calendarDateSchema),
    addedNightDates: z.array(calendarDateSchema),
    storedEvidence: z
      .object({
        guestTotalCents: nonNegativeCentsOrNull,
        nightPrices: z.array(
          z
            .object({
              date: calendarDateSchema,
              priceCents: nonNegativeCentsOrNull,
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const contextSchema: z.ZodType<EditFinancialReviewContext> = z
  .object({
    version: z.literal(1),
    occurrence: occurrenceSchema,
    guestMemberId: z.string().min(1).nullable(),
    bookingCheckIn: calendarDateSchema,
    bookingCheckOut: calendarDateSchema,
    bookingModificationId: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Read a stored `reviewContext` back, or return null.
 *
 * NULL RATHER THAN A THROW, deliberately. The caller is an admin surface trying
 * to show evidence; a row whose context is missing, was written by an older
 * shape, or is malformed must still let the admin see the task and the amount and
 * reach the booking's live payment history. Losing the whole screen because one
 * JSON blob is unreadable would be a worse failure than showing the task without
 * its captured evidence. What must NEVER happen is a partially-read context
 * being treated as complete, which is why this is a whole-object `strict()`
 * parse rather than field-by-field optional reads.
 */
export function parseEditFinancialReviewContext(
  value: unknown,
): EditFinancialReviewContext | null {
  const parsed = contextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
