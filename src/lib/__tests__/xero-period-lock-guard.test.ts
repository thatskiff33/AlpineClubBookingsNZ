import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadEffectiveModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
// getEffectiveXeroLockDate stays real: the effective-lock (later-of-two)
// resolution is part of what these tests prove.
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-organisation")>();
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});

import {
  assertCheckInClearsXeroLockDate,
  assertDateEditClearsXeroLockDate,
  assertProposedCheckInClearsXeroLockDate,
  assertProposedDateEditClearsXeroLockDate,
  getXeroLockGuardErrorResponse,
  XeroLockDateCheckFailedError,
  XeroPeriodLockedError,
} from "@/lib/xero-period-lock-guard";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";

/*
 * Relative dates only: the guard compares against the CLUB's today, which it
 * reads with `readClubTimeZoneOutsideRequest()` (xero-period-lock-guard.ts:215).
 * This suite mocks no `ClubTimeSettings` row, so that reader falls back to the
 * environment seed — `Pacific/Auckland` under test — and the fixtures below have
 * to be built in the same zone or a "today" check-in lands on the wrong side of
 * the guard. Zone AUTHORITY is not this file's subject, so it names the agreeing
 * zone rather than a divergent one (#3123).
 */
const CLUB_ZONE = "Pacific/Auckland";

const daysAgo = (n: number) => addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -n);

beforeEach(() => {
  vi.clearAllMocks();
  h.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: true });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: daysAgo(10),
    endOfYearLockDate: null,
  });
});

