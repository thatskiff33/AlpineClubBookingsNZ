// "+ Add Member Guest" (epic #2305) MG2 (#2307) — THE PENDING-HOLD EXPIRY SWEEP.
//
// Owner decision D-4 lets a `PENDING` guest hold a bed so a booker is not made to
// race a stranger's inbox for capacity. That is only defensible because the hold
// has a deadline, and this is the job that enforces it: without it, one unanswered
// request holds a bed until the stay has been and gone. It is why the widening,
// the approval surface and this sweep all ship in the same release — there is no
// released state in which an admin can switch the module on and strand capacity.
//
// The sweep DECIDES NOTHING. Every transition, lock, settlement and
// refusal-classification lives in `member-guest-consent-service.ts`, shared with
// the member-facing decline path so a lapse and a decline cannot diverge. That is
// exactly why this suite runs the REAL service against a fake database rather than
// mocking the service out: what is worth testing here is the composition — which
// rows are picked, in what order, what happens to the ones that will not release,
// and that running the whole thing twice changes nothing.
//
// THE FAKE DATABASE ROLLS BACK. `$transaction` snapshots the guest rows and
// restores them if the callback throws, because "a row that throws stays PENDING
// and is retried next run" is one of the properties under test and a fake that
// kept the half-applied write would assert the opposite of the truth.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NO_ADDITIONAL_ASK } from "@/lib/additional-payment-ask";

const h = vi.hoisted(() => {
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
    state: { world: null as unknown as World },
    removeGuest: vi.fn(),
    acquireLodgeCapacityLock: vi.fn(),
    getDefaultLodgeId: vi.fn(),
    reconcileBeds: vi.fn(),
    logAudit: vi.fn(),
    sendOutcomeEmail: vi.fn(),
    sendExpiredEmail: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (tx: unknown) => unknown) => h.state.world.$transaction(cb),
    bookingGuest: {
      findMany: (args: unknown) => h.state.world.bookingGuest.findMany(args as never),
      findUnique: (args: unknown) => h.state.world.bookingGuest.findUnique(args as never),
    },
    booking: {
      findUnique: (args: unknown) => h.state.world.booking.findUnique(args as never),
    },
    member: {
      findUnique: (args: unknown) => h.state.world.member.findUnique(args as never),
      findMany: () => h.state.world.member.findMany(),
    },
    // The lapse notice reaches the member through the same recipient rule the
    // request did, so the real delegate resolver runs against this fake too.
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
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/email/member-guest", () => ({
  sendMemberGuestConsentOutcomeEmail: h.sendOutcomeEmail,
  sendMemberGuestConsentExpiredEmail: h.sendExpiredEmail,
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
  runMemberGuestConsentExpiryCron,
  summariseMemberGuestConsentExpiryRun,
} from "@/lib/cron-member-guest-consent-expiry";

const NOW = new Date("2026-08-01T04:30:00.000Z");
const HOUR = 60 * 60 * 1000;
const LAST_GUEST_MESSAGE = "Cannot remove the last guest. Cancel the booking instead.";

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

function guest(overrides: Partial<GuestRow> & { id: string }): GuestRow {
  return {
    bookingId: "bk-1",
    memberId: `m-${overrides.id}`,
    consentStatus: "PENDING",
    consentRequestedAt: new Date(NOW.getTime() - 7 * 24 * HOUR),
    consentRespondedAt: null,
    consentRespondedByMemberId: null,
    consentExpiresAt: new Date(NOW.getTime() - HOUR),
    ...overrides,
  };
}

/**
 * The sweep's own fake world.
 *
 * Deliberately shaped for this file rather than shared with
 * `member-guest-consent-service.test.ts`: that suite asks questions about ONE row
 * (who may answer it, what happens when two people answer at once), while this one
 * needs an ordered candidate scan over several rows spread across bookings, and a
 * removal that refuses on its own when a booking would be emptied. Two fixtures
 * for two questions is clearer than one fixture that answers neither well.
 */
type World = ReturnType<typeof makeWorld>;

