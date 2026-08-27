import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  AdminReviewStatus,
  AgeTier,
  BookingStatus,
  type MemberGuestConsentStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * ONE export replaced: #2543's subscription bridge.
 *
 * Everything else in `subscription-lockout-enforcement` stays genuine. The bridge
 * is stubbed to "nobody is unpaid", which is byte-identical to what the real one
 * returns in this environment — it short-circuits outside `NON_MEMBER_PRICING` and
 * this suite has no lockout-settings row — with the difference that the SEASON it
 * is asked about becomes observable. That season is the whole subject of the
 * `seasonYear` tests at the end of this file, and it is otherwise invisible: the
 * bridge is the only thing in the hosting rule that uses it.
 */
const subscriptionBridge = vi.hoisted(() => ({
  loadUnpaidSubscriptionMemberIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/subscription-lockout-enforcement", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/subscription-lockout-enforcement")
  >()),
  loadUnpaidSubscriptionMemberIds:
    subscriptionBridge.loadUnpaidSubscriptionMemberIds,
}));

import {
  evaluatePersistedBookingAdultMemberHostingReadOnly,
  evaluateProposedAdultMemberHosting,
  reconcileAdultMemberHostingReview,
  reconcileAdultMemberHostingReviewWithSiblings,
  recordAdultMemberHostingReviewForNewBooking,
  parseStoredHostingReview,
  toHostingParticipants,
} from "@/lib/adult-member-hosting-review";
import {
  bookingReviewReasonCodes,
  bookingReviewReasonSentences,
} from "@/lib/booking-review";
import {
  fenceBookingFindMany,
  fenceMemberFindMany,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";

const CLUB_ON = {
  id: "policy-club",
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ADMIN_REVIEW_REQUIRED",
  capacityMode: "NO_HOLD",
  version: 3,
};

const CLUB_OFF = { ...CLUB_ON, mode: "DISABLED" };

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    ageTier: AgeTier.ADULT,
    active: true,
    cancelledAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function guest(
  id: string,
  nights: string[],
  memberRow: ReturnType<typeof member> | null = null,
  consentStatus: MemberGuestConsentStatus | null = null,
) {
  return {
    id,
    firstName: id,
    lastName: "Person",
    stayStart: new Date(`${nights[0]}T00:00:00.000Z`),
    stayEnd: new Date(`${nights[nights.length - 1]}T00:00:00.000Z`),
    consentStatus,
    nights: nights.map((night) => ({ stayDate: new Date(`${night}T00:00:00.000Z`) })),
    member: memberRow,
  };
}

type BookingRow = Record<string, unknown>;

function makeDb(booking: BookingRow | null, policies: unknown[], siblings: BookingRow[] = []) {
  const update = vi.fn().mockResolvedValue({});
  return {
    update,
    db: {
      booking: {
        findUnique: vi.fn().mockResolvedValue(booking),
        findMany: vi.fn().mockResolvedValue(siblings),
        update,
      },
      adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue(policies) },
      lodge: { findFirst: vi.fn() },
      member: { findMany: vi.fn().mockResolvedValue([]) },
    } as any,
  };
}

/**
 * A whole booking FAMILY behind one fake client: `findUnique` answers by id,
 * `findMany` really applies the sibling predicate, and `update` mutates the row
 * it names. The single-row `makeDb` above cannot express the bug this exists to
 * pin — a mutation on one half of a #738 split pair changing the OTHER half's
 * answer — because that needs two rows that can each be read and written.
 */
function makeFamilyDb(rows: BookingRow[], policies: unknown[]) {
  const byId = new Map(rows.map((row) => [row.id as string, { ...row }]));
  const update = vi.fn(async ({ where, data }: any) => {
    Object.assign(byId.get(where.id)!, data);
    return {};
  });

  // #2619: `reconcileAdultMemberHostingReviewWithSiblings` fences its source
  // participants before it does anything else — it locks the owner/actor Member
  // rows FOR KEY SHARE NOWAIT and then re-reads, under that lock, both those
  // members and the source booking's owner and lodge. Replaying exactly what
  // this client's own `findUnique` served is what makes the no-drift case match
  // by construction instead of by a hand-copied fixture.
  const fenceBooking = recordingBookingDouble(async (args: unknown) => {
    const { where } = args as { where: { id: string } };
    return byId.get(where.id) ?? null;
  });

  /**
   * Every booking.findMany the REVIEW code makes — the sibling fan-out's id-only
   * read and the borrow's own guest read. The fence's three-column re-read goes
   * to the double above instead, so this spy stays exactly the call list this
   * suite asserted on before the fence was switched on.
   */
  const siblingFindMany = vi.fn(async (args: unknown) => {
    const { where } = args as { where: any };
    return [...byId.values()].filter((row) => {
      if (row.id === where.id?.not) return false;
      if (row.memberId !== where.memberId) return false;
      return (where.OR as any[]).some((clause) =>
        clause.id !== undefined
          ? row.id === clause.id
          : row.parentBookingId === clause.parentBookingId,
      );
    });
  });

  return {
    update,
    siblingFindMany,
    rowFor: (id: string) => byId.get(id)!,
    db: {
      $executeRaw: vi.fn().mockResolvedValue(1),
      booking: {
        findUnique: fenceBooking.findUnique,
        findMany: fenceBookingFindMany(fenceBooking.lookup, siblingFindMany),
        update,
      },
      adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue(policies) },
      lodge: { findFirst: vi.fn() },
      member: { findMany: fenceMemberFindMany() },
    } as any,
  };
}

