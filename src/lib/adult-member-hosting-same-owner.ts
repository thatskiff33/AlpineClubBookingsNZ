import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  coverageDependentEnvelopeOverStayUnionWhere,
  coverageDependentEnvelopeWhere,
  coverageEnvelopeWhere,
} from "@/lib/adult-member-hosting-coverage-envelope";
import { ApiError } from "@/lib/api-error";
import { formatBookingReference } from "@/lib/booking-reference";
import { bookingsOverlap } from "@/lib/booking-night-overlap";
import {
  HOSTING_COVERAGE_STATE_KEY_PATTERN,
  hostingCoverageStateKeyOf,
} from "@/lib/hosting-coverage-override-client";

/**
 * The `SAME_BOOKING_OWNER` host scope: which OTHER bookings may supply cover, and
 * which other bookings DEPEND on this one's cover (#2576).
 *
 * Deliberately I/O-free — two Prisma `where` builders, the refusal shape, and the
 * member-facing sentence. The reads themselves live in
 * `adult-member-hosting-review.ts`, which is the one module allowed to turn a
 * persisted booking into evaluator input, and the incident/notification side lives
 * in `adult-member-hosting-coverage-incidents.ts`. Splitting it this way is what
 * keeps the import graph acyclic, and it means the RELATIONSHIP — the thing the
 * owner's decision is almost entirely about — can be read in one place.
 *
 * THE RELATIONSHIP IS THE EXACT `Booking.memberId`, AND NOTHING ELSE (§1). Not
 * `createdById`, not the administrator who keyed the booking in, not a matching
 * email address, not Family Group membership, not `parentBookingId` on its own,
 * not a shared group organiser, not a shared payment, not another member who
 * happens to be at the lodge, and not any fuzzy identity match. An administrator
 * entering bookings on behalf of two different members must not cause those
 * bookings to cover each other, so the only column either builder below filters
 * on is `memberId`.
 *
 * OWNERSHIP IS NOT ATTENDANCE (§2). Everything here is about which bookings are
 * in scope. WHO may host is decided afterwards, by the shared evaluator's own
 * `participantQualifiesAsHost` — a booking owned by an adult member supplies
 * nothing unless a qualifying adult member is actually recorded as attending the
 * relevant lodge-night. §13 forbids a second definition of a qualifying adult
 * member and this module deliberately contains none.
 *
 * COVERAGE IS EXISTENTIAL (§14). Neither builder is keyed on a stored dependency:
 * they are re-derived from live rows at every evaluation, so a dependent booking
 * stays compliant while ANY eligible source remains, and evidence naming the
 * source observed at one evaluation never becomes an authorisation.
 */

/**
 * Bookings whose attendance may cover `booking`'s non-member guest-nights.
 *
 * Four clauses, each from the owner's decision:
 *
 *  - `memberId` — the exact same account (§1). THE RELATIONSHIP, and the only
 *    clause this module owns.
 *  - the shared coverage envelope — the same lodge, not this booking, an
 *    overlapping half-open date range, and the eligible-source lifecycle filter
 *    (§3, §4). Those five are `coverageEnvelopeWhere`, in
 *    `adult-member-hosting-coverage-envelope.ts`, because `SAME_GROUP_TRIP`
 *    (#3037) needs them to be byte-for-byte the same and hand-maintained
 *    symmetry between two copies is what `INV-SSOT-002` refuses. Their reasoning
 *    lives there rather than being restated here.
 *
 * WHY THIS IS BOUNDED WITHOUT A NEW INDEX (§10). The leading equality is
 * `memberId`, and the existing `Booking(memberId, status, checkIn)` index makes
 * this one member's own bookings — single digits for almost every member, low
 * hundreds for the busiest — with the lodge and date clauses filtering inside
 * that. It is emphatically not the lodge-wide sweep #2575 rejected: no clause
 * here can match a booking belonging to anybody else. A narrower composite index
 * is deliberately NOT added, because the owner asked for "the narrow indexes
 * required by the proven query plan" and no plan has been proven against a
 * production-shaped database in this lane — see the PR's residual risks.
 */
