import { Prisma } from "@prisma/client";

import {
  coverageDependentEnvelopeAcrossNightsWhere,
  coverageEnvelopeWhere,
  type CoverageEnvelopeBooking,
} from "@/lib/adult-member-hosting-coverage-envelope";

/**
 * The one answer to "which Group Trip does this booking or join belong to?"
 * (#3037, epic #2943).
 *
 * Deliberately I/O-free — one `select` fragment, one resolver, one comparison and
 * two Prisma `where` builders. The reads themselves belong to the modules that
 * already own them (`adult-member-hosting-review.ts` turns a persisted booking
 * into evaluator input; `adult-member-hosting-proposed.ts` does the same for a
 * party that has no rows yet), and keeping this module read-free is what lets
 * BOTH of them, plus the reconciliation writers of #3039 and the kiosk payloads
 * of #3040, share one definition without an import cycle.
 *
 * ## Three rules this module exists to state once
 *
 * **1. GROUP IDENTITY IS `GroupBooking.organiserBookingId` AND
 * `GroupBookingJoin.bookingId`, AND NOTHING ELSE.** Emphatically NOT
 * `Booking.parentBookingId`. That column is the #738 split-booking relationship —
 * one party the database stores as a member row plus a linked non-member child —
 * and it is neither necessary nor sufficient for Group Trip membership: two
 * bookings in one Group Trip have no `parentBookingId` link at all, and a split
 * pair that is in no Group Trip has one. Reading grouping off it would produce a
 * sibling set that is wrong in both directions, which is why the owner's contract
 * names the two authoritative columns and forbids that one. Nothing in this file
 * mentions `parentBookingId`, and `adult-member-hosting-call-sites.test.ts`
 * asserts that — reading this module off disk, alongside its census of every
 * other hosting call site. (`group-trip-identity.test.ts` is the behavioural
 * suite and makes no such claim; the attribution here used to name it, which is
 * the kind of docblock promise `INV-SSOT` treats as a contract.)
 *
 * **2. THE CONTAINER'S STATUS GOVERNS JOINING, NOT COVER.** `GroupBooking.status`
 * (`OPEN` / `CLOSED` / `CANCELLED`) decides whether NEW bookings may join the
 * group. It says nothing about whether the adults on the bookings that already
 * joined are still travelling — a `CLOSED` group is the normal state of a trip
 * whose party is settled, and an organiser cancelling the container does not
 * cancel the joiners' own bookings. So `GroupBooking.status` is absent from both
 * builders below, on purpose: filtering on it would silently strip cover from
 * live, compliant bookings whose party has not changed at all. Whether a given
 * booking is really happening is decided where it always was — on
 * `Booking.status`, through `hostingCoverageSourceBookingFilter`.
 *
 * **3. THE PAID-UP-ADULT LOCKOUT IS A DIFFERENT RULE AND STAYS PER-BOOKING.**
 * `PAID_UP_ADULT_MEMBER_REQUIRED` (#2543) asks whether THIS booking's own party
 * contains a paid-up adult member. It is party-level, it is not per-night, and it
 * is not a cover-source question, so nothing here widens it across a Group Trip.
 * This module supplies group identity to the hosting rule only.
 */

/** Which end of the Group Trip relationship a booking sits on. */
export type GroupTripRole = "ORGANISER" | "JOINER";

/**
 * A booking's Group Trip membership: the container it belongs to, and how.
 *
 * `groupBookingId` is the whole identity — two bookings are in the same Group
 * Trip exactly when this id matches. `role` carries no policy weight at all in
 * the hosting rule (an organiser's adults and a joiner's adults are equally
 * admissible), and exists because #3040 needs to know which booking is the
 * organiser's in order to keep organiser identity OUT of the ordinary
 * staying-guest tier.
 */
export interface GroupTripIdentity {
  groupBookingId: string;
  role: GroupTripRole;
}