function makeWorld(rows: GuestRow[]) {
  const guests = new Map(rows.map((row) => [row.id, { ...row }]));
  const bookings = new Map(
    [...new Set(rows.map((row) => row.bookingId))].map((bookingId) => [
      bookingId,
      {
        id: bookingId,
        lodgeId: "lodge-1",
        memberId: `m-owner-${bookingId}`,
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-22T00:00:00.000Z"),
        member: {
          id: `m-owner-${bookingId}`,
          email: `owner-${bookingId}@example.com`,
          firstName: "Ophelia",
        },
      },
    ]),
  );

  const state = { raceHook: null as null | ((guestId: string) => void) };

  const bookingGuest = {
    // The candidate scan, evaluated the way the partial index would: PENDING rows
    // whose deadline has passed, oldest first then by id.
    findMany: vi.fn(
      async (args: {
        where: { consentStatus?: string; consentExpiresAt?: { lte: Date } };
        orderBy?: unknown;
      }) => {
        const lte = args.where.consentExpiresAt?.lte;
        return [...guests.values()]
          .filter((row) =>
            args.where.consentStatus === undefined
              ? true
              : row.consentStatus === args.where.consentStatus,
          )
          .filter((row) =>
            lte === undefined
              ? true
              : row.consentExpiresAt !== null && row.consentExpiresAt.getTime() <= lte.getTime(),
          )
          .sort(
            (a, b) =>
              (a.consentExpiresAt?.getTime() ?? 0) - (b.consentExpiresAt?.getTime() ?? 0) ||
              a.id.localeCompare(b.id),
          )
          .map((row) => ({ id: row.id, memberId: row.memberId, bookingId: row.bookingId }));
      },
    ),
    findUnique: vi.fn(async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
      const row = guests.get(args.where.id);
      if (!row) return null;
      state.raceHook?.(row.id);
      const fresh = guests.get(args.where.id)!;
      return args.select?.booking
        ? { ...fresh, booking: bookings.get(fresh.bookingId) ?? null }
        : { ...fresh };
    }),
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
  };

  const booking = {
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
      const row = bookings.get(args.where.id);
      return row ? { ...row } : null;
    }),
  };

  // Every fixture member holds a login of their own, so the lapse notice goes to
  // the member who was asked and no family lookup is needed. (The no-login case —
  // the normal one under D-9 — is covered in member-guest-delegate.test.ts, which
  // owns the recipient rule.)
  const member = {
    findUnique: vi.fn(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      active: true,
      canLogin: true,
      ageTier: "ADULT",
      email: `${args.where.id}@example.com`,
      firstName: "Tania",
      lastName: "Target",
    })),
    // These two exist so the delegate resolver's queries resolve rather than
    // throw; the fixture members all hold logins, so nothing reads the results.
    findMany: vi.fn(async () => []),
  };

  const familyGroupMember = { findMany: vi.fn(async () => []) };

  const tx = { $executeRaw: vi.fn(async () => 0), bookingGuest, booking, member };

  return {
    guests,
    bookings,
    state,
    bookingGuest,
    booking,
    member,
    familyGroupMember,
    tx,
    /** Snapshot-and-restore, so a throwing row really does stay PENDING. */
    $transaction: vi.fn(async (cb: (client: typeof tx) => unknown) => {
      const snapshot = new Map([...guests].map(([id, row]) => [id, { ...row }]));
      try {
        return await cb(tx);
      } catch (err) {
        guests.clear();
        for (const [id, row] of snapshot) guests.set(id, row);
        throw err;
      }
    }),
  };
}

function world(): World {
  return h.state.world;
}

function seed(rows: GuestRow[]) {
  h.state.world = makeWorld(rows);
}

/** Guests still on a booking, which is what the last-guest gate really looks at. */
function guestsOn(bookingId: string) {
  return [...world().guests.values()].filter((row) => row.bookingId === bookingId);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed([guest({ id: "g-1" })]);
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.reconcileBeds.mockResolvedValue(undefined);
  h.logAudit.mockResolvedValue(undefined);
  h.sendOutcomeEmail.mockResolvedValue(undefined);
  h.sendExpiredEmail.mockResolvedValue(undefined);
  // A removal that behaves like the real one in the one respect this file cares
  // about: it deletes the guest row, and it REFUSES when the booking would be left
  // empty. Nothing else about the real path (repricing, promos, chores) matters to
  // the sweep's composition, and mocking it here would only re-test the removal
  // service through a second, worse harness.
  h.removeGuest.mockImplementation(async ({ bookingId, guestId }: { bookingId: string; guestId: string }) => {
    if (guestsOn(bookingId).length <= 1) {
      throw new h.BookingGuestRemovalError(LAST_GUEST_MESSAGE, 400);
    }
    world().guests.delete(guestId);
    // #3809: with the figures the removal's Xero leg reads.
    return {
      accountCreditAmountCents: 4500,
      appliedCreditGivenBackCents: 0,
      booking: { id: bookingId },
      bookingModificationId: `mod-${guestId}`,
      hasIssuedXeroInvoice: false,
      paymentStatus: null,
      priceDiffCents: -4500,
      xeroRefundAmountCents: 0,
      settlementMethod: "credit",
      hasSucceededPayment: false,
      xeroAdditionalAmountCents: 0,
      zeroDollarAutoPaid: false,
      // #3954: no unpaid ask on this booking, so the removal retired none.
      retiredAdditionalAsks: [],
      additionalAsk: NO_ADDITIONAL_ASK,
    };
  });
});

