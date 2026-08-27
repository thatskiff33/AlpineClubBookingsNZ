// "+ Add Member Guest" (epic #2305) MG2 (#2307) — THE CONSENT STATE MACHINE.
//
// `PENDING -> CONFIRMED | DECLINED | EXPIRED`, one-way and terminal (owner
// decision D-13: no later modification of the booking re-opens a settled
// consent). Three properties are worth the whole file:
//
//   1. NO EXISTENCE ORACLE. A booking id that does not exist, a guest id that
//      does not exist, a guest row on somebody else's booking, a row that has
//      already been answered, and a caller who is neither the target nor an
//      accepted delegate must all get the SAME 403 with the SAME body. This
//      endpoint takes two ids straight off a URL; if any of those cases had its
//      own message, the endpoint would answer "is member X on booking Y?" for
//      anyone who cared to ask.
//
//   2. IDEMPOTENCY THROUGH ONE MECHANISM. Every side effect — the removal, the
//      bed reconcile, the audit entry, the emails — hangs off the count returned
//      by the status-guarded `updateMany` in `claimConsentTransition`. Double
//      answers, an answer racing the nightly sweep, and two delegates answering
//      at once therefore all resolve to exactly one winner and exactly one set of
//      consequences.
//
//   3. OWNER DECISION D-14 AS TICKED. A member who never consented gets NO
//      exemption from the ordinary self-removal blockers. There are five ways a
//      decline can be refused, each is asserted separately, and in every one of
//      them the row survives as a *blocked* row — still holding its bed, still on
//      the booking, on the admin exception list (D-15) — rather than
//      half-removed.
//
// MUTATION PROBE 3 (the status-guarded claim): replace the `updateMany` in
// `claimConsentTransition` with a bare `update` by id and these tests fail —
// "a second approval changes nothing and resolves as ALREADY_RESOLVED",
// "a decline that loses the race to the sweep takes no side effects", and
// "an approval and a decline racing each other produce exactly one winner".
// The fake database below deliberately implements BOTH `updateMany` (honouring
// the `consentStatus: "PENDING"` guard the way Postgres would) and an
// unconditional `update`, so the probe is genuinely reproducible rather than
// merely described.
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  /**
   * The shared removal path's own error class, re-declared here because the whole
   * module is mocked. The service does `err instanceof BookingGuestRemovalError`,
   * so the class the mock exports and the class the tests throw must be the same
   * object — which is why it lives in the hoisted block.
   */
  class BookingGuestRemovalError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }

  return {
    BookingGuestRemovalError,
    /** Set in beforeEach; the mocked `prisma` reads through to it. */
    state: { world: null as unknown as World },
    removeGuest: vi.fn(),
    acquireLodgeCapacityLock: vi.fn(),
    getDefaultLodgeId: vi.fn(),
    reconcileBeds: vi.fn(),
    enqueueHostingCoverage: vi.fn(async () => 0),
    settleHostingCoverage: vi.fn(async () => ({})),
    logAudit: vi.fn(),
    sendOutcomeEmail: vi.fn(),
    sendExpiredEmail: vi.fn(),
    sendAnsweredEmail: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (tx: unknown) => unknown) => h.state.world.$transaction(cb),
    bookingGuest: {
      findUnique: (args: unknown) => h.state.world.bookingGuest.findUnique(args as never),
    },
    booking: {
      findUnique: (args: unknown) => h.state.world.booking.findUnique(args as never),
    },
    member: {
      findUnique: (args: unknown) => h.state.world.member.findUnique(args as never),
      findMany: () => h.state.world.member.findMany(),
    },
    // The lapse notice reaches the member through the real delegate resolver, so
    // the fake has to answer its queries too rather than have them throw into the
    // notifier's catch-all and look like "nobody to tell".
    familyGroupMember: {
      findMany: () => h.state.world.familyGroupMember.findMany(),
    },
  },
}));
vi.mock("@/lib/booking-guest-removal-service", () => ({
  BookingGuestRemovalError: h.BookingGuestRemovalError,
  removeBookingGuestInTransaction: h.removeGuest,
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
}));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: h.getDefaultLodgeId }));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: h.reconcileBeds,
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: h.enqueueHostingCoverage,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: h.settleHostingCoverage,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/email/member-guest", () => ({
  sendMemberGuestConsentOutcomeEmail: h.sendOutcomeEmail,
  sendMemberGuestConsentExpiredEmail: h.sendExpiredEmail,
  sendMemberGuestConsentAnsweredEmail: h.sendAnsweredEmail,
}));
vi.mock("@/lib/logger", () => ({
  default: {
    error: h.loggerError,
    warn: h.loggerWarn,
    info: h.loggerInfo,
    debug: vi.fn(),
  },
}));

import {
  MemberGuestConsentError,
  classifyConsentRemovalRefusal,
  describeConsentBlockedRemedy,
  expireMemberGuestConsent,
  finaliseMemberGuestConsentTransition,
  respondToMemberGuestConsent,
  type MemberGuestConsentBlockedReason,
} from "@/lib/member-guest-consent-service";
import type { MemberGuestConsentDelegateResolver } from "@/lib/member-guest-delegate";
// The REAL error classes the shared removal path raises, imported rather than
// re-declared: the service decides what is a refusal with `instanceof`, so a
// lookalike would prove nothing. `BookingGuestRemovalError` is the exception — the
// whole removal module is mocked, so its class is declared in the hoisted block
// above and re-exported by the mock.
import { ApiError } from "@/lib/api-error";
import { MembershipTypeBookingPolicyError } from "@/lib/membership-type-policy";

// Test helper: reads a fixed repo file under process.cwd(); the path is
// test-controlled, not user input.
function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------
const BOOKING = "bk-1";
const OTHER_BOOKING = "bk-2";
const GUEST = "g-target";
const OTHER_GUEST = "g-other-booking";
const OWNER = "m-owner";
const TARGET = "m-target";
const DELEGATE = "m-delegate";
const STRANGER = "m-stranger";
const NOW = new Date("2026-08-01T02:00:00.000Z");
const REQUESTED_AT = new Date("2026-07-25T02:00:00.000Z");
const EXPIRES_AT = new Date("2026-08-01T01:00:00.000Z"); // one hour ago

type GuestRow = {
  id: string;
  bookingId: string;
  memberId: string | null;
  consentStatus: string | null;
  consentRequestedAt: Date | null;
  consentRespondedAt: Date | null;
  consentRespondedByMemberId: string | null;
  consentExpiresAt: Date | null;
};

