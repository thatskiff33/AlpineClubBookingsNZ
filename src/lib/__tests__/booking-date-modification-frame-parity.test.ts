/**
 * CT-4 (#2870), #3088: THE PREVIEW AND THE THIRD APPLY-PATH MIRROR MUST AGREE.
 *
 * `booking-date-modification-service.ts` holds both apply-path halves of the
 * booking-modification date window — `modifyBookingDates` and
 * `adminShiftBookingDates`. Their preview twins live in
 * `src/app/api/bookings/[id]/modify-quote/route.ts`: the `editPolicy.today`
 * gate in `POST`, and `buildShiftPreviewResponse`.
 *
 * Group B (#3056) corrected the preview side onto `storedDateOnly` and left
 * three apply-path mirrors reading the same `@db.Date` lodge nights through
 * `APP_TIME_ZONE`. F4b (#3087) fixed the first, `booking-modify-validation.ts`;
 * this file pins the third. For a club behind Greenwich the two halves computed
 * windows a day apart, so a member could be quoted a modification and refused
 * when they saved it.
 *
 * ## WHY THIS IS ONE AGREEMENT TEST AND NOT TWO PINS
 *
 * The defect class is DIVERGENCE, and two independent assertions can both pass
 * while the pair disagrees — that is exactly how #2870's ledger came to record
 * the pair as "internally consistent with each other" for two whole groups
 * after #3056 stopped making it true. So every case below computes the
 * PREVIEW's answer from an oracle and compares the apply path against THAT,
 * with one assertion over the pair. Nothing here asserts an absolute date that
 * a reader could satisfy by moving both sides together.
 *
 * The oracles transcribe the quote route rather than importing it, for the
 * reason F4b's parity test gives: importing the route drags its whole module
 * graph in and proves nothing about the text that actually ships there.
 *
 * ## WHAT MAKES THESE CASES DISCRIMINATING
 *
 * Two axes, because the removed call read one and the surviving code must be
 * independent of both:
 *
 * - `APP_TIME_ZONE` is mocked to `America/Denver`. It cannot be left at its
 *   default: with no `TZ` set that default IS `Pacific/Auckland`, which is
 *   ahead of Greenwich, where `normalizeDateOnlyForTimeZone` is the identity on
 *   a UTC-midnight value and every case below would pass vacuously.
 * - one case pins the HOST behind Greenwich as well (`Pacific/Pago_Pago`),
 *   because `storedDateOnly` must read the stored day with UTC getters and take
 *   no zone at all.
 *
 * The frozen clock is `2026-07-01T00:00:00.000Z`. Read in Denver that instant is
 * still 30 June, so `editPolicy.today` is `2026-06-30` — and a stored
 * `2026-07-01` read as itself is after it while the same value projected through
 * Denver is `2026-06-30`, which is not. One day decides whether the member is
 * refused. This file installs no clock of its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

// Hoisted spies so the module mocks below can reference them and tests can read
// what the apply path actually wrote.
const h = vi.hoisted(() => ({
  txBookingFindUnique: vi.fn(),
  txBookingUpdate: vi.fn(),
  txGuestUpdate: vi.fn(),
  txGuestNightDeleteMany: vi.fn(),
  txGuestNightCreateMany: vi.fn(),
  txModificationCreate: vi.fn(),
  executeRaw: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  sendBookingModifiedEmail: vi.fn(),
  logAudit: vi.fn(),
  linkModification: vi.fn(),
  processWaitlistForDates: vi.fn(),
  assertNoConflicts: vi.fn(),
  reconcileBedAllocations: vi.fn(),
  cleanupDate: vi.fn(),
  cleanupRanges: vi.fn(),
  assertEnvelope: vi.fn(),
  assertNotQuotePriced: vi.fn(),
  reconcileHosting: vi.fn(),
  validateMinimumStay: vi.fn(),
}));

const tx = {
  // #1881 — the date service takes the global lock(1) via $executeRaw, and the
  // roster-date locks go through the same channel.
  $executeRaw: h.executeRaw,
  booking: { findUnique: h.txBookingFindUnique, update: h.txBookingUpdate },
  bookingGuest: { update: h.txGuestUpdate },
  bookingGuestNight: {
    deleteMany: h.txGuestNightDeleteMany,
    createMany: h.txGuestNightCreateMany,
  },
  bookingModification: { create: h.txModificationCreate },
  payment: { update: vi.fn() },
  choreAssignment: { findMany: vi.fn().mockResolvedValue([]) },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (client: typeof tx) => unknown) => cb(tx),
  },
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
    checkCapacity: vi.fn(),
    acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
  };
});

vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: h.sendBookingModifiedEmail,
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: vi.fn(),
}));
vi.mock("@/lib/xero-period-lock-guard", () => ({
  assertProposedCheckInClearsXeroLockDate: vi.fn(),
  assertProposedDateEditClearsXeroLockDate: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/booking-change-request-linkage", () => ({
  linkModificationToOutstandingChangeRequest: h.linkModification,
}));
vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: h.processWaitlistForDates,
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: h.assertNoConflicts,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: h.reconcileBedAllocations,
}));
vi.mock("@/lib/chore-cleanup", () => ({
  cleanupChoreAssignmentsForDateChange: h.cleanupDate,
  cleanupChoreAssignmentsForGuestStayRanges: h.cleanupRanges,
}));
vi.mock("@/lib/booking-envelope-invariants", () => ({
  assertBookingEnvelopeInvariants: h.assertEnvelope,
}));
// `modifyBookingDates` reaches this one immediately after the window gate, so
// reaching it is the marker that the gate did NOT fire — see
// `applyRefusesSelfServiceWindow`.
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: () => "minimum stay",
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
}));
vi.mock("@/lib/policies/booking-route-decisions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/policies/booking-route-decisions")>();
  return { ...actual, calculateBookingHoldDecision: vi.fn() };
});
vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
  return { ...actual, assertBookingNotQuotePriced: h.assertNotQuotePriced };
});
vi.mock("@/lib/booking-modification-settlement", () => ({
  createModificationAdditionalPaymentIntent: vi.fn(),
  executeBookingModificationRefund: vi.fn(),
}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: vi.fn(),
  clampAppliedCreditToBookingPrice: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/adult-member-hosting-review", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/adult-member-hosting-review")
  >();
  return {
    ...actual,
    reconcileAdultMemberHostingReviewWithSiblings: h.reconcileHosting,
  };
});

import { APP_TIME_ZONE } from "@/config/operational";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  getTodayDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import {
  adminShiftBookingDates,
  modifyBookingDates,
} from "@/lib/booking-date-modification-service";
import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SELF_SERVICE_REFUSAL =
  "NZ today and earlier are locked for self-service changes";
const NO_CHANGE_REFUSAL = "The booking already has these dates";
/**
 * The statement immediately after the window gate, made to fail on purpose.
 * Reaching it is the only evidence available here that the gate let a request
 * through: getting past it needs the whole pricing, capacity and settlement tail
 * of the function, none of which this file is about.
 */
