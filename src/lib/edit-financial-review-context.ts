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
 * DESTROYS: the stored sold-price rows for the nights it surrenders are gone the
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
  /** The guest strand carries no stored per-night sold price at all. */
  "NO_STORED_NIGHT_PRICES",
  /** Some of the surrendered nights carry a stored price and some do not. */
  "PARTIAL_STORED_NIGHT_PRICES",
  /** Stored night prices exist but do not reconcile to the stored guest total. */
  "STORED_TOTAL_MISMATCH",
] as const;

export type EditFinancialReviewCause =
  (typeof EDIT_FINANCIAL_REVIEW_CAUSES)[number];

/**
 * One stored sold-price row as it existed BEFORE the edit. `priceCents` is null
 * where the row existed with no usable price, or where no row existed for that
 * night at all — the distinction an admin needs, and the reason this is
 * `number | null` rather than a number defaulted to zero. Zero is a real sold
 * price (a comped night); null is an absence.
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
  /** The stored sold-price evidence this edit was judged against. */
  storedEvidence: {
    /** `BookingGuest.priceCents` as stored, or null where absent. */
    guestTotalCents: number | null;
    /** The guest strand's stored night rows as they were before the edit. */
    nightPrices: readonly StoredNightPriceEvidence[];
  };
};

/**
 * THE ONE "we cannot price this" OUTCOME (`INV-SSOT`, #3031, epic #2797).
 *
 * Both the in-progress planner (`InProgressGuestRangePlanResult`) and the
 * modification pricer (`PricingResult`) answer with either a priced result or
 * this — one idea, so one type rather than two parallel unions that happened to
 * be spelled identically. There is deliberately NO numeric field on it: the epic
 * prohibits a magic zero and an estimate alike, and a shape carrying neither is
 * cheaper than a rule saying not to read one (INV-MOD-028).
 */
export type FinancialReviewRequired = {
  kind: "financial_review_required";
  occurrences: EditFinancialReviewOccurrence[];
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
};

const calendarDateSchema = z.custom<CalendarDate>(isCalendarDate, {
  message: "Expected a yyyy-mm-dd calendar date.",
});

/**
 * Integer cents, non-negative — `INV-MONEY-001`, and the same rule the
 * `ManualRefundTask_amount_nonnegative` CHECK enforces in the database.
 *
 * THE ONE STATEMENT OF THE RULE (`INV-SSOT`). A stored
 * `BookingGuestNight.priceCents` is a bare `Int` with no non-negative
 * constraint, so "is this stored value usable as money at all" is a question
 * several modules ask — the planner that refuses to price from it (#3031), the
 * review-context schema below, and the task writer. They must agree to the
 * value, so the rule is written here once, as a schema, and everything else is
 * derived from it rather than restated beside it.
 */
export const nonNegativeCentsSchema = z.number().int().nonnegative();

/**
 * The predicate form of {@link nonNegativeCentsSchema}, DERIVED rather than
 * re-implemented: a hand-rolled `typeof === "number" && Number.isInteger(…)`
 * twin is one edit away from disagreeing with the schema that gates the write,
 * and the two disagreeing is the difference between refusing a value and storing
 * it.
 */
export function isNonNegativeIntegerCents(value: unknown): value is number {
  return nonNegativeCentsSchema.safeParse(value).success;
}

/**
 * {@link nonNegativeCentsSchema}, with null accepted where the evidence is
 * genuinely absent — which is not the same as zero (see
 * `StoredNightPriceEvidence`).
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