export function sameBookingOwnerCoverageSourceWhere(
  booking: {
    id: string;
    memberId: string;
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
  },
  options: { historical?: boolean } = {},
): Prisma.BookingWhereInput {
  // Spread flat, which is safe HERE and only here: the relationship is a scalar
  // equality on one key, so it cannot collide with anything the envelope sets.
  // The Group Trip scope's relationship is an `OR` and must compose under `AND`.
  return {
    ...coverageEnvelopeWhere(booking, options),
    memberId: booking.memberId,
  };
}

/** The owner, lodge and stay window either dependent builder is keyed from. */
export interface SameOwnerDependentBooking {
  id: string;
  memberId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
}

/**
 * Bookings whose own compliance may DEPEND on `booking`'s attendance — the set
 * that has to be re-evaluated when this booking's rows change (§6, §8, §10).
 *
 * The mirror of the source builder: the same `memberId` relationship, wrapped in
 * `coverageDependentEnvelopeWhere` instead. That envelope carries the one
 * deliberate difference — the wider `ACTIVE_BOOKING_STATUSES` cohort, because
 * the rule judges a PAYMENT_PENDING or AWAITING_REVIEW booking too — and the
 * reasoning for it, and for the absence of a guest-composition filter that §10
 * might seem to ask for. Both are stated once, there.
 *
 * The one thing worth repeating here is §10's consequence: refusing an ordinary
 * source-removal change preserves a dependent's prospective cover, and if an
 * authorised or unavoidable change proceeds, its own confirmation path still
 * rechecks the rule.
 *
 * THIS FORM IS NOW THE DRAIN'S, AND ONLY THE DRAIN'S (#3232). Its single-window
 * night clause is exactly right for `loadSameOwnerCoverageDependentIds`, whose
 * `booking` argument is a SYNTHETIC envelope built from a queue item's own night
 * list — there the window IS the bound §10 asks for, not a stale reading of a
 * booking that has since moved. The post-mutation fan-out cannot use it, for the
 * reason `sameOwnerCoverageDependentOverStayUnionWhere` states, and the two are
 * separate named functions rather than one flagged function so that neither
 * caller can reach the other's window by accident.
 */
export function sameOwnerCoverageDependentWhere(
  booking: SameOwnerDependentBooking,
): Prisma.BookingWhereInput {
  return {
    ...coverageDependentEnvelopeWhere(booking),
    memberId: booking.memberId,
  };
}

/**
 * The same relationship, over the window this booking VACATED as well as the one
 * it now holds — the set the POST-MUTATION fan-out has to look at (#3232,
 * `INV-HOST-049`).
 *
 * WHY THE BUILDER ABOVE CANNOT SERVE THIS CALLER. The fan-out runs after the
 * write, so `booking.checkIn`/`checkOut` are the NEW dates, and a booking relying
 * on the OLD ones fails a single-window overlap test. It is then not in the set at
 * all: `inspectSameOwnerDependents` never evaluates it, no incident opens, the
 * owner is not told and nothing reaches the officer queue, so the booking stays
 * marked compliant while being uncovered for as long as nobody happens to edit it.
 * That was live for every club on this scope, and it is what #3232 fixes.
 *
 * The envelope carries the whole argument for why the answer is the UNION of the
 * two windows rather than the group direction's dropped clause — see
 * `coverageDependentEnvelopeOverStayUnionWhere`. Nothing about it is same-owner
 * specific, which is why it lives there; the only thing this function owns is §1's
 * relationship, the exact `Booking.memberId`, spread flat for the reason the source
 * builder documents.
 */
export function sameOwnerCoverageDependentOverStayUnionWhere(
  booking: SameOwnerDependentBooking,
  vacated: { checkIn: Date; checkOut: Date } | null,
): Prisma.BookingWhereInput {
  return {
    ...coverageDependentEnvelopeOverStayUnionWhere(booking, vacated),
    memberId: booking.memberId,
  };
}

