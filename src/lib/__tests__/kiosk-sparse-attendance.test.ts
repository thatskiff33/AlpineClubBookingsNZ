/**
 * #2628 — a stay with a gap in it has more than one arrival and more than one
 * departure, and the kiosk has ONE attendance pair to hold them.
 *
 * The night-set repair made the depart endpoint accept every departure morning a
 * sparse stay has, which was the point of the issue. Two things downstream were
 * written when "departure morning" and "the end of the stay" were the same date,
 * and both are wrong the moment they stop being:
 *
 *  1. The chore sweep. Checking a guest out deletes the SUGGESTED chores they
 *     can no longer do, with no upper bound — correct when the only accepted
 *     departure was the last one, data loss when it is not, because the roster
 *     somebody generated for the guest's SECOND segment goes with it.
 *  2. `BookingGuest.arrivedAt` / `departedAt`. One pair for the whole stay, so a
 *     guest checking back in on the 14th does it against a record that still
 *     says "departed on the 12th". The kiosk hid the arrive button on that
 *     record and offered no depart button (not a departure morning), leaving the
 *     hut leader nothing at all to press on a night the guest was in the lodge.
 *
 * The fixture throughout is nights {2026-07-11, 2026-07-14} — the same sparse
 * stay the roster and kiosk suites use. Frozen clock discipline: fixed July 2026
 * dates, never the real calendar.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = {
  member: { findUnique: vi.fn(), count: vi.fn() },
  bookingGuest: { findFirst: vi.fn(), update: vi.fn() },
  choreAssignment: { findMany: vi.fn(), deleteMany: vi.fn() },
  hutLeaderAssignment: { count: vi.fn() },
  booking: { count: vi.fn() },
  memberLodgeAccess: { findMany: vi.fn() },
  lodge: { findFirst: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  getAuditRequestContext: vi.fn(() => ({
    id: null,
    ipAddress: "127.0.0.1",
    userAgent: null,
  })),
}));

// A pass-through spy: the real roster keys, so the no-op case can prove the
// depart route stops before taking any of them (#4965).
vi.mock("@/lib/roster-lock", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/roster-lock");
  return { ...actual, lockRosterDates: vi.fn(actual.lockRosterDates) };
});

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

const utc = (dateKey: string) => new Date(`${dateKey}T00:00:00.000Z`);

/** Nights {11, 14}: in on the 11th, home on the 12th, back on the 14th. */
function sparseGuest(overrides: Record<string, unknown> = {}) {
  return {
    id: "g-sparse",
    bookingId: "booking-1",
    firstName: "Sam",
    lastName: "Sparse",
    memberId: "member-1",
    arrivedAt: null,
    departedAt: null,
    stayStart: utc("2026-07-11"),
    stayEnd: utc("2026-07-15"),
    nights: [{ stayDate: utc("2026-07-11") }, { stayDate: utc("2026-07-14") }],
    booking: {
      memberId: "booking-owner-1",
      checkIn: utc("2026-07-11"),
      checkOut: utc("2026-07-15"),
    },
    ...overrides,
  };
}

/**
 * `wanted` is the #4965 wanted-state field (`arrived` / `departed`). Left out,
 * the body is exactly what a kiosk page opened before #4965 still sends.
 */
