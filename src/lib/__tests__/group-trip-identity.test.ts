// #3037 (epic #2943) — the opt-in Group Trip host scope, and the one canonical
// answer to "which Group Trip does this booking or join belong to?".
//
// Two claims this file exists to hold down, because both are silent when they
// break:
//
//   * THE UPGRADE MOVES NOBODY. `SAME_GROUP_TRIP` defaults OFF, and OFF has to
//     mean OFF at every layer: the built-in scope set, a row that decided the
//     #2569 pair before this column existed, the evaluator's per-night OR, the
//     frozen snapshot's byte order, and the member-facing sentence. A regression
//     here reads as "some other booking started covering mine" in production,
//     which is a cross-account behaviour change nobody switched on.
//   * IDENTITY IS THE TWO CANONICAL COLUMNS. `GroupBooking.organiserBookingId`
//     and `GroupBookingJoin.bookingId` — never `Booking.parentBookingId`, and
//     never gated on the container's own status. Both mistakes produce a sibling
//     set that looks plausible and is wrong.
import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ADULT_MEMBER_HOST_SCOPES,
  type AdultMemberHostScope,
} from "@/lib/booking-policy-exceptions";
import { HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  GROUP_TRIP_IDENTITY_SELECT,
  groupTripCoverageDependentWhere,
  groupTripCoverageSourceWhere,
  groupTripIdentityForJoin,
  groupTripIdentityOf,
  groupTripMembershipWhere,
  sameGroupTrip,
  type GroupTripIdentity,
} from "@/lib/group-trip-identity";
import {
  DEFAULT_ADULT_MEMBER_HOST_SCOPES,
  adultMemberHostingStateKey,
  enabledHostScopeList,
  evaluateAdultMemberHostingWithPolicy,
  formatAdultMemberHostingMessage,
  hostScopeEnabled,
  resolveAdultMemberHostingPolicy,
  type AdultMemberHostingPolicyLike,
  type HostingParticipant,
} from "@/lib/policies/adult-member-hosting";
import { AgeTier } from "@prisma/client";

const GROUP = "group-alpine-weekend";

/** A booking that anchors the Group Trip. */
const organiserRow = {
  groupBookingAsOrganiser: { id: GROUP },
  groupBookingJoin: null,
};

/** A booking created by redeeming that group's join code. */
const joinerRow = {
  groupBookingAsOrganiser: null,
  groupBookingJoin: { groupBookingId: GROUP },
};

/** A perfectly ordinary booking that is in no Group Trip at all. */
const ungroupedRow = {
  groupBookingAsOrganiser: null,
  groupBookingJoin: null,
};

const BOOKING = {
  id: "booking-under-evaluation",
  lodgeId: "lodge-1",
  checkIn: new Date("2026-08-07T00:00:00.000Z"),
  checkOut: new Date("2026-08-09T00:00:00.000Z"),
};