/**
 * Whether this dependent needs a queue item OF ITS OWN, or is already reached by
 * the item recorded for the changed booking (#3232, `INV-HOST-049`).
 *
 * THE SECOND HALF OF THE FIX, AND THE HALF THAT IS EASY TO MISS. Widening the read
 * is not enough on its own: the queue item's nights are what the drain turns back
 * into bookings — `loadSameOwnerCoverageDependentIds` reads the owner's bookings at
 * that lodge over exactly that window — so an item carrying the CHANGED booking's
 * new nights resolves to a dependent list that does not contain the booking the
 * change stranded. The refusal would then look fixed and the booking would be
 * dropped in the background instead, with nothing logged. #3039 measured that on
 * the Group Trip path; this is the same trap on the same-owner path.
 *
 * SO THE TEST IS OVERLAP WITH THE CHANGED BOOKING'S CURRENT WINDOW, and it is
 * exact rather than cautious. A dependent that DOES overlap it is already inside
 * the night envelope of the changed booking's own item, so a second item would be
 * duplicate work the drain has to recognise and discard. A dependent that does NOT
 * overlap it is precisely the case the old code lost, and it gets an item naming
 * ITS OWN nights, which is the window over which its compliance can have changed
 * and the window whose drain read is guaranteed to find it.
 *
 * WHAT THIS COSTS A CLUB THAT WAS NEVER BROKEN: nothing. In the ordinary edit every
 * dependent overlaps, so exactly one item is written, exactly as before. Items
 * appear only for the non-overlapping dependents, which is only after a date move,
 * and are capped with the dependent set at `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT`.
 *
 * A ZERO-NIGHT CHANGED BOOKING falls out correctly without a special case: no
 * dependent can overlap an empty half-open window, so every dependent gets its own
 * item — which is right, because the changed booking's item is not written at all
 * (`enqueueHostingCoverageReevaluation` returns null for an empty night list).
 */
export function dependentNeedsOwnQueueItem(
  booking: { checkIn: Date; checkOut: Date },
  dependent: { checkIn: Date; checkOut: Date },
): boolean {
  // THE SHARED PREDICATE, NOT A THIRD SPELLING OF IT. This decision has to agree
  // with the query that found the dependent, whose SQL half is
  // `nightOverlapClause`; writing the two comparisons out here again was one
  // drift away from an item whose window the drain cannot resolve back to this
  // booking (`INV-SSOT-001`).
  return !bookingsOverlap(booking, dependent);
}

/**
 * The officer's explicit confirmation and mandatory reason, as it arrives on the
 * wire (#2576 §7).
 *
 * `acknowledged: z.literal(true)` rather than a boolean, following the house shape
 * the `no-emails` admin route uses: the only value that means anything is `true`, so
 * a client that sends `false` is told its request is malformed rather than having a
 * silent no-op accepted. The reason has a real minimum length because "ok" is not an
 * answer anybody can audit — the same standard D-R4 already applies to a hosting
 * decision and an exception approval.
 *
 * OPTIONAL IN EVERY SHAPE THAT CARRIES IT. A first submission has no override, and
 * that is the normal case: the officer is asked only when the change would actually
 * strand a booking, so demanding the field up front would put a reason prompt in
 * front of every officer edit at an enforcing lodge.
 */
export const hostingCoverageOverrideSchema = z
  .object({
    acknowledged: z.literal(true),
    reason: z.string().trim().min(10).max(500),
    strandedStateKey: z.string().regex(HOSTING_COVERAGE_STATE_KEY_PATTERN),
  })
  .strict();

export type HostingCoverageOverrideInput = z.infer<
  typeof hostingCoverageOverrideSchema
>;

/**
 * Pull the override off an already-parsed request body without making every route
 * restate the shape.
 *
 * Returns `null` for anything that is not a complete, valid override — a missing
 * field, `acknowledged: false`, a too-short reason. Failing to `null` rather than
 * throwing is deliberate: the consequence of an incomplete override is that the
 * officer is ASKED for one, with the affected bookings and nights, which is a better
 * answer than a 400 about a field they have not seen yet.
 */
