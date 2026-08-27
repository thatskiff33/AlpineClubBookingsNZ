import { beforeEach, describe, expect, it, vi } from "vitest";

// #1697 wiring: both recalculate-override services must consult the Xero
// lock-date guard BEFORE opening their modification transaction (the guard
// performs a Xero API call, which must never run inside a DB transaction),
// and only when the admin override is active.
//
// #1729 wiring: ordinary (non-override) date edits get the NARROW guard on
// the same pre-transaction footing — it consults the lock dates only when
// the edit would actually queue the check-in-dated invoice update (issued
// Xero invoice + dates changing + payment not settled), with member wording
// for non-admin actors. The override variant stays mocked (h.assertProposed);
// the ordinary variant runs for real over mocked module-settings /
// xero-token-store / xero-organisation so these tests prove the narrow
// predicate itself, not just a call-through.

const h = vi.hoisted(() => ({
  assertProposed: vi.fn(),
  transaction: vi.fn(),
  bookingFindUnique: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
}));

const TRANSACTION_SENTINEL = new Error("reached-the-transaction");

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
    booking: { findUnique: h.bookingFindUnique },
  },
}));
vi.mock("@/lib/xero-period-lock-guard", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-period-lock-guard")>();
  return { ...actual, assertProposedCheckInClearsXeroLockDate: h.assertProposed };
});
// The ordinary-edit guard's lock-date chain (#1729). getEffectiveXeroLockDate
// stays real, as do the module-settings helpers the services pull in at
// import time (only the flag loader is stubbed).
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/module-settings")>();
  return { ...actual, loadEffectiveModuleFlags: h.loadEffectiveModuleFlags };
});
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-organisation")>();
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { modifyBookingDates } from "@/lib/booking-date-modification-service";
import { XeroPeriodLockedError } from "@/lib/xero-period-lock-guard";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");

const actor = { id: "admin1", role: "ADMIN" as const };
const memberActor = { id: "m1", role: "USER" as const };

/** The club's zone, named rather than taken from a helper default (#3123). */
const CLUB_ZONE = "Pacific/Auckland";

// Relative dates only: the guard compares against the club's own today.
const daysAgo = (n: number) =>
  addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -n);

// Light pre-transaction row (#1729): an unpaid invoiced booking whose past
// stay sits inside the locked period (lock = daysAgo(10), armed below).
const guardedLightBooking = (
  overrides: Partial<{
    checkIn: Date;
    checkOut: Date;
    status: string;
    memberId: string;
    payment: { status: string; xeroInvoiceId: string | null } | null;
  }> = {},
) => ({
  checkIn: daysAgo(15),
  checkOut: daysAgo(12),
  status: "CONFIRMED",
  // Owned by the member actor: the guard defers foreign bookings to the
  // transaction's 403 (PR #1748 review).
  memberId: "m1",
  payment: { status: "PENDING", xeroInvoiceId: "inv-1" },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.assertProposed.mockResolvedValue(undefined);
  // The transaction body needs a real database; every case here must resolve
  // BEFORE it. Rejecting with a sentinel proves exactly how far a call got.
  h.transaction.mockRejectedValue(TRANSACTION_SENTINEL);
  h.bookingFindUnique.mockResolvedValue(null);
  // Lock armed by default for the #1729 cases; the override cases never reach
  // this chain (their guard is the h.assertProposed mock).
  h.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: true });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: daysAgo(10),
    endOfYearLockDate: null,
  });
});

