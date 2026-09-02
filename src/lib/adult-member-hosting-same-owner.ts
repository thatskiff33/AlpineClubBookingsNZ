import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  coverageDependentEnvelopeWhere,
  coverageEnvelopeWhere,
} from "@/lib/adult-member-hosting-coverage-envelope";
import { ApiError } from "@/lib/api-error";
import { formatBookingReference } from "@/lib/booking-reference";

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
 */
export function sameOwnerCoverageDependentWhere(booking: {
  id: string;
  memberId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
}): Prisma.BookingWhereInput {
  return {
    ...coverageDependentEnvelopeWhere(booking),
    memberId: booking.memberId,
  };
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
    strandedStateKey: z.string().regex(/^v1:[0-9a-f]{64}$/),
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
  const canonical = stranded
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
  const digest = createHash("sha256")
    .update(JSON.stringify({ sourceBookingId, stranded: canonical }))
    .digest("hex");
  return `v1:${digest}`;
}

/**
 * The member-facing sentence for a refused self-service change (§6).
 *
 * The owner supplied the first sentence verbatim and it is used verbatim. What
 * follows is the evidence §6 asks for "where appropriate and safe": the affected
 * booking reference, its lodge and the uncovered dates.
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
  const opening =
    "This change would leave another booking on your account without the " +
    "required adult member coverage for one or more nights. Update the " +
    "affected booking first, provide alternative qualifying coverage, or " +
    "contact a Booking Officer for assistance.";
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
 * specified is the three concrete actions in the message — amend the affected
 * booking, restore alternative cover, or ask an officer — not a policy-exception
 * request against the booking being changed. `exceptionEligible` is therefore
 * absent rather than false: this refusal never enters exception review, so it
 * carries no aggregated review shape to mislead a client into offering one.
 */
export class SameOwnerCoverageWouldBreakError extends ApiError {
  readonly code = "SAME_OWNER_COVERAGE_WOULD_BREAK";
  readonly stranded: readonly StrandedCoverageBooking[];

  constructor(stranded: readonly StrandedCoverageBooking[]) {
    super(formatStrandedCoverageMessage(stranded), 409);
    this.name = "SameOwnerCoverageWouldBreakError";
    this.stranded = stranded;
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