export function readHostingCoverageOverride(
  body: unknown,
): HostingCoverageOverrideInput | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { hostingCoverageOverride?: unknown })
    .hostingCoverageOverride;
  const parsed = hostingCoverageOverrideSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** One same-owner booking a change would leave without required cover. */
export interface StrandedCoverageBooking {
  bookingId: string;
  /** The short handle the member sees, never the raw cuid alone. */
  reference: string;
  lodgeName: string;
  /** Sorted, unique NZ lodge-nights (YYYY-MM-DD) left uncovered. */
  nights: string[];
  /**
   * This booking's OWN arrival, as a stored lodge night (`YYYY-MM-DD`) — #3232.
   *
   * Distinct from `nights`, which is the subset the rule found uncovered. The
   * linked-move offer has to propose a whole new stay for this booking, and moving
   * only the uncovered part of a partially covered one would split a stay nobody
   * asked to split.
   */
  checkIn: string;
  /** This booking's own checkout — the morning nobody stays (#3232). */
  checkOut: string;
}

/**
 * Bind an officer's second submission to the exact evidence they confirmed.
 *
 * The dependent query is already ordered, but the key is deliberately insensitive
 * to query and night ordering so it represents a SET rather than an implementation
 * detail. The changed source booking id plus each dependent booking id and its exact
 * lodge-nights are the policy identity; references and lodge names are presentation
 * derived from those persisted ids and deliberately do not make a harmless label
 * edit look like a different breach. If the material set moves before the retry
 * reaches the authoritative under-lock read, the key changes and the mutation is
 * refused with a fresh prompt. The digest keeps the wire value fixed-width while
 * the `v1` prefix makes a future material-identity change fail closed.
 */
export function strandedCoverageStateKey(
  stranded: readonly StrandedCoverageBooking[],
  sourceBookingId: string | null = null,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        sourceBookingId,
        stranded: canonicalStrandedRows(stranded),
      }),
    )
    .digest("hex");
  return hostingCoverageStateKeyOf(digest);
}

/**
 * The stranded set reduced to its policy identity: booking ids and their exact
 * lodge-nights, insensitive to query and night ordering.
 *
 * Exported because #3232's linked-move prompt binds the member's acceptance to
 * the same set plus the proposal and the money, and a second hand-written
 * canonicaliser is exactly the drift `INV-SSOT-001` refuses — two keys that
 * disagree about whether a situation changed would let one prompt be answered
 * with the other's evidence.
 */
export function canonicalStrandedRows(
  stranded: readonly StrandedCoverageBooking[],
): Array<{ bookingId: string; nights: string[] }> {
  return stranded
    .map((row) => ({
      bookingId: row.bookingId,
      nights: [...new Set(row.nights)].sort(),
    }))
    .sort((left, right) => {
      if (left.bookingId < right.bookingId) return -1;
      if (left.bookingId > right.bookingId) return 1;
      const leftNights = JSON.stringify(left.nights);
      const rightNights = JSON.stringify(right.nights);
      return leftNights < rightNights ? -1 : leftNights > rightNights ? 1 : 0;
    });
}

