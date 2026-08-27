import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Role } from "@prisma/client";

/*
  The other-lodge election's exemption from the quote-priced edit block, on the
  SAVE path (owner decision, 21 Aug 2026).

  WHAT WAS BROKEN. `modify-quote` has carried this exemption since the Other
  Lodges epic; `modifyBookingBatch` never had one. So an election-only edit on a
  quote-priced booking PREVIEWED 200 and then SAVED 400 — and a quote-priced
  booking is exactly where these guests come from, because the public request
  form is what asks "are you a member of another lodge?". #2978 did not introduce
  that, but it widened who may be ticked, so it made it far more reachable.

  WHY ALLOWING IT IS SAFE, and why the fence below is the reason. The tick
  renegotiates nothing: it records that somebody belongs to a partner lodge and
  applies the rate the club already agreed to give such people. Pair it with a
  date move, a guest added or removed, a per-guest stay range or a promotion and
  the negotiated basis really does move, so the block applies again in full —
  exactly the shape of the #2337 link exemption this follows.

  `prepareGuestPlan` is stubbed to reject with a sentinel, so "reached the guest
  plan" means the request cleared the block. What happens AFTER it clears — the
  ticked guest's locks being dropped so the re-rate actually reaches the member
  rate — is pinned on the pricing INPUT in
  `src/app/api/bookings/[id]/__tests__/modify-quote-other-lodge-rate.test.ts`,
  over the same election resolver both paths share.
*/

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  isQuotePricedBooking: vi.fn(),
  isMemberWholeLodgeBooking: vi.fn(),
  prepareGuestPlan: vi.fn(),
  loadMemberGuestAddPolicy: vi.fn(),
  assertProposedDateEditClearsXeroLockDate: vi.fn(),
  assertProposedCheckInClearsXeroLockDate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: h.transaction } }));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, acquireLodgeCapacityLock: h.acquireLodgeCapacityLock };
});

vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
  return {
    ...actual,
    isQuotePricedBooking: h.isQuotePricedBooking,
    isMemberWholeLodgeBooking: h.isMemberWholeLodgeBooking,
    prepareGuestPlan: h.prepareGuestPlan,
  };
});

vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/member-guest-add-policy")>();
  return { ...actual, loadMemberGuestAddPolicy: h.loadMemberGuestAddPolicy };
});

vi.mock("@/lib/xero-period-lock-guard", () => ({
  assertProposedCheckInClearsXeroLockDate:
    h.assertProposedCheckInClearsXeroLockDate,
  assertProposedDateEditClearsXeroLockDate:
    h.assertProposedDateEditClearsXeroLockDate,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { QUOTE_PRICED_EDIT_BLOCK_MESSAGE } from "@/lib/booking-modify";
import { addDaysDateOnly, formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");

/*
 * The zone every relative fixture below is built in (#3123).
 * `modifyBookingBatch` takes its own day from `(await clubTime()).today()`, the
 * persisted `ClubTimeSettings` zone; this suite's prisma mock serves no such
 * row, so that resolver falls back to `APP_TIME_ZONE` — `Pacific/Auckland`
 * under test. The fixtures must be built in the same zone the service reads, or
 * a stored window meant to sit 30 nights ahead of the service's today no longer
 * does. Zone AUTHORITY is not what this suite tests, so it names the agreeing
 * zone.
 */
const CLUB_ZONE = "Pacific/Auckland";

const storedCheckIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 30);
const storedCheckOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 33);
const LODGE = "lodge-1";
const GUEST_PLAN_SENTINEL = new Error("reached-the-guest-plan");

function loadedBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: LODGE,
    status: "CONFIRMED",
    checkIn: storedCheckIn,
    checkOut: storedCheckOut,
    wholeLodgeHold: false,
    finalPriceCents: 30_000,
    totalPriceCents: 30_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    creditElectionCents: null,
    organiserSettled: false,
    guests: [
      {
        id: "g1",
        firstName: "Vic",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
      },
    ],
    payment: null,
    member: { id: "member-1" },
    promoRedemption: null,
  };
}

let txClient: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  txClient = {
    $executeRaw: h.executeRaw,
    booking: { findUnique: h.bookingFindUnique },
    choreAssignment: { findMany: vi.fn().mockResolvedValue([]) },
  };
  h.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) => callback(txClient),
  );
  h.bookingFindUnique
    .mockResolvedValueOnce({ lodgeId: LODGE })
    .mockResolvedValueOnce(loadedBooking());
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.loadMemberGuestAddPolicy.mockResolvedValue({});
  h.assertProposedDateEditClearsXeroLockDate.mockResolvedValue(undefined);
  h.assertProposedCheckInClearsXeroLockDate.mockResolvedValue(undefined);
  h.prepareGuestPlan.mockRejectedValue(GUEST_PLAN_SENTINEL);
  // Every case below is a booking whose price was negotiated, which is the only
  // state in which the block fires at all.
  h.isQuotePricedBooking.mockResolvedValue(true);
  h.isMemberWholeLodgeBooking.mockResolvedValue(false);
});