describe("modifyBookingDates (issue #1697)", () => {
  it("consults the guard with the requested check-in before the transaction and propagates its rejection", async () => {
    h.assertProposed.mockRejectedValue(new XeroPeriodLockedError("2026-06-30"));

    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor,
        // This service's override is always the recalculate mode (shift is
        // dispatched to adminShiftBookingDates at the route).
        input: {
          adminOverride: true,
          checkIn: "2026-06-15",
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(XeroPeriodLockedError);

    expect(h.assertProposed).toHaveBeenCalledWith(
      expect.anything(),
      "b1",
      "2026-06-15",
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("passes undefined for a check-out-only override (the guard falls back to the stored check-in)", async () => {
    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor,
        input: {
          adminOverride: true,
          checkOut: "2026-06-20",
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);

    expect(h.assertProposed).toHaveBeenCalledWith(
      expect.anything(),
      "b1",
      undefined,
    );
  });

  it("never consults the OVERRIDE guard for a standard (non-override) date change", async () => {
    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor,
        input: { checkIn: "2026-06-15" },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);

    expect(h.assertProposed).not.toHaveBeenCalled();
  });
});

describe("modifyBookingDates ordinary-edit narrow guard (issue #1729)", () => {
  it("rejects a member date change pre-transaction with the member wording when the narrow predicate holds", async () => {
    h.bookingFindUnique.mockResolvedValue(guardedLightBooking());

    const error = await modifyBookingDates({
      bookingId: "b1",
      actor: memberActor,
      input: { checkIn: formatDateOnly(daysAgo(20)) },
      ipAddress: "test",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(XeroPeriodLockedError);
    expect((error as XeroPeriodLockedError).message).toBe(
      "These dates fall in an accounting period that has been locked in Xero. Please contact an administrator to make this change.",
    );
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.assertProposed).not.toHaveBeenCalled();
    // The pre-read happened outside the transaction, with the light select.
    expect(h.bookingFindUnique).toHaveBeenCalledWith({
      where: { id: "b1" },
      select: {
        checkIn: true,
        checkOut: true,
        status: true,
        memberId: true,
        payment: { select: { status: true, xeroInvoiceId: true } },
      },
    });
  });

  it("gives an admin's ordinary edit the unlock-instructions wording on the same rejection", async () => {
    h.bookingFindUnique.mockResolvedValue(guardedLightBooking());

    const error = await modifyBookingDates({
      bookingId: "b1",
      actor,
      input: { checkIn: formatDateOnly(daysAgo(20)) },
      ipAddress: "test",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(XeroPeriodLockedError);
    expect((error as XeroPeriodLockedError).message).toContain(
      "Unlock the period in Xero",
    );
  });

  it("guards a member's check-out-only change via the unchanged past check-in", async () => {
    h.bookingFindUnique.mockResolvedValue(guardedLightBooking());

    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor: memberActor,
        input: { checkOut: formatDateOnly(daysAgo(11)) },
        ipAddress: "test",
      }),
    ).rejects.toThrow(XeroPeriodLockedError);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("never consults the lock dates on a paid booking (no check-in-dated write would be queued)", async () => {
    h.bookingFindUnique.mockResolvedValue(
      guardedLightBooking({
        payment: { status: "SUCCEEDED", xeroInvoiceId: "inv-1" },
      }),
    );

    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor: memberActor,
        input: { checkIn: formatDateOnly(daysAgo(20)) },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("never consults the lock dates without an issued Xero invoice", async () => {
    h.bookingFindUnique.mockResolvedValue(
      guardedLightBooking({ payment: null }),
    );

    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor: memberActor,
        input: { checkIn: formatDateOnly(daysAgo(20)) },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("never consults the lock dates when the requested dates equal the stored ones", async () => {
    h.bookingFindUnique.mockResolvedValue(guardedLightBooking());

    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor: memberActor,
        input: {
          checkIn: formatDateOnly(daysAgo(15)),
          checkOut: formatDateOnly(daysAgo(12)),
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });
});

describe("modifyBookingBatch (issue #1697)", () => {
  it("consults the guard for a recalculate override before the transaction and propagates its rejection", async () => {
    h.assertProposed.mockRejectedValue(new XeroPeriodLockedError("2026-06-30"));

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "b1",
        actor,
        input: {
          adminOverride: true,
          pricingMode: "recalculate",
          checkIn: "2026-06-15",
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(XeroPeriodLockedError);

    expect(h.assertProposed).toHaveBeenCalledWith(
      expect.anything(),
      "b1",
      "2026-06-15",
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("rejects shift mode before the guard is ever consulted (shift never reaches recalculate machinery)", async () => {
    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "b1",
        actor,
        input: {
          adminOverride: true,
          pricingMode: "shift",
          checkIn: "2026-06-15",
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(
      "Shift-mode admin overrides are applied through the date-shift path",
    );

    expect(h.assertProposed).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("never consults the OVERRIDE guard for a standard (non-override) edit", async () => {
    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "b1",
        actor,
        input: { checkIn: "2026-06-15" },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);

    expect(h.assertProposed).not.toHaveBeenCalled();
  });
});

describe("modifyBookingBatch ordinary-edit narrow guard (issue #1729)", () => {
  it("rejects a member date-changing edit pre-transaction when the narrow predicate holds", async () => {
    h.bookingFindUnique.mockResolvedValue(guardedLightBooking());

    const error = await modifyBookingBatch({
      todayAtClub: FIXTURE_CLUB_DAY,
      bookingId: "b1",
      actor: memberActor,
      input: { checkOut: formatDateOnly(daysAgo(11)) },
      ipAddress: "test",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(XeroPeriodLockedError);
    expect((error as XeroPeriodLockedError).message).toContain(
      "contact an administrator",
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("defers a member's edit of a booking they do not own to the transaction's 403 (no lock-date disclosure, PR #1748 review)", async () => {
    h.bookingFindUnique.mockResolvedValue(
      guardedLightBooking({ memberId: "someone-else" }),
    );

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "b1",
        actor: memberActor,
        input: { checkOut: formatDateOnly(daysAgo(11)) },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);

    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("never reads the booking for an identity-only edit (guest name fixes stay unguarded)", async () => {
    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "b1",
        actor: memberActor,
        input: {
          guestUpdates: [{ guestId: "g1", firstName: "Ann", lastName: "Doe" }],
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);

    expect(h.bookingFindUnique).not.toHaveBeenCalled();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("never consults the lock dates on a paid booking", async () => {
    h.bookingFindUnique.mockResolvedValue(
      guardedLightBooking({
        payment: { status: "SUCCEEDED", xeroInvoiceId: "inv-1" },
      }),
    );

    await expect(
      modifyBookingBatch({
        todayAtClub: FIXTURE_CLUB_DAY,
        bookingId: "b1",
        actor: memberActor,
        input: { checkIn: formatDateOnly(daysAgo(20)) },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });
});