/**
 * The advice a refused member is given, and EVERY ACTION IT NAMES IS ONE THEY CAN
 * ACTUALLY TAKE (#3232).
 *
 * IT USED TO OPEN THE DOOR IT HAD JUST LOCKED. The sentence #2576 shipped read
 * "Update the affected booking first, provide alternative qualifying coverage, or
 * contact a Booking Officer for assistance", and the first of those three is
 * impossible. Updating the affected booking means moving it, and moving it is
 * refused by the same rule from the other end — `modify-dates/route.ts` catches
 * `AdultMemberHostingRequiredError` and `REFUSE` is the default enforcement — so a
 * member who wants both of their own bookings on different nights could move
 * NEITHER. The product was instructing people to do something the code forbids,
 * which is worse than saying nothing: they try it, they are refused again with a
 * different message, and they conclude the booking system is broken rather than
 * that they need an officer.
 *
 * THE THIRD CLAUSE IS STILL AN INSTRUCTION, which the rewrite briefly lost. It
 * became "A Booking Officer can also authorise this change and record why" — a
 * true statement about officers, and a dead end, because the member cannot take
 * that override themselves and was told nothing about how to reach anyone. A
 * refusal that names no way forward is the failure this whole sentence exists to
 * avoid.
 *
 * The deadlock itself is fixed elsewhere — a date move that would strand another
 * of the owner's bookings now offers the LINKED MOVE (`INV-HOST-050`) instead of
 * reaching this sentence at all. This sentence is what is left for the strandings a
 * linked move cannot answer: a guest removal, a cancellation, and a date move the
 * shift provably cannot fix (a stay shortened at the tail, where the arrival did
 * not move — see `linkedMoveWouldRestoreCover`). It is NOT what a full lodge
 * reaches: "there are not beds for both" is the offer's own `NO_CAPACITY` arm,
 * which still offers warn-and-continue. So the remedies it names are the ones that
 * work for those: put cover back on the booking that needs it, stop that booking
 * happening, or ask the officer who is the authority the refusal points at.
 *
 * COUNT-DRIVEN, because the dependent cap is `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT`
 * and not one. The singular second sentence sat above a plural "Affected:" list
 * and told a member to add an adult to "that booking" when three were named.
 *
 * NOTHING HERE PROMISES SUCCESS, on purpose. Adding an adult member to another
 * booking can itself be refused (consent, subscription standing, capacity), so the
 * wording offers a direction rather than a guarantee. What it must never do again
 * is name a step that cannot even be attempted.
 */
function strandedCoverageOpening(count: number): string {
  const which =
    count > 1
      ? `${count} other bookings on your account`
      : "another booking on your account";
  const fix =
    count > 1
      ? "Adding a qualifying adult member to those bookings, or cancelling them,"
      : "Adding a qualifying adult member to that booking, or cancelling it,";
  return (
    `This change would leave ${which} without the required adult member ` +
    `coverage for one or more nights. ${fix} would resolve this. A Booking ` +
    `Officer can also authorise this change and record why — contact the club ` +
    `if you would like them to look at it.`
  );
}

/**
 * The member-facing sentence for a refused self-service change (§6).
 *
 * The evidence §6 asks for "where appropriate and safe" follows the advice: the
 * affected booking reference, its lodge and the uncovered dates.
 *
 * SAFE ONLY WHEN THE ACTOR IS THE OWNER, AND THE CALLER MUST HAVE ESTABLISHED
 * THAT. Every booking in this list has the same `Booking.memberId` as the one
 * being CHANGED — that is guaranteed by `sameOwnerCoverageDependentWhere`, which
 * cannot match another account's booking. It does NOT follow that the list is safe
 * to show whoever made the change, and conflating the two is a real disclosure:
 * the guest DELETE route deliberately admits a member from ANOTHER account (a
 * member-linked guest removing their own row, `booking-guest-removal-service.ts`'s
 * `isSelfRemoval`), so an actor who is not the owner can reach a refusal about the
 * owner's other booking. §6 and §11 both forbid that in as many words: "do not
 * expose information from a booking belonging to another account."
 *
 * `settleSameOwnerDependentCoverage` therefore raises this refusal only after
 * checking that the acting member IS the booking owner, and escalates instead of
 * refusing for any other actor. That check is the precondition of this function;
 * it is not re-derivable here, because nothing in the stranded rows records who
 * asked. No person is ever named either way: not the covering adult member, not a
 * guest. The owner is told which of their bookings, which lodge and which nights,
 * which is exactly what they need to fix it.
 */