describe("canonical Group Trip identity", () => {
  it("resolves the organiser's own booking to its group", () => {
    expect(groupTripIdentityOf(organiserRow)).toEqual({
      groupBookingId: GROUP,
      role: "ORGANISER",
    });
  });

  it("resolves a joined booking to the same group", () => {
    const organiser = groupTripIdentityOf(organiserRow);
    const joiner = groupTripIdentityOf(joinerRow);
    expect(joiner).toEqual({ groupBookingId: GROUP, role: "JOINER" });
    // The whole point: the two are siblings, and the ROLE is not what decides it.
    expect(sameGroupTrip(organiser, joiner)).toBe(true);
  });

  it("resolves a booking in no Group Trip to null, and null is never a sibling", () => {
    expect(groupTripIdentityOf(ungroupedRow)).toBeNull();
    // Two ungrouped bookings are NOT in "the same (absent) group". Reading null
    // as a joinable identity would make every ungrouped booking at a lodge a
    // cover source for every other one — the lodge-wide scope #2575 removed.
    expect(sameGroupTrip(null, null)).toBe(false);
    expect(sameGroupTrip(groupTripIdentityOf(organiserRow), null)).toBe(false);
  });

  it("is unchanged when the container is CLOSED or CANCELLED", () => {
    // A CLOSED container is the normal state of a trip whose party is settled; a
    // CANCELLED one does not cancel the joiners' own bookings. Neither says the
    // adults on those bookings stopped travelling, so neither may change the
    // answer. Structurally: the identity select does not read the container's
    // status at all, so there is nothing for a status to change.
    const selected = JSON.stringify(GROUP_TRIP_IDENTITY_SELECT);
    expect(selected).not.toContain("status");
    expect(selected).not.toContain("joinCode");
    expect(GROUP_TRIP_IDENTITY_SELECT).toEqual({
      groupBookingAsOrganiser: { select: { id: true } },
      groupBookingJoin: { select: { groupBookingId: true } },
    });
  });

  it("carries identity for a join whose booking does not exist yet", () => {
    // The pre-persist case the contract names. A member join is created inside
    // the booking transaction and a non-member join holds a GroupBookingJoin row
    // with a NULL bookingId until the joiner confirms their email — so in both
    // cases the hosting rule has to be answered before there is a Booking to
    // resolve. The group id is already known, because the joiner redeemed its
    // join code, and it is the same id the persisted row will carry.
    const proposed = groupTripIdentityForJoin({ groupBookingId: GROUP });
    expect(proposed).toEqual({ groupBookingId: GROUP, role: "JOINER" });
    expect(sameGroupTrip(proposed, groupTripIdentityOf(organiserRow))).toBe(
      true,
    );
    expect(sameGroupTrip(proposed, groupTripIdentityOf(joinerRow))).toBe(true);
  });

  it("treats a row that names neither relation as ungrouped", () => {
    // A booking that really is in no Group Trip: both relations present and
    // null. It supplies and consumes no cross-booking cover, so the rule falls
    // back to exactly its pre-#3037 answer.
    expect(
      groupTripIdentityOf({
        groupBookingAsOrganiser: null,
        groupBookingJoin: null,
      }),
    ).toBeNull();
  });

  it("refuses at COMPILE TIME a row that simply omitted the select", () => {
    // The distinction the row type exists to draw, and why the fields are
    // required-and-nullable rather than optional. "In no Group Trip" is data and
    // is the test above. "I forgot GROUP_TRIP_IDENTITY_SELECT" is a WIRING BUG,
    // and resolving it silently to "no Group Trip" is only safe in one of the two
    // directions this module serves: a source read errs towards flagging, but a
    // DEPENDENT read that misses a booking means nobody reconciles a genuinely
    // stranded one. So the omission is a type error instead of a quiet answer.
    // @ts-expect-error — a row that omits the relations is not a GroupTripIdentityRow.
    groupTripIdentityOf({});
    // @ts-expect-error — half of the select is still an omission.
    groupTripIdentityOf({ groupBookingJoin: null });
  });
});

