import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — THE REFUND TIER IS DECIDED ON THE CLUB'S DAY, AND THIS FILE ASSERTS IT
 * AS MONEY.
 *
 * `daysUntilDate` is the cancellation policy's tier boundary: the number it
 * returns is compared against each rule's `daysBeforeStay`, and the rule that
 * wins decides what fraction of a member's payment comes back. It used to
 * project BOTH of its operands through `APP_TIME_ZONE`, and the two projections
 * did not cancel — they subtracted, because a stored `@db.Date` check-in moves
 * back a day in a zone behind Greenwich while a real instant does not. Measured
 * on `America/Denver`: 31 where the answer is 32.
 *
 * So this is not a formatting defect. Every club behind Greenwich was tiering
 * refunds one day short of its own published cancellation policy, and a member
 * cancelling exactly on a tier boundary was paid the lower tier.
 *
 * ## Why the assertion is a dollar figure and not a day count
 *
 * A day count is one indirection away from what the member is owed, and this
 * route is the surface that tells them: `GET /api/bookings/[id]/cancel-preview`
 * is what the cancel dialog reads before they confirm. The case below is built
 * so the boundary falls exactly between the two candidate days, so the club's
 * answer and the container's differ by the WHOLE refund — $400.00 against $0.00
 * on the same booking, the same policy and the same instant.
 *
 * ## What makes this file discriminating
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — both the answer the replaced
 * code gave AND this codebase's own fallback, so it is the one value a wrong fix
 * could still pass under. The PERSISTED club zone is `America/Denver`. Under the
 * repository's frozen clock (`2026-07-01T00:00:00.000Z`) the club's day is
 * 30 June while the environment says 1 July, so nothing here can agree by
 * coincidence and no `vi.setSystemTime` is needed.
 *
 * THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THE PRISMA MOCK.
 * `getClubTimeZone` is fail-soft three ways — no delegate, a throwing query, no
 * row — and each degrades silently to the environment, so a mock without it
 * would pass for exactly the reason this file exists to rule out.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindUnique: vi.fn(),
  memberCreditAggregate: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  paymentEligibleForPaidCancelPath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    memberCredit: { aggregate: mocks.memberCreditAggregate },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));
vi.mock("@/lib/booking-cancel", () => ({
  paymentEligibleForPaidCancelPath: mocks.paymentEligibleForPaidCancelPath,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { GET } from "@/app/api/bookings/[id]/cancel-preview/route";

/**
 * A policy whose only meaningful threshold is THIRTY-TWO days.
 *
 * That number is chosen so the two candidate answers fall on opposite sides of
 * it: from the club's 30 June to a stored check-in of 1 August is 32 lodge days
 * and earns the full refund; from the environment's 1 July it is 31 and earns
 * nothing at all.
 */
const POLICY = [
  { daysBeforeStay: 32, refundPercentage: 100, creditRefundPercentage: 100 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
];

const PAID_CENTS = 40_000;

function bookingRow() {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "PAID",
    finalPriceCents: PAID_CENTS,
    // `Booking.checkIn` is `@db.Date`, so this is the only shape it can hold.
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    payment: {
      amountCents: PAID_CENTS,
      refundedAmountCents: 0,
      changeFeeCents: 0,
      creditAppliedCents: 0,
      manuallyMarkedPaidAt: null,
    },
  };
}

type PreviewBody = {
  refundAmountCents: number;
  refundPercentage: number;
  keptAmountCents: number;
};

async function preview(): Promise<PreviewBody> {
  const response = await GET(
    new Request("http://localhost/api/bookings/booking-1/cancel-preview") as never,
    { params: Promise.resolve({ id: "booking-1" }) },
  );
  return (await response.json()) as PreviewBody;
}

function persistZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.bookingFindUnique.mockResolvedValue(bookingRow());
  mocks.memberCreditAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  mocks.loadCancellationPolicy.mockResolvedValue(POLICY);
  mocks.paymentEligibleForPaidCancelPath.mockResolvedValue(true);
  persistZone(PERSISTED_ZONE);
});

describe("the cancellation refund tier is decided on the club's day (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's disagree about today", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(clubToday(requireClubTimeZone(PERSISTED_ZONE))).toBe("2026-06-30");
    expect(clubToday(requireClubTimeZone(ENVIRONMENT_ZONE))).toBe("2026-07-01");
  });

  it("MONEY: the member is quoted the full $400.00 their club's own policy owes them", async () => {
    // 30 June -> 1 August is 32 lodge days, which is exactly the club's 100%
    // threshold. On the environment's 1 July it would be 31, one day short, and
    // this member would be told they get nothing back.
    const body = await preview();
    expect(body.refundAmountCents).toBe(40_000);
    expect(body.refundPercentage).toBe(100);
    expect(body.keptAmountCents).toBe(0);
  });

  it("MONEY: the environment's day is the WRONG answer, and it is a whole tier away", async () => {
    // Stated explicitly rather than implied, so the size of the defect is on the
    // record: swap the persisted zone for the container's and the same member,
    // the same booking and the same instant produce $0.00.
    persistZone(ENVIRONMENT_ZONE);
    const body = await preview();
    expect(body.refundAmountCents).toBe(0);
    expect(body.refundPercentage).toBe(0);
    expect(body.keptAmountCents).toBe(40_000);
  });

  it("still refuses the tier when the club's own day is genuinely inside it", async () => {
    // A 31 July check-in is 31 days from the club's 30 June — one short — so the
    // fix does not simply pay everybody. The boundary moved onto the club's
    // calendar; it did not disappear.
    mocks.bookingFindUnique.mockResolvedValue({
      ...bookingRow(),
      checkIn: new Date("2026-07-31T00:00:00.000Z"),
    });
    const body = await preview();
    expect(body.refundAmountCents).toBe(0);
  });

  it("MOVES with the persisted zone, which kills a hard-coded Pacific/Auckland", async () => {
    // Two zones on opposite sides of the date line at the frozen instant. If the
    // day were pinned to a constant — Auckland, the container, anything but the
    // row — these two would agree, and they must not.
    persistZone("Pacific/Kiritimati"); // UTC+14, so 1 July
    const east = await preview();
    persistZone("Pacific/Pago_Pago"); // UTC-11, so 30 June
    const west = await preview();

    expect(east.refundAmountCents).toBe(0);
    expect(west.refundAmountCents).toBe(40_000);
  });

  it("reads the club's timezone ONCE for the preview, not once per figure", async () => {
    // The preview reports a card refund, a credit refund and a credit restore
    // from one `calculateCancellationPreview` call. One resolved day feeds all
    // of them, so they cannot disagree across club midnight.
    await preview();
    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledTimes(1);
  });
});
