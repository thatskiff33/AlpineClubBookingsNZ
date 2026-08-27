import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #2337 — the SERVICE-level gate for the placeholder→member link, the two rules
  that live in `modifyBookingBatch` rather than in the pure resolver:

    1. member-ORIGIN fence — a link is refused unless the booking is a genuine
       member whole-lodge booking (`isMemberWholeLodgeBooking`), so a SCHOOL
       whole-lodge booking's students can never be re-rated at a member rate; and
    2. quote-priced exemption — a member-whole-lodge LINK-ONLY request is exempt
       from the quote-priced block (the placeholders were flat-split at approval,
       so the link IS the sanctioned re-rate), but a link COMBINED with a
       date/add/remove/promo change is still blocked.

  `prepareGuestPlan` is stubbed to reject with a sentinel, so "reached the guest
  plan" means the request cleared both gates.
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
 * the "mid-stay" booking below stops straddling the service's today. Zone
 * AUTHORITY is not what this suite tests, so it names the agreeing zone.
 */
const CLUB_ZONE = "Pacific/Auckland";

const storedCheckIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 30);
const storedCheckOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 33);
const LODGE = "lodge-1";
const GUEST_PLAN_SENTINEL = new Error("reached-the-guest-plan");

// #2337: an in-progress (mid-stay) variant — PAID and straddling NZ today — so
// `resolveTargetDates` resolves the edit to the in-progress mode where a link
// would price through the in-progress plan and silently settle $0.
function inProgressBooking() {
  return {
    ...loadedBooking(),
    status: "PAID",
    checkIn: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -1),
    checkOut: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 2),
  };
}

function loadedBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: LODGE,
    status: "CONFIRMED",
    checkIn: storedCheckIn,
    checkOut: storedCheckOut,
    wholeLodgeHold: true,
    finalPriceCents: 30_000,
    totalPriceCents: 30_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    creditElectionCents: null,
    organiserSettled: false,
    guests: [
      {
        id: "g1",
        firstName: "Guest",
        lastName: "1",
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
});

const link = { linkGuestToMember: [{ guestId: "g1", memberId: "member-9" }] };

describe("modifyBookingBatch member-link service gate (#2337)", () => {
  it("REFUSES a link on a booking that is not a member whole-lodge booking, before the guest plan", async () => {
    h.isQuotePricedBooking.mockResolvedValue(false);
    h.isMemberWholeLodgeBooking.mockResolvedValue(false);

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "admin-9", role: "ADMIN" },
        input: link,
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(/only available on member whole-lodge bookings/);

    expect(h.prepareGuestPlan).not.toHaveBeenCalled();
  });

  it("EXEMPTS a member-whole-lodge LINK-ONLY request from the quote-priced block", async () => {
    // The booking is quote-priced (flat-split at approval) AND member-origin: the
    // link is the sanctioned re-rate, so it must clear the block and reach pricing.
    h.isQuotePricedBooking.mockResolvedValue(true);
    h.isMemberWholeLodgeBooking.mockResolvedValue(true);

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "admin-9", role: "ADMIN" },
        input: link,
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(GUEST_PLAN_SENTINEL);

    expect(h.prepareGuestPlan).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a link on an IN-PROGRESS (mid-stay) booking BEFORE the guest plan — the silent-$0 re-rate (#2337 apply path)", async () => {
    // Member-origin and quote-priced (harmless — a link-only request is exempt),
    // so the request clears both service gates and reaches resolveTargetDates,
    // which refuses the mid-stay link before any pricing or the guest plan.
    h.isQuotePricedBooking.mockResolvedValue(true);
    h.isMemberWholeLodgeBooking.mockResolvedValue(true);
    h.bookingFindUnique
      .mockReset()
      .mockResolvedValueOnce({ lodgeId: LODGE })
      .mockResolvedValueOnce(inProgressBooking());

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "admin-9", role: "ADMIN" },
        input: link,
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(/not available once a booking has started/);

    // The refusal fires before the guest plan, so nothing is priced or settled.
    expect(h.prepareGuestPlan).not.toHaveBeenCalled();
  });

  it("STILL blocks a link COMBINED with a date change on a quote-priced booking", async () => {
    // The exemption is link-ONLY: a date change on a quote-priced booking would
    // reprice the whole negotiated basis, so the block must still fire.
    h.isQuotePricedBooking.mockResolvedValue(true);
    h.isMemberWholeLodgeBooking.mockResolvedValue(true);

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "booking-1",
        actor: { id: "admin-9", role: "ADMIN" },
        input: {
          ...link,
          checkOut: formatDateOnly(addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 34)),
        },
        ipAddress: "127.0.0.1",
      }),
    ).rejects.toThrow(QUOTE_PRICED_EDIT_BLOCK_MESSAGE);

    expect(h.prepareGuestPlan).not.toHaveBeenCalled();
  });
});
