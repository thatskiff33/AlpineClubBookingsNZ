import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route coverage for the admin exclusive whole-lodge hold (issue #121, ADR-001):
// POST /api/admin/bookings/[id]/exclusive-hold. Mirrors the admin-capacity-hold
// route harness (its closest sibling admin capacity action). The exclusive hold
// has NO empty-lodge precondition and runs NO bed-arithmetic capacity engine
// (decision 1): setting it is allowed regardless of existing overlapping
// bookings. But per ADR-001's Security/safety section the flag write and the
// conflict read are lock-serialised under the per-lodge capacity lock
// (issue #154) so a hold set cannot race a concurrent admission.
const mocks = vi.hoisted(() => {
  const tx = {
    booking: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    // #2285 review: the SET reads the booking's allocation rows BEFORE the
    // prune so the audit can record what was destroyed.
    bedAllocation: {
      findMany: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(),
    requireAdmin: vi.fn(),
    acquireLodgeCapacityLock: vi.fn(),
    checkCapacityForGuestRanges: vi.fn(),
    findOverlappingCapacityHoldingBookings: vi.fn(),
    findOverlappingOverriddenNonHoldingBookings: vi.fn(),
    // ADR-001 bed-allocation short-circuit (#2285): the toggle reconciles the
    // booking's BedAllocation rows on both directions (SET prunes, CLEAR
    // re-plans), inside the route's transaction.
    reconcileBedAllocations: vi.fn(),
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

// The route takes the per-lodge capacity lock (ADR-001 Security/safety, issue
// #154) but runs no bed-arithmetic capacity engine: checkCapacityForGuestRanges
// is mocked only to fail loudly (via the assertions below) if the route were
// ever to consult it.
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  // Read-only conflict surfacing (issue #119) — NOT the capacity engine.
  findOverlappingCapacityHoldingBookings:
    mocks.findOverlappingCapacityHoldingBookings,
  // Override-settle blind-spot surfacing (issue #177) — also read-only.
  findOverlappingOverriddenNonHoldingBookings:
    mocks.findOverlappingOverriddenNonHoldingBookings,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
  },
}));

// #2285: the lifecycle reconcile is mocked so these route tests stay focused on
// the toggle's contract (when it is called, on which client, and what the audit
// records); the reconcile's own held-booking semantics are covered by
// bed-allocation-lifecycle.test.ts and held-booking-allocation-agreement.test.ts.
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocations,
  MAX_AUDITED_PRUNED_ALLOCATIONS: 50,
}));

import { POST } from "@/app/api/admin/bookings/[id]/exclusive-hold/route";

function holdRequest(body: Record<string, unknown> = {}) {
  return new NextRequest(
    "http://localhost/api/admin/bookings/booking-1/exclusive-hold",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "request-1",
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "vitest",
      },
      body: JSON.stringify(body),
    },
  );
}

function routeParams() {
  return {
    params: Promise.resolve({ id: "booking-1" }),
  };
}

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: "CONFIRMED",
    deletedAt: null,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    wholeLodgeHold: false,
    wholeLodgeHoldAt: null,
    wholeLodgeHoldByMemberId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: {
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    },
  });
  mocks.transaction.mockImplementation(async (fn) => fn(mocks.tx));
  mocks.tx.booking.findUnique.mockResolvedValue(booking());
  // CAS write (issue #186): updateMany returns only a row count. The happy path
  // matches one row; the race regression below overrides this to { count: 0 }.
  mocks.tx.booking.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.findOverlappingCapacityHoldingBookings.mockResolvedValue([]);
  mocks.findOverlappingOverriddenNonHoldingBookings.mockResolvedValue([]);
  mocks.reconcileBedAllocations.mockResolvedValue({
    enabled: true,
    deletedCount: 0,
    createdCount: 0,
    promotedCount: 0,
  });
  mocks.tx.bedAllocation.findMany.mockResolvedValue([]);
});