/** Two guests on one booking so the first removal is not the last guest. */
function withCompanion(rows: GuestRow[], bookingId = "bk-1") {
  return [
    ...rows,
    guest({ id: `g-companion-${bookingId}`, bookingId, consentStatus: null, consentExpiresAt: null }),
  ];
}

describe("runMemberGuestConsentExpiryCron — the module gate", () => {
  it("reports SKIPPED with a reason and issues no queries while the module is off", async () => {
    // Checked at RUN time rather than at registration, on the `cron-waitlist.ts`
    // precedent: the job registers unconditionally, so an admin toggling the module
    // takes effect on the next tick without a restart. And a skipped run must not
    // touch the database at all — the health view's "why did nothing happen" answer
    // should not cost a query.
    seed([guest({ id: "g-1" })]);
    const result = await runMemberGuestConsentExpiryCron({
      isModuleEnabled: async () => false,
      now: () => NOW,
    });

    expect(result).toEqual({
      cronStatus: "SKIPPED",
      reason: "Member guests effective module state is disabled",
    });
    expect(world().bookingGuest.findMany).not.toHaveBeenCalled();
    expect(h.removeGuest).not.toHaveBeenCalled();
    expect(summariseMemberGuestConsentExpiryRun(result)).toBe(
      "Member guests effective module state is disabled",
    );
  });

  it("runs when the module is on", async () => {
    seed(withCompanion([guest({ id: "g-1" })]));
    const result = await runMemberGuestConsentExpiryCron({
      isModuleEnabled: async () => true,
      now: () => NOW,
    });
    expect(result.cronStatus).toBe("SUCCESS");
  });
});

describe("runMemberGuestConsentExpiryCron — which rows it touches", () => {
  it("expires only PENDING rows whose deadline has passed", async () => {
    // The candidate scan is exactly the shape the partial index
    // `BookingGuest_pendingConsent_expiresAt_idx` was created for, and every other
    // row in the table has to be left alone: a CONFIRMED guest is a real occupant,
    // a row whose deadline is still ahead is a live hold somebody may yet answer,
    // and DECLINED/EXPIRED rows have already been through here.
    seed(
      withCompanion([
        guest({ id: "g-lapsed" }),
        guest({ id: "g-still-waiting", consentExpiresAt: new Date(NOW.getTime() + HOUR) }),
        guest({ id: "g-confirmed", consentStatus: "CONFIRMED", consentExpiresAt: null }),
        guest({ id: "g-declined", consentStatus: "DECLINED" }),
        guest({ id: "g-already-expired", consentStatus: "EXPIRED" }),
        guest({ id: "g-ordinary", consentStatus: null, consentExpiresAt: null }),
      ]),
    );

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(result).toMatchObject({
      cronStatus: "SUCCESS",
      expiredGuestIds: ["g-lapsed"],
      skippedGuestIds: [],
      blockedGuests: [],
      failedGuestIds: [],
    });
    expect(world().guests.has("g-still-waiting")).toBe(true);
    expect(world().guests.get("g-still-waiting")?.consentStatus).toBe("PENDING");
    expect(world().guests.get("g-confirmed")?.consentStatus).toBe("CONFIRMED");
    expect(world().guests.get("g-ordinary")?.consentStatus).toBeNull();
  });

  it("elects account credit so a paid booking releases cleanly (D-15)", async () => {
    // Owner decision D-15, asserted where it actually reaches the money: the sweep
    // passes `settlementMethod: "credit"` through the shared path, so an ordinary
    // paid booking is reduced to account credit for the OWNER and no card refund is
    // ever issued that nobody asked for. Without the election the shared path
    // refuses a settled booking outright and every paid booking would land on the
    // exception list instead of releasing its bed.
    seed(withCompanion([guest({ id: "g-1" })]));
    await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(h.removeGuest).toHaveBeenCalledTimes(1);
    expect(h.removeGuest.mock.calls[0][0]).toMatchObject({
      settlementMethod: "credit",
      actorMemberId: "m-owner-bk-1",
      actorRole: "MEMBER",
      consentAuthority: { kind: "CONSENT_EXPIRY", guestId: "g-1", targetMemberId: "m-g-1" },
    });
  });

  it("re-asserts the clock on the FRESH row under the lock", async () => {
    // The settlement reaper's lesson, and the reason the deadline is re-read inside
    // the transaction rather than trusted from the scan: a hold can be extended
    // between the two, and expiring a row whose deadline has moved is not
    // idempotent — it is wrong. The row is counted as already-resolved, not as
    // expired and not as failed.
    seed(withCompanion([guest({ id: "g-1" })]));
    world().state.raceHook = (guestId) => {
      if (guestId !== "g-1") return;
      world().guests.get("g-1")!.consentExpiresAt = new Date(NOW.getTime() + 48 * HOUR);
    };

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(result).toMatchObject({ expiredGuestIds: [], skippedGuestIds: ["g-1"] });
    expect(world().guests.get("g-1")?.consentStatus).toBe("PENDING");
    expect(h.removeGuest).not.toHaveBeenCalled();
    // Nobody is told about a lapse that did not happen.
    expect(h.sendExpiredEmail).not.toHaveBeenCalled();
  });
});