const PAST_THE_GATE = "PAST_THE_GATE";

/**
 * The same single-guest PAID fixture `admin-shift-booking-dates.test.ts` uses,
 * moved onto the frozen clock: 3 nights of 10000c, stored as UTC-midnight
 * `@db.Date` values, every one of which reads a day EARLIER through Denver.
 */
function makeBooking(checkIn = "2026-07-05", checkOut = "2026-07-08") {
  const nights = eachDateOnlyInRange(D(checkIn), D(checkOut));
  return {
    id: "b1",
    status: "PAID",
    lodgeId: "lodge-1",
    memberId: "m1",
    checkIn: D(checkIn),
    checkOut: D(checkOut),
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 30000,
    nonMemberHoldUntil: null,
    member: { id: "m1", email: "m@example.com", firstName: "Mia" },
    payment: null,
    promoRedemption: null,
    guests: [
      {
        id: "g1",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        priceCents: 30000,
        stayStart: D(checkIn),
        stayEnd: D(checkOut),
        nights: nights.map((stayDate) => ({ stayDate, priceCents: 10000 })),
      },
    ],
  };
}

type Booking = ReturnType<typeof makeBooking>;

function primeTx(booking: Booking) {
  // findUnique #1 = lock-target select {lodgeId}; #2 = the full booking include.
  h.txBookingFindUnique
    .mockResolvedValueOnce({ lodgeId: booking.lodgeId })
    .mockResolvedValueOnce(booking);
  h.txBookingUpdate.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...booking,
        ...data,
        guests: booking.guests,
        payment: booking.payment,
      }),
  );
  h.txModificationCreate.mockResolvedValue({ id: "mod_1" });
}

