// The owner's performance gate on the family-boundary recomputation.
//
// Finding 4 of the MG3 (#2308) privacy re-review, and a BINDING OWNER DECISION
// (1 Aug 2026) that reverses what `markCrossFamilyGuestsOnBooking` used to
// document about itself ("NOT GATED ON THE MODULE FLAG, deliberately").
//
// The rule: the recomputation runs on a booking-change request only when EITHER
// the club's member-guest module is effectively enabled, OR the booking already
// carries a member-guest consent row. It must NOT run for every booking at every
// club where the module is off and no consent data was ever written.
//
// THE CONSENT-ROW ARM IS THE WHOLE REASON A GATE IS SAFE, and it is the objection
// the old "not gated" paragraph was written against: without it, a club that used
// the module and then switched it off would re-open C1's read-out on every
// booking it had already created. So it gets a test of its own, and so does the
// case where the gate cannot answer — because "I could not tell" silently
// becoming "the module is off" is exactly the failure mode C1 was.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  isEffectiveModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/admin-modules", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-modules")),
  isEffectiveModuleEnabled: h.isEffectiveModuleEnabled,
}));

import { markCrossFamilyGuestsOnBooking } from "@/lib/member-guest-add-policy";

const BOOKER = "m-booker";
const CHILD = "m-child";
const OUTSIDER = "m-outsider";
const BOOKING = "bk-1";

type Counters = {
  familyReads: number;
  consentReads: number;
};

/**
 * A db that can answer both arms of the gate and the boundary itself, counting
 * every read so a test can assert what was NOT done as well as what was.
 *
 * `consentRow` is whether this booking carries a non-null `consentStatus` on any
 * guest row — arm (b). `withoutGateDelegates` drops the two delegates the gate
 * needs, which is the narrowed test double / un-taught caller case.
 */
function gateDb(options: {
  consentRow: boolean;
  family?: string[];
  withoutGateDelegates?: boolean;
}) {
  const counters: Counters = { familyReads: 0, consentReads: 0 };
  const family = options.family ?? [BOOKER, CHILD];
  const db: Record<string, unknown> = {
    familyGroupMember: {
      findMany: async (args: {
        where: { memberId?: string; familyGroupId?: { in: string[] } };
      }) => {
        counters.familyReads += 1;
        return args.where.memberId
          ? [{ familyGroupId: "fg-1" }]
          : family.map((memberId) => ({ memberId }));
      },
    },
    member: { findMany: async () => [] },
  };
  if (!options.withoutGateDelegates) {
    db.clubModuleSettings = { findUnique: async () => null };
    db.bookingGuest = {
      findFirst: async () => {
        counters.consentReads += 1;
        return options.consentRow ? { id: "bg-1" } : null;
      },
    };
  }
  return { db, counters };
}

