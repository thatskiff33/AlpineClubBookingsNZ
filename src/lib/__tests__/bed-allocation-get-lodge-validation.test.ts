import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Low 2: the bed-allocation GET dashboards must validate an explicit
// ?lodgeId= the same way their write paths do (400 on unknown/inactive),
// while an omitted lodgeId stays club-wide. resolveOptionalActiveLodgeId is
// left un-mocked so the real validation runs against the mocked prisma.
const {
  mockLodgeFindUnique,
  mockBookingFindUnique,
  mockRequireBedAllocationRead,
  mockRequireBedInventoryRead,
  mockGetBedAllocationDashboard,
  mockGetRoomsAndBedsConfiguration,
} = vi.hoisted(() => ({
  mockLodgeFindUnique: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockRequireBedAllocationRead: vi.fn(),
  mockRequireBedInventoryRead: vi.fn(),
  mockGetBedAllocationDashboard: vi.fn(),
  mockGetRoomsAndBedsConfiguration: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findUnique: mockLodgeFindUnique },
    // #2678: the board read resolves a named booking's own lodge.
    booking: { findUnique: mockBookingFindUnique },
  },
}));

// #2352 slice-1 review: these writers now clear the STORED public pages, not just
// the capacity tag. `revalidatePath` needs a static-generation store that no unit
// test has, so the shared helper is stubbed here; its own contents are pinned by
// public-content-invalidation-contract.test.ts.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

vi.mock("@/lib/admin-bed-allocation-routes", () => ({
  requireBedAllocationRead: () => mockRequireBedAllocationRead(),
  requireBedInventoryRead: () => mockRequireBedInventoryRead(),
  bedAllocationErrorResponse: vi.fn(),
}));

// The real limits stay: the routes' request schemas read them (ALP-719).
vi.mock("@/lib/bed-allocation-date-range", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-date-range")),
  parseBedAllocationDateRange: () => ({
    from: new Date("2026-04-01T00:00:00Z"),
    to: new Date("2026-04-14T00:00:00Z"),
  }),
}));
vi.mock("@/lib/bed-allocation-board", () => ({
  getBedAllocationDashboard: (...args: unknown[]) =>
    mockGetBedAllocationDashboard(...args),
}));
vi.mock("@/lib/bed-allocation-rooms", () => ({
  getRoomsAndBedsConfiguration: (...args: unknown[]) =>
    mockGetRoomsAndBedsConfiguration(...args),
  createBedAllocationRoom: vi.fn(),
}));

describe("GET /api/admin/bed-allocation lodge validation (Low 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireBedAllocationRead.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockGetBedAllocationDashboard.mockResolvedValue({ ok: true });
  });

  it("rejects an unknown or inactive lodgeId with 400", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(400);
    expect(mockGetBedAllocationDashboard).not.toHaveBeenCalled();
  });

  it("passes a valid active lodge through to the dashboard", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockGetBedAllocationDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" }),
    );
  });

  it("stays club-wide when no lodgeId is supplied (no validation query)", async () => {
    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockLodgeFindUnique).not.toHaveBeenCalled();
    expect(mockGetBedAllocationDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: undefined }),
    );
  });
});

/**
 * #2678 — a named booking fixes the lodge, and the server owns it.
 *
 * The lodge-scoping contract already said so for booking-scoped reads ("derives
 * its lodge from `Booking.lodgeId` server-side ... never from a client-supplied
 * `lodgeId`"); this board read was the last one still taking it from the caller,
 * after #2673 and #2677 closed the requested-room picker and the wizard.
 *
 * The path that mattered was not a hand-crafted request: `AdminBookingToolsCard`
 * deep-linked this board with `bookingId` and no `lodgeId`, so the board opened
 * CLUB-WIDE with the booking focused and its bed pickers offered every lodge's
 * beds for that booking's guests — the #2664 symptom, two clicks from a booking
 * page, with the write then refused by `assertGuestAndBedForAllocation`.
 */
