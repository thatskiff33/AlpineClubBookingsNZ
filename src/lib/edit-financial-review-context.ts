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
 *
 * ADDING A VALUE IS SAFE; CHANGING WHAT IS HASHED IS NOT. The occurrence key's
 * material is a fixed set of FIELDS (`editFinancialReviewOccurrenceKey`), and a
 * new value of an existing field re-identifies nothing that already exists — an
 * occurrence that hashed as `STORED_TOTAL_MISMATCH` yesterday still does. That
 * is why `COUNTERPART_STRAND_UNREADABLE` below needed no namespace bump, and it
 * is not a precedent for adding a FIELD, which would move every future key.
 */
export const EDIT_FINANCIAL_REVIEW_CAUSES = [
  /** The guest strand carries no stored per-night price at all. */
  "NO_STORED_NIGHT_PRICES",
  /** Some of the surrendered nights carry a stored price and some do not. */
  "PARTIAL_STORED_NIGHT_PRICES",
  /** Stored night prices exist but do not reconcile to the stored guest total. */
  "STORED_TOTAL_MISMATCH",
  /** The rows reconcile only as a whole-guest allocation, not as sold nights. */
  "INEXACT_STORED_NIGHT_PRICES",
  /**
   * #3032: THIS strand's own rows read perfectly. Another strand on the same
   * booking does not, so the edit's money was parked as a whole and this
   * strand's share went with it.
   *
   * It exists because the removal path settles a DIFFERENCE OF REPRICINGS: one
   * unreadable strand anywhere on the booking makes the arithmetic unsafe for
   * every strand, including the one whose nights are actually being given back.
   * Before this cause existed such a strand was skipped entirely — it was
   * "exact", so nothing raised it — and the departing guest's money, which the
   * delete was about to destroy, was recorded nowhere at all.
   *
   * The distinction is what an admin needs: on this cause the stored evidence
   * beside it is complete and adds up, so they are confirming a number the rows
   * already show rather than reconstructing one.
   */
  "COUNTERPART_STRAND_UNREADABLE",
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
 * ONE GUEST STRAND'S RECORD inside a parked edit (#3498).
 *
 * Exactly the fields a whole occurrence used to carry, because until #3498 one
 * strand WAS one occurrence and one work item. The grain moved up; the record
 * did not change, which is what makes "no stored figure is lost" checkable
 * rather than asserted (`editFinancialReviewStrandRecords` enumerates them, and
 * `edit-financial-review-strand-census.test.ts` pins every field).
 */
export type EditFinancialReviewStrandRecord = {
  /** The guest strand this record is about. */
  bookingGuestId: string;
  cause: EditFinancialReviewCause;
  /** Nights leaving the occupancy set. Order-insensitive; the key sorts them. */
  surrenderedNightDates: readonly CalendarDate[];
  /**
   * Nights the same edit ADDS to this strand. Priced normally under current
   * policy, so they are not part of the unknown amount — but two edits that
   * surrender the same nights and add different ones are two different edits, so
   * they are part of the identity.
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
 * The IDENTITY of one unpriceable structural edit — the material the occurrence
 * key is derived from, and nothing else. Anything an admin merely wants to LOOK
 * at belongs on `EditFinancialReviewContext` below instead: adding a display
 * field here would silently change the identity of every future occurrence.
 *
 * `storedEvidence` is part of the identity on purpose, and the reasoning is in
 * `editFinancialReviewOccurrenceKey`.
 *
 * ## THE GRAIN IS THE EDIT, NOT THE STRAND (#3498, owner decision D1)
 *
 * It used to be the strand, and one parked edit minted one of these PER GUEST.
 * Measured on the live deployment on 17 September 2026: removing one guest from
 * a seven-guest booking raised seven work items, six of them guests nobody
 * touched, all seven carrying the same **Record the adjustment** button — and a
 * dismissal was terminal, silent and unrecoverable. Every consumer was already
 * per-edit (one `BookingModification` anchor, a whole-booking re-price on every
 * closure), so the grain, not the consumers, was what was wrong.
 *
 * ## Why a LEAD strand plus `otherStrands`, rather than a bare list
 *
 * Two reasons, and neither is cosmetic.
 *
 * Rows already in production carry the lead fields at the top level with no
 * `otherStrands`, and this shape reads them back EXACTLY as written — no
 * migration, no versioned parser branch, no window in which the finance queue
 * cannot render money it is holding. #3498 explicitly does not rewrite the items
 * already raised; they are worked by hand, and they must stay readable while
 * that happens.
 *
 * And a work item has to LEAD with something. An officer opens one card and the
 * first thing on it should be the strand the money hangs on —
 * `parkedEditWorkItems` in `parked-edit-occurrence.ts` owns that choice and
 * states the ranking, along with how many items the edit raises at all. Every
 * other strand is supporting detail, which is D1's own word for it.
 *
 * Nothing may read `otherStrands` directly to enumerate the edit's strands: call
 * `editFinancialReviewStrandRecords`, which is the one place that list is
 * assembled (`INV-SSOT`).
 */
export type EditFinancialReviewOccurrence = EditFinancialReviewStrandRecord & {
  bookingId: string;
  /**
   * Every OTHER strand this parked edit recorded, in the canonical order
   * `parkedEditWorkItems` sorts them into.
   *
   * ABSENT — not empty — on a row written before #3498, and on an edit whose
   * only recorded strand is the lead. Optional because the parser is a
   * whole-object `strict()` read that must keep accepting production rows that
   * have no such field.
   */
  otherStrands?: readonly EditFinancialReviewStrandRecord[];
};

/**
 * EVERY strand one parked edit recorded, lead first — the one place that list is
 * assembled (`INV-SSOT`, #3498).
 *
 * A reader that spliced `[occurrence, ...occurrence.otherStrands ?? []]` for
 * itself would be a second definition of "what strands does this item cover",
 * and the two are free to drift on the order, on whether the lead is included,
 * and on what an absent `otherStrands` means. There are four such readers (the
 * queue projection, the night-price repair, the reason builder and the census),
 * so it lives here.
 */
export function editFinancialReviewStrandRecords(
  occurrence: EditFinancialReviewOccurrence,
): readonly EditFinancialReviewStrandRecord[] {
  return [
    {
      bookingGuestId: occurrence.bookingGuestId,
      cause: occurrence.cause,
      surrenderedNightDates: occurrence.surrenderedNightDates,
      addedNightDates: occurrence.addedNightDates,
      storedEvidence: occurrence.storedEvidence,
    },
    ...(occurrence.otherStrands ?? []),
  ];
}

/**
 * DID THIS EDIT MOVE THIS STRAND'S NIGHTS? The one definition (`INV-SSOT`,
 * #3498 fix round).
 *
 * Three separate money rules turn on this one question and each of them was
 * asking it in its own words before this existed:
 *
 *  - which strand LEADS a parked edit's work item (`parkedEditOccurrence`);
 *  - HOW MANY work items the edit raises at all (`parkedEditWorkItems`, the
 *    owner's 17 September 2026 decision: one item per edit while at most one
 *    strand moves, one item per strand once two or more do);
 *  - whether the amount being settled moves THIS strand's stored worth
 *    (`RepairableStrand.absorbsSettlement`).
 *
 * The third is money in the plainest sense — get it wrong and a settlement is
 * absorbed into a stranger's stay — so the three cannot be allowed to answer
 * differently, and they can only be kept from it by there being one answer.
 *
 * A REMOVED strand answers true through its surrendered nights, not through a
 * flag: `preCheckInEditStrands` gives a strand being deleted an empty proposed
 * night set, so every night it held is surrendered. `rowsDestroyed` exists
 * upstream for the separate question of whether an EXACT strand is recorded at
 * all, and it is deliberately not part of the strand record — the record is
 * hashed into the occurrence key, so a field added to it re-identifies every
 * future occurrence.
 */
export function editFinancialReviewStrandMovesNights(
  strand: Pick<
    EditFinancialReviewStrandRecord,
    "surrenderedNightDates" | "addedNightDates"
  >,
): boolean {
  return (
    strand.surrenderedNightDates.length > 0 || strand.addedNightDates.length > 0
  );
}

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
  /**
   * THE WORK ITEMS this parked edit raises, lead item first and NEVER EMPTY
   * (#3498, owner decision D1 as amended 17 September 2026).
   *
   * One of them on an edit that moved at most one strand's nights, which is the
   * shape every case the issue measured has; one per recorded strand once two
   * or more moved, because an item holds one `amountCents` and two moving
   * strands need two. `parkedEditWorkItems` is the ONE place that count is
   * decided and the only place the reasoning is written.
   *
   * A NON-EMPTY TUPLE rather than an array a caller is asked to keep populated:
   * `INV-SSOT`'s "prefer unrepresentable over policed". A parked edit that
   * raises nothing is a parked edit nobody is asked to price, and the type is
   * what makes that unwritable rather than a rule enforced at four call sites.
   */
  occurrences: readonly [
    EditFinancialReviewOccurrence,
    ...EditFinancialReviewOccurrence[],
  ];
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
   * #3166: the guests this same edit ADDED to the booking, and what they were
   * priced at — or null when it added none.
   *
   * ## Why an admin cannot do the job without it
   *
   * A parked edit's occurrence describes ONE unreadable strand. On a guest add
   * that strand is an existing guest nobody touched, so the whole card reads
   * "nights given back: none · nights added: none · stored total: $200" — and
   * says nothing at all about the two guests just put on the booking at $320
   * each. A parked add writes the booking's total back UNCHANGED and raises no
   * charge, so that $640 is owed, is recorded only on the new guests' own rows,
   * and the person being asked to price the booking is never shown it.
   *
   * It is on the CONTEXT and deliberately not on the occurrence: occurrence
   * fields are the material the key is hashed from, so putting it there would
   * re-identify every future occurrence and would have to bump the namespace
   * version. This is evidence about the edit, not identity.
   *
   * OPTIONAL, because rows written before #3166 have no such field and the
   * parser is a whole-object `strict()` read that must keep accepting them.
   * `totalPriceCents` is nullable for the same reason the stored figures are: a
   * total that is not usable money is recorded as absent rather than as a number
   * an admin might act on.
   */
  guestsAddedByEdit?: {
    count: number;
    totalPriceCents: number | null;
  } | null;
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

/**
 * A club calendar date on the wire.
 *
 * EXPORTED since #3191, which needed the same rule for the per-night amounts an
 * officer posts back. A second `z.custom(isCalendarDate)` beside this one would
 * be a second spelling of the same boundary, and the two are free to drift on
 * the message or on which predicate they use (`INV-SSOT`).
 */
export const calendarDateSchema = z.custom<CalendarDate>(isCalendarDate, {
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
 * #3031 added a fifth, and it is the one that explains why the rule has to be
 * shared rather than merely tidy: a stored `BookingGuestNight.priceCents` is a
 * bare `Int` with NO non-negative constraint, so "is this stored value usable as
 * money at all" is asked by the planner that refuses to price from it as well as
 * by the writers above. Those two disagreeing is the difference between refusing
 * a value and storing it.
 *
 * The ten pre-existing inline sites are deliberately NOT refactored onto this;
 * that is a wider change than this issue, and doing it half-way would leave the
 * rule looking centralised when it is not.
 */
export const nonNegativeCentsSchema = z.number().int().nonnegative();

/**
 * The same rule as a predicate, for the server callers that validate a number
 * they already hold and throw their own domain error. Derived FROM the schema
 * rather than re-implemented beside it, so there is one definition and not two
 * that agree today.
 */
export function isNonNegativeIntegerCents(value: unknown): value is number {
  return nonNegativeCentsSchema.safeParse(value).success;
}

/**
 * Null is accepted where the evidence is genuinely absent, which is not the same
 * as zero (see `StoredNightPriceEvidence`).
 */
const nonNegativeCentsOrNull = nonNegativeCentsSchema.nullable();

const strandRecordShape = {
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
} as const;

/**
 * #3498 fix round: UNKNOWN KEYS ARE IGNORED, on this schema and the occurrence
 * schema below, and that is a deliberate reversal of `.strict()` here.
 *
 * The property that matters is not strictness about extras, it is that every
 * KNOWN field is required and validated - which is what stops a partially-read
 * context being treated as complete, and which is unchanged. What `.strict()`
 * added on top was this: a colour that does not know about a field the shape
 * has GAINED refuses the whole context and reads it as absent.
 *
 * That is not theoretical, it is what #3498 does. Adding `otherStrands` means a
 * context written by the new colour cannot be parsed by the previous one at
 * all - and the previous one does not fail loudly, it reads null, offers no
 * price boxes, and lets a review close with the #3219-D2 mandatory night prices
 * skipped. Blue/green runs the two colours side by side between migrate and
 * cutover, so that window is real even though this release adds no migration
 * and `docs/BLUE_GREEN_MIGRATION_POLICY.md` therefore binds nothing here; its
 * runtime-release rule - "move reads and writes to the new shape while still
 * TOLERATING the old one" - is the principle being applied.
 *
 * No edit to this file can rescue the colour that is ALREADY DEPLOYED, whose
 * parser is compiled. What it does buy is that the NEXT field this shape gains
 * degrades to "read what you understand" instead of "read nothing", which is
 * the right failure for evidence about a member's money. Widening the shape
 * still moves the occurrence key and still needs the namespace bump the key's
 * own docblock demands; this changes only how a reader that is behind copes.
 */
const strandRecordSchema: z.ZodType<EditFinancialReviewStrandRecord> =
  z.object(strandRecordShape);

/** Unknown keys ignored, for the reason `strandRecordSchema` above sets out. */
const occurrenceSchema: z.ZodType<EditFinancialReviewOccurrence> = z
  .object({
    bookingId: z.string().min(1),
    ...strandRecordShape,
    /*
      #3498: OPTIONAL, and that is what keeps every row raised before this issue
      readable. A production row carries the lead fields above and no
      `otherStrands` at all, and this is a whole-object `.strict()` parse, so an
      absent field has to be legal rather than tolerated. Absent and empty are
      not distinguished by any reader — `editFinancialReviewStrandRecords`
      collapses both to "the lead strand and nothing else".
    */
    otherStrands: z.array(strandRecordSchema).optional(),
  });

const contextSchema: z.ZodType<EditFinancialReviewContext> = z
  .object({
    version: z.literal(1),
    occurrence: occurrenceSchema,
    guestMemberId: z.string().min(1).nullable(),
    bookingCheckIn: calendarDateSchema,
    bookingCheckOut: calendarDateSchema,
    guestsAddedByEdit: z
      .object({
        count: z.number().int().positive(),
        totalPriceCents: nonNegativeCentsOrNull,
      })
      .strict()
      .nullish(),
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
  INEXACT_STORED_NIGHT_PRICES:
    "The stored amounts reconcile for the whole guest but were not recorded as sold night prices, so an individual night cannot be valued from them.",
  COUNTERPART_STRAND_UNREADABLE:
    "This guest's own stored night prices are complete and add up, but another guest on the same booking has prices that cannot be read — so the booking's total could not be reworked automatically. The figures shown here are what was stored for this guest.",
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
export type EditFinancialReviewStrandEvidence = {
  cause: EditFinancialReviewCause;
  surrenderedNightDates: readonly CalendarDate[];
  addedNightDates: readonly CalendarDate[];
  storedEvidence: {
    guestTotalCents: number | null;
    nightPrices: readonly StoredNightPriceEvidence[];
  };
};

export type EditFinancialReviewEvidence = EditFinancialReviewStrandEvidence & {
  /**
   * #3498: the OTHER strands the same parked edit recorded, in the order the
   * item stores them — supporting detail behind the lead strand above, which is
   * owner decision D1's own description of them.
   *
   * WITHOUT THE GUEST-STRAND ID, exactly like the lead strand: this projection's
   * whole job is that no admin payload can carry one, and a list of them would
   * be the same leak in a loop. A card distinguishes them by position and by
   * what their evidence says, which is what an officer pricing the edit is
   * reading anyway.
   *
   * EMPTY on every row raised before #3498, which is the honest answer for one:
   * those items each described a single strand.
   */
  otherStrands: readonly EditFinancialReviewStrandEvidence[];
  bookingCheckIn: CalendarDate;
  bookingCheckOut: CalendarDate;
  /**
   * #3166: how many guests the same edit added and what they were priced at.
   * Money the club is owed and has NOT taken, which this strand's own evidence
   * cannot show. No id and no name — a count and a figure.
   */
  guestsAddedByEdit: {
    count: number;
    totalPriceCents: number | null;
  } | null;
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
  /*
    #3498 fix round: through `editFinancialReviewStrandRecords`, like every
    other reader. This projection used to splice the lead and `otherStrands`
    itself, which made it the one named reader bypassing the one home the type
    docblock above forbids bypassing - and the drift that would buy is not
    hypothetical, because "is the lead included, and in what order" is exactly
    what this function has to agree with the settle path about: the officer's
    figures come back matched by POSITION.
  */
  const [lead, ...otherStrands] = editFinancialReviewStrandRecords(
    context.occurrence,
  );
  // Field by field rather than a spread, for the reason this function exists: a
  // spread would carry `bookingGuestId` straight onto a `finance:view` payload.
  const redact = (
    strand: EditFinancialReviewStrandRecord,
  ): EditFinancialReviewStrandEvidence => ({
    cause: strand.cause,
    surrenderedNightDates: strand.surrenderedNightDates,
    addedNightDates: strand.addedNightDates,
    storedEvidence: {
      guestTotalCents: strand.storedEvidence.guestTotalCents,
      nightPrices: strand.storedEvidence.nightPrices,
    },
  });
  return {
    // Non-null by construction: the helper always answers with the lead first.
    ...redact(lead!),
    otherStrands: otherStrands.map(redact),
    bookingCheckIn: context.bookingCheckIn,
    bookingCheckOut: context.bookingCheckOut,
    guestsAddedByEdit: context.guestsAddedByEdit ?? null,
  };
}
