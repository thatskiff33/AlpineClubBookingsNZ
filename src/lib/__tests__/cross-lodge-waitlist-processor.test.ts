import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Cross-lodge waitlist processor and confirm dispatch (ADR-004): queue
// modes, cross-lodge gates, offer recording, and the create-and-cancel
// confirm path's dispatch and revert contracts.

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  bookingFindUnique: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  isMemberEligibleToBookLodge: vi.fn(),
  getWaitlistCrossLodgeOrder: vi.fn(),
  quoteWaitlistEntryAtLodge: vi.fn(),
  confirmCrossLodgeWaitlistOffer: vi.fn(),
  sendWaitlistOfferEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistOfferExpiredEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminWaitlistOfferAlert: vi.fn().mockResolvedValue(undefined),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    booking: { findUnique: mocks.bookingFindUnique },
    // #2543: after the sweep commits, the offer email's "why is this the price"
    // sentence is resolved from the offer's guest rows. Empty is the neutral answer
    // — no member rows means nobody is repriced and the notice stays null — and it
    // keeps this suite from exercising the graceful-degradation branch instead of
    // the real read.
    bookingGuest: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: mocks.getDefaultLodgeId,
  lodgeNullTolerantScope: (lodgeId: string | null) => ({
    OR: [{ lodgeId }, { lodgeId: null }],
  }),
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithGlobalLockHeld:
    mocks.reconcileBedAllocations,
}));
vi.mock("@/lib/lodge-access", () => ({
  isMemberEligibleToBookLodge: mocks.isMemberEligibleToBookLodge,
}));
vi.mock("@/lib/waitlist-cross-lodge", () => ({
  getWaitlistCrossLodgeOrder: mocks.getWaitlistCrossLodgeOrder,
  quoteWaitlistEntryAtLodge: mocks.quoteWaitlistEntryAtLodge,
  confirmCrossLodgeWaitlistOffer: mocks.confirmCrossLodgeWaitlistOffer,
}));
vi.mock("@/lib/email", () => ({
  sendWaitlistOfferEmail: mocks.sendWaitlistOfferEmail,
  sendWaitlistOfferExpiredEmail: mocks.sendWaitlistOfferExpiredEmail,
  sendAdminWaitlistOfferAlert: mocks.sendAdminWaitlistOfferAlert,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

import { confirmWaitlistOffer, processWaitlistForDates } from "@/lib/waitlist";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-10");
const CHECK_OUT = new Date("2026-08-12");

function candidate(input: {
  id: string;
  lodgeId: string;
  createdAt: string;
  alternates?: string[];
  promo?: boolean;
}) {
  return {
    id: input.id,
    memberId: `member-${input.id}`,
    lodgeId: input.lodgeId,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    createdAt: new Date(input.createdAt),
    guests: [],
    member: {
      id: `member-${input.id}`,
      email: `${input.id}@example.org`,
      firstName: "Test",
      lastName: input.id,
    },
    waitlistAlternateLodges: (input.alternates ?? []).map((lodgeId) => ({ lodgeId })),
    promoRedemption: input.promo ? { id: `promo-${input.id}` } : null,
  };
}

function makeTx(candidates: ReturnType<typeof candidate>[]) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    lodge: {
      findMany: vi.fn().mockResolvedValue([{ id: "lodge-a" }, { id: "lodge-b" }]),
      findUnique: vi.fn().mockResolvedValue({ name: "River Lodge" }),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue(candidates),
      update: vi.fn().mockImplementation(async (args) => args),
      count: vi.fn().mockResolvedValue(0),
    },
  };
}

describe("processWaitlistForDates cross-lodge pass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-a");
    mocks.isMemberEligibleToBookLodge.mockResolvedValue(true);
    mocks.quoteWaitlistEntryAtLodge.mockResolvedValue({
      offerable: true,
      finalPriceCents: 34000,
    });
    mocks.reconcileBedAllocations.mockResolvedValue(undefined);
    mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(currentTx),
    );
  });

  let currentTx: ReturnType<typeof makeTx>;

  it("OWN_LODGE_FIRST serves the freed lodge's own queue before an older cross-lodge opt-in", async () => {
    // Entry at lodge A (older) opted into lodge B; entry at lodge B (newer).
    // Capacity freed at B, and B has room; A does not.
    const crossCandidate = candidate({
      id: "entry-a",
      lodgeId: "lodge-a",
      createdAt: "2026-07-01T10:00:00Z",
      alternates: ["lodge-b"],
    });
    const ownCandidate = candidate({
      id: "entry-b",
      lodgeId: "lodge-b",
      createdAt: "2026-07-02T10:00:00Z",
    });
    currentTx = makeTx([crossCandidate, ownCandidate]);
    mocks.getWaitlistCrossLodgeOrder.mockResolvedValue("OWN_LODGE_FIRST");
    mocks.checkCapacityForGuestRanges.mockImplementation(async (lodgeId: string) => ({
      available: lodgeId === "lodge-b",
    }));

    const result = await processWaitlistForDates({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-b",
    }, CLUB_FORMAT_TEST);

    expect(result.offeredBookingId).toBe("entry-b");
    const update = currentTx.booking.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: "entry-b" });
    // Same-lodge offer records no offered-lodge fields.
    expect(update.data.waitlistOfferedLodgeId).toBeNull();
    expect(update.data.waitlistOfferedPriceCents).toBeNull();
  });

  // #2258: a suppressed booking must never enter candidacy. If it did, the
  // offer transaction would stamp waitlistOfferExpiresAt and start the offer
  // clock, the offer email would then be withheld, and the entry would hold a
  // bed for the whole window with the member never told — then lapse.
  it("excludes bookings with the No emails switch from waitlist candidacy", async () => {
    const own = candidate({
      id: "entry-b",
      lodgeId: "lodge-b",
      createdAt: "2026-07-02T10:00:00Z",
    });
    currentTx = makeTx([own]);
    mocks.getWaitlistCrossLodgeOrder.mockResolvedValue("OWN_LODGE_FIRST");
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: true });

    await processWaitlistForDates({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-b",
    }, CLUB_FORMAT_TEST);

    const where = currentTx.booking.findMany.mock.calls[0][0].where;
    expect(where.noEmails).toBe(false);
  });

  it("MERGED lets an older cross-lodge opt-in take the freed spot, recording lodge and price", async () => {
    const crossCandidate = candidate({
      id: "entry-a",
      lodgeId: "lodge-a",
      createdAt: "2026-07-01T10:00:00Z",
      alternates: ["lodge-b"],
    });
    const ownCandidate = candidate({
      id: "entry-b",
      lodgeId: "lodge-b",
      createdAt: "2026-07-02T10:00:00Z",
    });
    currentTx = makeTx([crossCandidate, ownCandidate]);
    mocks.getWaitlistCrossLodgeOrder.mockResolvedValue("MERGED");
    mocks.checkCapacityForGuestRanges.mockImplementation(async (lodgeId: string) => ({
      available: lodgeId === "lodge-b",
    }));

    const result = await processWaitlistForDates({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-b",
    }, CLUB_FORMAT_TEST);

    expect(result.offeredBookingId).toBe("entry-a");
    const update = currentTx.booking.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: "entry-a" });
    expect(update.data.waitlistOfferedLodgeId).toBe("lodge-b");
    expect(update.data.waitlistOfferedPriceCents).toBe(34000);
    // The offer email states the price (arg 8 after the merged #1035
    // reprice param; arg 9 is the club's format, #3565), speaks with the
    // offered lodge's identity, and names the cross-lodge offer.
    const emailArgs = mocks.sendWaitlistOfferEmail.mock.calls[0];
    expect(emailArgs[8]).toBe(34000);
    expect(emailArgs[9]).toEqual(CLUB_FORMAT_TEST);
    expect(emailArgs[10]).toBe("lodge-b");
    expect(emailArgs[11]).toEqual({ lodgeName: "River Lodge" });
  });

  it("skips a cross-lodge candidate who is no longer eligible for the freed lodge", async () => {
    const crossCandidate = candidate({
      id: "entry-a",
      lodgeId: "lodge-a",
      createdAt: "2026-07-01T10:00:00Z",
      alternates: ["lodge-b"],
    });
    currentTx = makeTx([crossCandidate]);
    mocks.getWaitlistCrossLodgeOrder.mockResolvedValue("MERGED");
    mocks.checkCapacityForGuestRanges.mockImplementation(async (lodgeId: string) => ({
      available: lodgeId === "lodge-b",
    }));
    mocks.isMemberEligibleToBookLodge.mockResolvedValue(false);

    const result = await processWaitlistForDates({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-b",
    }, CLUB_FORMAT_TEST);

    expect(result.offeredBookingId).toBeNull();
    expect(currentTx.booking.update).not.toHaveBeenCalled();
  });

  it("skips a cross-lodge candidate the offered lodge cannot price", async () => {
    const crossCandidate = candidate({
      id: "entry-a",
      lodgeId: "lodge-a",
      createdAt: "2026-07-01T10:00:00Z",
      alternates: ["lodge-b"],
    });
    currentTx = makeTx([crossCandidate]);
    mocks.getWaitlistCrossLodgeOrder.mockResolvedValue("MERGED");
    mocks.checkCapacityForGuestRanges.mockImplementation(async (lodgeId: string) => ({
      available: lodgeId === "lodge-b",
    }));
    mocks.quoteWaitlistEntryAtLodge.mockResolvedValue({
      offerable: false,
      reason: "unpriceable",
    });

    const result = await processWaitlistForDates({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-b",
    }, CLUB_FORMAT_TEST);

    expect(result.offeredBookingId).toBeNull();
    expect(currentTx.booking.update).not.toHaveBeenCalled();
  });

  it("counts the offered candidate's queue position per-lodge, not club-wide (M6)", async () => {
    // The candidate is first in line at lodge B. Older overlapping WAITLISTED
    // entries exist at lodge A; club-wide counting would report position 4,
    // but the per-lodge count makes it position 1.
    const ownCandidate = candidate({
      id: "entry-b",
      lodgeId: "lodge-b",
      createdAt: "2026-07-02T10:00:00Z",
    });
    currentTx = makeTx([ownCandidate]);
    // Only lodge-B entries count toward this candidate's position; the three
    // older lodge-A entries do not.
    currentTx.booking.count.mockImplementation(async (args: {
      where: { lodgeId?: string };
    }) => (args.where.lodgeId === "lodge-b" ? 0 : 3));
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: true });

    const result = await processWaitlistForDates({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-b",
    }, CLUB_FORMAT_TEST);

    expect(result.offeredBookingId).toBe("entry-b");
    // The position count is scoped to the candidate's own lodge.
    expect(currentTx.booking.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "WAITLISTED", lodgeId: "lodge-b" }),
      }),
    );
    // The admin alert (and audit metadata) report position 1, not 4.
    expect(mocks.sendAdminWaitlistOfferAlert).toHaveBeenCalledWith(
      expect.objectContaining({ position: 1 }),
    );
  });

  it("never builds a cross-lodge opportunity for a candidate who did not opt into the freed lodge", async () => {
    const nonOptIn = candidate({
      id: "entry-a",
      lodgeId: "lodge-a",
      createdAt: "2026-07-01T10:00:00Z",
      alternates: [],
    });
    currentTx = makeTx([nonOptIn]);
    // Own lodge has no capacity; freed lodge does.
    mocks.checkCapacityForGuestRanges.mockImplementation(async (lodgeId: string) => ({
      available: lodgeId === "lodge-b",
    }));

    const result = await processWaitlistForDates({
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      lodgeId: "lodge-b",
    }, CLUB_FORMAT_TEST);

    expect(result.offeredBookingId).toBeNull();
    // No cross opportunities exist, so the queue-order setting is not read.
    expect(mocks.getWaitlistCrossLodgeOrder).not.toHaveBeenCalled();
  });
});