/**
 * The Booking `select` fragment that carries canonical Group Trip identity.
 *
 * Spread into a narrow select rather than re-typed at each call site, because
 * Prisma does NOT typecheck `select` keys through the hand-written
 * `Pick<PrismaClient, ...>` interfaces the hosting paths use: a column or relation
 * name that drifts from the schema is a runtime validation failure on a booking
 * write path with a green typecheck. One constant means one place to be right,
 * and `adult-member-hosting-call-sites.test.ts` reads `prisma/schema.prisma` to
 * prove it still is — which is a claim this docblock made before anything
 * checked it, the identity suite having only compared the constant with a copy
 * of itself.
 *
 * `joinCode` IS NEVER SELECTED HERE, and must never be added. It is the group's
 * join credential; the epic's privacy contract keeps it out of every payload and
 * every tier, and identity resolution has no use for it.
 */
export const GROUP_TRIP_IDENTITY_SELECT = {
  groupBookingAsOrganiser: { select: { id: true } },
  groupBookingJoin: { select: { groupBookingId: true } },
} as const;

/**
 * What `GROUP_TRIP_IDENTITY_SELECT` produces, as a structural type.
 *
 * BOTH FIELDS ARE REQUIRED, and nullable rather than optional. Nullable is the
 * DATA: a booking in no Group Trip has neither relation. Optional would be
 * something else entirely — permission for a caller to omit the `select` — and
 * omitting it resolves to "no Group Trip" SILENTLY.
 *
 * That direction is safe for a coverage SOURCE (a booking wrongly read as
 * ungrouped supplies no cross-booking cover, so the rule falls back to its
 * pre-#3037 answer) and it is the WRONG direction for a DEPENDENT, which this
 * same module builds: a booking wrongly read as ungrouped is a booking nobody
 * re-evaluates, so a genuinely stranded booking is never reconciled and never
 * escalated. One module cannot make the omission safe in both directions, so it
 * makes the omission IMPOSSIBLE instead: with the fields required, a call site
 * that forgot `GROUP_TRIP_IDENTITY_SELECT` is a compile error rather than a
 * quiet wrong answer. Unrepresentable beats policed (`INV-SSOT`).
 */
export interface GroupTripIdentityRow {
  groupBookingAsOrganiser: { id: string } | null;
  groupBookingJoin: { groupBookingId: string } | null;
}

/**
 * The Group Trip a loaded booking belongs to, or `null` for a booking in none.
 *
 * A booking cannot be both ends of the relationship: `GroupBooking` has a UNIQUE
 * `organiserBookingId` and `GroupBookingJoin` a UNIQUE `bookingId`, and the
 * organiser's booking is never also a join row. Should both ever be present the
 * ORGANISER link wins — it is the stronger of the two, being the row that defines
 * the container — and the answer is still one deterministic group rather than a
 * throw, because the hosting rule must not become unevaluatable for a data shape
 * the database is meant to prevent.
 */
export function groupTripIdentityOf(
  row: GroupTripIdentityRow,
): GroupTripIdentity | null {
  const organised = row.groupBookingAsOrganiser;
  if (organised) {
    return { groupBookingId: organised.id, role: "ORGANISER" };
  }
  const join = row.groupBookingJoin;
  if (join) {
    return { groupBookingId: join.groupBookingId, role: "JOINER" };
  }
  return null;
}