describe("runMemberGuestConsentExpiryCron — running it twice", () => {
  it("produces an identical end state and no second email", async () => {
    // MARK BEFORE SEND: the destructive database transition IS the idempotency
    // token, so a failed notification is logged for an operator and never replayed
    // into a second removal. This is the property that makes a retried cron tick,
    // an overlapping manual run, or a scheduler double-fire harmless.
    seed(withCompanion([guest({ id: "g-1" })]));

    const first = await runMemberGuestConsentExpiryCron({ now: () => NOW });
    const stateAfterFirst = [...world().guests.entries()].map(([id, row]) => [id, { ...row }]);

    const second = await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(first).toMatchObject({ expiredGuestIds: ["g-1"] });
    expect(second).toMatchObject({
      expiredGuestIds: [],
      skippedGuestIds: [],
      blockedGuests: [],
      failedGuestIds: [],
    });
    expect([...world().guests.entries()].map(([id, row]) => [id, { ...row }])).toEqual(
      stateAfterFirst,
    );
    // One removal, one owner email, one lapse notice — in total, across both runs.
    expect(h.removeGuest).toHaveBeenCalledTimes(1);
    expect(h.sendOutcomeEmail).toHaveBeenCalledTimes(1);
    expect(h.sendExpiredEmail).toHaveBeenCalledTimes(1);
    expect(h.logAudit).toHaveBeenCalledTimes(1);
  });

  it("never retries a blocked row in a loop, or on the next night", async () => {
    // D-15 rows are counted separately and left alone. Two things are being pinned:
    // the sweep does not re-attempt a refusal within a run (which would mean N
    // removal attempts and N warnings for one stuck bed), and the row drops out of
    // the candidate scan entirely afterwards because it is no longer PENDING — so
    // it waits for the operator rather than generating a failure every night.
    seed([guest({ id: "g-alone" })]); // its own booking, so it IS the last guest

    const first = await runMemberGuestConsentExpiryCron({ now: () => NOW });
    expect(first).toMatchObject({
      expiredGuestIds: [],
      blockedGuests: [{ guestId: "g-alone", reason: "LAST_GUEST" }],
      failedGuestIds: [],
    });
    expect(h.removeGuest).toHaveBeenCalledTimes(1);
    // Claimed but not removed: still holding its bed, still on the booking. That
    // combination IS the admin exception list.
    expect(world().guests.get("g-alone")).toMatchObject({ consentStatus: "EXPIRED" });

    h.removeGuest.mockClear();
    const second = await runMemberGuestConsentExpiryCron({ now: () => NOW });
    expect(second).toMatchObject({ expiredGuestIds: [], blockedGuests: [], failedGuestIds: [] });
    expect(h.removeGuest).not.toHaveBeenCalled();
  });

  it("counts blocked rows apart from expired ones and surfaces both in the summary", async () => {
    seed([
      ...withCompanion([guest({ id: "g-releases", consentExpiresAt: new Date(NOW.getTime() - 3 * HOUR) })]),
      guest({ id: "g-stuck", bookingId: "bk-2" }),
    ]);

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(result).toMatchObject({
      expiredGuestIds: ["g-releases"],
      blockedGuests: [{ guestId: "g-stuck", reason: "LAST_GUEST" }],
    });
    expect(summariseMemberGuestConsentExpiryRun(result)).toBe(
      "1 expired, 1 needing attention, 0 already resolved, 0 failed",
    );
    // Deliberately a warning, not an info line: every one of these is a bed still
    // held by somebody who never answered, waiting on a human.
    expect(h.loggerWarn).toHaveBeenCalledTimes(1);
    expect(h.loggerWarn.mock.calls[0][0]).toMatchObject({
      blockedGuests: [{ guestId: "g-stuck", reason: "LAST_GUEST" }],
    });
  });
});