describe("POST /api/admin/bookings/[id]/exclusive-hold", () => {
  it("sets the hold (200), stamps who/when, and writes the audit row", async () => {
    const response = await POST(holdRequest({ hold: true }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, wholeLodgeHold: true });
    // CAS on SET (issue #186): the write is a conditional updateMany whose
    // predicate re-checks capacity-holding at write time — id PLUS the
    // capacity-holding filter (an AND-wrapped OR fragment). An unconditional
    // update-by-id could plant an inert hold on a row a concurrent cancel just
    // moved to a terminal status.
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "booking-1",
          AND: expect.any(Array),
        }),
        data: expect.objectContaining({
          wholeLodgeHold: true,
          wholeLodgeHoldAt: expect.any(Date),
          wholeLodgeHoldByMemberId: "admin-1",
        }),
      }),
    );
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: "booking.exclusiveHold.set",
      actorMemberId: "admin-1",
      subjectMemberId: "member-1",
      entityType: "Booking",
      entityId: "booking-1",
      category: "booking",
      outcome: "success",
    });
  });

  it("sets the hold even when other bookings overlap: lock taken, no capacity engine, no 409 (decision 1 + #154)", async () => {
    const response = await POST(holdRequest({ hold: true }), routeParams());

    expect(response.status).toBe(200);
    // The whole point of decision 1: setting is allowed over conflicts, never
    // refused. The route runs no bed-arithmetic capacity engine...
    expect(mocks.checkCapacityForGuestRanges).not.toHaveBeenCalled();
    // ...but ADR-001's Security/safety section (issue #154) requires the flag
    // write to be lock-serialised: the per-lodge capacity lock IS acquired, in
    // the same transaction, for the booking's lodge. Taking the lock serialises
    // against a concurrent admission; it does NOT refuse the set.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      mocks.tx,
      "lodge-1",
    );
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledTimes(1);
  });

  it("lock-serialises the hold set: lock acquired BEFORE the conflict read, on the same tx client as the read and write (issue #154)", async () => {
    // Race-shaped regression coverage the epic promised (ADR-001 Security/
    // safety): a hold set and a concurrent admission must resolve
    // deterministically under the per-lodge capacity lock. We cannot exercise a
    // second connection in a mocked route, so we prove serialisation at the mock
    // level — the lock is acquired first, and the conflict read + flag write run
    // on the SAME transaction client the lock was taken on (so any admission
    // contending for that lodge blocks until this transaction commits).
    const conflicts = [{ id: "booking-2", status: "CONFIRMED" }];
    mocks.findOverlappingCapacityHoldingBookings.mockResolvedValue(conflicts);

    const response = await POST(holdRequest({ hold: true }), routeParams());
    expect(response.status).toBe(200);

    // Same tx client threaded through lock, conflict read, and flag write.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(
      mocks.tx,
      "lodge-1",
    );
    expect(mocks.findOverlappingCapacityHoldingBookings).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({ lodgeId: "lodge-1", excludeBookingId: "booking-1" }),
    );
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledTimes(1);

    // Ordering: the lock is acquired strictly before the conflict read (and
    // therefore before the flag write). invocationCallOrder is a monotonic
    // global counter across all mocks, so this proves the lock came first.
    const lockOrder =
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0];
    const conflictReadOrder =
      mocks.findOverlappingCapacityHoldingBookings.mock.invocationCallOrder[0];
    const writeOrder = mocks.tx.booking.updateMany.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(conflictReadOrder);
    expect(lockOrder).toBeLessThan(writeOrder);
  });

  it("re-reads after the lodge lock and uses refreshed dates for conflicts and audit (#1881)", async () => {
    const refreshedCheckIn = new Date("2026-10-10T00:00:00.000Z");
    const refreshedCheckOut = new Date("2026-10-13T00:00:00.000Z");
    mocks.tx.booking.findUnique
      // The pre-lock read is deliberately only the immutable lock key. It
      // represents an earlier snapshot whose mutable dates are unavailable.
      .mockResolvedValueOnce({ lodgeId: "lodge-1" })
      // A concurrent date modification commits while this transaction waits
      // for the lodge lock. The post-lock read must become authoritative.
      .mockResolvedValueOnce(
        booking({
          status: "PAID",
          checkIn: refreshedCheckIn,
          checkOut: refreshedCheckOut,
        }),
      );

    const response = await POST(holdRequest({ hold: true }), routeParams());
    expect(response.status).toBe(200);

    expect(mocks.tx.booking.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "booking-1" },
      select: { lodgeId: true },
    });
    expect(mocks.findOverlappingCapacityHoldingBookings).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        lodgeId: "lodge-1",
        checkIn: refreshedCheckIn,
        checkOut: refreshedCheckOut,
      }),
    );
    expect(
      mocks.findOverlappingOverriddenNonHoldingBookings,
    ).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        lodgeId: "lodge-1",
        checkIn: refreshedCheckIn,
        checkOut: refreshedCheckOut,
      }),
    );

    const [preLockReadOrder, postLockReadOrder] =
      mocks.tx.booking.findUnique.mock.invocationCallOrder;
    const lockOrder =
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0];
    const writeOrder = mocks.tx.booking.updateMany.mock.invocationCallOrder[0];
    const conflictReadOrder =
      mocks.findOverlappingCapacityHoldingBookings.mock.invocationCallOrder[0];
    expect(preLockReadOrder).toBeLessThan(lockOrder);
    expect(lockOrder).toBeLessThan(postLockReadOrder);
    expect(postLockReadOrder).toBeLessThan(writeOrder);
    expect(writeOrder).toBeLessThan(conflictReadOrder);

    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.metadata).toMatchObject({
      bookingStatus: "PAID",
      checkIn: refreshedCheckIn.toISOString(),
      checkOut: refreshedCheckOut.toISOString(),
    });
  });

  it("honours an exclusive hold that appeared while waiting for the lodge lock", async () => {
    mocks.tx.booking.findUnique
      .mockResolvedValueOnce({ lodgeId: "lodge-1" })
      .mockResolvedValueOnce(booking({ wholeLodgeHold: true }));

    const response = await POST(holdRequest({ hold: true }), routeParams());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "This booking already has an exclusive whole-lodge hold.",
    });
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
    expect(mocks.findOverlappingCapacityHoldingBookings).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("CAS regression (issue #186): post-lock guard passes but the conditional write matches zero rows → 409, no fields, no audit", async () => {
    // The post-lock findUnique returns a healthy CONFIRMED booking, so the
    // status guard passes and the route reaches the write. But between that
    // read and the write a concurrent cancel (serialised on the DISJOINT
    // club-wide key, not the per-lodge lock this route holds) moved the row to
    // a terminal, non-capacity-holding status — so the CAS updateMany predicate
    // (id + capacityHoldingBookingFilter) matches nothing and resolves { count:
    // 0 }. The route must refuse rather than plant an inert stale hold on the
    // cancelled row: 409, no booking fields echoed, and NO audit written.
    mocks.tx.booking.findUnique.mockResolvedValue(booking({ status: "CONFIRMED" }));
    mocks.tx.booking.updateMany.mockResolvedValue({ count: 0 });

    const response = await POST(holdRequest({ hold: true }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/changed while the hold was being set/i);
    // No hold state echoed back — nothing was written.
    expect(body).not.toHaveProperty("wholeLodgeHold");
    expect(body).not.toHaveProperty("wholeLodgeHoldAt");
    // The write was attempted (the guard passed) but no audit follows a no-op.
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("surfaces overlapping conflicts on set without refusing (issue #119): still 200, conflicts returned", async () => {
    const conflicts = [
      {
        id: "booking-2",
        memberName: "Jane Doe",
        checkIn: "2026-09-01",
        checkOut: "2026-09-02",
        guestCount: 3,
        status: "CONFIRMED",
      },
    ];
    mocks.findOverlappingCapacityHoldingBookings.mockResolvedValue(conflicts);

    const response = await POST(holdRequest({ hold: true }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.conflicts).toEqual(conflicts);
    // Called with the held booking's own id excluded, at its lodge/nights.
    expect(mocks.findOverlappingCapacityHoldingBookings).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        lodgeId: "lodge-1",
        excludeBookingId: "booking-1",
      }),
    );
    // Decision 1: the set still succeeded even with conflicts present.
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledTimes(1);
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.metadata).toMatchObject({ overlappingConflictCount: 1 });
  });

  it("also surfaces overridden-but-not-yet-holding overlaps at set, marked overridden (issue #177)", async () => {
    mocks.findOverlappingCapacityHoldingBookings.mockResolvedValue([
      {
        id: "booking-2",
        memberName: "Jane Doe",
        checkIn: "2026-09-01",
        checkOut: "2026-09-02",
        guestCount: 3,
        status: "CONFIRMED",
      },
    ]);
    mocks.findOverlappingOverriddenNonHoldingBookings.mockResolvedValue([
      {
        id: "booking-3",
        memberName: "Sam Over",
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
        guestCount: 2,
        status: "PAYMENT_PENDING",
        overridden: true,
      },
    ]);

    const response = await POST(holdRequest({ hold: true }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    // Both populations merged into one conflicts list; the override marker is
    // preserved so the UI can flag it distinctly. Never-refuse unchanged.
    expect(body.conflicts).toHaveLength(2);
    expect(body.conflicts).toContainEqual(
      expect.objectContaining({ id: "booking-3", overridden: true }),
    );
    // Both reads are excluded on the held booking's own id, at its lodge/nights.
    expect(mocks.findOverlappingOverriddenNonHoldingBookings).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        lodgeId: "lodge-1",
        excludeBookingId: "booking-1",
      }),
    );
    // Audit records the two populations separately.
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.metadata).toMatchObject({
      overlappingConflictCount: 1,
      overriddenNonHoldingConflictCount: 1,
      overriddenNonHoldingConflictBookingIds: ["booking-3"],
    });
  });

  it("does not query conflicts when clearing the hold (nothing to surface)", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      booking({ wholeLodgeHold: true }),
    );

    const response = await POST(holdRequest({ hold: false }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.conflicts).toEqual([]);
    expect(mocks.findOverlappingCapacityHoldingBookings).not.toHaveBeenCalled();
    expect(
      mocks.findOverlappingOverriddenNonHoldingBookings,
    ).not.toHaveBeenCalled();
  });

  it("clears the hold (200), nulls the who/when fields, and audits the clear", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      booking({
        wholeLodgeHold: true,
        wholeLodgeHoldAt: new Date("2026-07-10T00:00:00.000Z"),
        wholeLodgeHoldByMemberId: "admin-2",
      }),
    );

    const response = await POST(holdRequest({ hold: false }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, wholeLodgeHold: false });
    // CLEAR stays unconditional-by-id (issue #186): clearing a stale hold on
    // any status must never be blocked, so no capacity-holding predicate.
    expect(mocks.tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: {
          wholeLodgeHold: false,
          wholeLodgeHoldAt: null,
          wholeLodgeHoldByMemberId: null,
        },
      }),
    );
    const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: "booking.exclusiveHold.cleared",
      actorMemberId: "admin-1",
      entityId: "booking-1",
    });
  });

  // Status guard (issue #173, H2): SETTING an exclusive hold is only allowed on
  // a capacity-holding booking. A hold on a non-holding booking is invisible to
  // enforcement (every masking index is built from the capacity-holding
  // population — ADR-001 capacity rule), so it blocks nothing while returning
  // success. Setting on such a booking must 409 with no write and no audit;
  // clearing must stay allowed on any status.
  describe("set is gated on capacity-holding status (issue #173)", () => {
    it.each(["WAITLISTED", "DRAFT", "PENDING"] as const)(
      "rejects set on non-capacity-holding %s (409, no write, no audit)",
      async (status) => {
        mocks.tx.booking.findUnique.mockResolvedValue(booking({ status }));

        const response = await POST(holdRequest({ hold: true }), routeParams());
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.error).toMatch(/does not hold lodge capacity/i);
        expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
        expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
      },
    );

    it("rejects set on PAYMENT_PENDING without an admin capacity hold, pointing at the capacity hold (409, no write, no audit)", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ status: "PAYMENT_PENDING", adminCapacityHoldAt: null }),
      );

      const response = await POST(holdRequest({ hold: true }), routeParams());
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toMatch(/apply an admin capacity hold first/i);
      expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
      expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("allows set on a naturally capacity-holding PAID booking (200, writes + audits)", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ status: "PAID" }),
      );

      const response = await POST(holdRequest({ hold: true }), routeParams());

      expect(response.status).toBe(200);
      expect(mocks.tx.booking.updateMany).toHaveBeenCalledTimes(1);
      expect(mocks.tx.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it("allows set on a PENDING booking converted from a BookingRequest (#1254 relation hold): 200, writes", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ status: "PENDING", originBookingRequest: { id: "req-1" } }),
      );

      const response = await POST(holdRequest({ hold: true }), routeParams());

      expect(response.status).toBe(200);
      expect(mocks.tx.booking.updateMany).toHaveBeenCalledTimes(1);
    });

    it("allows set on a PAYMENT_PENDING booking carrying an admin capacity hold (#1764): 200, writes", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({
          status: "PAYMENT_PENDING",
          adminCapacityHoldAt: new Date("2026-07-10T00:00:00.000Z"),
        }),
      );

      const response = await POST(holdRequest({ hold: true }), routeParams());

      expect(response.status).toBe(200);
      expect(mocks.tx.booking.updateMany).toHaveBeenCalledTimes(1);
    });

    it("allows clearing a hold on a non-capacity-holding booking (cleanup never blocked)", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ status: "WAITLISTED", wholeLodgeHold: true }),
      );

      const response = await POST(holdRequest({ hold: false }), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ success: true, wholeLodgeHold: false });
      expect(mocks.tx.booking.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a double set with 409 and no write", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(
      booking({ wholeLodgeHold: true }),
    );

    const response = await POST(holdRequest({ hold: true }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/already has an exclusive/i);
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects clearing a booking with no hold (409, no write)", async () => {
    const response = await POST(holdRequest({ hold: false }), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/no exclusive whole-lodge hold to clear/i);
    expect(mocks.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("422s an invalid body (missing hold)", async () => {
    const response = await POST(holdRequest({}), routeParams());
    expect(response.status).toBe(422);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("404s a missing or soft-deleted booking", async () => {
    mocks.tx.booking.findUnique.mockResolvedValue(null);
    expect((await POST(holdRequest({ hold: true }), routeParams())).status).toBe(
      404,
    );

    mocks.tx.booking.findUnique.mockResolvedValue(
      booking({ deletedAt: new Date() }),
    );
    expect((await POST(holdRequest({ hold: true }), routeParams())).status).toBe(
      404,
    );
  });

  it("403s a non-admin caller without touching the booking", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await POST(holdRequest({ hold: true }), routeParams());

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  // ADR-001 bed-allocation short-circuit (#2285): a held booking owns NO
  // BedAllocation rows. The toggle route reconciles on BOTH directions, on the
  // SAME transaction client as the flag write, so the flag and the rows can
  // never commit apart: SET prunes the booking's rows (including legacy rows
  // an older lifecycle wrongly created), CLEAR re-plans its guests.
  describe("bed-allocation reconcile on the hold toggle (#2285)", () => {
    it("SET reconciles on the tx AFTER the flag write and BEFORE the audit, and audits the prune", async () => {
      mocks.reconcileBedAllocations.mockResolvedValue({
        enabled: true,
        deletedCount: 3,
        createdCount: 0,
        promotedCount: 1,
      });

      const response = await POST(holdRequest({ hold: true }), routeParams());
      expect(response.status).toBe(200);

      // Same tx client as the flag write: prune + flag are atomic.
      expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(1);
      expect(mocks.reconcileBedAllocations).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "booking-1", db: mocks.tx }),
      );

      // Ordering: flag write → reconcile → audit (the audit metadata carries
      // the reconcile counts, so the reconcile must resolve first).
      const writeOrder = mocks.tx.booking.updateMany.mock.invocationCallOrder[0];
      const reconcileOrder =
        mocks.reconcileBedAllocations.mock.invocationCallOrder[0];
      const auditOrder = mocks.tx.auditLog.create.mock.invocationCallOrder[0];
      expect(writeOrder).toBeLessThan(reconcileOrder);
      expect(reconcileOrder).toBeLessThan(auditOrder);

      const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
      expect(audit.metadata).toMatchObject({
        bedAllocationReconcile: {
          enabled: true,
          deletedCount: 3,
          createdCount: 0,
          promotedCount: 1,
        },
      });
    });

    it("CLEAR reconciles on the tx too (release re-plans the booking) and audits the counts", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ wholeLodgeHold: true }),
      );
      mocks.reconcileBedAllocations.mockResolvedValue({
        enabled: true,
        deletedCount: 0,
        createdCount: 4,
        promotedCount: 0,
      });

      const response = await POST(holdRequest({ hold: false }), routeParams());
      expect(response.status).toBe(200);

      expect(mocks.reconcileBedAllocations).toHaveBeenCalledTimes(1);
      expect(mocks.reconcileBedAllocations).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "booking-1", db: mocks.tx }),
      );
      const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
      expect(audit.metadata).toMatchObject({
        bedAllocationReconcile: expect.objectContaining({ createdCount: 4 }),
      });
    });

    it("never reconciles when the CAS write matched zero rows (issue #186 refusal)", async () => {
      mocks.tx.booking.updateMany.mockResolvedValue({ count: 0 });

      const response = await POST(holdRequest({ hold: true }), routeParams());

      expect(response.status).toBe(409);
      expect(mocks.reconcileBedAllocations).not.toHaveBeenCalled();
    });

    it("never reconciles on the pre-write refusals (double set, nothing to clear, status gate)", async () => {
      // Double set.
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ wholeLodgeHold: true }),
      );
      expect(
        (await POST(holdRequest({ hold: true }), routeParams())).status,
      ).toBe(409);

      // Nothing to clear.
      mocks.tx.booking.findUnique.mockResolvedValue(booking());
      expect(
        (await POST(holdRequest({ hold: false }), routeParams())).status,
      ).toBe(409);

      // Non-capacity-holding status gate (issue #173).
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ status: "WAITLISTED" }),
      );
      expect(
        (await POST(holdRequest({ hold: true }), routeParams())).status,
      ).toBe(409);

      expect(mocks.reconcileBedAllocations).not.toHaveBeenCalled();
      // Nor does any refusal read the rows for the audit list (#2285 review).
      expect(mocks.tx.bedAllocation.findMany).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // #2285 review: the toggle used to rewrite the booking's bed assignments
    // and tell nobody. Two fixes are pinned here — the counts come back in the
    // JSON so the admin toast can report them, and the SET audit records WHAT
    // it destroyed so an approved/manual placement can be rebuilt by hand.
    // -----------------------------------------------------------------------
    it("returns the reconcile counts in the response body on SET and on CLEAR", async () => {
      mocks.reconcileBedAllocations.mockResolvedValue({
        enabled: true,
        deletedCount: 12,
        createdCount: 0,
        promotedCount: 2,
      });

      const setBody = await (
        await POST(holdRequest({ hold: true }), routeParams())
      ).json();
      expect(setBody.bedAllocationReconcile).toEqual({
        enabled: true,
        deletedCount: 12,
        createdCount: 0,
        promotedCount: 2,
      });

      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ wholeLodgeHold: true }),
      );
      mocks.reconcileBedAllocations.mockResolvedValue({
        enabled: true,
        deletedCount: 0,
        createdCount: 9,
        promotedCount: 0,
      });

      const clearBody = await (
        await POST(holdRequest({ hold: false }), routeParams())
      ).json();
      expect(clearBody.bedAllocationReconcile).toMatchObject({
        enabled: true,
        createdCount: 9,
      });
    });

    it("SET records the destroyed allocation rows in the audit metadata, read BEFORE the prune", async () => {
      mocks.tx.bedAllocation.findMany.mockResolvedValue([
        {
          bookingGuestId: "guest-1",
          roomId: "room-a",
          bedId: "bed-a1",
          stayDate: new Date("2026-09-01T00:00:00.000Z"),
          source: "MANUAL",
          approvedAt: new Date("2026-08-20T04:05:06.000Z"),
        },
        {
          bookingGuestId: "guest-2",
          roomId: "room-a",
          bedId: "bed-a2",
          stayDate: new Date("2026-09-02T00:00:00.000Z"),
          source: "AUTO",
          approvedAt: null,
        },
      ]);
      mocks.reconcileBedAllocations.mockResolvedValue({
        enabled: true,
        deletedCount: 2,
        createdCount: 0,
        promotedCount: 0,
      });

      const response = await POST(holdRequest({ hold: true }), routeParams());
      expect(response.status).toBe(200);

      // Read on the SAME tx and BEFORE the reconcile — after it the rows are
      // gone and the list would be empty.
      expect(mocks.tx.bedAllocation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { bookingId: "booking-1" } }),
      );
      expect(
        mocks.tx.bedAllocation.findMany.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.reconcileBedAllocations.mock.invocationCallOrder[0]);

      const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
      expect(audit.metadata.bedAllocationReconcile).toMatchObject({
        deletedCount: 2,
        removedAllocationsTruncated: false,
        removedAllocations: [
          {
            bookingGuestId: "guest-1",
            roomId: "room-a",
            bedId: "bed-a1",
            stayDate: "2026-09-01",
            source: "MANUAL",
            approvedAt: "2026-08-20T04:05:06.000Z",
          },
          {
            bookingGuestId: "guest-2",
            roomId: "room-a",
            bedId: "bed-a2",
            stayDate: "2026-09-02",
            source: "AUTO",
            approvedAt: null,
          },
        ],
      });
    });

    it("omits the removed-rows list when the SET destroyed nothing, and never reads it on CLEAR", async () => {
      // Nothing deleted: no list (and no noise in the audit metadata).
      const setResponse = await POST(holdRequest({ hold: true }), routeParams());
      expect(setResponse.status).toBe(200);
      let audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
      expect(audit.metadata.bedAllocationReconcile).not.toHaveProperty(
        "removedAllocations",
      );

      // CLEAR destroys nothing by definition, so the pre-read never runs.
      vi.clearAllMocks();
      mocks.transaction.mockImplementation(async (fn) => fn(mocks.tx));
      mocks.tx.booking.findUnique.mockResolvedValue(
        booking({ wholeLodgeHold: true }),
      );
      mocks.tx.booking.updateMany.mockResolvedValue({ count: 1 });
      mocks.tx.auditLog.create.mockResolvedValue({});
      mocks.findOverlappingCapacityHoldingBookings.mockResolvedValue([]);
      mocks.findOverlappingOverriddenNonHoldingBookings.mockResolvedValue([]);
      mocks.reconcileBedAllocations.mockResolvedValue({
        enabled: true,
        deletedCount: 0,
        createdCount: 4,
        promotedCount: 0,
      });

      const clearResponse = await POST(
        holdRequest({ hold: false }),
        routeParams(),
      );
      expect(clearResponse.status).toBe(200);
      expect(mocks.tx.bedAllocation.findMany).not.toHaveBeenCalled();
      audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
      expect(audit.metadata.bedAllocationReconcile).not.toHaveProperty(
        "removedAllocations",
      );
    });

    it("caps and flags the removed-rows list so one audit row cannot grow without limit", async () => {
      // The route reads cap + 1 rows; more than the cap means the list is
      // truncated and the flag must say so (the exact count still comes from
      // the reconcile result, so nothing is lost).
      mocks.tx.bedAllocation.findMany.mockResolvedValue(
        Array.from({ length: 51 }, (_, index) => ({
          bookingGuestId: `guest-${index}`,
          roomId: "room-a",
          bedId: `bed-${index}`,
          stayDate: new Date("2026-09-01T00:00:00.000Z"),
          source: "AUTO",
          approvedAt: null,
        })),
      );
      mocks.reconcileBedAllocations.mockResolvedValue({
        enabled: true,
        deletedCount: 640,
        createdCount: 0,
        promotedCount: 0,
      });

      await POST(holdRequest({ hold: true }), routeParams());

      const audit = mocks.tx.auditLog.create.mock.calls[0][0].data;
      expect(
        audit.metadata.bedAllocationReconcile.removedAllocations,
      ).toHaveLength(50);
      expect(
        audit.metadata.bedAllocationReconcile.removedAllocationsTruncated,
      ).toBe(true);
      expect(audit.metadata.bedAllocationReconcile.deletedCount).toBe(640);
    });
  });
});