describe("assertCheckInClearsXeroLockDate", () => {
  it("passes a today-or-future check-in without touching flags, connection, or Xero", async () => {
    await expect(
      assertCheckInClearsXeroLockDate(getTodayDateOnly(CLUB_ZONE)),
    ).resolves.toBeUndefined();
    await expect(
      assertCheckInClearsXeroLockDate(addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 3)),
    ).resolves.toBeUndefined();

    expect(h.loadEffectiveModuleFlags).not.toHaveBeenCalled();
    expect(h.isXeroConnected).not.toHaveBeenCalled();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("passes an unparseable check-in (normal validation owns that rejection)", async () => {
    await expect(
      assertCheckInClearsXeroLockDate(new Date("invalid")),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("skips when the Xero module is disabled", async () => {
    h.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: false });

    await expect(
      assertCheckInClearsXeroLockDate(daysAgo(5)),
    ).resolves.toBeUndefined();
    expect(h.isXeroConnected).not.toHaveBeenCalled();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("skips when Xero is not connected", async () => {
    h.isXeroConnected.mockResolvedValue(false);

    await expect(
      assertCheckInClearsXeroLockDate(daysAgo(5)),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("honours a caller-provided module flag instead of re-loading settings", async () => {
    await assertCheckInClearsXeroLockDate(daysAgo(5), {
      xeroIntegrationEnabled: true,
    });
    expect(h.loadEffectiveModuleFlags).not.toHaveBeenCalled();
    expect(h.getXeroLockDates).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await assertCheckInClearsXeroLockDate(daysAgo(5), {
      xeroIntegrationEnabled: false,
    });
    expect(h.loadEffectiveModuleFlags).not.toHaveBeenCalled();
    expect(h.isXeroConnected).not.toHaveBeenCalled();
  });

  it("fails closed when the lock dates cannot be read", async () => {
    h.getXeroLockDates.mockRejectedValue(new Error("xero down"));

    await expect(assertCheckInClearsXeroLockDate(daysAgo(5))).rejects.toThrow(
      XeroLockDateCheckFailedError,
    );
  });

  it("rejects a past check-in before the effective lock date with the lock date attached", async () => {
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: daysAgo(10),
      endOfYearLockDate: null,
    });

    const error = await assertCheckInClearsXeroLockDate(daysAgo(15)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(XeroPeriodLockedError);
    expect((error as XeroPeriodLockedError).status).toBe(409);
    expect((error as XeroPeriodLockedError).lockDate).toBe(
      formatDateOnly(daysAgo(10)),
    );
  });

  it("rejects a check-in exactly ON the lock date (locked periods are inclusive)", async () => {
    await expect(assertCheckInClearsXeroLockDate(daysAgo(10))).rejects.toThrow(
      XeroPeriodLockedError,
    );
  });

  it("passes a past check-in after the lock date", async () => {
    await expect(
      assertCheckInClearsXeroLockDate(daysAgo(5)),
    ).resolves.toBeUndefined();
  });

  it("guards against the LATER of the two lock dates", async () => {
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: daysAgo(20),
      endOfYearLockDate: daysAgo(8),
    });

    // Clears the period lock but not the end-of-year lock.
    await expect(assertCheckInClearsXeroLockDate(daysAgo(12))).rejects.toThrow(
      XeroPeriodLockedError,
    );
  });

  it("passes when neither lock date is set", async () => {
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: null,
      endOfYearLockDate: null,
    });

    await expect(
      assertCheckInClearsXeroLockDate(daysAgo(30)),
    ).resolves.toBeUndefined();
  });
});

describe("assertProposedCheckInClearsXeroLockDate", () => {
  const dbWith = (checkIn: Date | null) => ({
    booking: {
      findUnique: vi
        .fn()
        .mockResolvedValue(checkIn === null ? null : { checkIn }),
    },
  });

  it("guards the requested check-in without reading the booking", async () => {
    const db = dbWith(daysAgo(2));

    await expect(
      assertProposedCheckInClearsXeroLockDate(
        db,
        "b1",
        formatDateOnly(daysAgo(15)),
      ),
    ).rejects.toThrow(XeroPeriodLockedError);
    expect(db.booking.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the booking's current check-in when no new one was requested", async () => {
    const db = dbWith(daysAgo(15));

    await expect(
      assertProposedCheckInClearsXeroLockDate(db, "b1", undefined),
    ).rejects.toThrow(XeroPeriodLockedError);
    expect(db.booking.findUnique).toHaveBeenCalledWith({
      where: { id: "b1" },
      select: { checkIn: true },
    });
  });

  it("passes when the unchanged current check-in clears the lock", async () => {
    await expect(
      assertProposedCheckInClearsXeroLockDate(dbWith(daysAgo(5)), "b1", undefined),
    ).resolves.toBeUndefined();
  });

  it("resolves silently for a missing booking (the transaction path 404s)", async () => {
    await expect(
      assertProposedCheckInClearsXeroLockDate(dbWith(null), "b1", undefined),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("resolves silently for an unparseable requested date (validation owns it)", async () => {
    await expect(
      assertProposedCheckInClearsXeroLockDate(dbWith(daysAgo(2)), "b1", "not-a-date"),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });
});

// #1729: ordinary (non-override) date edits get a NARROW guard that fires
// only when the edit would actually queue the check-in-dated invoice
// date/narration update (issued Xero invoice + dates changing + payment not
// settled — the settlement classifier's shared predicate), with actor-
// appropriate error text.
describe("assertDateEditClearsXeroLockDate (issue #1729)", () => {
  // Unpaid invoiced booking whose past stay sits inside the locked period
  // (lock = daysAgo(10) from the beforeEach default).
  const guardedBooking = (
    overrides: Partial<{
      checkIn: Date;
      checkOut: Date;
      status: string;
      payment: { status: string; xeroInvoiceId: string | null } | null;
    }> = {},
  ) => ({
    checkIn: daysAgo(15),
    checkOut: daysAgo(12),
    status: "CONFIRMED",
    payment: { status: "PENDING", xeroInvoiceId: "inv-1" },
    ...overrides,
  });

  it("rejects a check-in change into the locked period with the admin wording when audience is omitted (defaults to 'admin')", async () => {
    const error = await assertDateEditClearsXeroLockDate(
      guardedBooking(),
      { checkIn: formatDateOnly(daysAgo(20)) },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(XeroPeriodLockedError);
    // Default audience is admin: unlock instructions.
    expect((error as XeroPeriodLockedError).message).toContain(
      "Unlock the period in Xero",
    );
  });

  it("uses the member wording for audience 'member' (same code and status)", async () => {
    const error = await assertDateEditClearsXeroLockDate(
      guardedBooking(),
      { checkIn: formatDateOnly(daysAgo(20)) },
      { audience: "member" },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(XeroPeriodLockedError);
    expect((error as XeroPeriodLockedError).message).toBe(
      "These dates fall in an accounting period that has been locked in Xero. Please contact an administrator to make this change.",
    );
    expect((error as XeroPeriodLockedError).code).toBe("XERO_PERIOD_LOCKED");
    expect((error as XeroPeriodLockedError).status).toBe(409);
    expect((error as XeroPeriodLockedError).lockDate).toBe(
      formatDateOnly(daysAgo(10)),
    );
  });

  it("guards a check-out-only change via the unchanged past check-in", async () => {
    await expect(
      assertDateEditClearsXeroLockDate(
        guardedBooking(),
        { checkOut: formatDateOnly(daysAgo(11)) },
        { audience: "member" },
      ),
    ).rejects.toThrow(XeroPeriodLockedError);
  });

  it("fails closed with the member 503 wording when the lock dates cannot be read", async () => {
    h.getXeroLockDates.mockRejectedValue(new Error("xero down"));

    const error = await assertDateEditClearsXeroLockDate(
      guardedBooking(),
      { checkIn: formatDateOnly(daysAgo(20)) },
      { audience: "member" },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(XeroLockDateCheckFailedError);
    expect((error as XeroLockDateCheckFailedError).message).toBe(
      "We couldn't confirm this change can be saved right now. Please try again, or contact an administrator.",
    );
    expect((error as XeroLockDateCheckFailedError).status).toBe(503);
  });

  it("never consults the lock dates without a date change (identity-only requests carry no date fields)", async () => {
    await expect(
      assertDateEditClearsXeroLockDate(guardedBooking(), {}),
    ).resolves.toBeUndefined();
    // Date fields present but identical to the stored dates are no change.
    await expect(
      assertDateEditClearsXeroLockDate(guardedBooking(), {
        checkIn: formatDateOnly(daysAgo(15)),
        checkOut: formatDateOnly(daysAgo(12)),
      }),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
    expect(h.loadEffectiveModuleFlags).not.toHaveBeenCalled();
  });

  it("never consults the lock dates when the payment is settled (no check-in-dated write is queued)", async () => {
    for (const status of ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"]) {
      await expect(
        assertDateEditClearsXeroLockDate(
          guardedBooking({ payment: { status, xeroInvoiceId: "inv-1" } }),
          { checkIn: formatDateOnly(daysAgo(20)) },
        ),
      ).resolves.toBeUndefined();
    }
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("never consults the lock dates without an issued Xero invoice", async () => {
    await expect(
      assertDateEditClearsXeroLockDate(guardedBooking({ payment: null }), {
        checkIn: formatDateOnly(daysAgo(20)),
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertDateEditClearsXeroLockDate(
        guardedBooking({ payment: { status: "PENDING", xeroInvoiceId: null } }),
        { checkIn: formatDateOnly(daysAgo(20)) },
      ),
    ).resolves.toBeUndefined();
    // Settled-lifecycle statuses are part of the issued-invoice derivation.
    await expect(
      assertDateEditClearsXeroLockDate(guardedBooking({ status: "PENDING" }), {
        checkIn: formatDateOnly(daysAgo(20)),
      }),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("passes a guarded edit whose new check-in is in the future (only past check-ins are guarded)", async () => {
    await expect(
      assertDateEditClearsXeroLockDate(guardedBooking(), {
        checkIn: formatDateOnly(addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 3)),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertProposedDateEditClearsXeroLockDate (issue #1729)", () => {
  const dbWith = (
    booking: {
      checkIn: Date;
      checkOut: Date;
      status: string;
      memberId: string;
      payment: { status: string; xeroInvoiceId: string | null } | null;
    } | null,
  ) => ({
    booking: { findUnique: vi.fn().mockResolvedValue(booking) },
  });
  const storedBooking = () => ({
    checkIn: daysAgo(15),
    checkOut: daysAgo(12),
    status: "CONFIRMED" as const,
    memberId: "m1",
    payment: { status: "PENDING", xeroInvoiceId: "inv-1" },
  });

  it("returns without even the light read when the request has no date fields", async () => {
    const db = dbWith(storedBooking());
    await expect(
      assertProposedDateEditClearsXeroLockDate(db, "b1", {}),
    ).resolves.toBeUndefined();
    expect(db.booking.findUnique).not.toHaveBeenCalled();
  });

  it("reads the light row outside the transaction and rejects a guarded edit", async () => {
    const db = dbWith(storedBooking());
    await expect(
      assertProposedDateEditClearsXeroLockDate(
        db,
        "b1",
        { checkIn: formatDateOnly(daysAgo(20)) },
        { audience: "member", actorMemberId: "m1" },
      ),
    ).rejects.toThrow(XeroPeriodLockedError);
    expect(db.booking.findUnique).toHaveBeenCalledWith({
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

  it("resolves silently for a member editing a booking they do not own (the transaction path 403s — no lock-date disclosure)", async () => {
    await expect(
      assertProposedDateEditClearsXeroLockDate(
        dbWith(storedBooking()),
        "b1",
        { checkIn: formatDateOnly(daysAgo(20)) },
        { audience: "member", actorMemberId: "someone-else" },
      ),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("still guards an admin-audience actor editing another member's booking", async () => {
    await expect(
      assertProposedDateEditClearsXeroLockDate(
        dbWith(storedBooking()),
        "b1",
        { checkIn: formatDateOnly(daysAgo(20)) },
        { audience: "admin", actorMemberId: "admin1" },
      ),
    ).rejects.toThrow(XeroPeriodLockedError);
  });

  it("resolves silently for an unparseable requested check-OUT even when the stored past check-in is locked (validation owns the 400)", async () => {
    await expect(
      assertProposedDateEditClearsXeroLockDate(
        dbWith(storedBooking()),
        "b1",
        { checkOut: "not-a-date" },
        { audience: "member", actorMemberId: "m1" },
      ),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("resolves silently for a missing booking (the transaction path 404s)", async () => {
    await expect(
      assertProposedDateEditClearsXeroLockDate(dbWith(null), "b1", {
        checkIn: formatDateOnly(daysAgo(20)),
      }),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("resolves silently for an unparseable requested check-in (validation owns it)", async () => {
    await expect(
      assertProposedDateEditClearsXeroLockDate(dbWith(storedBooking()), "b1", {
        checkIn: "not-a-date",
      }),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });
});

describe("getXeroLockGuardErrorResponse", () => {
  it("maps XeroPeriodLockedError to a 409 body with code and lockDate", () => {
    const lockDate = formatDateOnly(daysAgo(10));
    const mapped = getXeroLockGuardErrorResponse(
      new XeroPeriodLockedError(lockDate),
    );
    expect(mapped).toEqual({
      body: {
        error: expect.stringContaining(lockDate),
        code: "XERO_PERIOD_LOCKED",
        lockDate,
      },
      status: 409,
    });
  });

  it("maps XeroLockDateCheckFailedError to a 503 body with code and the admin reason (#2105)", () => {
    const mapped = getXeroLockGuardErrorResponse(
      new XeroLockDateCheckFailedError(),
    );
    expect(mapped).toEqual({
      body: {
        error: "Could not verify the Xero lock dates. Please try again.",
        code: "XERO_LOCK_DATE_CHECK_FAILED",
        // Admin audience (the default) carries the classified reason.
        reason: "transient",
      },
      status: 503,
    });
  });

  it("maps the member-audience variants (#1729) with the same codes and statuses", () => {
    const lockDate = formatDateOnly(daysAgo(10));
    expect(
      getXeroLockGuardErrorResponse(
        new XeroPeriodLockedError(lockDate, "member"),
      ),
    ).toEqual({
      body: {
        error:
          "These dates fall in an accounting period that has been locked in Xero. Please contact an administrator to make this change.",
        code: "XERO_PERIOD_LOCKED",
        lockDate,
      },
      status: 409,
    });
    expect(
      getXeroLockGuardErrorResponse(new XeroLockDateCheckFailedError("member")),
    ).toEqual({
      body: {
        error:
          "We couldn't confirm this change can be saved right now. Please try again, or contact an administrator.",
        code: "XERO_LOCK_DATE_CHECK_FAILED",
      },
      status: 503,
    });
  });

  it("returns null for anything else", () => {
    expect(getXeroLockGuardErrorResponse(new Error("other"))).toBeNull();
    expect(getXeroLockGuardErrorResponse(null)).toBeNull();
  });
});

// #2105: the guard still fails closed, but now classifies WHY. The reason and
// cause-specific admin copy are disclosed to admins only; member bodies stay
// generic and reason-free.
describe("lock-date check-failure classification (#2105)", () => {
  const reconnectError = () =>
    Object.assign(
      new Error("Xero is not connected. Please connect via admin panel."),
      { name: "XeroReconnectRequiredError" },
    );
  const dailyLimitError = (retryAfterSec?: number) =>
    Object.assign(new Error("Xero daily API limit reached."), {
      name: "XeroDailyLimitError",
      retryAfterSec,
    });

  const failWith = async (
    error: unknown,
    options?: { audience?: "admin" | "member" },
  ) => {
    h.getXeroLockDates.mockRejectedValue(error);
    return assertCheckInClearsXeroLockDate(daysAgo(5), options).then(
      () => null,
      (e: unknown) => e as XeroLockDateCheckFailedError,
    );
  };

  it("classifies a reconnect-required cause with reason + admin reconnect copy", async () => {
    const error = await failWith(reconnectError());
    expect(error).toBeInstanceOf(XeroLockDateCheckFailedError);
    expect(error?.reason).toBe("reconnect_required");
    expect(error?.message).toBe(
      "Could not verify the Xero lock dates because the Xero connection needs re-authorising. Reconnect Xero (Admin → Xero → Setup), then try again.",
    );
    expect(getXeroLockGuardErrorResponse(error)).toEqual({
      body: {
        error: error?.message,
        code: "XERO_LOCK_DATE_CHECK_FAILED",
        reason: "reconnect_required",
      },
      status: 503,
    });
  });

  it("classifies a daily-limit cause as rate_limited with retry timing when available", async () => {
    const error = await failWith(dailyLimitError(7200));
    expect(error?.reason).toBe("rate_limited");
    expect(error?.message).toContain("daily API limit");
    expect(error?.message).toContain("about 2 hours");
  });

  it("falls back to rate_limited 'tomorrow' wording without retry timing", async () => {
    const error = await failWith(dailyLimitError());
    expect(error?.reason).toBe("rate_limited");
    expect(error?.message).toContain("Please try again tomorrow.");
  });

  it("defaults an unclassified failure to transient (the current wording)", async () => {
    const error = await failWith(new Error("xero down"));
    expect(error?.reason).toBe("transient");
    expect(error?.message).toBe(
      "Could not verify the Xero lock dates. Please try again.",
    );
  });

  it("classifies a raw 401/403 from the org read as reconnect_required (revoked-token window)", async () => {
    // A token revoked in Xero's UI is rejected live before the pre-expiry
    // refresh window trips, so the error arrives as a raw API status — the
    // classifier falls back to the same 401/403 check as getXeroApiErrorInfo.
    const raw401 = Object.assign(new Error("Unauthorized"), {
      response: { statusCode: 401 },
    });
    const error = await failWith(raw401);
    expect(error?.reason).toBe("reconnect_required");

    const raw403 = Object.assign(new Error("Forbidden"), {
      response: { statusCode: 403 },
    });
    const error403 = await failWith(raw403);
    expect(error403?.reason).toBe("reconnect_required");
  });

  it("classifies internally but discloses NO reason to members (non-disclosure)", async () => {
    const error = await failWith(reconnectError(), { audience: "member" });
    // Internally the cause is still known…
    expect(error?.reason).toBe("reconnect_required");
    // …but the member wording and body stay generic and reason-free.
    expect(error?.message).toBe(
      "We couldn't confirm this change can be saved right now. Please try again, or contact an administrator.",
    );
    const mapped = getXeroLockGuardErrorResponse(error);
    expect(mapped?.body).not.toHaveProperty("reason");
    expect(mapped).toEqual({
      body: {
        error: error?.message,
        code: "XERO_LOCK_DATE_CHECK_FAILED",
      },
      status: 503,
    });
  });
});