// ---------------------------------------------------------------------------
// The oracles: what the PREVIEW computes, in the preview's own terms.
// ---------------------------------------------------------------------------

/**
 * `modify-quote/route.ts`'s self-service window gate, transcribed. Its
 * `editPolicy.today` is the container's day on both sides of the pair (CT-6,
 * #2991, is what moves that), so the only thing this pins is that the REQUESTED
 * day is read as the day it is.
 */
function previewRefusesSelfServiceWindow(
  booking: Booking,
  requestedCheckIn: Date,
): boolean {
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: "USER",
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });
  return storedDateOnly(requestedCheckIn) <= editPolicy.today;
}

/**
 * What `buildShiftPreviewResponse` computes for a check-in-only shift: the
 * previous range, the delta, and the `translatedRanges` it prices capacity and
 * the person-night guard against.
 */
function previewShift(booking: Booking, requestedCheckInStr: string) {
  const oldCheckIn = storedDateOnly(booking.checkIn);
  const oldCheckOut = storedDateOnly(booking.checkOut);
  const originalNightCount = eachDateOnlyInRange(oldCheckIn, oldCheckOut).length;
  const newCheckIn = parseDateOnly(requestedCheckInStr);
  const newCheckOut = addDaysDateOnly(newCheckIn, originalNightCount);
  const deltaDays = Math.round(
    (newCheckIn.getTime() - oldCheckIn.getTime()) / MS_PER_DAY,
  );
  const translatedRanges = booking.guests.map((guest) => ({
    memberId: guest.memberId ?? null,
    stayStart: addDaysDateOnly(storedDateOnly(guest.stayStart), deltaDays),
    stayEnd: addDaysDateOnly(storedDateOnly(guest.stayEnd), deltaDays),
    nights: guest.nights.map((night) =>
      addDaysDateOnly(storedDateOnly(night.stayDate), deltaDays),
    ),
  }));
  return {
    previousRange: { checkIn: oldCheckIn, checkOut: oldCheckOut },
    deltaDays,
    translatedRanges,
    // What the guest envelope row must become, which is the same pair of days
    // the preview priced.
    guestEnvelope: {
      stayStart: translatedRanges[0].stayStart,
      stayEnd: translatedRanges[0].stayEnd,
    },
    nightDates: translatedRanges[0].nights,
  };
}

// ---------------------------------------------------------------------------
// The apply path, reduced to the same terms.
// ---------------------------------------------------------------------------

/**
 * True when `modifyBookingDates` refuses on the self-service window.
 *
 * A refusal from the minimum-stay policy is the marker for "the gate did not
 * fire": it is the very next statement in the function, so reaching it proves
 * the window gate let the request through. Anything else is re-thrown rather
 * than swallowed, so a change that moves the gate cannot quietly read as a pass.
 */