function pendingGuest(overrides: Partial<GuestRow> = {}): GuestRow {
  return {
    id: GUEST,
    bookingId: BOOKING,
    memberId: TARGET,
    consentStatus: "PENDING",
    consentRequestedAt: REQUESTED_AT,
    consentRespondedAt: null,
    consentRespondedByMemberId: null,
    consentExpiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/**
 * A hand-written stand-in for the Prisma client, not a per-call mock.
 *
 * The guard on `updateMany` IS the thing under test, so the fake has to evaluate
 * it the way Postgres would — a `where` naming a status the row no longer carries
 * matches nothing and reports `count: 0`. `update` is implemented too, and
 * unconditionally, so mutation probe 3 (swap the guarded `updateMany` for a bare
 * `update`) really does produce two winners and really does fail a test.
 *
 * `raceHook` runs at the top of every transaction, which is the honest place to
 * simulate "somebody else's claim committed while this caller was authorizing":
 * the authorization read happens before the transaction opens, so a row that
 * changes hands in between is exactly the race the guard exists for.
 */
type World = ReturnType<typeof makeWorld>;

function makeWorld(rows: GuestRow[]) {
  const guests = new Map(rows.map((row) => [row.id, { ...row }]));
  // The shared removal path deletes a guest's chore assignments BEFORE the two
  // gates that can still refuse, so they are the second thing a half-completed
  // removal destroys. Modelled here so "the removal was rolled back" is an
  // observable fact about two tables rather than an assertion about one.
  const choreAssignments = new Map<string, string[]>([
    [GUEST, ["chore-fire", "chore-dishes"]],
    [OTHER_GUEST, ["chore-fire"]],
  ]);
  const bookings = new Map([
    [
      BOOKING,
      {
        id: BOOKING,
        lodgeId: "lodge-1",
        memberId: OWNER,
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-22T00:00:00.000Z"),
        member: { id: OWNER, email: "owner@example.com", firstName: "Ophelia" },
      },
    ],
    [
      OTHER_BOOKING,
      {
        id: OTHER_BOOKING,
        lodgeId: "lodge-1",
        memberId: OWNER,
        checkIn: new Date("2026-09-20T00:00:00.000Z"),
        checkOut: new Date("2026-09-22T00:00:00.000Z"),
        member: { id: OWNER, email: "owner@example.com", firstName: "Ophelia" },
      },
    ],
  ]);
  // Both fixture members hold logins of their own, so a lapse notice goes to the
  // member who was asked without any family lookup. The no-login case is the
  // delegate resolver's own suite (member-guest-delegate.test.ts).
  const members = new Map([
    [
      TARGET,
      {
        id: TARGET,
        active: true,
        canLogin: true,
        ageTier: "ADULT",
        email: "target@example.com",
        firstName: "Tania",
        lastName: "Target",
      },
    ],
    [
      OWNER,
      {
        id: OWNER,
        active: true,
        canLogin: true,
        ageTier: "ADULT",
        email: "owner@example.com",
        firstName: "Ophelia",
        lastName: "Owner",
      },
    ],
  ]);

  const state = { raceHook: null as null | (() => void) };

  const bookingGuest = {
    findUnique: vi.fn(async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
      const row = guests.get(args.where.id);
      if (!row) return null;
      return args.select?.booking
        ? { ...row, booking: bookings.get(row.bookingId) ?? null }
        : { ...row };
    }),
    // The status-guarded claim, evaluated as SQL would.
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = guests.get(args.where.id as string);
        if (!row) return { count: 0 };
        if ("consentStatus" in args.where && row.consentStatus !== args.where.consentStatus) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
    ),
    // Unconditional, on purpose: see mutation probe 3.
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = guests.get(args.where.id);
      if (!row) throw new Error("record not found");
      Object.assign(row, args.data);
      return { ...row };
    }),
  };

  const booking = {
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
      const row = bookings.get(args.where.id);
      return row ? { ...row } : null;
    }),
  };

  const member = {
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
      const row = members.get(args.where.id);
      return row ? { ...row } : null;
    }),
    // These two exist so the delegate resolver's queries resolve rather than
    // throw; the fixture members all hold logins, so nothing reads the results.
    findMany: vi.fn(async () => []),
  };

  const familyGroupMember = { findMany: vi.fn(async () => []) };

  const tx = {
    $executeRaw: vi.fn(async () => 0),
    bookingGuest,
    booking,
    member,
  };

  return {
    guests,
    choreAssignments,
    members,
    bookings,
    state,
    bookingGuest,
    booking,
    member,
    familyGroupMember,
    tx,
    /**
     * A transaction that actually ROLLS BACK, which this fake previously did not.
     *
     * Without it the tests could not tell a refusal that unwound its writes from
     * one that committed them, and that difference is the whole of finding H1: the
     * removal path deletes the chore assignments and the guest row before its last
     * two gates run, so a refusal that merely RETURNS lets Prisma commit a
     * half-completed removal — the guest gone, the price never recalculated, no
     * credit, and no blocked row for the admin exception list to show. Postgres
     * would have thrown all of that away; so does this.
     */
    $transaction: vi.fn(async (cb: (client: typeof tx) => unknown) => {
      state.raceHook?.();
      const guestSnapshot = new Map(
        [...guests.entries()].map(([id, row]) => [id, { ...row }]),
      );
      const choreSnapshot = new Map(
        [...choreAssignments.entries()].map(([id, list]) => [id, [...list]]),
      );
      try {
        return await cb(tx);
      } catch (err) {
        guests.clear();
        for (const [id, row] of guestSnapshot) guests.set(id, row);
        choreAssignments.clear();
        for (const [id, list] of choreSnapshot) choreAssignments.set(id, list);
        throw err;
      }
    }),
  };
}

/** A resolver that accepts exactly one delegate, so the seam stays under test. */
const acceptDelegate: MemberGuestConsentDelegateResolver = {
  canRespondForTarget: async ({ actorMemberId }) => actorMemberId === DELEGATE,
  resolveNotificationRecipients: async () => [],
};

function world(): World {
  return h.state.world;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.world = makeWorld([
    pendingGuest(),
    pendingGuest({ id: OTHER_GUEST, bookingId: OTHER_BOOKING }),
  ]);
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.reconcileBeds.mockResolvedValue(undefined);
  h.logAudit.mockResolvedValue(undefined);
  h.sendOutcomeEmail.mockResolvedValue(undefined);
  h.sendExpiredEmail.mockResolvedValue(undefined);
  h.sendAnsweredEmail.mockResolvedValue(undefined);
  // The shared removal path succeeds and DELETES the row, exactly as the real one
  // does — so "the row is gone" and "the row survived as blocked" are different
  // observable states in these tests rather than the same one.
  h.removeGuest.mockImplementation(async ({ guestId }: { guestId: string }) => {
    world().choreAssignments.delete(guestId);
    world().guests.delete(guestId);
    return { accountCreditAmountCents: 0 };
  });
});

