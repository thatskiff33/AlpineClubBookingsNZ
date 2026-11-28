// D-8's FOURTH collapsing refusal — the membership-type booking policy.
//
// Finding 2 of the MG3 (#2308) privacy re-review. MG3's documentation says a
// cross-family refusal never discloses WHY, and three refusals were built to
// honour that (`member-guest-cross-family-refusals.test.ts` pins those). This
// one was missed, and it was the most explicit of the four: it answered
//
//     "The following member guests cannot be booked for the 2026/2027 season:
//      Dana Doe."
//
// naming the member — or, where the name was blank, their EMAIL ADDRESS — and
// its response body carried their member id and membership category as
// structured `blockedMembers` fields. Against a stranger that is not an
// inference from a pattern of answers; it is a read-out, and unlike the C1 leak
// it does not even depend on the dates asked about, so one request answers it.
//
// WHAT THIS FILE PINS, in the order the review asked for it:
//   1. a beyond-family block collapses to the SAME envelope as its three
//      siblings — same sentence, same status, same code, no structured body;
//   2. nothing identifying survives ANYWHERE in the refusal (message or body):
//      not the name, not the email fallback, not the member id, not the
//      membership category;
//   3. family scope and admin/on-behalf paths keep the detailed, actionable
//      message verbatim, because a booker adding their own child needs to act
//      on it and an officer is entitled to it;
//   4. the collapse is driven by the SAME boundary the other refusals use, and
//      works both from the caller's marker and from the live boundary alone —
//      `confirm-draft`, guest removal and the promo validator all re-check a
//      party they never marked;
//   5. the collapsed error carries `crossFamilyMemberIds` so the routes can
//      hand it to `handleMemberGuestAddRefusal` — collapsed-but-uncounted is
//      how #2388's mitigation set gets a hole in it.
import { describe, expect, it } from "vitest";