/**
 * Group Trip identity for a join whose Booking does not exist yet — the
 * PRE-PERSIST case the contract calls out by name.
 *
 * Both join paths need it, and neither can go through `groupTripIdentityOf`:
 *
 *  - a MEMBER join is created inside the booking transaction, so at the moment
 *    the hosting rule has to be answered (before the write, because the answer
 *    decides whether the member must supply a justification and whether the
 *    booking may be confirmed at all) there is no `Booking` row and no
 *    `GroupBookingJoin.bookingId`;
 *  - a NON-MEMBER join has a `GroupBookingJoin` row from the verify handshake,
 *    holding the contact and guest snapshot with `bookingId` still NULL until the
 *    joiner confirms their email.
 *
 * In both cases the joiner is joining a Group Trip whose id is already known and
 * already authoritative — it came from the join code they redeemed — so identity
 * is available strictly earlier than the booking is. Taking it from the container
 * rather than from the not-yet-written booking is what makes a pre-persist
 * evaluation possible at all, and it is exactly as canonical as the persisted
 * answer: the row this join becomes will carry the same `groupBookingId`.
 *
 * `role` is `JOINER` unconditionally, because an ORGANISER's booking has no
 * pre-persist group identity to resolve: the `GroupBooking` is created with the
 * organiser's booking in one transaction, so before that transaction there is no
 * container, and after it there are no siblings yet either.
 */
export function groupTripIdentityForJoin(join: {
  groupBookingId: string;
}): GroupTripIdentity {
  return { groupBookingId: join.groupBookingId, role: "JOINER" };
}

/** Whether two bookings are in the same Group Trip. `null` is never equal. */
export function sameGroupTrip(
  left: GroupTripIdentity | null,
  right: GroupTripIdentity | null,
): boolean {
  if (left === null || right === null) return false;
  return left.groupBookingId === right.groupBookingId;
}

/**
 * The membership clause on its own: bookings that ARE this Group Trip.
 *
 * The organiser's booking plus every booking a join row points at, expressed
 * through the two canonical relations and nothing else. Exported so a caller that
 * needs group membership WITHOUT the lodge/date/status envelope below — a
 * reconciliation fan-out, a kiosk linkage read — composes this rather than
 * writing the relation filter a third time.
 *
 * `is:` is written explicitly on both to-one relations. Prisma infers it, but the
 * inferred form reads like a scalar-equality filter and the two mean different
 * things on a nullable relation, so the explicit spelling is the one that stays
 * correct when somebody edits it.
 */
export function groupTripMembershipWhere(
  identity: GroupTripIdentity,
): Prisma.BookingWhereInput {
  return {
    OR: [
      { groupBookingAsOrganiser: { is: { id: identity.groupBookingId } } },
      { groupBookingJoin: { is: { groupBookingId: identity.groupBookingId } } },
    ],
  };
}

/**
 * The booking being evaluated, as the two builders below need it.
 *
 * The shared envelope's own input type under this module's name, so a Group Trip
 * caller has one import rather than two and the two scopes cannot drift to
 * different notions of "the booking being evaluated". Its `id` is nullable ON
 * PURPOSE — see `CoverageEnvelopeBooking` for why the pre-persist paths need
 * that.
 */
export type GroupTripCoverageBooking = CoverageEnvelopeBooking;

/**
 * Bookings whose attendance may cover `booking`'s non-member guest-nights under
 * `SAME_GROUP_TRIP`.
 *
 * ONE RELATIONSHIP CLAUSE INSIDE THE SHARED ENVELOPE. The Group Trip membership
 * clause is this scope's own (§1); everything else — the same lodge, not this
 * booking, an overlapping half-open date range and the eligible-source lifecycle
 * filter — is `coverageEnvelopeWhere`, the same function `SAME_BOOKING_OWNER`
 * calls. The two scopes are OR-ed per night by ONE evaluator, so a scope with its
 * own quietly different lodge, date or status rules would be a second definition
 * of coverage. That symmetry used to be two copies plus a docblock asking
 * somebody to keep them equal, which is the arrangement `INV-SSOT-002` refuses.
 *
 * Note what the lifecycle filter is NOT: it is `Booking.status`, never
 * `GroupBooking.status` (§2).
 *
 * WHY THIS IS BOUNDED. `GroupBookingJoin` is indexed on `groupBookingId` and
 * `GroupBooking.organiserBookingId` is unique, so the relation clause resolves to
 * one trip's bookings — the size of a travelling party, and capped further by the
 * group's own `maxJoiners` where the organiser set one. It is emphatically not the
 * lodge-wide sweep #2575 rejected: no clause here can match a booking that is not
 * in this Group Trip.
 *
 * WHAT IT DOES NOT DECIDE. Membership is not hosting. WHO may host is settled
 * afterwards by the shared evaluator's own `participantQualifiesAsHost`, and a
 * sibling booking supplies nothing unless a qualifying adult member is actually
 * recorded as attending the relevant lodge-night. There is deliberately no second
 * definition of a qualifying adult member here.
 */