function bookingRow(overrides: BookingRow = {}): BookingRow {
  return {
    id: "booking-1",
    memberId: "owner-1",
    parentBookingId: null,
    lodgeId: "lodge-1",
    checkIn: new Date("2026-07-04T00:00:00.000Z"),
    checkOut: new Date("2026-07-06T00:00:00.000Z"),
    adultMemberHostingReview: null,
    adultMemberHostingReviewStatus: null,
    guests: [guest("g1", ["2026-07-04", "2026-07-05"])],
    ...overrides,
  };
}

describe("hosting review reconciliation (#2364)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes nothing when the policy is off and nothing is recorded", async () => {
    const { db, update } = makeDb(bookingRow(), [CLUB_OFF]);
    await expect(
      reconcileAdultMemberHostingReview("booking-1", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
  });

  it("writes nothing for a booking that does not exist", async () => {
    const { db, update } = makeDb(null, [CLUB_ON]);
    await expect(
      reconcileAdultMemberHostingReview("missing", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
  });

  it("opens a PENDING review with the frozen snapshot when the rule trips", async () => {
    const { db, update } = makeDb(bookingRow(), [CLUB_ON]);
    const outcome = await reconcileAdultMemberHostingReview("booking-1", db);
    expect(outcome.action).toBe("opened");
    const data = update.mock.calls[0][0].data;
    expect(data.adultMemberHostingReviewStatus).toBe(AdminReviewStatus.PENDING);
    expect(data.adultMemberHostingReviewReason).toBeNull();
    expect(data.adultMemberHostingReviewedById).toBeNull();
    expect(data.adultMemberHostingReview.affectedNights).toEqual([
      "2026-07-04",
      "2026-07-05",
    ]);
    expect(data.adultMemberHostingReview.policyId).toBe("policy-club");
    expect(data.adultMemberHostingReview.policyVersion).toBe(3);
  });

  it("does not trip when an adult member guest covers every night", async () => {
    const { db, update } = makeDb(
      bookingRow({
        guests: [
          guest("g1", ["2026-07-04", "2026-07-05"]),
          guest("m1", ["2026-07-04", "2026-07-05"], member()),
        ],
      }),
      [CLUB_ON],
    );
    await expect(
      reconcileAdultMemberHostingReview("booking-1", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
  });

  it("clears a pending review the moment the nights become covered", async () => {
    const stored = {
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      policyId: "policy-club",
      policyVersion: 3,
      requirements: { uncovered: [{ guestRef: "g1", night: "2026-07-04" }] },
    };
    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: stored,
        adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
        guests: [
          guest("g1", ["2026-07-04"]),
          guest("m1", ["2026-07-04"], member()),
        ],
      }),
      [CLUB_ON],
    );
    const outcome = await reconcileAdultMemberHostingReview("booking-1", db);
    expect(outcome.action).toBe("cleared");
    const data = update.mock.calls[0][0].data;
    expect(data.adultMemberHostingReviewStatus).toBeNull();
    expect(data.adultMemberHostingReviewedAt).toBeNull();
  });

  it("clears when the club switches the policy off, not only when guests change", async () => {
    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: {
          reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
          policyId: "policy-club",
          policyVersion: 3,
          requirements: { uncovered: [{ guestRef: "g1", night: "2026-07-04" }] },
        },
        adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
      }),
      [CLUB_OFF],
    );
    await expect(
      reconcileAdultMemberHostingReview("booking-1", db),
    ).resolves.toMatchObject({ action: "cleared" });
    expect(update).toHaveBeenCalled();
  });

  it("leaves a decided review alone while the same hazard stands", async () => {
    // Round-trip the real snapshot so the comparison sees identical evidence.
    const first = makeDb(bookingRow(), [CLUB_ON]);
    await reconcileAdultMemberHostingReview("booking-1", first.db);
    const stored = first.update.mock.calls[0][0].data.adultMemberHostingReview;

    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: stored,
        adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
      }),
      [CLUB_ON],
    );
    await expect(
      reconcileAdultMemberHostingReview("booking-1", db),
    ).resolves.toMatchObject({ action: "unchanged" });
    expect(update).not.toHaveBeenCalled();
  });

  it("reopens an approved review when a materially different hazard appears", async () => {
    const first = makeDb(bookingRow(), [CLUB_ON]);
    await reconcileAdultMemberHostingReview("booking-1", first.db);
    const stored = first.update.mock.calls[0][0].data.adultMemberHostingReview;

    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: stored,
        adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
        adultMemberHostingReviewReason: "Long-standing family friend",
        adultMemberHostingReviewedById: "admin-1",
        // A second uncovered guest joins the same nights.
        guests: [
          guest("g1", ["2026-07-04", "2026-07-05"]),
          guest("g2", ["2026-07-04", "2026-07-05"]),
        ],
      }),
      [CLUB_ON],
    );
    const outcome = await reconcileAdultMemberHostingReview("booking-1", db);
    expect(outcome.action).toBe("reopened");
    const data = update.mock.calls[0][0].data;
    expect(data.adultMemberHostingReviewStatus).toBe(AdminReviewStatus.PENDING);
    // The previous decision does not survive a different question.
    expect(data.adultMemberHostingReviewReason).toBeNull();
    expect(data.adultMemberHostingReviewedById).toBeNull();
  });

  it("adopts an unsnapshotted flagged booking without reopening its decision", async () => {
    const { db, update } = makeDb(
      bookingRow({
        adultMemberHostingReview: null,
        adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
      }),
      [CLUB_ON],
    );
    const outcome = await reconcileAdultMemberHostingReview("booking-1", db);
    // A status with no snapshot counts as RECORDED, so this is a reopen path,
    // not a first open: there is nothing to compare against, so the safe answer
    // is a fresh decision rather than silently inheriting the old one.
    expect(outcome.action).toBe("reopened");
    expect(update.mock.calls[0][0].data.adultMemberHostingReviewStatus).toBe(
      AdminReviewStatus.PENDING,
    );
  });

  it("borrows the split parent's adults so a #738 non-member child is not always in breach", async () => {
    const child = bookingRow({
      id: "child-1",
      parentBookingId: "parent-1",
      guests: [guest("g1", ["2026-07-04"])],
    });
    const parent = bookingRow({
      id: "parent-1",
      parentBookingId: null,
      guests: [guest("m1", ["2026-07-04"], member())],
    });
    const { db, update } = makeDb(child, [CLUB_ON], [parent]);
    await expect(
      reconcileAdultMemberHostingReview("child-1", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
    // Only same-member, live siblings are considered.
    const where = db.booking.findMany.mock.calls[0][0].where;
    expect(where.memberId).toBe("owner-1");
    expect(where.deletedAt).toBeNull();
    expect(where.status).toEqual({ notIn: ["CANCELLED", "BUMPED"] });
  });

  it("does not charge a split PARENT with its child's guests — one party, one hazard", async () => {
    // The mirror of the case above, and the reason siblings are host-only. The
    // parent carries the member half; if its child's non-member guests counted
    // against it, the same party would raise a review on BOTH bookings and an
    // admin would decide the identical question twice.
    // The member leaves a night early, so the child's guest has an uncovered
    // night. That night is the CHILD's hazard to carry, not the parent's.
    const parent = bookingRow({
      id: "parent-1",
      parentBookingId: null,
      guests: [guest("m1", ["2026-07-04"], member())],
    });
    const child = bookingRow({
      id: "child-1",
      parentBookingId: "parent-1",
      guests: [guest("g1", ["2026-07-04", "2026-07-05"])],
    });
    const { db, update } = makeDb(parent, [CLUB_ON], [child]);
    await expect(
      reconcileAdultMemberHostingReview("parent-1", db),
    ).resolves.toMatchObject({ action: "none" });
    expect(update).not.toHaveBeenCalled();
  });

  it("does not borrow anybody when the policy is off — the sibling read is skipped", async () => {
    const { db } = makeDb(bookingRow(), [CLUB_OFF]);
    await reconcileAdultMemberHostingReview("booking-1", db);
    expect(db.booking.findMany).not.toHaveBeenCalled();
  });

  it("scopes the policy read to this lodge and the club row, and nothing else", async () => {
    // The resolver re-filters in memory, so a drift in this predicate would be
    // invisible to every other test in the suite: dropping `{ lodgeId: null }`
    // would silently answer DISABLED at every lodge without its own override,
    // which switches the club's rule off and auto-clears live reviews.
    const { db } = makeDb(bookingRow(), [CLUB_ON]);
    await reconcileAdultMemberHostingReview("booking-1", db);
    expect(db.adultMemberHostingPolicy.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ lodgeId: "lodge-1" }, { lodgeId: null }],
    });
  });

  it("does not let an unaccepted member-guest invite host anybody (D-12)", async () => {
    // The adult member covers every night on paper, but their invite is still
    // PENDING, so the kiosk, the roster and bed allocation all leave them out.
    // If they counted here, a member could suppress the review with somebody
    // who never agreed to come — and the lodge would receive the non-member
    // guests unaccompanied.
    const pending = makeDb(
      bookingRow({
        guests: [
          guest("g1", ["2026-07-04", "2026-07-05"]),
          guest("m1", ["2026-07-04", "2026-07-05"], member(), "PENDING"),
        ],
      }),
      [CLUB_ON],
    );
    await expect(
      reconcileAdultMemberHostingReview("booking-1", pending.db),
    ).resolves.toMatchObject({ action: "opened" });

    // ...and the moment they accept, the review clears with no admin action.
    const confirmed = makeDb(
      bookingRow({
        guests: [
          guest("g1", ["2026-07-04", "2026-07-05"]),
          guest("m1", ["2026-07-04", "2026-07-05"], member(), "CONFIRMED"),
        ],
      }),
      [CLUB_ON],
    );
    await expect(
      reconcileAdultMemberHostingReview("booking-1", confirmed.db),
    ).resolves.toMatchObject({ action: "none" });
    expect(confirmed.update).not.toHaveBeenCalled();
  });
});