describe("the sibling sets the later children read", () => {
  const identity: GroupTripIdentity = { groupBookingId: GROUP, role: "JOINER" };

  it("selects the group through both canonical relations and nothing else", () => {
    expect(groupTripMembershipWhere(identity)).toEqual({
      OR: [
        { groupBookingAsOrganiser: { is: { id: GROUP } } },
        { groupBookingJoin: { is: { groupBookingId: GROUP } } },
      ],
    });
  });

  it("builds the cover-source set from group, lodge, booking status and overlap", () => {
    // Asserted as the whole object rather than clause by clause, because the
    // claim is as much about what is ABSENT as about what is present: no
    // GroupBooking status gate, no parentBookingId, no owner column, nothing
    // that could widen the read beyond one travelling party.
    expect(groupTripCoverageSourceWhere(BOOKING, identity)).toEqual({
      AND: [
        // The shared envelope, which SAME_BOOKING_OWNER builds from the same
        // function — so the two scopes cannot drift to different lodge, date or
        // lifecycle rules while one evaluator ORs them per night.
        {
          status: { in: [...HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES] },
          deletedAt: null,
          lodgeId: BOOKING.lodgeId,
          id: { not: BOOKING.id },
          checkIn: { lt: BOOKING.checkOut },
          checkOut: { gt: BOOKING.checkIn },
        },
        // This scope's own relationship, and the only clause it owns.
        {
          OR: [
            { groupBookingAsOrganiser: { is: { id: GROUP } } },
            { groupBookingJoin: { is: { groupBookingId: GROUP } } },
          ],
        },
      ],
    });
  });

  it("drops the self-exclusion when the booking is not persisted yet", () => {
    const where = groupTripCoverageSourceWhere(
      { ...BOOKING, id: null },
      identity,
    );
    const clauses = where.AND as Record<string, unknown>[];
    expect(clauses[0]).not.toHaveProperty("id");
    // Everything else is identical: the pre-persist read is the same read, minus
    // an exclusion of a row that cannot exist.
    expect(clauses[0]).toEqual({
      status: { in: [...HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES] },
      deletedAt: null,
      lodgeId: BOOKING.lodgeId,
      checkIn: { lt: BOOKING.checkOut },
      checkOut: { gt: BOOKING.checkIn },
    });
  });

  it("keeps the dependent set on the wider active statuses", () => {
    const where = groupTripCoverageDependentWhere(BOOKING, identity);
    const clauses = where.AND as Record<string, unknown>[];
    const envelope = clauses[0] as {
      status: { in: BookingStatus[] };
      deletedAt: null;
      id: unknown;
    };
    // A dependent is any booking the rule would JUDGE, which includes bookings
    // that cannot themselves supply cover — they still need it. So this set is
    // strictly wider than the source set above, and asserting that relationship
    // is what stops somebody "tidying" the two into one constant.
    const statuses = envelope.status.in;
    expect(statuses).toEqual(expect.arrayContaining([BookingStatus.CONFIRMED]));
    expect(statuses).toContain(BookingStatus.PAYMENT_PENDING);
    expect(statuses).not.toContain(BookingStatus.CANCELLED);
    expect(envelope.deletedAt).toBeNull();
    expect(envelope.id).toEqual({ not: BOOKING.id });
    expect(clauses[1]).toEqual(groupTripMembershipWhere(identity));
  });

  it("composes the dependent set under AND, so no OR can swallow another", () => {
    // THE BUG THIS PINS. The membership clause IS an `OR`, and this builder used
    // to spread it flat beside the envelope's own keys. Any `OR` the envelope
    // ever grows — a widened dependent cohort, a soft-delete variant — would then
    // have replaced group membership outright, and the failure is silent: the
    // fan-out becomes EVERY active booking at that lodge on those nights, which
    // is exactly the lodge-wide sweep #2575 rejected. The source builder already
    // composed under `AND`; this asserts both do.
    const where = groupTripCoverageDependentWhere(BOOKING, identity);
    expect(Object.keys(where)).toEqual(["AND"]);
    expect(where.OR).toBeUndefined();
    expect(
      Object.keys(groupTripCoverageSourceWhere(BOOKING, identity)),
    ).toEqual(["AND"]);
  });

  it("excludes a sibling at another lodge or on non-overlapping nights", () => {
    // Both are envelope clauses rather than the coverage rule, but getting either
    // wrong is a cross-lodge or cross-week cover claim: an adult at Lodge A on
    // Friday cannot supervise Lodge B on Friday.
    const where = groupTripCoverageSourceWhere(BOOKING, identity);
    const envelope = (where.AND as Record<string, unknown>[])[0];
    expect(envelope.lodgeId).toBe("lodge-1");
    // Half-open: a source arriving on this booking's checkout morning shares no
    // night with it.
    expect(envelope.checkIn).toEqual({ lt: BOOKING.checkOut });
    expect(envelope.checkOut).toEqual({ gt: BOOKING.checkIn });
  });
});

// ---------------------------------------------------------------------------
// Disabled-scope equivalence — the release invariant the epic names first.
// ---------------------------------------------------------------------------

function policyRow(
  overrides: Partial<AdultMemberHostingPolicyLike> = {},
): AdultMemberHostingPolicyLike {
  return {
    id: "club-policy",
    scopeKey: "club-wide",
    lodgeId: null,
    mode: "ADMIN_REVIEW_REQUIRED",
    capacityMode: "NO_HOLD",
    version: 7,
    hostScopeSameBooking: null,
    hostScopeSameBookingOwner: null,
    hostScopeSameGroupTrip: null,
    ...overrides,
  };
}