export function groupTripCoverageSourceWhere(
  booking: GroupTripCoverageBooking,
  identity: GroupTripIdentity,
  options: { historical?: boolean } = {},
): Prisma.BookingWhereInput {
  // Composed with `AND` rather than spread flat, unlike its same-owner sibling.
  // The membership clause is an `OR`, and the envelope is a helper this module
  // does not own: were either to carry an `OR` at the same level, a flat spread
  // would silently keep only the last — dropping the lifecycle filter would admit
  // cancelled bookings as cover, and dropping the membership filter would admit
  // the whole lodge. `AND` cannot lose a clause that way.
  return {
    AND: [
      coverageEnvelopeWhere(booking, options),
      groupTripMembershipWhere(identity),
    ],
  };
}

/**
 * Bookings whose own compliance may DEPEND on `booking`'s attendance — the set
 * #3039 has to re-evaluate when this booking's rows change.
 *
 * The mirror of the source builder: the same membership clause, wrapped in
 * `coverageDependentEnvelopeAcrossNightsWhere` instead. That envelope carries two
 * deliberate differences from the source side, both stated once at their
 * definition: the wider `ACTIVE_BOOKING_STATUSES` cohort, because the rule judges a
 * `PAYMENT_PENDING` or `AWAITING_REVIEW` booking too, and the deliberately absent
 * guest-composition filter.
 *
 * AND ONE SUBTRACTION, WHICH IS THE THIRD: NO NIGHT-OVERLAP CLAUSE. Every writer
 * calls the hosting seam AFTER it has written the booking, so `booking.checkIn` and
 * `booking.checkOut` here are the POST-change dates. A dependent that was relying
 * on this booking over its OLD dates would fail an overlap test against the new
 * ones and drop out of the set entirely — no item, no re-evaluation, no incident,
 * no notice — which is precisely the stranding this rule exists to catch. Booking A
 * carries the trip's only qualifying adult on nights 10-11, booking B on another
 * account is compliant only through this scope, A moves to nights 20-21, and B
 * stays marked compliant forever. So the dependent direction asks "is this booking
 * in the same trip at the same lodge and still live", and lets the per-dependent
 * re-evaluation decide the rest. Over-wide costs one idempotent re-read per extra
 * row; too narrow loses a stranded booking silently. The SOURCE builder above keeps
 * its night clause, because it answers "who is covering these nights" about a
 * booking whose dates are the ones being asked about.
 *
 * `AND`, NEVER A FLAT SPREAD, and here that is not hypothetical. The membership
 * clause IS an `OR` today, so spreading it beside an envelope that ever grew an
 * `OR` of its own would drop group membership outright and turn #3039's
 * reconciliation fan-out into every active booking at the lodge on those nights.
 * The source builder above already composed under `AND` for exactly this reason;
 * this one used to spread flat, which is the hazard its sibling's comment
 * describes and this one did not follow.
 *
 * AND STILL NO `GroupBooking.status` (§2). Closing or cancelling the container
 * changes no booking's cover, so it must not change who is re-evaluated either —
 * a dependent dropped because its container closed is a dependent nobody
 * reconciles.
 */
export function groupTripCoverageDependentWhere(
  booking: GroupTripCoverageBooking,
  identity: GroupTripIdentity,
): Prisma.BookingWhereInput {
  return {
    AND: [
      coverageDependentEnvelopeAcrossNightsWhere(booking),
      groupTripMembershipWhere(identity),
    ],
  };
}