function request(
  dateKey: string,
  action: "arrive" | "depart",
  guestId: string,
  wanted?: Record<string, boolean>,
) {
  return new Request(
    `http://localhost/api/lodge/guests/${dateKey}/${action}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: guestId, ...wanted }),
    },
  ) as never;
}

const params = (dateKey: string) => ({ params: Promise.resolve({ date: dateKey }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.member.findUnique.mockResolvedValue({
    id: "session-member",
    active: true,
    forcePasswordChange: false,
    accessRoles: [{ role: "LODGE" }],
  });
  mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
  mockPrisma.booking.count.mockResolvedValue(0);
  mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
  mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
  mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
  mockPrisma.bookingGuest.update.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (fn: never) =>
    (fn as unknown as (tx: unknown) => unknown)(mockPrisma),
  );
  mockAuth.mockResolvedValue({
    user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }] },
  });
});

describe("the departure chore sweep is bounded by the SEGMENT (#2628)", () => {
  it("stops at the night the guest comes back for", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());

    const { PUT } = await import("@/app/api/lodge/guests/[date]/depart/route");
    const res = await PUT(request("2026-07-12", "depart", "g-sparse"), params("2026-07-12"));

    expect(res.status).toBe(200);
    // The 13th is swept (a gap day nobody is there for); the 14th and 15th are
    // NOT — the guest sleeps on the 14th and is rosterable on both. Remove the
    // `lt` bound and this fails: an unbounded sweep deletes a roster generated
    // for the guest's second segment, and toggling the departure back off does
    // not restore it.
    const swept = { gt: utc("2026-07-12"), lt: utc("2026-07-14") };
    expect(mockPrisma.choreAssignment.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ bookingGuestId: "g-sparse", date: swept }),
    });
    // The roster lock is taken over exactly the same window, never wider.
    expect(mockPrisma.choreAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ date: swept }),
      }),
    );
  });

  it("sweeps everything after a FINAL departure, exactly as before", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());

    const { PUT } = await import("@/app/api/lodge/guests/[date]/depart/route");
    const res = await PUT(request("2026-07-15", "depart", "g-sparse"), params("2026-07-15"));

    expect(res.status).toBe(200);
    expect(mockPrisma.choreAssignment.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ date: { gt: utc("2026-07-15") } }),
    });
  });

  it("accepts BOTH of the stay's departure mornings and refuses a booked night", async () => {
    // The issue's own acceptance criterion, driven through the endpoint rather
    // than through the helper: the 12th used to 404.
    const { PUT } = await import("@/app/api/lodge/guests/[date]/depart/route");

    mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());
    expect(
      (await PUT(request("2026-07-12", "depart", "g-sparse"), params("2026-07-12"))).status,
    ).toBe(200);

    mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());
    expect(
      (await PUT(request("2026-07-15", "depart", "g-sparse"), params("2026-07-15"))).status,
    ).toBe(200);

    // The 14th is a night they sleep, not a morning they leave. The endpoint
    // stays fenced off from presence.
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());
    expect(
      (await PUT(request("2026-07-14", "depart", "g-sparse"), params("2026-07-14"))).status,
    ).toBe(404);
  });
});

describe("a RETURN supersedes the stay's stale attendance pair (#2628)", () => {
  it("marks arrived and clears the earlier departure, without toggling off", async () => {
    // The dead end: after checking out on the 12th, `departedAt` is set and
    // `arrivedAt` still holds the 11th. A plain toggle would UN-arrive them and
    // leave them showing as departed for the rest of the stay.
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(
      sparseGuest({ arrivedAt: utc("2026-07-11"), departedAt: utc("2026-07-12") }),
    );

    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
    const res = await PUT(request("2026-07-14", "arrive", "g-sparse"), params("2026-07-14"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.arrivedAt).toBeTruthy();
    expect(data.departedAt).toBeNull();
    expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "g-sparse" },
      data: { arrivedAt: expect.any(Date), departedAt: null },
    });
  });

  it("leaves the ordinary toggle alone when nothing was departed", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(
      sparseGuest({ arrivedAt: utc("2026-07-14"), departedAt: null }),
    );

    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
    const res = await PUT(request("2026-07-14", "arrive", "g-sparse"), params("2026-07-14"));
    const data = await res.json();

    expect(data.arrivedAt).toBeNull();
    expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "g-sparse" },
      data: { arrivedAt: null },
    });
  });

  it("does NOT treat a contiguous stay's arrival day as a return", async () => {
    // The safety property. A contiguous stay has one departure morning and it is
    // after every night, so no arrival can follow it — the arrive route must
    // keep its shipped toggle for every ordinary booking, `departedAt` or not.
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      ...sparseGuest({ arrivedAt: utc("2026-07-11"), departedAt: utc("2026-07-15") }),
      nights: [
        { stayDate: utc("2026-07-11") },
        { stayDate: utc("2026-07-12") },
        { stayDate: utc("2026-07-13") },
        { stayDate: utc("2026-07-14") },
      ],
    });

    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
    await PUT(request("2026-07-11", "arrive", "g-sparse"), params("2026-07-11"));

    expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "g-sparse" },
      data: { arrivedAt: null },
    });
  });
});

describe("the arrive ENDPOINT refuses a gap night (#2737)", () => {
  /**
   * The issue's own acceptance criterion, driven through the endpoint.
   *
   * Nights {11, 14}. The envelope the SQL filter uses is `[11, 15)`, so the
   * 12th and the 13th are INSIDE it while the guest is at home — that is the
   * whole hole. Before #2737 the endpoint accepted both and stamped an arrival
   * time on a night nobody was in the lodge.
   *
   * MUTATION PROBE: delete the `isGuestActiveOnNight` guard in
   * `findLodgeGuestForDate` and the two gap-night cases below go 200, because
   * the envelope filter is mocked out here exactly as Postgres would satisfy it.
   */
  it("refuses BOTH gap nights with 409 and writes nothing", async () => {
    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");

    for (const gapNight of ["2026-07-12", "2026-07-13"]) {
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());
      const res = await PUT(
        request(gapNight, "arrive", "g-sparse"),
        params(gapNight),
      );

      expect(res.status, gapNight).toBe(409);
      await expect(res.json()).resolves.toEqual(
        expect.objectContaining({ code: "GUEST_NOT_BOOKED_THIS_NIGHT" }),
      );
    }
    // Not "no arrival was recorded" — no write was attempted at all.
    expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("still accepts both nights the guest DOES hold, either side of the gap", async () => {
    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");

    for (const bookedNight of ["2026-07-11", "2026-07-14"]) {
      mockPrisma.bookingGuest.update.mockClear();
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());
      const res = await PUT(
        request(bookedNight, "arrive", "g-sparse"),
        params(bookedNight),
      );

      expect(res.status, bookedNight).toBe(200);
      expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g-sparse" },
        data: { arrivedAt: expect.any(Date) },
      });
    }
  });

  it("keeps 404 for a guest nothing matched, so a refusal is never a disclosure", async () => {
    // The two refusals must stay distinguishable in the OTHER direction as
    // well. Consent, pending review, lodge scope and booking status all resolve
    // to null in SQL and must keep collapsing to the same uninformative 404 —
    // if the 409 ever became the general "no" this endpoint gives, it would
    // start answering questions the caller was refused.
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
    const res = await PUT(
      request("2026-07-11", "arrive", "g-sparse"),
      params("2026-07-11"),
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Guest not found for this date",
    });
    expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("a legacy guest carrying NO night rows still arrives on every envelope night", async () => {
    // Pre-#713 rows have only the envelope, and `isGuestActiveOnNight` falls
    // back to it. #2737 must not turn those guests into permanent 409s: the
    // 12th is a night for them precisely because they declare no night set.
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest({ nights: [] }));

    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
    const res = await PUT(
      request("2026-07-12", "arrive", "g-sparse"),
      params("2026-07-12"),
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "g-sparse" },
      data: { arrivedAt: expect.any(Date) },
    });
  });
});

describe("the kiosk sends the state it WANTS, so a repeat changes nothing (#4965)", () => {
  /**
   * The double tap. On slow lodge Wi-Fi the hut leader taps Mark Arrived, sees
   * nothing happen and taps again. When these endpoints were toggles the second
   * request un-did the first and left a "cleared" audit row behind. The kiosk
   * now says which state it wants, and asking for the state already stored is
   * a no-op: no write and no audit row.
   *
   * MUTATION PROBE: make the routes ignore `arrived` / `departed` (pass
   * `wanted: undefined` to the helper) and every "no-op" case below fails.
   */
  // Imported lazily, like the routes: a static import would load `@/lib/prisma`
  // before `mockPrisma` exists.
  let logAudit: typeof import("@/lib/audit").logAudit;
  let lockRosterDates: typeof import("@/lib/roster-lock").lockRosterDates;
  beforeEach(async () => {
    ({ logAudit } = await import("@/lib/audit"));
    ({ lockRosterDates } = await import("@/lib/roster-lock"));
  });

  const contiguousGuest = (overrides: Record<string, unknown> = {}) => ({
    ...sparseGuest(overrides),
    nights: [
      { stayDate: utc("2026-07-11") },
      { stayDate: utc("2026-07-12") },
      { stayDate: utc("2026-07-13") },
      { stayDate: utc("2026-07-14") },
    ],
  });

  describe("arrive", () => {
    it("records the arrival when asked for one", async () => {
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(contiguousGuest());

      const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
      const res = await PUT(
        request("2026-07-11", "arrive", "g-sparse", { arrived: true }),
        params("2026-07-11"),
      );

      expect(res.status).toBe(200);
      expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g-sparse" },
        data: { arrivedAt: expect.any(Date) },
      });
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "lodge.guest.arrived" }),
      );
    });

    it("is a no-op when the guest is already here: no write, no audit row", async () => {
      const arrivedAt = new Date("2026-07-11T03:00:00.000Z");
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(
        contiguousGuest({ arrivedAt }),
      );

      const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
      const res = await PUT(
        request("2026-07-11", "arrive", "g-sparse", { arrived: true }),
        params("2026-07-11"),
      );

      expect(res.status).toBe(200);
      // The same shape a write returns, carrying the stored values, so the
      // kiosk draws the row as it really is.
      await expect(res.json()).resolves.toEqual({
        success: true,
        arrivedAt: arrivedAt.toISOString(),
        departedAt: null,
      });
      expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    });

    it("clears an arrival only when one is recorded", async () => {
      const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");

      mockPrisma.bookingGuest.findFirst.mockResolvedValue(
        contiguousGuest({ arrivedAt: new Date("2026-07-11T03:00:00.000Z") }),
      );
      await PUT(
        request("2026-07-11", "arrive", "g-sparse", { arrived: false }),
        params("2026-07-11"),
      );
      expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g-sparse" },
        data: { arrivedAt: null },
      });
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "lodge.guest.arrival_cleared" }),
      );

      vi.clearAllMocks();
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(contiguousGuest());
      const res = await PUT(
        request("2026-07-11", "arrive", "g-sparse", { arrived: false }),
        params("2026-07-11"),
      );
      expect(res.status).toBe(200);
      expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    });

    it("still records a sparse stay's RETURN although `arrivedAt` is already set (#2628)", async () => {
      // `arrivedAt` holds the first segment's check-in, so a naive "already
      // arrived" test would refuse to check a returning guest back in — ever.
      // "Already here" is `arrivedAt && !departedAt`, and the departure from the
      // 12th means they are not.
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(
        sparseGuest({ arrivedAt: utc("2026-07-11"), departedAt: utc("2026-07-12") }),
      );

      const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
      const res = await PUT(
        request("2026-07-14", "arrive", "g-sparse", { arrived: true }),
        params("2026-07-14"),
      );

      expect(res.status).toBe(200);
      expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g-sparse" },
        data: { arrivedAt: expect.any(Date), departedAt: null },
      });
      const data = await res.json();
      expect(data.departedAt).toBeNull();
    });

    it("keeps the old toggle for a body with no `arrived`, as a pre-#4965 page sends", async () => {
      // Blue-green: a kiosk page already open across the deploy sends only the
      // id. It must keep the behaviour it was written against — a second press
      // clears the arrival.
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(
        contiguousGuest({ arrivedAt: new Date("2026-07-11T03:00:00.000Z") }),
      );

      const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
      await PUT(request("2026-07-11", "arrive", "g-sparse"), params("2026-07-11"));

      expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g-sparse" },
        data: { arrivedAt: null },
      });
    });

    it("rejects a wanted state that is not a boolean", async () => {
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(contiguousGuest());

      const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
      const res = await PUT(
        request("2026-07-11", "arrive", "g-sparse", {
          arrived: "yes" as unknown as boolean,
        }),
        params("2026-07-11"),
      );

      expect(res.status).toBe(400);
      expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
    });
  });

  describe("depart", () => {
    it("records the departure and sweeps when asked for one", async () => {
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());

      const { PUT } = await import("@/app/api/lodge/guests/[date]/depart/route");
      const res = await PUT(
        request("2026-07-15", "depart", "g-sparse", { departed: true }),
        params("2026-07-15"),
      );

      expect(res.status).toBe(200);
      expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g-sparse" },
        data: { departedAt: expect.any(Date) },
      });
      expect(mockPrisma.choreAssignment.deleteMany).toHaveBeenCalledTimes(1);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "lodge.guest.departed" }),
      );
    });

    it("is a no-op on a repeat: locks first, then no roster keys, write, sweep or audit row", async () => {
      const departedAt = new Date("2026-07-14T21:00:00.000Z");
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(
        sparseGuest({ arrivedAt: utc("2026-07-14"), departedAt }),
      );

      const { PUT } = await import("@/app/api/lodge/guests/[date]/depart/route");
      const res = await PUT(
        request("2026-07-15", "depart", "g-sparse", { departed: true }),
        params("2026-07-15"),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        success: true,
        departedAt: departedAt.toISOString(),
      });
      // The decision is made from the row read under the global lock, so the
      // lock is still taken; nothing after the decision runs.
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
      expect(lockRosterDates).not.toHaveBeenCalled();
      expect(mockPrisma.choreAssignment.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
      expect(mockPrisma.choreAssignment.deleteMany).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    });

    it("clears a stale departure when asked, without sweeping", async () => {
      // The guide's stale-Departed card: the first tap clears, the next records.
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(
        sparseGuest({ arrivedAt: utc("2026-07-11"), departedAt: utc("2026-07-12") }),
      );

      const { PUT } = await import("@/app/api/lodge/guests/[date]/depart/route");
      await PUT(
        request("2026-07-15", "depart", "g-sparse", { departed: false }),
        params("2026-07-15"),
      );

      expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g-sparse" },
        data: { departedAt: null },
      });
      expect(mockPrisma.choreAssignment.deleteMany).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "lodge.guest.departure_cleared" }),
      );
    });

    it("is a no-op when asked to clear a departure that is not recorded", async () => {
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(sparseGuest());

      const { PUT } = await import("@/app/api/lodge/guests/[date]/depart/route");
      const res = await PUT(
        request("2026-07-15", "depart", "g-sparse", { departed: false }),
        params("2026-07-15"),
      );

      expect(res.status).toBe(200);
      expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    });

    it("keeps the old toggle for a body with no `departed`, as a pre-#4965 page sends", async () => {
      mockPrisma.bookingGuest.findFirst.mockResolvedValue(
        sparseGuest({ departedAt: new Date("2026-07-14T21:00:00.000Z") }),
      );

      const { PUT } = await import("@/app/api/lodge/guests/[date]/depart/route");
      await PUT(request("2026-07-15", "depart", "g-sparse"), params("2026-07-15"));

      expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g-sparse" },
        data: { departedAt: null },
      });
    });
  });
});