import {
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyBlocks,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import {
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/member-guest-refusal";

const BOOKER = "m-booker";
const CHILD = "m-child";
const OUTSIDER = "m-outsider";
const SEASON = 2026;

const BLOCKING_TYPE = {
  id: "mt-blocked",
  key: "SUSPENDED",
  name: "Suspended membership",
  isActive: true,
  isBuiltIn: false,
  bookingBehavior: "BLOCK_BOOKING" as const,
  subscriptionBehavior: "REQUIRED" as const,
};
const BOOKABLE_TYPE = {
  id: "mt-full",
  key: "FULL",
  name: "Full",
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: "MEMBER_RATE" as const,
  subscriptionBehavior: "REQUIRED" as const,
};

type MemberRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "USER";
  ageTier: "ADULT";
};

function member(id: string, firstName: string, lastName: string): MemberRow {
  return {
    id,
    firstName,
    lastName,
    email: `${id}@club.example`,
    role: "USER",
    ageTier: "ADULT",
  };
}

/**
 * A db the policy resolver and the family boundary can both read.
 *
 * `family` is the booker's household. `blocked` is the set whose membership type
 * refuses bookings; everybody else resolves to a bookable type. The
 * `familyGroupMember` delegate answers `getAllowedGuestMemberIds`'s two reads in
 * the same shape the real one does — the first keyed on the booker, the second
 * on the group ids it returned.
 */
function policyDb(params: {
  members: MemberRow[];
  blocked: string[];
  family: string[];
  /** Omit the family delegate entirely — the narrowed-db case. */
  withoutFamilyBoundary?: boolean;
}) {
  const blocked = new Set(params.blocked);
  const db: Record<string, unknown> = {
    member: {
      findMany: async () => params.members,
    },
    seasonalMembershipAssignment: {
      findMany: async () =>
        params.members.map((row) => ({
          memberId: row.id,
          seasonYear: SEASON,
          membershipType: blocked.has(row.id) ? BLOCKING_TYPE : BOOKABLE_TYPE,
        })),
    },
    membershipType: {
      findMany: async () => [BOOKABLE_TYPE],
    },
  };
  if (!params.withoutFamilyBoundary) {
    db.familyGroupMember = {
      findMany: async (args: {
        where: { memberId?: string; familyGroupId?: { in: string[] } };
      }) =>
        args.where.memberId
          ? [{ familyGroupId: "fg-1" }]
          : params.family.map((memberId) => ({ memberId })),
    };
  }
  return db;
}

const guest = (memberId: string, crossFamilyMemberGuest?: boolean) => ({
  isMember: true,
  memberId,
  ...(crossFamilyMemberGuest === undefined ? {} : { crossFamilyMemberGuest }),
});

async function refuse(
  db: unknown,
  params: Parameters<typeof assertMembershipTypeBookingAllowed>[1],
): Promise<MembershipTypeBookingPolicyError> {
  const error = await assertMembershipTypeBookingAllowed(db, params).catch(
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(MembershipTypeBookingPolicyError);
  return error as MembershipTypeBookingPolicyError;
}

describe("D-8 leak 5 — the membership-type booking policy refusal", () => {
  it("collapses to the neutral refusal for a beyond-family member guest", async () => {
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), member(OUTSIDER, "Dana", "Doe")],
      blocked: [OUTSIDER],
      family: [BOOKER, CHILD],
    });

    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [guest(BOOKER), guest(OUTSIDER)],
      seasonYear: SEASON,
    });

    expect(error.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(error.status).toBe(403);
    expect(error.code).toBe(MEMBER_GUEST_NOT_ADDABLE_CODE);
    expect(error.crossFamilyMemberIds).toEqual([OUTSIDER]);
  });

  it("leaks nothing identifying in the message OR the body", async () => {
    // The single most important assertion in the file: every field the old
    // refusal handed over, checked against the serialised answer rather than
    // against the shape it happens to have today.
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), member(OUTSIDER, "Dana", "Doe")],
      blocked: [OUTSIDER],
      family: [BOOKER, CHILD],
    });
    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [guest(OUTSIDER)],
      seasonYear: SEASON,
    });

    const body = getMembershipTypeBookingPolicyErrorBody(error);
    const wire = JSON.stringify(body);
    for (const secret of [
      "Dana",
      "Doe",
      `${OUTSIDER}@club.example`,
      OUTSIDER,
      BLOCKING_TYPE.key,
      BLOCKING_TYPE.name,
      "2026/2027",
    ]) {
      expect(wire, `the refusal must not disclose ${secret}`).not.toContain(secret);
    }
    // And no emptied-out `blockedMembers` either: a caller can read the
    // difference between "the array is empty" and "there is no array".
    expect(body).not.toHaveProperty("blockedMembers");
    expect(body).toEqual({
      code: MEMBER_GUEST_NOT_ADDABLE_CODE,
      error: MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
    });
  });

  it("does not fall back to the EMAIL address when the blocked member has no name", async () => {
    // `memberDisplayName` returns the email when both name parts are blank, so
    // the pre-fix refusal published an address rather than a name for exactly
    // the members least likely to have completed a profile.
    const nameless = { ...member(OUTSIDER, "", ""), email: "quiet@club.example" };
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), nameless],
      blocked: [OUTSIDER],
      family: [BOOKER, CHILD],
    });
    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [guest(OUTSIDER)],
      seasonYear: SEASON,
    });
    expect(error.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(JSON.stringify(getMembershipTypeBookingPolicyErrorBody(error))).not.toContain(
      "quiet@club.example",
    );
  });

  it("keeps the detailed, actionable refusal for a FAMILY-scope member guest", async () => {
    // A booker adding their own child has to be told who and why, and nothing is
    // disclosed to somebody already in that household.
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), member(CHILD, "Kit", "Booker")],
      blocked: [CHILD],
      family: [BOOKER, CHILD],
    });
    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [guest(CHILD)],
      seasonYear: SEASON,
    });

    expect(error.message).toContain("Kit Booker");
    expect(error.crossFamilyMemberIds).toBeUndefined();
    const body = getMembershipTypeBookingPolicyErrorBody(error);
    expect(body).toHaveProperty("blockedMembers");
    expect(body.code).toBe("MEMBERSHIP_TYPE_BLOCKS_BOOKING");
  });

  it("keeps the detailed refusal on an admin / on-behalf path", async () => {
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), member(OUTSIDER, "Dana", "Doe")],
      blocked: [OUTSIDER],
      family: [BOOKER, CHILD],
    });
    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [guest(OUTSIDER)],
      seasonYear: SEASON,
      skipAuthorization: true,
    });
    expect(error.message).toContain("Dana Doe");
    expect(error.crossFamilyMemberIds).toBeUndefined();
    expect(getMembershipTypeBookingPolicyErrorBody(error)).toHaveProperty(
      "blockedMembers",
    );
  });

  it("collapses from the LIVE BOUNDARY alone, with no marker on the party", async () => {
    // `confirm-draft` re-checks the booking's STORED guests, the guest-removal
    // path re-checks what is left, and the promo validator prices a party it
    // built from the request — none of them have ever run the marking helpers.
    // A marker-only implementation would leak on exactly those three, which is
    // the same shape of mistake C1 was.
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), member(OUTSIDER, "Dana", "Doe")],
      blocked: [OUTSIDER],
      family: [BOOKER, CHILD],
    });
    const blocks = await getMembershipTypeBookingPolicyBlocks(db, {
      ownerMemberId: BOOKER,
      // Deliberately no `crossFamilyMemberGuest` anywhere.
      guests: [guest(OUTSIDER)],
      seasonYear: SEASON,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].crossFamily).toBe(true);
  });

  it("collapses from the MARKER alone, when the db cannot compute a boundary", async () => {
    // The in-transaction callers hand over a party that
    // `markCrossFamilyGuestsOnBooking` or `planMemberGuestConsentWrites` has
    // already marked, so the answer is in hand and costs no second read.
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), member(OUTSIDER, "Dana", "Doe")],
      blocked: [OUTSIDER],
      family: [],
      withoutFamilyBoundary: true,
    });
    const blocks = await getMembershipTypeBookingPolicyBlocks(db, {
      ownerMemberId: BOOKER,
      guests: [guest(OUTSIDER, true)],
      seasonYear: SEASON,
    });
    expect(blocks[0].crossFamily).toBe(true);
  });

  it("collapses the WHOLE message when a family block and a cross-family one land together", async () => {
    // Not "the collapsed part is omitted and the rest is listed": a caller who
    // can see which members were named and which were merely counted can
    // subtract, and one line of arithmetic gives the name back.
    const db = policyDb({
      members: [
        member(BOOKER, "Bea", "Booker"),
        member(CHILD, "Kit", "Booker"),
        member(OUTSIDER, "Dana", "Doe"),
      ],
      blocked: [CHILD, OUTSIDER],
      family: [BOOKER, CHILD],
    });
    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [guest(CHILD), guest(OUTSIDER)],
      seasonYear: SEASON,
    });
    expect(error.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(error.message).not.toContain("Kit");
    expect(error.crossFamilyMemberIds).toEqual([OUTSIDER]);
  });

  it("leaves an ordinary owner-only block completely unchanged", async () => {
    // No member guest is involved at all, so nothing about this refusal moves —
    // MG1's promise that a club which has not adopted the feature sees no
    // change whatsoever.
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker")],
      blocked: [BOOKER],
      family: [BOOKER],
    });
    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [],
      seasonYear: SEASON,
    });
    expect(error.message).toContain("2026/2027");
    expect(error.message).toContain(BLOCKING_TYPE.name);
    expect(error.status).toBe(403);
    expect(error.code).toBe("MEMBERSHIP_TYPE_BLOCKS_BOOKING");
    expect(getMembershipTypeBookingPolicyErrorBody(error)).toHaveProperty(
      "blockedMembers",
    );
  });

  it("is indistinguishable from the OTHER collapsed refusals", async () => {
    // The whole point of the collapse: a caller holding one refused response
    // cannot tell which of the four invariants refused. Compared against the
    // shared constants rather than against another refusal's live output, so
    // this test does not need the other three's fixtures to stay in step.
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), member(OUTSIDER, "Dana", "Doe")],
      blocked: [OUTSIDER],
      family: [BOOKER, CHILD],
    });
    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [guest(OUTSIDER)],
      seasonYear: SEASON,
    });
    expect({
      message: error.message,
      status: error.status,
      body: getMembershipTypeBookingPolicyErrorBody(error),
    }).toEqual({
      message: MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
      status: 403,
      body: {
        code: MEMBER_GUEST_NOT_ADDABLE_CODE,
        error: MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
      },
    });
  });

  it("carries the targets for the audit trail, in the shape the refusal handler reads", async () => {
    // `handleMemberGuestAddRefusal` discriminates on `crossFamilyMemberIds`
    // being present. Without it the fourth refusal would be collapsed but
    // uncounted — no throttle unit, no audit row, no timing floor — which is a
    // hole in #2388's mitigation set rather than a cosmetic gap.
    const db = policyDb({
      members: [member(BOOKER, "Bea", "Booker"), member(OUTSIDER, "Dana", "Doe")],
      blocked: [OUTSIDER],
      family: [BOOKER, CHILD],
    });
    const error = await refuse(db, {
      ownerMemberId: BOOKER,
      guests: [guest(OUTSIDER)],
      seasonYear: SEASON,
    });
    const asHandlerInput: { crossFamilyMemberIds?: readonly string[] } = error;
    expect(asHandlerInput.crossFamilyMemberIds).toEqual([OUTSIDER]);
  });

  it("costs no family-boundary read when nothing is blocked", async () => {
    // The backstop runs only on a refusal. An ordinary booking — every booking —
    // must not pay for it.
    let familyReads = 0;
    const db = {
      ...policyDb({
        members: [member(BOOKER, "Bea", "Booker"), member(OUTSIDER, "Dana", "Doe")],
        blocked: [],
        family: [BOOKER],
        withoutFamilyBoundary: true,
      }),
      familyGroupMember: {
        findMany: async () => {
          familyReads += 1;
          return [];
        },
      },
    };
    const blocks = await getMembershipTypeBookingPolicyBlocks(db, {
      ownerMemberId: BOOKER,
      guests: [guest(OUTSIDER)],
      seasonYear: SEASON,
    });
    expect(blocks).toHaveLength(0);
    expect(familyReads).toBe(0);
  });
});
