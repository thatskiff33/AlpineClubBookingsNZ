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

/**
 * #3033: the safe diagnostic category, in words an admin can act on.
 *
 * ONE HOME, here rather than in the admin card, because the vocabulary above
 * already exists for exactly this purpose — its own doc comment says the closed
 * set is what lets #3033 render "a safe diagnostic category" — and a label map
 * kept anywhere else would be a second place a renamed cause has to be changed
 * (`INV-SSOT`).
 *
 * Each label says what the EVIDENCE is missing, never what anybody did wrong.
 * These reach an admin screen only; the member surface renders none of them
 * (#3033 forbids corruption terminology and blaming the member), and nothing
 * here is a sentence a member's copy may be built from.
 */
export const EDIT_FINANCIAL_REVIEW_CAUSE_LABEL: Record<
  EditFinancialReviewCause,
  string
> = {
  NO_STORED_NIGHT_PRICES:
    "No per-night price was stored for this guest, so there is nothing to work the refund out from.",
  PARTIAL_STORED_NIGHT_PRICES:
    "Only some of the nights given back carry a stored price, so the total cannot be worked out from what is stored.",
  STORED_TOTAL_MISMATCH:
    "The stored night prices do not add up to the stored total for this guest, so neither figure can be trusted on its own.",
};

/**
 * What an admin surface may SEE of a captured review context.
 *
 * A PROJECTION, not the context: `guestMemberId` and `bookingGuestId` have no
 * field here at all, so no admin payload can carry them. They identify a member
 * and a guest strand — membership-roll identifiers with no rendering use on the
 * finance queue, which already shows the booking's own member by name — and the
 * honest way to keep them off a `finance:view` screen is to make them
 * unrepresentable in the shape that screen is built from, rather than to
 * remember to delete them at each send site (`INV-SSOT`: prefer unrepresentable
 * over policed).
 *
 * Everything that survives is money evidence about a task whose amount the same
 * screen already shows, which is why it needs no second permission: the nights
 * the edit gave back and added, whatever night prices were stored, the stored
 * guest total, and the booking's own stay window for the "which rates applied
 * then" question.
 */
export type EditFinancialReviewEvidence = {
  cause: EditFinancialReviewCause;
  surrenderedNightDates: readonly CalendarDate[];
  addedNightDates: readonly CalendarDate[];
  storedEvidence: {
    guestTotalCents: number | null;
    nightPrices: readonly StoredNightPriceEvidence[];
  };
  bookingCheckIn: CalendarDate;
  bookingCheckOut: CalendarDate;
};

/**
 * Reduce a parsed context to the evidence an admin surface may render.
 *
 * The single redaction point for this feature. Field-by-field rather than a
 * spread-and-delete, so a field added to `EditFinancialReviewContext` later is
 * withheld by default and has to be admitted deliberately — the safe direction
 * for a shape whose whole job is to carry evidence about a member's money.
 */
export function toEditFinancialReviewEvidence(
  context: EditFinancialReviewContext,
): EditFinancialReviewEvidence {
  return {
    cause: context.occurrence.cause,
    surrenderedNightDates: context.occurrence.surrenderedNightDates,
    addedNightDates: context.occurrence.addedNightDates,
    storedEvidence: {
      guestTotalCents: context.occurrence.storedEvidence.guestTotalCents,
      nightPrices: context.occurrence.storedEvidence.nightPrices,
    },
    bookingCheckIn: context.bookingCheckIn,
    bookingCheckOut: context.bookingCheckOut,
  };
}