describe("persisted read-only hosting evidence (#2376)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the split parent's accepted adult member as child-booking coverage", async () => {
    const child = bookingRow({
      id: "child-1",
      parentBookingId: "parent-1",
      guests: [guest("child-guest", ["2026-07-04"])],
    });
    const parent = bookingRow({
      id: "parent-1",
      guests: [guest("parent-adult", ["2026-07-04"], member())],
    });
    const { db, update } = makeDb(child, [CLUB_ON], [parent]);

    await expect(
      evaluatePersistedBookingAdultMemberHostingReadOnly("child-1", db),
    ).resolves.toMatchObject({ violation: null });
    expect(update).not.toHaveBeenCalled();
  });

  it("does not let a PENDING adult-member guest cover the persisted booking", async () => {
    const { db, update } = makeDb(
      bookingRow({
        guests: [
          guest("non-member", ["2026-07-04"]),
          guest("pending-adult", ["2026-07-04"], member(), "PENDING"),
        ],
      }),
      [CLUB_ON],
    );

    const result = await evaluatePersistedBookingAdultMemberHostingReadOnly(
      "booking-1",
      db,
    );
    expect(result?.violation).toMatchObject({
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      affectedNights: ["2026-07-04"],
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("split-pair reconciliation (#2364 review finding)", () => {
  beforeEach(() => vi.clearAllMocks());

  /** Parent = the member's own booking; child = the party's non-member half. */
  function splitPair(parentNights: string[], childNights: string[]) {
    return [
      bookingRow({
        id: "parent-1",
        parentBookingId: null,
        guests: [guest("m1", parentNights, member())],
      }),
      bookingRow({
        id: "child-1",
        parentBookingId: "parent-1",
        guests: [guest("g1", childNights)],
      }),
    ];
  }

  it("opens the CHILD's review when the parent's member shortens their own stay", async () => {
    // Nobody touches the child: its guest rows and nights are identical before
    // and after. The hazard appears entirely because the PARENT changed.
    const family = makeFamilyDb(
      splitPair(["2026-07-04"], ["2026-07-04", "2026-07-05"]),
      [CLUB_ON],
    );
    await reconcileAdultMemberHostingReviewWithSiblings("parent-1", family.db);

    const child = family.rowFor("child-1");
    expect(child.adultMemberHostingReviewStatus).toBe(AdminReviewStatus.PENDING);
    expect((child.adultMemberHostingReview as any).affectedNights).toEqual([
      "2026-07-05",
    ]);
    // The parent itself carries no hazard — one party, one review.
    expect(family.rowFor("parent-1").adultMemberHostingReviewStatus).toBeNull();
  });

  it("clears the CHILD's review when the parent's member extends to cover it", async () => {
    // The issue's automatic clear, on the shape it is most likely to be needed.
    const [parent, child] = splitPair(
      ["2026-07-04", "2026-07-05"],
      ["2026-07-04", "2026-07-05"],
    );
    const family = makeFamilyDb(
      [
        parent,
        {
          ...child,
          adultMemberHostingReview: {
            reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
            policyId: "policy-club",
            policyVersion: 3,
            requirements: { uncovered: [{ guestRef: "g1", night: "2026-07-05" }] },
          },
          adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
        },
      ],
      [CLUB_ON],
    );
    await reconcileAdultMemberHostingReviewWithSiblings("parent-1", family.db);

    const reconciled = family.rowFor("child-1");
    expect(reconciled.adultMemberHostingReviewStatus).toBeNull();
    expect(reconciled.adultMemberHostingReviewedAt).toBeNull();
  });

  it("re-derives the PARENT when the child is the row that was mutated", async () => {
    // Symmetric by construction: the fan-out reads the same relation the borrow
    // does, so it works from either end.
    const family = makeFamilyDb(
      splitPair(["2026-07-04"], ["2026-07-04", "2026-07-05"]),
      [CLUB_ON],
    );
    await reconcileAdultMemberHostingReviewWithSiblings("child-1", family.db);
    expect(family.rowFor("child-1").adultMemberHostingReviewStatus).toBe(
      AdminReviewStatus.PENDING,
    );
    expect(family.siblingFindMany).toHaveBeenCalled();
  });

  it("never carries a caller's on-behalf decision onto a sibling", async () => {
    // An admin's reason belongs to the booking they were making. A hazard that
    // appears on a row they reached through it opens PENDING, so nothing is
    // approved by anybody who was never asked (D-R4).
    const family = makeFamilyDb(
      splitPair(["2026-07-04"], ["2026-07-04", "2026-07-05"]),
      [CLUB_ON],
    );
    await reconcileAdultMemberHostingReviewWithSiblings("parent-1", family.db, {
      openedStatus: AdminReviewStatus.APPROVED,
      decision: { reason: "Known to the committee", byMemberId: "admin-9" },
    });
    const child = family.rowFor("child-1");
    expect(child.adultMemberHostingReviewStatus).toBe(AdminReviewStatus.PENDING);
    expect(child.adultMemberHostingReviewReason).toBeNull();
    expect(child.adultMemberHostingReviewedById).toBeNull();
  });

  it("costs a club that has not turned the rule on nothing at all", async () => {
    // The fan-out and every write are what a disabled club must not pay for, and
    // neither happens. The participant fence's own lock and re-read DO still run
    // ahead of the policy read on this seam — that asymmetry against the two
    // coverage seams, which both check the mode first, is tracked separately as
    // T5 on #2623 and is not this test's subject.
    const family = makeFamilyDb(
      splitPair(["2026-07-04"], ["2026-07-04", "2026-07-05"]),
      [CLUB_OFF],
    );
    await reconcileAdultMemberHostingReviewWithSiblings("parent-1", family.db);
    expect(family.siblingFindMany).not.toHaveBeenCalled();
    expect(family.update).not.toHaveBeenCalled();
  });

  it("fans out one level only, and only over live same-member siblings", async () => {
    const family = makeFamilyDb(
      splitPair(["2026-07-04"], ["2026-07-04", "2026-07-05"]),
      [CLUB_ON],
    );
    await reconcileAdultMemberHostingReviewWithSiblings("parent-1", family.db);
    // Once for the mutated booking, once for the sibling lookup, once for the
    // sibling's own evaluation — never a third round trip from the sibling.
    const siblingWheres = family.siblingFindMany.mock.calls.map(
      (call: any[]) => (call[0] as any).where,
    );
    for (const where of siblingWheres) {
      expect(where.memberId).toBe("owner-1");
      expect(where.deletedAt).toBeNull();
      expect(where.status).toEqual({ notIn: ["CANCELLED", "BUMPED"] });
    }
    expect(siblingWheres.filter((w: any) => w.id?.not === "child-1")).toHaveLength(
      1,
    );
  });

  it("records an admin on-behalf decision, and refuses to approve without one", async () => {
    const approved = makeDb(bookingRow(), [CLUB_ON]);
    await recordAdultMemberHostingReviewForNewBooking("booking-1", approved.db, {
      reason: "Long-standing family friend of the club",
      byMemberId: "admin-9",
    });
    const data = approved.update.mock.calls[0][0].data;
    expect(data.adultMemberHostingReviewStatus).toBe(AdminReviewStatus.APPROVED);
    expect(data.adultMemberHostingReviewReason).toBe(
      "Long-standing family friend of the club",
    );
    expect(data.adultMemberHostingReviewedById).toBe("admin-9");
    expect(data.adultMemberHostingReviewedAt).toBeInstanceOf(Date);

    const pending = makeDb(bookingRow(), [CLUB_ON]);
    await recordAdultMemberHostingReviewForNewBooking("booking-1", pending.db, null);
    expect(
      pending.update.mock.calls[0][0].data.adultMemberHostingReviewStatus,
    ).toBe(AdminReviewStatus.PENDING);

    // Belt and braces: an APPROVED open with no reason is a programming error
    // and fails loudly rather than waving the booking through.
    const bad = makeDb(bookingRow(), [CLUB_ON]);
    await expect(
      reconcileAdultMemberHostingReview("booking-1", bad.db, {
        openedStatus: AdminReviewStatus.APPROVED,
      }),
    ).rejects.toThrow(/explicit decision reason/i);
    expect(bad.update).not.toHaveBeenCalled();
  });

  it("uses the fenced sibling-aware seam when a new booking is confirmed cover", async () => {
    const [parent, child] = splitPair(
      ["2026-07-04", "2026-07-05"],
      ["2026-07-04", "2026-07-05"],
    );
    const family = makeFamilyDb(
      [
        { ...parent, status: BookingStatus.CONFIRMED, deletedAt: null },
        {
          ...child,
          status: BookingStatus.PENDING,
          deletedAt: null,
          adultMemberHostingReview: {
            reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
            policyId: "policy-club",
            policyVersion: 3,
            requirements: {
              uncovered: [{ guestRef: "g1", night: "2026-07-05" }],
            },
          },
          adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
        },
      ],
      [CLUB_ON],
    );

    await recordAdultMemberHostingReviewForNewBooking(
      "parent-1",
      family.db,
      null,
    );

    expect(family.rowFor("child-1").adultMemberHostingReviewStatus).toBeNull();
    expect(family.siblingFindMany).toHaveBeenCalled();
  });

  it("keeps draft and waitlist creation on the single-booking review path", async () => {
    for (const status of [BookingStatus.DRAFT, BookingStatus.WAITLISTED]) {
      const family = makeFamilyDb(
        splitPair(["2026-07-04"], ["2026-07-04", "2026-07-05"]).map(
          (row) => ({ ...row, status, deletedAt: null }),
        ),
        [CLUB_ON],
      );
      await recordAdultMemberHostingReviewForNewBooking(
        "parent-1",
        family.db,
        null,
      );
      expect(
        family.db.booking.findMany.mock.calls.some(
          ([args]: any[]) =>
            args.select?.id === true && Object.keys(args.select).length === 1,
        ),
      ).toBe(false);
    }
  });
});

describe("source contract: no booking path may skip the hosting review (#2364)", () => {
  // These two contracts generalise a review finding rather than re-pinning the
  // one call site that had it. The finding was that four all-non-member
  // creation paths (the booking-request approval, both school approvals, the
  // held-booking conversion) committed with all five hosting columns NULL — the
  // hazard present but unrecorded until an unrelated later edit materialised
  // it. A per-site test would not stop the FIFTH such path being added.
  const sourceFiles = (() => {
    const roots = [join(process.cwd(), "src", "lib"), join(process.cwd(), "src", "app")];
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          found.push(full);
        }
      }
    };
    for (const root of roots) walk(root);
    return found.map((path) => ({ path, source: readFileSync(path, "utf8") }));
  })();

  it("every module that creates a Booking row records its hosting review", () => {
    const creators = sourceFiles.filter((file) =>
      /\bbooking\.create\(/.test(file.source),
    );
    // Guard against the walk silently finding nothing.
    expect(creators.length).toBeGreaterThanOrEqual(5);
    const missing = creators
      .filter(
        (file) =>
          !/(reconcileAdultMemberHostingReviewWithSiblings|recordAdultMemberHostingReviewForNewBooking)\(/.test(
            file.source,
          ),
      )
      .map((file) => file.path);
    expect(missing).toEqual([]);
  });

  it("leaves no *_CONFIRM_REQUIRED 409 that no surface can answer", () => {
    // The D-R4 refusal shipped with no client that could satisfy it: nothing in
    // the repo sent `adultMemberHostingReason` or branched on the code, so once
    // a club turned the policy on, admin on-behalf booking was permanently
    // blocked for exactly the parties the feature targets. A warn-and-confirm
    // is only half a feature until something can do the confirming.
    const route = readFileSync(
      join(process.cwd(), "src", "app", "api", "bookings", "route.ts"),
      "utf8",
    );
    const codes = [
      ...new Set(
        [...route.matchAll(/code:\s*"([A-Z_]+_CONFIRM_REQUIRED)"/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    expect(codes).toContain("ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED");

    const clients = sourceFiles.filter((file) => file.path.endsWith(".tsx"));
    const unanswerable = codes.filter(
      (code) => !clients.some((file) => file.source.includes(code)),
    );
    expect(unanswerable).toEqual([]);
  });

  it("sends the hosting reason from both admin on-behalf submit paths", () => {
    // The 409 is raised BEFORE the draft/confirmed fork, so it blocks both.
    const page = readFileSync(
      join(
        process.cwd(),
        "src",
        "app",
        "(admin)",
        "admin",
        "book",
        "page.tsx",
      ),
      "utf8",
    );
    expect(
      page.match(/adultMemberHostingReason: opts\.hostingReason/g) ?? [],
    ).toHaveLength(2);
    expect(
      page.match(/ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED/g) ?? [],
    ).toHaveLength(2);
  });

  it("no mutation path uses the single-booking reconciler", () => {
    // The single-id form leaves the other half of a #738 split pair asserting
    // facts that are no longer true, in both directions. Only the review module
    // itself may call it — from the sibling-aware wrapper, and from the create
    // path's own `recordAdultMemberHostingReviewForNewBooking`.
    const offenders = sourceFiles
      .filter(
        (file) =>
          !file.path.endsWith("adult-member-hosting-review.ts") &&
          /\breconcileAdultMemberHostingReview\(/.test(file.source),
      )
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});

describe("participant construction (#2364)", () => {
  it("uses the sparse per-night rows when they exist", () => {
    const participants = toHostingParticipants({
      guests: [guest("g1", ["2026-07-04", "2026-07-06"])],
    });
    expect(participants[0].nights).toEqual(["2026-07-04", "2026-07-06"]);
  });

  it("falls back to the GUEST's own envelope for pre-#713 rows, never the booking's", () => {
    const participants = toHostingParticipants({
      guests: [
        {
          id: "legacy",
          firstName: "Legacy",
          lastName: "Row",
          stayStart: new Date("2026-07-04T00:00:00.000Z"),
          stayEnd: new Date("2026-07-06T00:00:00.000Z"),
          consentStatus: null,
          nights: [],
          member: null,
        },
      ],
    });
    // stayEnd is exclusive: two nights, not three.
    expect(participants[0].nights).toEqual(["2026-07-04", "2026-07-05"]);
  });
});

describe("stored snapshot parsing (#2364)", () => {
  it("refuses anything that is not a hosting snapshot with comparable evidence", () => {
    expect(parseStoredHostingReview(null)).toBeNull();
    expect(parseStoredHostingReview("nope")).toBeNull();
    expect(parseStoredHostingReview([])).toBeNull();
    expect(parseStoredHostingReview({ reasonCode: "MINIMUM_STAY" })).toBeNull();
    expect(
      parseStoredHostingReview({
        reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
        policyId: "p",
        policyVersion: 1,
        requirements: {},
      }),
    ).toBeNull();
  });
});

describe("structured review reason codes (#2364)", () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    [
      "no review at all",
      { requiresAdminReview: false, adminReviewStatus: null, adultMemberHostingReviewStatus: null },
      [],
    ],
    [
      "the minors rule alone",
      {
        requiresAdminReview: true,
        adminReviewStatus: AdminReviewStatus.PENDING,
        adultMemberHostingReviewStatus: null,
      },
      ["ADULT_SUPERVISION"],
    ],
    [
      "the hosting policy alone",
      {
        requiresAdminReview: false,
        adminReviewStatus: null,
        adultMemberHostingReviewStatus: AdminReviewStatus.PENDING,
      },
      ["ADULT_MEMBER_HOSTING_REQUIRED"],
    ],
    [
      "both at once, in a fixed order",
      {
        requiresAdminReview: true,
        adminReviewStatus: AdminReviewStatus.PENDING,
        adultMemberHostingReviewStatus: AdminReviewStatus.APPROVED,
      },
      ["ADULT_SUPERVISION", "ADULT_MEMBER_HOSTING_REQUIRED"],
    ],
  ];

  for (const [label, booking, expected] of cases) {
    it(`reports ${label}`, () => {
      const codes = bookingReviewReasonCodes(booking as any);
      expect(codes).toEqual(expected);
      expect(bookingReviewReasonSentences(codes)).toHaveLength(expected.length);
    });
  }

  it("gives each code its own sentence, so neither hazard is described by the other", () => {
    const sentences = bookingReviewReasonSentences([
      "ADULT_SUPERVISION",
      "ADULT_MEMBER_HOSTING_REQUIRED",
    ]);
    expect(sentences[0]).toMatch(/does not include an adult guest/);
    expect(sentences[1]).toMatch(/no adult member is staying/);
    expect(sentences[0]).not.toBe(sentences[1]);
  });
});

describe("pre-persist evaluation for the create path (#2364)", () => {
  const db = (
    policies: unknown[],
    members: unknown[] = [],
    sourceBookings: unknown[] = [],
  ) =>
    ({
      adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue(policies) },
      member: { findMany: vi.fn().mockResolvedValue(members) },
      booking: { findMany: vi.fn().mockResolvedValue(sourceBookings) },
      lodge: { findFirst: vi.fn() },
    }) as any;

  const input = {
    lodgeId: "lodge-1",
    checkIn: new Date("2026-07-04T00:00:00.000Z"),
    checkOut: new Date("2026-07-06T00:00:00.000Z"),
    guests: [{ firstName: "Non", lastName: "Member" }],
  };

  it("returns nothing while the policy is off, without reading members", async () => {
    const client = db([CLUB_OFF]);
    await expect(
      evaluateProposedAdultMemberHosting(client, input),
    ).resolves.toBeNull();
    expect(client.member.findMany).not.toHaveBeenCalled();
  });

  it("trips on a submitted party with no adult member on the nights", async () => {
    const violation = await evaluateProposedAdultMemberHosting(db([CLUB_ON]), input);
    expect(violation).not.toBeNull();
    expect(violation!.affectedNights).toEqual(["2026-07-04", "2026-07-05"]);
    // Pre-persist refs are positional; the stored snapshot always comes from
    // the reconciler and carries real BookingGuest ids.
    expect(violation!.requirements.uncovered[0].guestRef).toBe("guest:0");
  });

  it("clears once an adult member is on the same nights", async () => {
    const violation = await evaluateProposedAdultMemberHosting(
      db([CLUB_ON], [member({ id: "m-1" })]),
      {
        ...input,
        guests: [
          { firstName: "Non", lastName: "Member" },
          { firstName: "Ada", lastName: "Member", memberId: "m-1" },
        ],
      },
    );
    expect(violation).toBeNull();
  });

  it("credits an eligible source booking owned by the prospective Booking.memberId", async () => {
    const client = db(
      [
        {
          ...CLUB_ON,
          hostScopeSameBooking: true,
          hostScopeSameBookingOwner: true,
        },
      ],
      [],
      [
        {
          id: "source-booking",
          guests: [
            guest(
              "source-host",
              ["2026-07-04", "2026-07-05"],
              member({ id: "host-member" }),
            ),
          ],
        },
      ],
    );

    const violation = await evaluateProposedAdultMemberHosting(client, {
      ...input,
      bookingOwnerMemberId: "owner-1",
    });

    expect(violation).toBeNull();
    expect(client.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberId: "owner-1",
          lodgeId: "lodge-1",
        }),
      }),
    );
  });

  it("never credits a member whose live row says they cannot host", async () => {
    for (const bad of [
      { ageTier: AgeTier.YOUTH },
      { active: false },
      { cancelledAt: new Date("2026-01-01") },
      { archivedAt: new Date("2026-01-01") },
    ]) {
      const violation = await evaluateProposedAdultMemberHosting(
        db([CLUB_ON], [member({ id: "m-1", ...bad })]),
        {
          ...input,
          guests: [
            { firstName: "Non", lastName: "Member" },
            { firstName: "Ada", lastName: "Member", memberId: "m-1" },
          ],
        },
      );
      expect(violation).not.toBeNull();
    }
  });

  it("uses each guest's own submitted nights, so a partial stay is judged per night", async () => {
    const violation = await evaluateProposedAdultMemberHosting(
      db([CLUB_ON], [member({ id: "m-1" })]),
      {
        ...input,
        guests: [
          { firstName: "Non", lastName: "Member", nights: ["2026-07-04", "2026-07-05"] },
          { firstName: "Ada", lastName: "Member", memberId: "m-1", nights: ["2026-07-04"] },
        ],
      },
    );
    expect(violation!.affectedNights).toEqual(["2026-07-05"]);
  });
});

// ---------------------------------------------------------------------------
// The season the subscription bridge is asked about (#2376).
// ---------------------------------------------------------------------------

describe("the read-only form's season basis (#2376)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionBridge.loadUnpaidSubscriptionMemberIds.mockResolvedValue(
      new Set<string>(),
    );
  });

  /** The season the bridge was actually asked about. */
  function seasonAsked(): unknown {
    const call = subscriptionBridge.loadUnpaidSubscriptionMemberIds.mock
      .calls[0] as unknown as [unknown, { seasonYear?: number }] | undefined;
    return call?.[1]?.seasonYear;
  }

  it("derives the season from the check-in night when no caller supplies one", async () => {
    // Unchanged behaviour for every writer: they reach this rule through a gated
    // request that has already seeded the process-level financial-year cache, so
    // `seasonYearOfStoredDate(checkIn)` is correct for them. The fixture's check-in is
    // 4 July 2026, which is season 2026 on the default 31-March year-end.
    //
    // ON ITS OWN THIS ASSERTION IS NOT DISCRIMINATING, and the sibling below is why
    // it needs one. The frozen clock is 1 July 2026, also season 2026, so an
    // implementation that answered from "now" instead of from the booking would pass
    // here. That is not hypothetical: the retired `getSeasonYear(date = new Date())`
    // silently substituted "now" whenever a caller handed it an absent `checkIn`, and
    // four reuse-path doubles in `booking-request.test.ts` were doing exactly that
    // with nothing failing (#2870, correctness review).
    const { db } = makeDb(bookingRow(), [CLUB_ON]);
    await evaluatePersistedBookingAdultMemberHostingReadOnly("booking-1", db);
    expect(seasonAsked()).toBe(2026);
  });

  it("asks about the BOOKING's season even when it is not the current one", async () => {
    // The discriminating half. A February check-in is season 2025 on a 31-March
    // year-end, while the frozen clock's "now" is season 2026 — so this fails for any
    // implementation that reads the process's day rather than the stored night, and
    // it fails for the one that reads a missing `checkIn` as "now".
    //
    // It matters because the season selects `MemberSubscription` by
    // `(memberId, seasonYear)`: the wrong season reports a settled member as
    // unfinancial, which disqualifies them as an adult-member host and can refuse a
    // party the club's own rules allow.
    const { db } = makeDb(
      bookingRow({
        checkIn: new Date("2026-02-10T00:00:00.000Z"),
        checkOut: new Date("2026-02-12T00:00:00.000Z"),
        guests: [guest("g1", ["2026-02-10", "2026-02-11"])],
      }),
      [CLUB_ON],
    );
    await evaluatePersistedBookingAdultMemberHostingReadOnly("booking-1", db);
    expect(seasonAsked()).toBe(2025);
  });

  it("leaves the sibling read UNBOUNDED when no ceiling is supplied", async () => {
    // Byte-identical for every writer, and deliberately so: the hosting answer has
    // to see every sibling that could cover a night, so a silent `take` here would
    // change the rule rather than the answer's confidence.
    const { db } = makeDb(bookingRow(), [CLUB_ON]);
    await evaluatePersistedBookingAdultMemberHostingReadOnly("booking-1", db);
    const args = db.booking.findMany.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.take).toBeUndefined();
    expect(args.orderBy).toBeUndefined();
  });

  it("bounds the sibling read to ceiling + 1 when a ceiling IS supplied", async () => {
    // `+ 1` so "there were more than I may read" is a distinguishable fact rather
    // than a quietly short list, and a total order so a bound that binds binds
    // reproducibly.
    const { db } = makeDb(bookingRow(), [CLUB_ON]);
    await evaluatePersistedBookingAdultMemberHostingReadOnly("booking-1", db, {
      siblingCeiling: 3,
    });
    const args = db.booking.findMany.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.take).toBe(4);
    expect(args.orderBy).toEqual([{ checkIn: "asc" }, { id: "asc" }]);
  });

  it("REFUSES rather than truncating when the ceiling binds", async () => {
    // A short host list and "I cannot tell you" are different answers, and the first
    // one reads as authoritative. Four siblings against a ceiling of three.
    const siblings = [1, 2, 3, 4].map((index) =>
      bookingRow({ id: `sibling-${index}`, parentBookingId: "booking-1" }),
    );
    const { db } = makeDb(bookingRow(), [CLUB_ON], siblings);
    await expect(
      evaluatePersistedBookingAdultMemberHostingReadOnly("booking-1", db, {
        siblingCeiling: 3,
      }),
    ).rejects.toThrow(/refusing an inconclusive answer/);
  });

  it("passes the caller's lockout mode to the bridge instead of letting it peek", async () => {
    // The bridge otherwise reads the mode through functions that swallow a database
    // failure into NO_BLOCK, so an evidence caller would report a fabricated hosting
    // answer for an enforcing club after one transient failure.
    const { db } = makeDb(bookingRow(), [CLUB_ON]);
    await evaluatePersistedBookingAdultMemberHostingReadOnly("booking-1", db, {
      subscriptionLockoutMode: "NON_MEMBER_PRICING",
    });
    const call = subscriptionBridge.loadUnpaidSubscriptionMemberIds.mock
      .calls[0] as unknown as [unknown, { mode?: string }] | undefined;
    expect(call?.[1]?.mode).toBe("NON_MEMBER_PRICING");
  });

  it("leaves the mode absent when no caller supplies one, so the bridge peeks as before", async () => {
    const { db } = makeDb(bookingRow(), [CLUB_ON]);
    await evaluatePersistedBookingAdultMemberHostingReadOnly("booking-1", db);
    const call = subscriptionBridge.loadUnpaidSubscriptionMemberIds.mock
      .calls[0] as unknown as [unknown, { mode?: string }] | undefined;
    expect(call?.[1]?.mode).toBeUndefined();
  });

  it("uses the season the caller resolved, when it resolved one", async () => {
    // THE SEAM #2376 NEEDS. A read-only evidence caller has no gated request
    // behind it, so nothing has seeded that cache and a club whose financial year
    // does not end in March would have its hosts judged against another season's
    // `MemberSubscription` rows. AI Diagnostics resolves the year-end month from
    // stored state, refuses when it cannot, and passes the season here — and the
    // number below is deliberately one no derivation from this fixture produces,
    // so a dropped parameter cannot pass by coincidence.
    const { db } = makeDb(bookingRow(), [CLUB_ON]);
    await evaluatePersistedBookingAdultMemberHostingReadOnly("booking-1", db, {
      seasonYear: 2029,
    });
    expect(seasonAsked()).toBe(2029);
  });
});