export function formatStrandedCoverageMessage(
  stranded: readonly StrandedCoverageBooking[],
): string {
  const opening = strandedCoverageOpening(stranded.length);
  if (stranded.length === 0) return opening;

  const detail = stranded
    .map(
      (row) =>
        `booking ${row.reference} at ${row.lodgeName} on ` +
        `${row.nights.join(", ")}`,
    )
    .join("; ");
  return `${opening} Affected: ${detail}.`;
}

/**
 * The refusal an ordinary member self-service change raises when it would strand
 * another same-owner booking's cover (§6).
 *
 * 409 AND NOT 403, for the same reason `AdultMemberHostingRequiredError` is: the
 * member is permitted to make this change, and a Booking Officer may authorise it
 * outright (§7) — what conflicts is the state of the other booking. It is thrown
 * from INSIDE the caller's transaction, after the change has been written and
 * evaluated against the resulting rows, so the throw rolls the change back and
 * the member's booking is left exactly as it was.
 *
 * DELIBERATELY NOT AN EXCEPTION-DOOR REFUSAL, and this is the one place it
 * differs from its hosting sibling. The #2365 exception workflow decides whether
 * a PROPOSED party may breach the hosting rule; this refusal is about a DIFFERENT
 * booking that is already confirmed and already compliant. The way out the owner
 * specified is the concrete actions in the message — put cover back on the
 * affected booking, cancel it, or ask an officer — not a policy-exception
 * request against the booking being changed. `exceptionEligible` is therefore
 * absent rather than false: this refusal never enters exception review, so it
 * carries no aggregated review shape to mislead a client into offering one.
 */
export class SameOwnerCoverageWouldBreakError extends ApiError {
  readonly code = "SAME_OWNER_COVERAGE_WOULD_BREAK";
  readonly stranded: readonly StrandedCoverageBooking[];
  /**
   * True when a LINKED MOVE would answer this, so the member must be OFFERED one
   * rather than refused (#3232, `INV-HOST-050`).
   *
   * SET ONLY WHEN THE STRANDING IS CAUSED BY MOVING AWAY, which is the one case in
   * which every remedy this refusal's own sentence offers is closed to the member.
   * They cannot move the affected booking — the same rule refuses that from the
   * other end — so a refusal here is a deadlock rather than a redirection. A
   * stranding caused by removing a guest, or by a cancellation, leaves them real
   * remedies on the affected booking and is refused exactly as before.
   *
   * WHY A FLAG ON THE REFUSAL RATHER THAN A SEPARATE ERROR TYPE. Because the
   * refusal itself is still correct and still the fallback: the hosting engine
   * cannot build the offer (that needs the pricing engine, which would be an import
   * cycle), so it raises what it has always raised and marks it as answerable. The
   * date writer catches it, prices the linked move and re-throws the offer. If some
   * path ever fails to do that the member gets the bare refusal — worse, but a
   * refusal naming an officer they can ring, never a silent stranding.
   */
  readonly linkedMoveWouldAnswer: boolean;

  constructor(
    stranded: readonly StrandedCoverageBooking[],
    options: { linkedMoveWouldAnswer?: boolean } = {},
  ) {
    super(formatStrandedCoverageMessage(stranded), 409);
    this.name = "SameOwnerCoverageWouldBreakError";
    this.stranded = stranded;
    this.linkedMoveWouldAnswer = options.linkedMoveWouldAnswer === true;
  }
}

/** The member-facing body for the refusal above. */
export function buildSameOwnerCoverageRefusalBody(
  error: SameOwnerCoverageWouldBreakError,
) {
  return {
    error: error.message,
    code: error.code,
    details: error.message,
    // Structured beside the sentence so a client can render its own list
    // without parsing prose. Same-account only — see
    // `formatStrandedCoverageMessage`.
    strandedBookings: error.stranded.map((row) => ({
      bookingId: row.bookingId,
      reference: row.reference,
      lodgeName: row.lodgeName,
      nights: row.nights,
    })),
  };
}

/**
 * The member-facing sentence for the OFFICER's unconfirmed change (#2576 §7).
 *
 * Separate wording from the member's refusal because the answer is different: the
 * officer is not being told to go and fix another booking, they are being told the
 * change is authorised but has to be confirmed and explained first.
 */