describe("confirmWaitlistOffer cross-lodge dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a cross-lodge offer to the create-and-cancel path", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ waitlistOfferedLodgeId: "lodge-b" });
    mocks.confirmCrossLodgeWaitlistOffer.mockResolvedValue({
      success: true,
      newBookingId: "booking-new",
    });

    const result = await confirmWaitlistOffer("entry-a", "member-1");

    expect(mocks.confirmCrossLodgeWaitlistOffer).toHaveBeenCalledWith(
      "entry-a",
      "member-1",
    );
    expect(result).toEqual({ success: true, newBookingId: "booking-new" });
  });

  it("keeps same-lodge offers on the existing in-place path", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ waitlistOfferedLodgeId: null });
    mocks.transaction.mockResolvedValue({ success: false, error: "Booking not found" });

    const result = await confirmWaitlistOffer("entry-a", "member-1");

    expect(mocks.confirmCrossLodgeWaitlistOffer).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});

describe("cross-lodge waitlist source contracts", () => {
  const waitlistSource = readFileSync(
    path.join(process.cwd(), "src/lib/waitlist.ts"),
    "utf8",
  );
  const crossLodgeSource = readFileSync(
    path.join(process.cwd(), "src/lib/waitlist-cross-lodge.ts"),
    "utf8",
  );

  it("every revert to WAITLISTED clears the cross-lodge offer fields", () => {
    // Both revert sites in waitlist.ts (confirm capacity-loss, expiry) and
    // the shared helper in waitlist-cross-lodge.ts must null the offered
    // lodge and price alongside the offer timestamps.
    const revertBlocks =
      waitlistSource.match(
        /data:\s*\{[^}]*status: BookingStatus\.WAITLISTED[^}]*\}/g,
      ) ?? [];
    expect(revertBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of revertBlocks) {
      expect(block).toContain("waitlistOfferedLodgeId: null");
      expect(block).toContain("waitlistOfferedPriceCents: null");
    }
    expect(crossLodgeSource).toContain("waitlistOfferedLodgeId: null");
    expect(crossLodgeSource).toContain("waitlistOfferedPriceCents: null");
  });

  it("the confirm path re-checks the quoted price and never mutates the entry's lodgeId", () => {
    const confirmStart = crossLodgeSource.indexOf(
      "export async function confirmCrossLodgeWaitlistOffer",
    );
    expect(confirmStart).toBeGreaterThan(-1);
    const block = crossLodgeSource.slice(confirmStart);
    // Price drift is rejected against the stored quote before success.
    expect(block).toContain("quote.finalPriceCents !== entry.waitlistOfferedPriceCents");
    expect(block).toContain("newBooking.finalPriceCents !== quotedPriceCents");
    // Create-and-cancel: the fresh booking comes from the standard path and
    // the entry is cancelled — its lodgeId is never reassigned.
    expect(block).toContain("createConfirmedBooking");
    expect(block).toContain("status: BookingStatus.CANCELLED");
    expect(block).not.toMatch(/data:\s*{[^}]*\blodgeId\s*:/);
  });

  it("promo-bearing entries are excluded from cross-lodge quotes", () => {
    expect(crossLodgeSource).toContain("entry.hasPromoRedemption");
    const quoteStart = crossLodgeSource.indexOf(
      "export async function quoteWaitlistEntryAtLodge",
    );
    const quoteBlock = crossLodgeSource.slice(quoteStart, quoteStart + 600);
    expect(quoteBlock).toContain('reason: "promo"');
  });
});