describe("GET /api/admin/bed-allocation booking-scoped lodge (#2678)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireBedAllocationRead.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockGetBedAllocationDashboard.mockResolvedValue({ ok: true });
  });

  it("derives the lodge from a named booking when the caller supplies none", async () => {
    mockBookingFindUnique.mockResolvedValue({ lodgeId: "lodge-1" });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&bookingId=booking-1",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockBookingFindUnique).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      select: { lodgeId: true },
    });
    expect(mockGetBedAllocationDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-1", bookingId: "booking-1" }),
    );
  });

  it("refuses a lodgeId that contradicts a named booking with a 409 (#2701)", async () => {
    // This USED to be ignored, matching `requested-room/options` (#2673). The
    // board is different in one way that matters: it renders the focused
    // booking and a lodge selector side by side, so serving lodge one's board
    // for a lodge-two request is an internally contradictory SCREEN rather than
    // a redundant parameter. The refusal is affordable because no honest
    // navigation can produce the pair any more — proved in
    // `bed-allocation-board-lodge-scope.test.tsx`, which drives the board
    // against this same predicate.
    mockBookingFindUnique.mockResolvedValue({ lodgeId: "lodge-1" });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&bookingId=booking-1&lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "LODGE_MISMATCH" });
    // No board is built for a request that cannot be answered coherently.
    expect(mockGetBedAllocationDashboard).not.toHaveBeenCalled();
    // The contradicting value is not validated either: "lodge not found" would
    // report the wrong fault entirely.
    expect(mockLodgeFindUnique).not.toHaveBeenCalled();
  });

  it("serves a lodgeId that AGREES with the named booking (#2701)", async () => {
    // The shape both real deep links send — `AdminBookingToolsCard` and the
    // booking page's bed panel both pass `booking.lodgeId` beside `bookingId`.
    // The 409 above must not catch them.
    mockBookingFindUnique.mockResolvedValue({ lodgeId: "lodge-1" });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&bookingId=booking-1&lodgeId=lodge-1",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockGetBedAllocationDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-1" }),
    );
  });

  it("echoes the lodge it actually scoped to, so the board's selector can adopt it (#2701)", async () => {
    // The whole fix for a deep link that names only a booking: the server is
    // the only party that knows the booking's lodge, so it says so. Without
    // this the board's selector defaults to the first lodge while the data
    // below it belongs to another.
    mockBookingFindUnique.mockResolvedValue({ lodgeId: "lodge-3" });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&bookingId=booking-1",
      ),
    );

    expect(await res.json()).toMatchObject({ scopedLodgeId: "lodge-3" });
  });

  it("echoes a null scope for a deliberate club-wide read (#2701)", async () => {
    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14",
      ),
    );

    expect(await res.json()).toMatchObject({ scopedLodgeId: null });
  });

  it("does not refuse when the bookingId resolves to nothing, however wrong the lodgeId looks", async () => {
    // A stale deep link must not turn a valid board load into a refusal: with
    // no booking lodge there is nothing for the caller's lodge to contradict,
    // and the ordinary active-lodge validation applies instead.
    mockBookingFindUnique.mockResolvedValue(null);
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&bookingId=gone&lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(200);
  });

  it("falls back to the caller's own scope when the bookingId resolves to nothing", async () => {
    // A stale deep link must not turn a valid lodge-scoped board load into an
    // error; the focus lookup inside the dashboard already returns nothing.
    mockBookingFindUnique.mockResolvedValue(null);
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&bookingId=gone&lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockGetBedAllocationDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" }),
    );
  });

  it("does not filter the lodge lookup by status, so a cancelled booking's board still scopes", async () => {
    // The lodge is a fact about the row whatever its status. `focusedBooking`
    // keeps its own stricter allocatable/non-deleted filter for the window it
    // snaps onto; scoping must not inherit it, or a cancelled booking's board
    // would silently reopen club-wide.
    mockBookingFindUnique.mockResolvedValue({ lodgeId: "lodge-3" });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&bookingId=cancelled-1",
      ),
    );

    const where = mockBookingFindUnique.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({ id: "cancelled-1" });
    expect(mockGetBedAllocationDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-3" }),
    );
  });
});

describe("GET /api/admin/bed-allocation/rooms lodge validation (Low 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireBedInventoryRead.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockGetRoomsAndBedsConfiguration.mockResolvedValue({ rooms: [] });
  });

  it("rejects an unknown or inactive lodgeId with 400", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const { GET } = await import("@/app/api/admin/bed-allocation/rooms/route");
    const res = await GET(
      new Request(
        "http://localhost/api/admin/bed-allocation/rooms?lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(400);
    expect(mockGetRoomsAndBedsConfiguration).not.toHaveBeenCalled();
  });

  it("passes a valid active lodge through to the configuration query", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const { GET } = await import("@/app/api/admin/bed-allocation/rooms/route");
    const res = await GET(
      new Request(
        "http://localhost/api/admin/bed-allocation/rooms?lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockGetRoomsAndBedsConfiguration).toHaveBeenCalledWith(
      undefined,
      "lodge-2",
    );
  });
});