export function formatCoverageOverrideRequiredMessage(
  stranded: readonly StrandedCoverageBooking[],
): string {
  const opening =
    "This change would leave another booking on this account without the " +
    "required adult member coverage for one or more nights. It is allowed with " +
    "a Booking Officer override: confirm the change and record a reason. The " +
    "affected booking's lifecycle, existing bed allocation and payment records " +
    "will remain unchanged. If it is already confirmed, it will be raised as an " +
    "urgent hosting-compliance incident; otherwise, it remains subject to the " +
    "hosting check before confirmation.";
  if (stranded.length === 0) return opening;

  const detail = stranded
    .map(
      (row) =>
        `booking ${row.reference} at ${row.lodgeName} on ` +
        `${row.nights.join(", ")}`,
    )
    .join("; ");
  return `${opening} Affected: ${detail}.`;
}

/**
 * The refusal an OFFICER-capable surface raises when their change would strand a
 * dependent booking and they have not confirmed the override (#2576 §7).
 *
 * WHY AN OFFICER IS STOPPED AT ALL, given that §8 lists "authorised officer
 * action" among the changes that "cannot reasonably be blocked". Because §7 is
 * explicit that the override "must require: the appropriate current permission; an
 * explicit confirmation; a mandatory reason; identification of the affected
 * bookings and nights; a full audit event" — and an override that is never asked
 * for cannot carry a confirmation or a reason. This refusal IS the confirmation
 * step: it is not a block on the officer's change, it is a block on the
 * UNCONFIRMED one. The officer re-submits with `hostingCoverageOverride`, the
 * change proceeds, and the incident records who overrode it and why.
 *
 * NOTHING AUTOMATED IS EVER GATED BY IT. Only the surfaces that go through
 * `hostingCoverageActorOptions` with a live officer session can raise it. The cron
 * sweeps, the group-settlement reaper, the payment lifecycle, the Xero inbound
 * effects and the membership sweeps all pass `ESCALATE` and are never refused, so
 * §8's list is honoured exactly.
 *
 * 409 for the same reason its two siblings are: the change is permitted, what
 * conflicts is the state of another booking.
 */
export class SameOwnerCoverageOverrideRequiredError extends ApiError {
  readonly code = "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED";
  readonly stranded: readonly StrandedCoverageBooking[];
  readonly strandedStateKey: string;

  constructor(
    stranded: readonly StrandedCoverageBooking[],
    sourceBookingId: string | null = null,
  ) {
    super(formatCoverageOverrideRequiredMessage(stranded), 409);
    this.name = "SameOwnerCoverageOverrideRequiredError";
    this.stranded = stranded;
    this.strandedStateKey = strandedCoverageStateKey(stranded, sourceBookingId);
  }
}

/**
 * The officer-facing body for the override prompt.
 *
 * `requiresOverrideReason` is the machine-readable flag a client keys on to show
 * the confirmation dialog, rather than having to match on prose. The stranded list
 * is the same shape the member's refusal carries and is safe for this audience for
 * a stronger reason: §11 says administrators "may see the full authorised evidence
 * under existing booking permissions", and this body is only ever produced for an
 * actor who has already passed the officer authorisation gate.
 */
export function buildSameOwnerCoverageOverrideRequiredBody(
  error: SameOwnerCoverageOverrideRequiredError,
) {
  return {
    error: error.message,
    code: error.code,
    details: error.message,
    requiresOverrideReason: true as const,
    strandedStateKey: error.strandedStateKey,
    strandedBookings: error.stranded.map((row) => ({
      bookingId: row.bookingId,
      reference: row.reference,
      lodgeName: row.lodgeName,
      nights: row.nights,
    })),
  };
}

/** The short reference for a stranded booking, so callers share one rendering. */
export function strandedCoverageReference(bookingId: string): string {
  return formatBookingReference(bookingId);
}