async function applyRefusesSelfServiceWindow(
  booking: Booking,
  requestedCheckIn: string,
  requestedCheckOut: string,
): Promise<boolean> {
  primeTx(booking);
  h.validateMinimumStay.mockRejectedValue(new Error(PAST_THE_GATE));
  try {
    await modifyBookingDates({
      bookingId: booking.id,
      actor: { id: "m1", role: "USER" },
      input: { checkIn: requestedCheckIn, checkOut: requestedCheckOut },
      ipAddress: "1.1.1.1",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === SELF_SERVICE_REFUSAL) return true;
    if (message === PAST_THE_GATE) return false;
    throw error;
  }
  // Fail closed. A harness that cannot tell a refusal from a pass must not
  // report either — the marker moving is a harness failure, not a survival.
  throw new Error(
    "modifyBookingDates neither refused on the window nor reached the " +
      "minimum-stay marker; this harness can no longer tell the two apart",
  );
}

/** What `adminShiftBookingDates` actually wrote, in `previewShift`'s terms. */
async function runAdminShift(booking: Booking, requestedCheckInStr: string) {
  primeTx(booking);
  await adminShiftBookingDates({
    bookingId: booking.id,
    actor: { id: "admin1", role: "ADMIN" },
    input: { checkIn: requestedCheckInStr },
    ipAddress: "1.1.1.1",
  });
  const previousRange = h.reconcileBedAllocations.mock.calls[0][0]
    .previousRange as { checkIn: Date; checkOut: Date };
  const nightDates = (
    h.txGuestNightCreateMany.mock.calls[0][0].data as Array<{ stayDate: Date }>
  ).map((row) => row.stayDate);
  const modification = h.txModificationCreate.mock.calls[0][0].data as {
    previousData: { checkIn: string };
    newData: { checkIn: string };
  };
  return {
    previousRange,
    deltaDays: Math.round(
      (parseDateOnly(modification.newData.checkIn).getTime() -
        parseDateOnly(modification.previousData.checkIn).getTime()) /
        MS_PER_DAY,
    ),
    // The ranges capacity and the person-night guard were asked about — the
    // apply-path name for the preview's `translatedRanges`.
    translatedRanges: h.checkCapacityForGuestRanges.mock.calls[0][3],
    guestEnvelope: h.txGuestUpdate.mock.calls[0][0].data as {
      stayStart: Date;
      stayEnd: Date;
    },
    nightDates,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.executeRaw.mockResolvedValue(undefined);
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.assertNotQuotePriced.mockResolvedValue(undefined);
  h.assertNoConflicts.mockResolvedValue(undefined);
  h.reconcileBedAllocations.mockResolvedValue(undefined);
  h.cleanupDate.mockResolvedValue({ choreWarnings: [] });
  h.cleanupRanges.mockResolvedValue({ choreWarnings: [] });
  h.assertEnvelope.mockResolvedValue(undefined);
  h.sendBookingModifiedEmail.mockResolvedValue(undefined);
  h.processWaitlistForDates.mockResolvedValue(undefined);
  h.linkModification.mockResolvedValue(null);
  h.reconcileHosting.mockResolvedValue({
    action: "none",
    violation: null,
    mode: null,
  });
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
});

describe("the preview and the apply service read the same date window", () => {
  it("PREMISE: the mocked zone puts the club's today a day behind the stored day", () => {
    expect(APP_TIME_ZONE).toBe("America/Denver");
    expect(formatDateOnly(getTodayDateOnly())).toBe("2026-06-30");
    // The single day every case below turns on: a stored 1 July projected
    // through Denver is 30 June.
    expect(formatDateOnlyForTimeZone(D("2026-07-01"))).toBe("2026-06-30");
  });

  // `modifyBookingDates`, the self-service window gate. Both directions in one
  // loop, each asserting the pair rather than either side.
  it.each([
    // The discriminator: read as stored it is after club-today, read through
    // Denver it is not.
    ["2026-07-01", "2026-07-08"],
    // A control the pair agree to REFUSE, in both frames.
    ["2026-06-30", "2026-07-08"],
    // A control the pair agree to ALLOW, in both frames.
    ["2026-07-09", "2026-07-12"],
  ])(
    "a member asking for %s is refused exactly when the preview would refuse it",
    async (requestedCheckIn, requestedCheckOut) => {
      const booking = makeBooking("2026-07-05", "2026-07-08");
      expect(
        await applyRefusesSelfServiceWindow(
          booking,
          requestedCheckIn,
          requestedCheckOut,
        ),
      ).toBe(previewRefusesSelfServiceWindow(booking, D(requestedCheckIn)));
    },
  );

  it("and the three cases are not all the same answer", () => {
    // Guards the loop above against becoming vacuous: if every case agreed by
    // returning `false`, the two frames could differ and the loop still pass.
    const booking = makeBooking("2026-07-05", "2026-07-08");
    expect(
      ["2026-07-01", "2026-06-30", "2026-07-09"].map((day) =>
        previewRefusesSelfServiceWindow(booking, D(day)),
      ),
    ).toEqual([false, true, false]);
  });

  it("HOST AXIS: the host cannot move that answer either", async () => {
    const booking = makeBooking("2026-07-05", "2026-07-08");
    const expected = previewRefusesSelfServiceWindow(booking, D("2026-07-01"));
    await withTimeZoneAsync("Pacific/Pago_Pago", async () => {
      expect(
        await applyRefusesSelfServiceWindow(booking, "2026-07-01", "2026-07-08"),
      ).toBe(expected);
    });
  });

  // `adminShiftBookingDates`. The translated guest rows survive a wrong
  // `oldCheckIn` by accident — the delta absorbs the same one-day error that
  // produced it — so a test that only checked the shifted nights would have
  // passed throughout. The previous range does NOT survive it, and it is what
  // the bed-allocation release, the modification history, the waitlist release
  // and the member's email are all built from.
  it("shifts by the delta the preview quoted, from the range it quoted", async () => {
    const booking = makeBooking("2026-07-05", "2026-07-08");
    expect(await runAdminShift(booking, "2026-07-09")).toEqual(
      previewShift(booking, "2026-07-09"),
    );
  });

  it("releases the beds and the waitlist for the range the preview showed", async () => {
    const booking = makeBooking("2026-07-05", "2026-07-08");
    const preview = previewShift(booking, "2026-07-09");
    await runAdminShift(booking, "2026-07-09");
    expect(h.processWaitlistForDates.mock.calls[0][0]).toMatchObject({
      checkIn: preview.previousRange.checkIn,
      checkOut: preview.previousRange.checkOut,
    });
    expect(h.sendBookingModifiedEmail.mock.calls[0][0]).toMatchObject({
      oldCheckIn: preview.previousRange.checkIn,
      oldCheckOut: preview.previousRange.checkOut,
    });
  });

  it("refuses a no-op shift the preview would have priced at zero nights", async () => {
    // The sharpest case in the shift path. Re-submitting the booking's own
    // check-in is a delta of nought, which the preview reports as "shifted by 0
    // night(s)"; the apply path must refuse it. Read through Denver its
    // `oldCheckIn` was a day earlier, so the equality guard never matched and a
    // phantom shift wrote a modification row, mailed the member and released a
    // range the booking never occupied.
    const booking = makeBooking("2026-07-05", "2026-07-08");
    expect(previewShift(booking, "2026-07-05").deltaDays).toBe(0);
    primeTx(booking);
    await expect(
      adminShiftBookingDates({
        bookingId: booking.id,
        actor: { id: "admin1", role: "ADMIN" },
        input: { checkIn: "2026-07-05" },
        ipAddress: "1.1.1.1",
      }),
    ).rejects.toThrow(NO_CHANGE_REFUSAL);
    expect(h.txModificationCreate).not.toHaveBeenCalled();
    expect(h.processWaitlistForDates).not.toHaveBeenCalled();
  });

  it("HOST AXIS: the shift agrees under a host behind Greenwich too", async () => {
    const booking = makeBooking("2026-07-05", "2026-07-08");
    const preview = previewShift(booking, "2026-07-09");
    await withTimeZoneAsync("Pacific/Pago_Pago", async () => {
      expect(await runAdminShift(booking, "2026-07-09")).toEqual(preview);
    });
  });
});