describe("runMemberGuestConsentExpiryCron — a row that throws", () => {
  it("counts the failure, leaves the rest of the sweep running, and leaves the row PENDING", async () => {
    // One bad row must not stop the sweep, and it must not be quietly marked
    // terminal either. The transaction rolls back, so the row is still PENDING and
    // is picked up again next run — which is safe precisely because the transition
    // is status-guarded.
    seed([
      ...withCompanion([guest({ id: "g-boom", consentExpiresAt: new Date(NOW.getTime() - 5 * HOUR) })]),
      ...withCompanion([guest({ id: "g-fine" })], "bk-2"),
    ]);
    h.removeGuest.mockImplementationOnce(async () => {
      throw new TypeError("cannot read property of undefined");
    });

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(result).toMatchObject({
      expiredGuestIds: ["g-fine"],
      failedGuestIds: ["g-boom"],
      blockedGuests: [],
    });
    expect(world().guests.get("g-boom")).toMatchObject({ consentStatus: "PENDING" });
    expect(h.loggerError).toHaveBeenCalled();

    // Next night it is retried, and this time it releases.
    const second = await runMemberGuestConsentExpiryCron({ now: () => NOW });
    expect(second).toMatchObject({ expiredGuestIds: ["g-boom"], failedGuestIds: [] });
  });

  it("keeps a broken notification from failing the row it belongs to", async () => {
    // The transition has already committed by the time anything is sent. A mail
    // failure is logged for an operator and the row still counts as expired,
    // because it IS expired — the bed was released.
    seed(withCompanion([guest({ id: "g-1" })]));
    h.sendOutcomeEmail.mockRejectedValueOnce(new Error("smtp down"));

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });
    expect(result).toMatchObject({ expiredGuestIds: ["g-1"], failedGuestIds: [] });
    expect(h.loggerError).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The order the candidates come back in IS part of the contract
// ---------------------------------------------------------------------------
describe("LAST_GUEST order-dependence is deterministic, and documented", () => {
  // Two pending guests on a two-guest booking CANNOT both be removed: the first
  // succeeds and the second is refused as the last guest. Something has to decide
  // which one that is, and leaving it to whatever order Postgres happened to return
  // would make the outcome — whose place is released and whose lands on an
  // operator's list — depend on the physical layout of a table.
  //
  // The contract is `ORDER BY consentExpiresAt ASC, id ASC`: the request that has
  // been waiting longest is resolved first, which is both explicable to a member
  // and stable across runs. The id is the tie-break, so two requests minted in the
  // same write still have a defined order. The second row lands on the exception
  // list, which is the honest answer — a booking whose entire party declined by
  // silence needs a human to decide whether it should exist at all.
  it("resolves the oldest request first and blocks the other", async () => {
    seed([
      guest({ id: "g-newer", consentExpiresAt: new Date(NOW.getTime() - HOUR) }),
      guest({ id: "g-older", consentExpiresAt: new Date(NOW.getTime() - 5 * HOUR) }),
    ]);

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(result).toMatchObject({
      expiredGuestIds: ["g-older"],
      blockedGuests: [{ guestId: "g-newer", reason: "LAST_GUEST" }],
    });
    expect(world().guests.has("g-older")).toBe(false);
    expect(world().guests.get("g-newer")).toMatchObject({ consentStatus: "EXPIRED" });
  });

  it("gives the same answer whichever order the rows were written in", async () => {
    // The same two rows, inserted the other way round. If the sweep depended on
    // insertion order this would swap the winner.
    seed([
      guest({ id: "g-older", consentExpiresAt: new Date(NOW.getTime() - 5 * HOUR) }),
      guest({ id: "g-newer", consentExpiresAt: new Date(NOW.getTime() - HOUR) }),
    ]);

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });
    expect(result).toMatchObject({
      expiredGuestIds: ["g-older"],
      blockedGuests: [{ guestId: "g-newer", reason: "LAST_GUEST" }],
    });
  });

  it("breaks a tie on the guest id, so two requests minted together still have an order", async () => {
    const sameDeadline = new Date(NOW.getTime() - 2 * HOUR);
    seed([
      guest({ id: "g-b", consentExpiresAt: sameDeadline }),
      guest({ id: "g-a", consentExpiresAt: sameDeadline }),
    ]);

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });
    expect(result).toMatchObject({
      expiredGuestIds: ["g-a"],
      blockedGuests: [{ guestId: "g-b", reason: "LAST_GUEST" }],
    });
  });

  it("asks the database for that order explicitly", async () => {
    // The determinism above only holds because the query says so. Asserted against
    // the query itself as well as through behaviour, because a fake database can be
    // made to sort however the test likes and the real one cannot.
    seed(withCompanion([guest({ id: "g-1" })]));
    await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(world().bookingGuest.findMany).toHaveBeenCalledTimes(1);
    expect(world().bookingGuest.findMany.mock.calls[0][0]).toMatchObject({
      where: { consentStatus: "PENDING", consentExpiresAt: { lte: NOW } },
      orderBy: [{ consentExpiresAt: "asc" }, { id: "asc" }],
    });
  });
});