/**
 * A refusal that WRITES FIRST, exactly where the real removal path writes.
 *
 * `removeBookingGuestInTransaction` runs its last-guest and quote-priced gates,
 * then deletes the guest's chore assignments and the guest row, and only THEN
 * checks the membership-type policy on the remaining guests and asks whether a
 * settled booking needs a refund-or-credit election. A test whose refusal mock
 * throws without writing anything cannot distinguish a rolled-back refusal from a
 * committed half-removal — it asserts against a mock that did nothing — so every
 * refusal in this file goes through here.
 */
function refuseAfterPartialRemoval(error: Error) {
  h.removeGuest.mockImplementationOnce(async ({ guestId }: { guestId: string }) => {
    world().choreAssignments.delete(guestId);
    world().guests.delete(guestId);
    throw error;
  });
}

// ---------------------------------------------------------------------------
// 1. Who may answer
// ---------------------------------------------------------------------------
describe("respondToMemberGuestConsent — authorization", () => {
  it("lets the target approve, and records that they answered for themselves", async () => {
    const result = await respondToMemberGuestConsent({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId: TARGET,
      action: "APPROVE",
      now: NOW,
      delegateResolver: acceptDelegate,
    });

    expect(result).toEqual({ outcome: "APPROVED" });
    expect(world().guests.get(GUEST)).toMatchObject({
      consentStatus: "CONFIRMED",
      consentRespondedAt: NOW,
      consentRespondedByMemberId: TARGET,
    });
    // An approval adds an occupant, so nothing is removed.
    expect(h.removeGuest).not.toHaveBeenCalled();
    expect(h.enqueueHostingCoverage).toHaveBeenCalledWith(
      TARGET,
      expect.anything(),
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE", actorMemberId: TARGET },
    );
  });

  it("records the DELEGATE as the responder, not the target they answered for", async () => {
    // This is the entire reason `consentRespondedByMemberId` is its own column
    // (sub-states TARGET_APPROVED vs DELEGATE_APPROVED). Writing the target's id
    // here would attribute to them an act somebody else performed, and MG4's audit
    // reads exactly this column to say who stood behind the add.
    const result = await respondToMemberGuestConsent({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId: DELEGATE,
      action: "APPROVE",
      now: NOW,
      delegateResolver: acceptDelegate,
    });

    expect(result).toEqual({ outcome: "APPROVED" });
    expect(world().guests.get(GUEST)?.consentRespondedByMemberId).toBe(DELEGATE);
    expect(world().guests.get(GUEST)?.consentRespondedByMemberId).not.toBe(TARGET);
  });

  it("gives a byte-identical 403 to every kind of caller who may not act", async () => {
    // THE NO-EXISTENCE-ORACLE TEST, and it is one test on purpose: five scenarios
    // compared against each other, so a future "helpful" message on any one of
    // them breaks it. Both ids come straight off a URL, and a distinguishable
    // refusal would turn this endpoint into a lookup for who is on which booking.
    world().guests.set(
      "g-answered",
      pendingGuest({ id: "g-answered", consentStatus: "CONFIRMED", consentRespondedAt: NOW }),
    );

    const attempts: Array<[string, { bookingId: string; guestId: string; actorMemberId: string }]> = [
      // A booking id nobody has ever heard of.
      ["unknown booking id", { bookingId: "bk-nope", guestId: GUEST, actorMemberId: TARGET }],
      // A guest id nobody has ever heard of.
      ["unknown guest id", { bookingId: BOOKING, guestId: "g-nope", actorMemberId: TARGET }],
      // A real guest row, a real booking — but not each other's.
      ["guest belonging to another booking", { bookingId: BOOKING, guestId: OTHER_GUEST, actorMemberId: TARGET }],
      // Already answered: indistinguishable from "not yours" by design.
      ["a row that is no longer PENDING", { bookingId: BOOKING, guestId: "g-answered", actorMemberId: TARGET }],
      // Neither the target nor an accepted delegate.
      ["an unauthorised actor", { bookingId: BOOKING, guestId: GUEST, actorMemberId: STRANGER }],
    ];

    const seen: { label: string; message: string; status: number }[] = [];
    for (const [label, params] of attempts) {
      const error = await respondToMemberGuestConsent({
        ...params,
        action: "APPROVE",
        now: NOW,
        delegateResolver: acceptDelegate,
      }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error, label).toBeInstanceOf(MemberGuestConsentError);
      const typed = error as MemberGuestConsentError;
      seen.push({ label, message: typed.message, status: typed.status });
    }

    // Every refusal is the same refusal.
    expect(new Set(seen.map((entry) => entry.message))).toEqual(new Set(["Forbidden"]));
    expect(new Set(seen.map((entry) => entry.status))).toEqual(new Set([403]));
    for (const entry of seen) {
      expect(entry, entry.label).toMatchObject({ message: "Forbidden", status: 403 });
    }

    // And a refused caller changes nothing and learns nothing from timing either:
    // no claim is attempted, nothing is removed, and no mail goes out.
    expect(world().bookingGuest.updateMany).not.toHaveBeenCalled();
    expect(h.removeGuest).not.toHaveBeenCalled();
    expect(h.sendOutcomeEmail).not.toHaveBeenCalled();
  });

  it("refuses a non-member guest row outright", async () => {
    // A guest row with no `memberId` is a plain named guest — nobody's consent to
    // give, and no member id an actor could match.
    world().guests.set("g-nonmember", pendingGuest({ id: "g-nonmember", memberId: null }));
    await expect(
      respondToMemberGuestConsent({
        bookingId: BOOKING,
        guestId: "g-nonmember",
        actorMemberId: TARGET,
        action: "APPROVE",
        now: NOW,
        delegateResolver: acceptDelegate,
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });
});

// ---------------------------------------------------------------------------
// 2. The decline path
// ---------------------------------------------------------------------------
describe("respondToMemberGuestConsent — DECLINE", () => {
  it("claims DECLINED and then removes through the shared removal path", async () => {
    // ONE removal semantics, never a bespoke second delete: capacity release,
    // night deletion, repricing, promo revalidation, chore cleanup and the bed
    // reconcile are all inherited from the path a member's own self-removal uses,
    // so a decline and a self-removal cannot diverge.
    const result = await respondToMemberGuestConsent({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId: TARGET,
      action: "DECLINE",
      now: NOW,
      delegateResolver: acceptDelegate,
    });

    expect(result).toMatchObject({ outcome: "DECLINED", removed: true });
    expect(h.removeGuest).toHaveBeenCalledTimes(1);
    const call = h.removeGuest.mock.calls[0][0];
    expect(call).toMatchObject({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId: TARGET,
      actorRole: "MEMBER",
      consentAuthority: {
        kind: "CONSENT_DECLINE",
        guestId: GUEST,
        targetMemberId: TARGET,
      },
    });
    // A member's own decline elects nothing: D-15's credit election belongs to the
    // sweep (a timer the club configured), never to a person declining.
    expect(call.settlementMethod).toBeUndefined();
    expect(world().guests.has(GUEST)).toBe(false);
  });

  it("names the delegate as the actor on the removal, not the target", async () => {
    // `actorMemberId` stays the truthful actor all the way down, so the booking
    // modification and audit trail name who actually refused.
    await respondToMemberGuestConsent({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId: DELEGATE,
      action: "DECLINE",
      now: NOW,
      delegateResolver: acceptDelegate,
    });
    expect(h.removeGuest.mock.calls[0][0]).toMatchObject({
      actorMemberId: DELEGATE,
      consentAuthority: { targetMemberId: TARGET },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotency — the status-guarded claim
// ---------------------------------------------------------------------------
describe("the status-guarded claim resolves every race to one winner", () => {
  async function respond(actorMemberId: string, action: "APPROVE" | "DECLINE") {
    return respondToMemberGuestConsent({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId,
      action,
      now: NOW,
      delegateResolver: acceptDelegate,
    });
  }

  it("a second approval changes nothing and resolves as ALREADY_RESOLVED", async () => {
    // MUTATION PROBE 3 breaks here first. The second caller reads the row as
    // PENDING (the sweep's own claim lands between the read and the transaction)
    // and must lose at the guard; a bare `update` by id would let both "win" and
    // stamp a second responder over the first.
    await respond(TARGET, "APPROVE");
    const first = { ...world().guests.get(GUEST)! };

    world().state.raceHook = null;
    // Re-open the read as PENDING but leave the stored row CONFIRMED, which is
    // exactly what the loser of a race sees.
    world().bookingGuest.findUnique.mockImplementationOnce(async () => ({
      ...first,
      consentStatus: "PENDING",
    }));

    const second = await respond(DELEGATE, "APPROVE");
    expect(second).toEqual({ outcome: "ALREADY_RESOLVED" });
    // Byte-for-byte the winner's row: no second respondedAt, no second responder.
    expect(world().guests.get(GUEST)).toEqual(first);
  });

  it("a second decline removes nothing a second time", async () => {
    await respond(TARGET, "DECLINE");
    expect(h.removeGuest).toHaveBeenCalledTimes(1);

    // The row is gone, so the loser's unlocked read finds nothing and the uniform
    // 403 applies — the same answer a stranger gets, which is the point.
    await expect(respond(DELEGATE, "DECLINE")).rejects.toMatchObject({
      message: "Forbidden",
      status: 403,
    });
    expect(h.removeGuest).toHaveBeenCalledTimes(1);
  });

  it("a decline that loses the race to the sweep takes no side effects", async () => {
    // The real shape of the race: the row is PENDING when the member's browser
    // posts, and the 04:30 sweep commits its EXPIRED claim while the request is
    // authorizing. MUTATION PROBE 3 fails here: with a bare `update` the loser
    // would overwrite EXPIRED with DECLINED and go on to remove the guest a second
    // time.
    world().state.raceHook = () => {
      const row = world().guests.get(GUEST)!;
      row.consentStatus = "EXPIRED";
    };

    const result = await respond(TARGET, "DECLINE");
    expect(result).toEqual({ outcome: "ALREADY_RESOLVED" });
    expect(world().guests.get(GUEST)?.consentStatus).toBe("EXPIRED");
    expect(h.removeGuest).not.toHaveBeenCalled();
  });

  it("an approval and a decline racing each other produce exactly one winner", async () => {
    // Two people answering at once — a target and their delegate, on two phones.
    // Both read PENDING; exactly one claim can succeed. MUTATION PROBE 3 fails
    // here too, and this is the case where a bare `update` would be worst: the row
    // would end up CONFIRMED *and* removed.
    const [a, b] = await Promise.all([respond(TARGET, "APPROVE"), respond(DELEGATE, "DECLINE")]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toContain("ALREADY_RESOLVED");
    expect(outcomes.filter((outcome) => outcome === "ALREADY_RESOLVED")).toHaveLength(1);
    // Whichever won, the row is in exactly one terminal state and the removal ran
    // at most once.
    const survivor = world().guests.get(GUEST);
    if (survivor) {
      expect(survivor.consentStatus).toBe("CONFIRMED");
      expect(h.removeGuest).not.toHaveBeenCalled();
    } else {
      expect(h.removeGuest).toHaveBeenCalledTimes(1);
    }
  });

  it("expiring an already-approved request does nothing", async () => {
    // D-13: CONFIRMED is terminal. The sweep meeting an approved row is not an
    // error and not a re-open — it is a no-op with no side effects.
    await respond(TARGET, "APPROVE");
    const confirmed = { ...world().guests.get(GUEST)! };

    const result = await expireMemberGuestConsent({ guestId: GUEST, now: NOW });
    expect(result).toEqual({ outcome: "ALREADY_RESOLVED" });
    expect(world().guests.get(GUEST)).toEqual(confirmed);
    expect(h.removeGuest).not.toHaveBeenCalled();
  });

  it("approving a request the sweep already expired is refused, not silently honoured", async () => {
    // The other order. An EXPIRED row is no longer PENDING, so the member gets the
    // uniform 403 rather than a message telling them their request lapsed —
    // because the same reply has to serve a caller who was never entitled to that
    // row at all.
    world().guests.get(GUEST)!.consentStatus = "EXPIRED";
    await expect(respond(TARGET, "APPROVE")).rejects.toMatchObject({
      message: "Forbidden",
      status: 403,
    });
    expect(world().bookingGuest.updateMany).not.toHaveBeenCalled();
  });

  it("gives the loser of a race no side effects at all", async () => {
    // Said once on its own, because "one winner" is only half the property. The
    // loser must produce NO removal, NO bed reconcile, NO audit entry and NO
    // email — a second set of those would be a lie told to the booking owner.
    await finaliseMemberGuestConsentTransition({
      bookingId: BOOKING,
      guestId: GUEST,
      targetMemberId: TARGET,
      outcome: { outcome: "ALREADY_RESOLVED" },
      actorMemberId: TARGET,
    });

    expect(h.removeGuest).not.toHaveBeenCalled();
    expect(h.reconcileBeds).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
    expect(h.sendOutcomeEmail).not.toHaveBeenCalled();
    expect(h.sendExpiredEmail).not.toHaveBeenCalled();
    expect(h.sendAnsweredEmail).not.toHaveBeenCalled();
  });

  it("reconciles beds and audits exactly once for a real approval", async () => {
    // The contrast case, so the previous test is a statement about losers rather
    // than about the finaliser doing nothing at all. An approval turns a held bed
    // into a real occupant, which is the one transition the removal path does not
    // reconcile for free.
    await finaliseMemberGuestConsentTransition({
      bookingId: BOOKING,
      guestId: GUEST,
      targetMemberId: TARGET,
      outcome: { outcome: "APPROVED" },
      actorMemberId: TARGET,
    });

    expect(h.reconcileBeds).toHaveBeenCalledTimes(1);
    expect(h.reconcileBeds).toHaveBeenCalledWith({ bookingId: BOOKING });
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "member_guest_consent_approved",
      outcome: "success",
      entityId: GUEST,
      subjectMemberId: TARGET,
    });
    expect(h.settleHostingCoverage).toHaveBeenCalledWith({ bookingId: BOOKING });
  });

  it("audits a blocked row as important-and-failed so an operator sees it", async () => {
    // D-15: a blocked row needs a human. Logged as a failure rather than as a
    // routine info line somebody would scroll past.
    await finaliseMemberGuestConsentTransition({
      bookingId: BOOKING,
      guestId: GUEST,
      targetMemberId: TARGET,
      outcome: {
        outcome: "BLOCKED",
        status: "EXPIRED",
        reason: "LAST_GUEST",
        message: "Cannot remove the last guest. Cancel the booking instead.",
      },
      actorMemberId: null,
      actorLabel: "cron:member-guest-consent-expiry",
    });

    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "member_guest_consent_blocked",
      severity: "important",
      outcome: "failure",
      metadata: { blockedReason: "LAST_GUEST" },
    });
    // No person acted, so no actor id is written — the sweep is named in metadata.
    expect(h.logAudit.mock.calls[0][0]).not.toHaveProperty("actorMemberId");
    expect(h.logAudit.mock.calls[0][0].metadata.actor).toBe(
      "cron:member-guest-consent-expiry",
    );
  });

  it("tells the member when a DELEGATE answered for them", async () => {
    // The loop D-10 left open. The booking's owner was told the outcome and the
    // adult who clicked obviously knew, but the member the answer was given FOR
    // heard nothing — even though a decline releases their bed and takes them off
    // a booking somebody else put them on. "A decline needs no notice: they just
    // made the decision themselves" is true of a member answering for themselves
    // and false of a delegate.
    world().members.get(TARGET)!.canLogin = false;

    await finaliseMemberGuestConsentTransition({
      bookingId: BOOKING,
      guestId: GUEST,
      targetMemberId: TARGET,
      outcome: { outcome: "DECLINED", removed: true, creditCents: 0 },
      actorMemberId: DELEGATE,
    });

    expect(h.sendAnsweredEmail).toHaveBeenCalledTimes(1);
    expect(h.sendAnsweredEmail.mock.calls[0][0]).toMatchObject({
      bookingId: BOOKING,
      email: "target@example.com",
      answer: { kind: "DECLINED_REMOVED" },
      target: { firstName: "Tania", lastName: "Target" },
    });
  });

  it("sends no such notice when the member answered for themselves", async () => {
    // The contrast case, so the test above is a statement about DELEGATES rather
    // than about the finaliser mailing everybody twice.
    await finaliseMemberGuestConsentTransition({
      bookingId: BOOKING,
      guestId: GUEST,
      targetMemberId: TARGET,
      outcome: { outcome: "DECLINED", removed: true, creditCents: 0 },
      actorMemberId: TARGET,
    });

    expect(h.sendAnsweredEmail).not.toHaveBeenCalled();
  });

  it("reports a blocked DECLINE to the booker as a decline, not as a lapse", async () => {
    // The member clicked "No thanks" the same day. Folding every BLOCKED outcome
    // into EXPIRED_STILL_ON_BOOKING told the booking's owner they "did not answer
    // in time", blamed them for silence they are not guilty of, and dated it with
    // whenever the email happened to be composed.
    await finaliseMemberGuestConsentTransition({
      bookingId: BOOKING,
      guestId: GUEST,
      targetMemberId: TARGET,
      outcome: {
        outcome: "BLOCKED",
        status: "DECLINED",
        reason: "OTHER",
        message: REFUSALS.SETTLED,
      },
      actorMemberId: TARGET,
    });

    const sent = h.sendOutcomeEmail.mock.calls[0][0];
    expect(sent.outcome.kind).toBe("DECLINED_STILL_ON_BOOKING");
    // ...and the reason names the settled payment rather than the vague
    // "this booking is in a state the system cannot change on its own".
    expect(sent.outcome.blocker).toBe("SETTLEMENT_CHOICE");
    expect(sent.outcome).not.toHaveProperty("expiredAt");
  });

  it("dates a lapse by the deadline the member was given, not by when the mail was written", async () => {
    await finaliseMemberGuestConsentTransition({
      bookingId: BOOKING,
      guestId: GUEST,
      targetMemberId: TARGET,
      outcome: { outcome: "EXPIRED", removed: true, creditCents: 0 },
      actorMemberId: null,
      actorLabel: "cron:member-guest-consent-expiry",
      consentExpiresAt: EXPIRES_AT,
    });

    expect(h.sendOutcomeEmail.mock.calls[0][0].outcome).toMatchObject({
      kind: "EXPIRED_REMOVED",
      expiredAt: EXPIRES_AT,
    });
  });

  it("keeps a failed email from undoing a committed consent decision", async () => {
    // The whole reason the notifications sit AFTER the commit and each in its own
    // try/catch: a mail provider being down must not roll back a decision, and
    // must not stop the next row in a sweep.
    h.sendOutcomeEmail.mockRejectedValueOnce(new Error("smtp down"));
    await expect(
      finaliseMemberGuestConsentTransition({
        bookingId: BOOKING,
        guestId: GUEST,
        targetMemberId: TARGET,
        outcome: { outcome: "APPROVED" },
        actorMemberId: TARGET,
      }),
    ).resolves.toBeUndefined();
    expect(h.loggerError).toHaveBeenCalled();
    // ...and the audit entry is still written.
    expect(h.logAudit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Owner decision D-14 — the trap matrix
// ---------------------------------------------------------------------------
//
// A pending guest may decline only when the booking's status allows guest
// changes, check-in is strictly in the future, there are two or more guests, the
// booking was not priced by hand, and no refund-vs-credit election is needed.
// D-14 was ticked with NO exemption from those blockers: a member who never
// consented can still be trapped on a booking, and the honest answer is to say so
// and route the row to an operator, not to invent a bypass that reprices somebody
// else's settled booking without their say.
//
// Each trap is its own test, and each asserts three things: the member sees the
// removal path's own plain-English 400 verbatim (never a paraphrase invented
// here), the reason an operator sees is derived from that same sentence, and the
// row SURVIVES as a blocked row rather than half-removed.
//
// The exact sentences are pinned against the real sources further down, so a
// reword upstream fails a test here instead of silently downgrading a
// classification to OTHER.
const REFUSALS = {
  /**
   * The COMMON case for a member-guest decline: member guests are charged up
   * front on the mixed-party split, so an ordinary paid booking needs a
   * refund-vs-credit election that only the owner (or an admin) may make.
   */
  SETTLED:
    "This booking has a settled payment, so a refund or account credit must be chosen. Ask the booking owner or an admin to remove this guest.",
  LAST_GUEST: "Cannot remove the last guest. Cancel the booking instead.",
  QUOTE_PRICED:
    "This booking keeps a negotiated booking-request price, so standard edits are disabled — they would reprice every guest at season rates. Re-price or issue a revised quote from its booking request instead.",
  STAY_NOT_FUTURE:
    "Only future booking guests can remove themselves from another member's booking",
  BOOKING_STATUS: "You cannot remove yourself from this booking in its current status",
} as const;

/**
 * A membership-type block on the guests LEFT BEHIND, built from the real class so
 * the test cannot pass against a lookalike.
 */
function membershipPolicyRefusal() {
  return new MembershipTypeBookingPolicyError([
    {
      scope: "MEMBER_GUEST",
      memberId: "m-left-behind",
      name: "Left Behind",
      seasonYear: 2026,
      membershipTypeKey: "SOCIAL",
      membershipTypeName: "Social",
      bookingBehavior: "BLOCKED" as never,
    },
  ]);
}

describe("D-14 — a decline refused, and a row left blocked rather than half-removed", () => {
  async function declineRefusedWith(error: Error) {
    refuseAfterPartialRemoval(error);
    return respondToMemberGuestConsent({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId: TARGET,
      action: "DECLINE",
      now: NOW,
      delegateResolver: acceptDelegate,
    });
  }

  /** Every trap ends the same way: claimed, still on the booking, needing a human. */
  function expectBlocked(
    result: Awaited<ReturnType<typeof declineRefusedWith>>,
    reason: MemberGuestConsentBlockedReason,
    message: string,
  ) {
    expect(result).toEqual({
      outcome: "BLOCKED",
      status: "DECLINED",
      reason,
      message,
    });
    // The row SURVIVES, carrying its terminal status: that combination IS the
    // blocked row D-15 puts on the admin exception list, and it is only reachable
    // because the refusal rolled the removal back and the status was then written
    // again over the restored row.
    expect(world().guests.get(GUEST)).toMatchObject({
      consentStatus: "DECLINED",
      consentRespondedByMemberId: TARGET,
      consentRespondedAt: NOW,
    });
    // And it survives WHOLE. The removal path had already deleted the chore
    // assignments and the guest row by the time these gates refused; if the
    // refusal were caught inside the transaction and returned, Prisma would have
    // committed both deletions and the "blocked row" above would be a row that no
    // longer exists — which is what the member is simultaneously told to ask an
    // admin about.
    expect(world().choreAssignments.get(GUEST)).toEqual(["chore-fire", "chore-dishes"]);
    // The operator's reason and the member's sentence are the same fact.
    expect(classifyConsentRemovalRefusal(message)).toBe(reason);
  }

  it("blocks a decline on a settled booking that needs a refund-vs-credit election", async () => {
    // The common case, and the one a reviewer should read first: the member is
    // told plainly who can act, the row goes to the exception list, and nobody's
    // captured payment is settled without the owner choosing how.
    //
    // It classifies as OTHER rather than as one of D-15's four named reasons, and
    // that is correct rather than a gap: D-15's four are the blockers that survive
    // the sweep's credit election, and the sweep never meets this one because it
    // elects credit. OTHER still reaches the exception list — an unclassified
    // block is a visible block — and its remedy names the edit flow, which is
    // where the refund/credit chooser actually lives.
    const result = await declineRefusedWith(
      new h.BookingGuestRemovalError(REFUSALS.SETTLED, 400),
    );
    expectBlocked(result, "OTHER", REFUSALS.SETTLED);
  });

  it("blocks a decline that would empty the booking (LAST_GUEST)", async () => {
    const result = await declineRefusedWith(
      new h.BookingGuestRemovalError(REFUSALS.LAST_GUEST, 400),
    );
    expectBlocked(result, "LAST_GUEST", REFUSALS.LAST_GUEST);
  });

  it("blocks a decline on a hand-priced booking (QUOTE_PRICED)", async () => {
    // The trap that exposed a real defect: this gate raises `ApiError`, not
    // `BookingGuestRemovalError`, and the consent path used to catch only the
    // latter — so the error escaped, the transaction rolled the claim back, and
    // the row stayed PENDING holding its bed while the sweep failed on it again
    // every night. The DELETE route that has called this same function since
    // #1032 has always handled both error types; the consent path now does too.
    const result = await declineRefusedWith(new ApiError(REFUSALS.QUOTE_PRICED, 400));
    expectBlocked(result, "QUOTE_PRICED", REFUSALS.QUOTE_PRICED);
  });

  it("blocks a decline the membership-type policy refuses for the guests left behind", async () => {
    // The third typed error class the shared path can raise, and the second half of
    // the same defect. `assertMembershipTypeBookingAllowed` runs over the REMAINING
    // guests, so a removal can be refused because of somebody who is staying — a
    // member whose membership type stopped allowing lodge bookings since the
    // booking was made. It raises its own class, which used to escape and strand
    // the bed exactly as the quote-priced case did.
    const refusal = membershipPolicyRefusal();
    const result = await declineRefusedWith(refusal);
    expectBlocked(result, "OTHER", refusal.message);
  });

  it("blocks a decline once the stay is no longer in the future", async () => {
    const result = await declineRefusedWith(
      new h.BookingGuestRemovalError(REFUSALS.STAY_NOT_FUTURE, 400),
    );
    expectBlocked(result, "STAY_NOT_FUTURE", REFUSALS.STAY_NOT_FUTURE);
  });

  it("blocks a decline on a booking whose status forbids guest changes", async () => {
    const result = await declineRefusedWith(
      new h.BookingGuestRemovalError(REFUSALS.BOOKING_STATUS, 400),
    );
    expectBlocked(result, "BOOKING_STATUS", REFUSALS.BOOKING_STATUS);
  });

  it("blocks rather than crashes when the removal path refuses for a reason nobody classified", async () => {
    // An unclassified refusal is a VISIBLE block, never a swallowed one, and never
    // an exception that takes the whole sweep down with it.
    const result = await declineRefusedWith(
      new h.BookingGuestRemovalError("Some future gate nobody has written yet", 400),
    );
    expectBlocked(result, "OTHER", "Some future gate nobody has written yet");
  });

  it("never stamps a blocked status over a claim the sweep won in the rollback gap", async () => {
    // THE GAP THE TWO-WRITE DESIGN OPENS, and the reason the second write re-uses
    // the guarded claim rather than a bare `update`. A refused decline rolls its
    // transaction back, which puts the row to PENDING again — and the 04:30 sweep
    // can legitimately claim that restored row before the blocked status is
    // written. The loser must take the same ALREADY_RESOLVED answer every other
    // loser takes; an unguarded write would stamp DECLINED (with a responder)
    // straight over the sweep's EXPIRED, breaking the one-way state machine and
    // attributing the lapse to a member as a decision.
    let transactions = 0;
    world().state.raceHook = () => {
      transactions += 1;
      // 1 = the decline attempt that is about to roll back; 2 = the blocked write.
      if (transactions === 2) world().guests.get(GUEST)!.consentStatus = "EXPIRED";
    };
    refuseAfterPartialRemoval(new h.BookingGuestRemovalError(REFUSALS.LAST_GUEST, 400));

    const result = await respondToMemberGuestConsent({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId: TARGET,
      action: "DECLINE",
      now: NOW,
      delegateResolver: acceptDelegate,
    });

    expect(result).toEqual({ outcome: "ALREADY_RESOLVED" });
    expect(world().guests.get(GUEST)).toMatchObject({
      consentStatus: "EXPIRED",
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
    });
  });

  it("does not resurrect a row the sweep removed in that same gap", async () => {
    // The other half of the gap: the sweep did not just claim the row, it claimed
    // it AND completed the removal, so there is no row left. The blocked write
    // must find nothing and report ALREADY_RESOLVED — never re-create a guest the
    // booking no longer has, and never fail the whole request on a missing row.
    let transactions = 0;
    world().state.raceHook = () => {
      transactions += 1;
      if (transactions === 2) {
        world().guests.delete(GUEST);
        world().choreAssignments.delete(GUEST);
      }
    };
    refuseAfterPartialRemoval(new h.BookingGuestRemovalError(REFUSALS.LAST_GUEST, 400));

    const result = await respondToMemberGuestConsent({
      bookingId: BOOKING,
      guestId: GUEST,
      actorMemberId: TARGET,
      action: "DECLINE",
      now: NOW,
      delegateResolver: acceptDelegate,
    });

    expect(result).toEqual({ outcome: "ALREADY_RESOLVED" });
    expect(world().guests.has(GUEST)).toBe(false);
  });

  it("still lets a genuinely unexpected failure surface", async () => {
    // The line between "the booking refused" and "something is broken". A
    // TypeError must NOT be filed as a blocked row: that would mark the row
    // EXPIRED/DECLINED on the strength of a bug and put it on an operator's list
    // with a meaningless reason.
    h.removeGuest.mockRejectedValueOnce(new TypeError("cannot read property of undefined"));
    await expect(
      respondToMemberGuestConsent({
        bookingId: BOOKING,
        guestId: GUEST,
        actorMemberId: TARGET,
        action: "DECLINE",
        now: NOW,
        delegateResolver: acceptDelegate,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("the operator's reason and the remedy an operator is offered", () => {
  const ALL_REASONS: MemberGuestConsentBlockedReason[] = [
    "LAST_GUEST",
    "QUOTE_PRICED",
    "BOOKING_STATUS",
    "STAY_NOT_FUTURE",
    "OTHER",
  ];

  it("names a real remedy for every reason, and never a dead-end", () => {
    // D-15 is explicit that the copy must name what actually fixes this — cancel
    // the booking, re-quote the request, move the status, open the edit flow — and
    // never "ask the club", which is what an operator IS. (The member-facing
    // wording in booking-guest-self-removal.ts does point at the club, and that is
    // right there: it is written for the member, not for the person holding the
    // exception list.)
    for (const reason of ALL_REASONS) {
      const remedy = describeConsentBlockedRemedy(reason);
      expect(remedy.length, reason).toBeGreaterThan(40);
      expect(remedy, reason).not.toMatch(/ask the club/i);
      // An imperative a human can carry out.
      expect(remedy, reason).toMatch(
        /Cancel the booking|add another guest|Re-quote|Move it to a status|adjust the booking|edit flow/,
      );
    }
  });

  it("distinguishes the four D-15 reasons from each other", () => {
    const remedies = ALL_REASONS.map((reason) => describeConsentBlockedRemedy(reason));
    expect(new Set(remedies).size).toBe(ALL_REASONS.length);
  });

  it("classifies each real refusal sentence, and each sentence is really raised somewhere", () => {
    // The classifier matches on the removal path's own MESSAGES rather than
    // re-deriving its gates, which is right — the reason an operator reads and the
    // sentence the member read must be the same fact — but it makes the classifier
    // silently dependent on wording it does not own. So each sentence is asserted
    // to exist, verbatim, in the source that raises it. A reword upstream fails
    // HERE, loudly, instead of quietly downgrading a named reason to OTHER.
    const removalSource = readRepoFile("src/lib/booking-guest-removal-service.ts");
    const validationSource = readRepoFile("src/lib/booking-modify-validation.ts");

    expect(removalSource).toContain(REFUSALS.SETTLED);
    expect(removalSource).toContain(REFUSALS.LAST_GUEST);
    expect(removalSource).toContain(REFUSALS.STAY_NOT_FUTURE);
    expect(removalSource).toContain(REFUSALS.BOOKING_STATUS);
    expect(validationSource).toContain(REFUSALS.QUOTE_PRICED);

    expect(classifyConsentRemovalRefusal(REFUSALS.LAST_GUEST)).toBe("LAST_GUEST");
    expect(classifyConsentRemovalRefusal(REFUSALS.QUOTE_PRICED)).toBe("QUOTE_PRICED");
    expect(classifyConsentRemovalRefusal(REFUSALS.STAY_NOT_FUTURE)).toBe("STAY_NOT_FUTURE");
    expect(classifyConsentRemovalRefusal(REFUSALS.BOOKING_STATUS)).toBe("BOOKING_STATUS");
    expect(classifyConsentRemovalRefusal(REFUSALS.SETTLED)).toBe("OTHER");
  });

  it("classifies the owner-path status refusal too, not just the self-removal one", () => {
    // The removal service raises a different sentence when a booking's status
    // blocks an owner/admin edit. A consent removal runs the self-removal gates so
    // it should never see this one, but classifying it is free and mis-filing it as
    // OTHER would lose a perfectly good reason.
    expect(
      classifyConsentRemovalRefusal(
        "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
      ),
    ).toBe("BOOKING_STATUS");
  });
});

// ---------------------------------------------------------------------------
// 5. The expiry transition, as the sweep calls it
// ---------------------------------------------------------------------------
describe("expireMemberGuestConsent", () => {
  it("elects account credit so an ordinary paid booking releases its bed (D-15)", async () => {
    // Owner decision D-15. Without an election the shared path refuses a settled
    // booking outright, which would send every ordinary paid booking to the
    // exception list; with `credit` the reduction goes to the booking owner's
    // account and no card refund is ever issued that nobody asked for. This is not
    // a weakening of D-14 — D-14 governs what a GUEST may do, this governs a timer
    // the club configured.
    const result = await expireMemberGuestConsent({ guestId: GUEST, now: NOW });

    expect(result).toMatchObject({ outcome: "EXPIRED", removed: true });
    expect(h.removeGuest).toHaveBeenCalledTimes(1);
    expect(h.removeGuest.mock.calls[0][0]).toMatchObject({
      settlementMethod: "credit",
      consentAuthority: { kind: "CONSENT_EXPIRY", guestId: GUEST, targetMemberId: TARGET },
    });
  });

  it("attributes the removal to the booking OWNER, never to the target", async () => {
    // Nobody acted, so nobody is named as the actor: the booking owner is passed
    // because they are the party whose booking is repriced and who receives the
    // credit, and the real actor is recorded separately as
    // `cron:member-guest-consent-expiry`. Writing the target's id here would
    // attribute to them a decision they never made — they were silent, which is
    // the whole reason this ran.
    await expireMemberGuestConsent({ guestId: GUEST, now: NOW });
    expect(h.removeGuest.mock.calls[0][0].actorMemberId).toBe(OWNER);
    expect(h.removeGuest.mock.calls[0][0].actorMemberId).not.toBe(TARGET);
  });

  it("records no responder on an expiry", async () => {
    // An expiry is nobody's decision. A responder id here would make the row
    // classify as DECLINED-shaped rather than EXPIRED, and the two are different
    // facts: somebody refused, versus the clock ran out.
    h.removeGuest.mockImplementationOnce(async () => ({ accountCreditAmountCents: 0 }));
    await expireMemberGuestConsent({ guestId: GUEST, now: NOW });
    expect(world().guests.get(GUEST)).toMatchObject({
      consentStatus: "EXPIRED",
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
    });
  });

  it("re-asserts the clock on the FRESH row under the lock", async () => {
    // The settlement reaper's hard-won lesson, applied here: a deadline can be
    // extended between the candidate scan and the transaction, and expiring a row
    // whose deadline has moved is not idempotent — it is simply wrong. The scan
    // saw a lapsed row; the row under the lock says otherwise, and the row under
    // the lock wins.
    world().state.raceHook = () => {
      world().guests.get(GUEST)!.consentExpiresAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    };

    const result = await expireMemberGuestConsent({ guestId: GUEST, now: NOW });
    expect(result).toEqual({ outcome: "ALREADY_RESOLVED" });
    expect(world().guests.get(GUEST)?.consentStatus).toBe("PENDING");
    expect(h.removeGuest).not.toHaveBeenCalled();
  });

  it("refuses to expire a PENDING row that somehow carries no deadline", async () => {
    // A PENDING row with a null expiry is a row the writer refuses to create, so
    // meeting one means something is wrong. The sweep leaves it alone rather than
    // guessing that "no deadline" means "expired".
    world().guests.get(GUEST)!.consentExpiresAt = null;
    await expect(expireMemberGuestConsent({ guestId: GUEST, now: NOW })).resolves.toEqual({
      outcome: "ALREADY_RESOLVED",
    });
    expect(h.removeGuest).not.toHaveBeenCalled();
  });

  it("does nothing for a guest id that does not exist", async () => {
    await expect(expireMemberGuestConsent({ guestId: "g-nope", now: NOW })).resolves.toEqual({
      outcome: "ALREADY_RESOLVED",
    });
  });

  it("leaves a blocked expiry marked EXPIRED and still on the booking", async () => {
    // The one case in which a DECLINED/EXPIRED row is durable rather than deleted,
    // and the reason the status column earns its keep: the claim succeeded, the
    // removal was refused, so the row is *blocked* — holding a bed, needing a
    // human, and on D-15's exception list.
    refuseAfterPartialRemoval(
      new h.BookingGuestRemovalError(REFUSALS.LAST_GUEST, 400),
    );
    const result = await expireMemberGuestConsent({ guestId: GUEST, now: NOW });

    expect(result).toEqual({
      outcome: "BLOCKED",
      status: "EXPIRED",
      reason: "LAST_GUEST",
      message: REFUSALS.LAST_GUEST,
    });
    expect(world().guests.get(GUEST)).toMatchObject({ consentStatus: "EXPIRED" });
    // Whole, not half-removed: the sweep's refusal rolled back the guest-row and
    // chore deletions the removal path had already made before it refused.
    expect(world().choreAssignments.get(GUEST)).toEqual(["chore-fire", "chore-dishes"]);
  });

  it("takes the global money lock before the per-lodge capacity lock", async () => {
    // The repo's declared two-tier order (#1881). This transaction can reprice a
    // booking AND release a bed, so it belongs in both cohorts; taking them in the
    // other order is how a deadlock with cancel/settlement is introduced.
    await expireMemberGuestConsent({ guestId: GUEST, now: NOW });
    expect(world().tx.$executeRaw).toHaveBeenCalled();
    expect(h.acquireLodgeCapacityLock).toHaveBeenCalledTimes(1);
    const globalLockAt = world().tx.$executeRaw.mock.invocationCallOrder[0];
    const lodgeLockAt = h.acquireLodgeCapacityLock.mock.invocationCallOrder[0];
    expect(globalLockAt).toBeLessThan(lodgeLockAt);
    expect(h.acquireLodgeCapacityLock.mock.calls[0][1]).toBe("lodge-1");
  });

  it("falls back to the default lodge when the booking carries none", async () => {
    // Single-lodge clubs leave `lodgeId` null, and the capacity lock still has to
    // be keyed to something.
    world().bookings.get(BOOKING)!.lodgeId = null as unknown as string;
    await expireMemberGuestConsent({ guestId: GUEST, now: NOW });
    expect(h.getDefaultLodgeId).toHaveBeenCalledTimes(1);
    expect(h.acquireLodgeCapacityLock.mock.calls[0][1]).toBe("lodge-1");
  });
});