function nonMemberGuest(guestRef: string, nights: string[]): HostingParticipant {
  return { guestRef, guestName: `Guest ${guestRef}`, member: null, nights };
}

function adultHost(
  guestRef: string,
  nights: string[],
  extra: Partial<HostingParticipant> = {},
): HostingParticipant {
  return {
    guestRef,
    guestName: `Member ${guestRef}`,
    member: {
      id: `member-${guestRef}`,
      ageTier: AgeTier.ADULT,
      active: true,
      cancelledAt: null,
      archivedAt: null,
    },
    nights,
    ...extra,
  };
}

describe("SAME_GROUP_TRIP is off until a club turns it on", () => {
  it("is off in the built-in default", () => {
    const rule =
      "INV-HOST-047 (docs/invariants/adult-member-hosting.md): SAME_GROUP_TRIP " +
      "is OFF unless a club turns it on, and it is APPENDED to " +
      "ADULT_MEMBER_HOST_SCOPES rather than inserted. enabledHostScopeList " +
      "sorts frozen violation snapshots through that constant, so widening the " +
      "default or reordering the list rewrites the bytes of snapshots nobody " +
      "edited and reopens decided reviews.";
    expect(DEFAULT_ADULT_MEMBER_HOST_SCOPES.sameGroupTrip, rule).toBe(false);
    expect(
      hostScopeEnabled(DEFAULT_ADULT_MEMBER_HOST_SCOPES, "SAME_GROUP_TRIP"),
      rule,
    ).toBe(false);
    // And the default set still lists exactly the one scope it always listed, so
    // a snapshot frozen for a club that changed nothing carries the same bytes.
    expect(
      enabledHostScopeList(DEFAULT_ADULT_MEMBER_HOST_SCOPES),
      rule,
    ).toEqual(["SAME_BOOKING"]);
  });

  it("is off for a row that decided the #2569 pair before this column existed", () => {
    // THE BLUE/GREEN SHAPE, and the one this whole design turns on. The pair is
    // set and the new column is NULL — which is every row written by a draining
    // previous colour, and every row that predates the migration. That row must
    // still read as an EXPLICIT set (its own decision, not the club default) with
    // Group Trip cover simply off.
    const resolved = resolveAdultMemberHostingPolicy(
      [
        policyRow({
          hostScopeSameBooking: true,
          hostScopeSameBookingOwner: true,
          hostScopeSameGroupTrip: null,
        }),
      ],
      "lodge-1",
    );
    expect(
      resolved.hostScopes,
      "INV-HOST-048 (docs/invariants/adult-member-hosting.md): the Group Trip " +
        "column is outside the all-or-none CHECK, and NULL on a row that DID " +
        "decide the #2569 pair means OFF rather than inherit. Reading it as " +
        "inherit would make every pre-migration and every previous-colour row " +
        "fall back to the club default — a scope set nobody chose.",
    ).toEqual({
      sameBooking: true,
      sameBookingOwner: true,
      sameGroupTrip: false,
    });
    // CLUB_WIDE, not BUILT_IN_DEFAULT: the row decided, and folding the new
    // column into that test would silently drop the club's saved scope set.
    expect(resolved.hostScopeSource).toBe("CLUB_WIDE");
  });

  it("counts no group host while the scope is off, and counts one when it is on", () => {
    // The seam #3038 arrives through: a cross-booking adult enters as a stamped
    // host-only participant, and the evaluator counts it ONLY where the club has
    // that scope switched on. Same facts, two policies, two answers.
    const participants: HostingParticipant[] = [
      nonMemberGuest("g1", ["2026-08-07", "2026-08-08"]),
      adultHost("sibling", ["2026-08-07", "2026-08-08"], {
        hostOnly: true,
        hostScope: "SAME_GROUP_TRIP",
      }),
    ];

    const off = resolveAdultMemberHostingPolicy([policyRow()], "lodge-1");
    const refusedWhileOff = evaluateAdultMemberHostingWithPolicy(
      participants,
      off,
    );
    expect(refusedWhileOff).not.toBeNull();
    expect(
      refusedWhileOff!.requirements.uncoveredNonMemberGuestNights,
    ).toBe(2);
    expect(refusedWhileOff!.requirements.enabledHostScopes).toEqual([
      "SAME_BOOKING",
    ]);

    const on = resolveAdultMemberHostingPolicy(
      [
        policyRow({
          hostScopeSameBooking: true,
          hostScopeSameBookingOwner: false,
          hostScopeSameGroupTrip: true,
        }),
      ],
      "lodge-1",
    );
    expect(evaluateAdultMemberHostingWithPolicy(participants, on)).toBeNull();
  });

  it("leaves the same-booking answer byte-identical while the scope is off", () => {
    // The migration promise reaching as far as the words the member reads. This
    // is the exact string the review-mode branch produced before #3037, and it is
    // reproduced here as a literal rather than by calling the formatter twice,
    // so a change to the formatter fails HERE rather than agreeing with itself.
    expect(
      formatAdultMemberHostingMessage(
        2,
        2,
        "ADMIN_REVIEW_REQUIRED",
        DEFAULT_ADULT_MEMBER_HOST_SCOPES,
      ),
    ).toBe(
      "This club asks that an adult member stays on the same booking as any " +
        "non-member guest. On 2 nights of this booking, 2 guest nights have no " +
        "adult member staying, so an admin needs to look at it.",
    );
  });

  it("stops using that branch the moment a club turns the scope ON", () => {
    // The CONTROL for the assertion above. The short same-booking-only sentence
    // is correct only while every wider scope is off; a club that enabled Group
    // Trip cover and is still told "an adult member stays on the same booking"
    // has been told the wrong rule, and would go and fix the wrong thing.
    const message = formatAdultMemberHostingMessage(2, 2, "ADMIN_REVIEW_REQUIRED", {
      sameBooking: true,
      sameBookingOwner: false,
      sameGroupTrip: true,
    });
    expect(message).toContain("in the same Group Trip");
    expect(message).not.toContain("stays on the same booking as any");
    // Named without naming anybody: no organiser, no booking reference, no
    // member. The other booking may belong to a different account, and this
    // sentence is rendered straight back to whoever was refused.
    expect(message).not.toMatch(/organiser/i);
  });

  it("leaves the frozen snapshot's material identity untouched", () => {
    // `adultMemberHostingStateKey` decides whether an officer's decided review
    // reopens and whether a fresh loss-of-cover email goes out. A club that
    // changed nothing must produce the same key it always did, or every open
    // review reopens on deploy day.
    const resolved = resolveAdultMemberHostingPolicy([policyRow()], "lodge-1");
    const violation = evaluateAdultMemberHostingWithPolicy(
      [nonMemberGuest("g1", ["2026-08-07"])],
      resolved,
    )!;
    expect(adultMemberHostingStateKey(violation)).toBe(
      "club-policy|7|2026-08-07 g1",
    );
  });

  it("keeps the scope list appended rather than reordered", () => {
    // `enabledHostScopeList` filters through this constant, and the result is
    // frozen onto violation snapshots that two evaluations must produce
    // byte-identically. Appending is safe; inserting ahead of an existing value
    // rewrites snapshots nobody edited.
    expect([...ADULT_MEMBER_HOST_SCOPES]).toEqual([
      "SAME_BOOKING",
      "SAME_BOOKING_OWNER",
      "SAME_GROUP_TRIP",
    ]);
    expect(ADULT_MEMBER_HOST_SCOPES.indexOf("SAME_GROUP_TRIP")).toBe(
      ADULT_MEMBER_HOST_SCOPES.length - 1,
    );
    // And every scope is answerable, with no silent default: an unmapped value
    // would fall through `hostScopeEnabled`'s switch and read as `undefined`,
    // which is falsy — a scope that is on but never counts.
    for (const scope of ADULT_MEMBER_HOST_SCOPES) {
      expect(
        hostScopeEnabled(
          {
            sameBooking: true,
            sameBookingOwner: true,
            sameGroupTrip: true,
          },
          scope as AdultMemberHostScope,
        ),
      ).toBe(true);
    }
  });
});