const election = {
  otherLodgeId: "lodge-partner",
  otherLodgeMemberGuestIds: ["g1"],
};

async function save(input: Record<string, unknown>, role: "ADMIN" | "MEMBER" = "ADMIN") {
  return modifyBookingBatch({
    todayAtClub: FIXTURE_CLUB_DAY,
    bookingId: "booking-1",
    // A MEMBER actor is the booking's own owner, so the ownership guard upstream
    // does not refuse first and the quote-priced block is genuinely what answers.
    actor:
      role === "ADMIN"
        ? { id: "admin-9", role: "ADMIN" as Role }
        : { id: "member-1", role: "MEMBER" as Role },
    input,
    ipAddress: "127.0.0.1",
  });
}

describe("modifyBookingBatch: the other-lodge election on a negotiated booking", () => {
  it("EXEMPTS an election-ONLY request from the quote-priced block", async () => {
    // The case that previewed 200 and saved 400. Reaching the guest plan is what
    // "saves" means here: past this point the election resolver and pricing run
    // exactly as they do on any other booking.
    await expect(save(election)).rejects.toThrow(GUEST_PLAN_SENTINEL);

    expect(h.prepareGuestPlan).toHaveBeenCalledTimes(1);
  });

  /**
   * The fence, one case per disturbing field. Each of these genuinely moves the
   * negotiated basis, which is why the exemption above is acceptable at all —
   * so each is asserted separately rather than trusting one representative.
   */
  it.each([
    [
      "a date change",
      { checkOut: formatDateOnly(addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 34)) },
    ],
    [
      "an added guest",
      { addGuests: [{ firstName: "New", lastName: "Guest", ageTier: "ADULT" }] },
    ],
    ["a removed guest", { removeGuestIds: ["g1"] }],
    [
      "a per-guest stay range",
      {
        guestStayRanges: [
          {
            guestId: "g1",
            stayStart: formatDateOnly(storedCheckIn),
            stayEnd: formatDateOnly(storedCheckOut),
          },
        ],
      },
    ],
    ["an added promotion", { promoCode: "WINTER" }],
    ["a removed promotion", { removePromoCode: true }],
  ])("STILL blocks an election combined with %s", async (_label, extra) => {
    await expect(save({ ...election, ...extra })).rejects.toThrow(
      QUOTE_PRICED_EDIT_BLOCK_MESSAGE,
    );

    expect(h.prepareGuestPlan).not.toHaveBeenCalled();
  });

  it("does not exempt a non-officer, even for an election-only request", async () => {
    // `resolveOtherLodgeRateElection` would refuse a member with its own 403
    // later, but the exemption must not read as though a member could use it —
    // and here the block is what answers, before any of that.
    await expect(save(election, "MEMBER")).rejects.toThrow(
      QUOTE_PRICED_EDIT_BLOCK_MESSAGE,
    );

    expect(h.prepareGuestPlan).not.toHaveBeenCalled();
  });

  it("leaves an ordinary edit on a negotiated booking blocked, as before", async () => {
    // The exemption is additive: a request that mentions the rate not at all is
    // refused exactly as it was.
    await expect(
      save({ checkOut: formatDateOnly(addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 34)) }),
    ).rejects.toThrow(QUOTE_PRICED_EDIT_BLOCK_MESSAGE);
  });
});

/**
 * The preview and the save agree BY CONSTRUCTION, not by two lists that happen
 * to match today — which is the whole defect being fixed here. This pins the
 * construction: if a future edit re-inlines either side's field list, the
 * drift that produced the 200-then-400 becomes possible again and this fails.
 */
describe("one predicate answers the exemption on both paths", () => {
  const source = (path: string) => readFileSync(path, "utf8");

  it.each([
    ["the preview", "src/app/api/bookings/[id]/modify-quote/route.ts"],
    ["the save", "src/lib/booking-batch-modification-service.ts"],
  ])("%s calls the shared predicate rather than listing the fields itself", (
    _label,
    file,
  ) => {
    const text = source(file);
    expect(text).toContain("requestIsOtherLodgeRateElectionOnly(");
    // The assignment reads `<flag> = <officer check> && <shared predicate>(…)`,
    // so the field list cannot be sitting beside it.
    const assignment = text.indexOf("const requestIsOtherLodgeRateExempt");
    expect(assignment).toBeGreaterThan(-1);
    const window = text.slice(assignment, assignment + 500);
    expect(window).toContain("requestIsOtherLodgeRateElectionOnly(");
    expect(window).not.toContain("removePromoCode ||");
  });
});