describe("a lapse on a guest row a member merge re-pointed", () => {
  // `BookingGuest.member` is classified `move` in member-merge.ts, so merging one
  // member into another re-points the loser's guest rows — consent columns and all
  // — onto the survivor. MG1 (#2306) recorded that as an accepted consequence and
  // noted it was unreachable while every consentStatus was NULL; MG2 makes it real,
  // and member-merge-execute.test.ts pins what the merge itself does. What is left
  // to check is what the SWEEP then does with such a row, because the merge can
  // leave a booking whose only remaining guest is the survivor.
  it("blocks as LAST_GUEST and names the SURVIVOR, not the member who was merged away", async () => {
    // The row's `memberId` is the survivor's, so this is the survivor's bed hold to
    // lose and the survivor's inbox the lapse notice belongs in. The deleted
    // member's id survives only in `consentRespondedByMemberId`, which a PENDING row
    // does not carry — so there is nothing here that could email a member who no
    // longer exists.
    seed([guest({ id: "g-merged", memberId: "m-survivor" })]);

    const result = await runMemberGuestConsentExpiryCron({ now: () => NOW });

    // Its booking has no other guest, so the bed cannot be released: the honest
    // answer is an operator deciding whether the booking should exist at all.
    expect(result).toMatchObject({
      expiredGuestIds: [],
      blockedGuests: [{ guestId: "g-merged", reason: "LAST_GUEST" }],
      failedGuestIds: [],
    });
    expect(world().guests.get("g-merged")).toMatchObject({
      consentStatus: "EXPIRED",
      memberId: "m-survivor",
    });

    // Everything downstream is about the survivor.
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "member_guest_consent_blocked",
      subjectMemberId: "m-survivor",
    });
    expect(h.sendExpiredEmail).toHaveBeenCalledTimes(1);
    expect(h.sendExpiredEmail.mock.calls[0][0]).toMatchObject({
      email: "m-survivor@example.com",
    });
  });
});

describe("what the sweep records", () => {
  it("audits the transition against the job, with no person named as the actor", async () => {
    // Nobody acted. The audit entry names `cron:member-guest-consent-expiry` in its
    // metadata and leaves the actor columns unset, rather than attributing the
    // removal to the booking owner whose id the removal path needed.
    seed(withCompanion([guest({ id: "g-1" })]));
    await runMemberGuestConsentExpiryCron({ now: () => NOW });

    expect(h.logAudit).toHaveBeenCalledTimes(1);
    const entry = h.logAudit.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: "member_guest_consent_expired",
      category: "booking",
      entityType: "BookingGuest",
      entityId: "g-1",
      subjectMemberId: "m-g-1",
      targetId: "bk-1",
      metadata: { actor: "cron:member-guest-consent-expiry" },
    });
    expect(entry).not.toHaveProperty("actorMemberId");
  });

  it("summarises a clean run in one line for the health view", () => {
    expect(
      summariseMemberGuestConsentExpiryRun({
        cronStatus: "SUCCESS",
        expiredGuestIds: ["a", "b"],
        skippedGuestIds: ["c"],
        blockedGuests: [{ guestId: "d", reason: "QUOTE_PRICED" }],
        failedGuestIds: ["e"],
      }),
    ).toBe("2 expired, 1 needing attention, 1 already resolved, 1 failed");
  });
});