const party = () => [{ memberId: OUTSIDER }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the owner's gate on the family-boundary recomputation (#2308 finding 4)", () => {
  it("SKIPS the recomputation when the module is off and the booking has no consent row", async () => {
    // The case the decision is about: an ordinary booking at a club that never
    // adopted the feature. No marker, and — the point of the gate — no
    // FamilyGroupMember reads at all.
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    const { db, counters } = gateDb({ consentRow: false });

    const guests = await markCrossFamilyGuestsOnBooking(
      db as never,
      BOOKER,
      party(),
      { bookingId: BOOKING },
    );

    expect(guests[0]).not.toHaveProperty("crossFamilyMemberGuest");
    expect(counters.familyReads).toBe(0);
    expect(counters.consentReads).toBe(1);
  });

  it("RUNS the recomputation when the module is enabled", async () => {
    h.isEffectiveModuleEnabled.mockResolvedValue(true);
    const { db, counters } = gateDb({ consentRow: false });

    const guests = await markCrossFamilyGuestsOnBooking(
      db as never,
      BOOKER,
      party(),
      { bookingId: BOOKING },
    );

    expect(guests[0]).toMatchObject({ crossFamilyMemberGuest: true });
    expect(counters.familyReads).toBeGreaterThan(0);
    // Arm (a) answered, so the booking read is never issued on an adopting club.
    expect(counters.consentReads).toBe(0);
  });

  it("RUNS it for a booking that carries a consent row even with the module OFF", async () => {
    // The arm that keeps legacy and in-flight bookings protected when a club
    // switches the module off. Without it the gate would re-open C1's read-out
    // on every booking that club had already created.
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    const { db, counters } = gateDb({ consentRow: true });

    const guests = await markCrossFamilyGuestsOnBooking(
      db as never,
      BOOKER,
      party(),
      { bookingId: BOOKING },
    );

    expect(guests[0]).toMatchObject({ crossFamilyMemberGuest: true });
    expect(counters.consentReads).toBe(1);
    expect(counters.familyReads).toBeGreaterThan(0);
  });

  it("FAILS CLOSED — no bookingId means the gate abstains and the marking runs", async () => {
    // A caller that has not been taught the option must not silently lose the
    // protection. "I could not tell" is not "the module is off".
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    const { db, counters } = gateDb({ consentRow: false });

    const guests = await markCrossFamilyGuestsOnBooking(db as never, BOOKER, party());

    expect(guests[0]).toMatchObject({ crossFamilyMemberGuest: true });
    expect(counters.familyReads).toBeGreaterThan(0);
    expect(h.isEffectiveModuleEnabled).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED — a db that cannot answer either arm marks anyway", async () => {
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    const { db, counters } = gateDb({
      consentRow: false,
      withoutGateDelegates: true,
    });

    const guests = await markCrossFamilyGuestsOnBooking(
      db as never,
      BOOKER,
      party(),
      { bookingId: BOOKING },
    );

    expect(guests[0]).toMatchObject({ crossFamilyMemberGuest: true });
    expect(counters.familyReads).toBeGreaterThan(0);
  });

  it("asks the module question on the CALLER'S OWN client", async () => {
    // The modify paths call this inside `prisma.$transaction` while holding the
    // per-lodge capacity lock. Reading the module singleton off the global
    // client would take a second connection under that lock — the ordering rule
    // at the top of `member-guest-add-policy.ts`, applied to a read the file did
    // not previously make.
    h.isEffectiveModuleEnabled.mockResolvedValue(true);
    const { db } = gateDb({ consentRow: false });

    await markCrossFamilyGuestsOnBooking(db as never, BOOKER, party(), {
      bookingId: BOOKING,
    });

    expect(h.isEffectiveModuleEnabled).toHaveBeenCalledWith("memberGuests", db);
  });

  it("still short-circuits on skipAuthorization and on a party with no members", async () => {
    // Both early returns come BEFORE the gate, so an admin path and a
    // non-member-only party cost nothing at all — unchanged by finding 4.
    h.isEffectiveModuleEnabled.mockResolvedValue(true);
    const admin = gateDb({ consentRow: false });
    await markCrossFamilyGuestsOnBooking(admin.db as never, BOOKER, party(), {
      bookingId: BOOKING,
      skipAuthorization: true,
    });
    expect(admin.counters.consentReads).toBe(0);
    expect(admin.counters.familyReads).toBe(0);

    const noMembers = gateDb({ consentRow: false });
    await markCrossFamilyGuestsOnBooking(
      noMembers.db as never,
      BOOKER,
      [{ memberId: null }],
      { bookingId: BOOKING },
    );
    expect(noMembers.counters.consentReads).toBe(0);
    expect(noMembers.counters.familyReads).toBe(0);
    expect(h.isEffectiveModuleEnabled).not.toHaveBeenCalled();
  });

  it("degrades coherently: gate skipped means no marker, so nothing downstream charges", async () => {
    // The accepted trade, asserted rather than assumed. Everything keyed off the
    // marker goes quiet together — including the whole-party throttle charge,
    // which filters on exactly this flag. Half-protected would be worse: a
    // charged request that still discloses.
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    const { db } = gateDb({ consentRow: false });

    const guests = await markCrossFamilyGuestsOnBooking(
      db as never,
      BOOKER,
      party(),
      { bookingId: BOOKING },
    );

    const { applyMemberGuestPartyProbeThrottle } = await import(
      "@/lib/member-guest-probe-guard"
    );
    const throttled = await applyMemberGuestPartyProbeThrottle({
      request: new Request("https://club.example/api/bookings/bk-1/modify-quote", {
        method: "POST",
      }),
      actorMemberId: BOOKER,
      guests,
      ledger: { spent: false },
    });
    expect(throttled).toBeNull();
  });
});
