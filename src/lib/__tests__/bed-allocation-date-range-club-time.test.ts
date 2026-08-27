import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The bed board's default window opens on the CLUB's day, not the container's
 * (#3123; `INV-CONFIG-002`, `INV-LOCK-004`).
 *
 * ## The defect
 *
 * `parseBedAllocationDateRange` defaulted a missing `from` to the environment
 * timezone's today. For a club behind Greenwich that opened the bed board — and
 * ran `auto-allocate` and `approve` over its default window — on **yesterday**.
 * Approve and auto-allocate then write under `pg_advisory_xact_lock(1)` plus the
 * lodge capacity key, so the wrong window is a wrong write, not a wrong view.
 *
 * ## Why the day is threaded rather than read where it was needed
 *
 * The parse is synchronous and pure and its product is consumed inside those
 * locked transactions. `INV-LOCK-004` names the club timezone as one of exactly
 * two reads that cannot take a transaction client, so each route resolves ONE
 * club day before it calls anything and passes it in as a required argument.
 * `lock-bound-club-zone-outside-transaction.test.ts` holds that structurally;
 * this file holds the resulting date.
 *
 * ## Two traps this file is built to avoid
 *
 * 1. **`getClubTimeZone` is fail-soft three ways** — an absent row, an
 *    unreachable database and a MISSING PRISMA DELEGATE all resolve to "not
 *    persisted" and fall through to the environment. A prisma mock without
 *    `clubTimeSettings` therefore passes identically before and after the
 *    migration. The mock below carries the delegate.
 * 2. **The persisted zone must not be `Pacific/Auckland`**, which is what the
 *    environment already resolves to under test — a test that persists it cannot
 *    tell the persisted zone from the container's. `America/Denver` is behind
 *    Greenwich, so at the frozen instant (`2026-07-01T00:00:00.000Z`) the club is
 *    still on 30 June while the container says 1 July.
 */

const CLUB_ZONE = "America/Denver";
/** The club's day at the frozen instant. The container's is 2026-07-01. */
const CLUB_DAY = "2026-06-30";
const CONTAINER_DAY = "2026-07-01";

const mocks = vi.hoisted(() => ({
  requireRead: vi.fn(),
  requireWrite: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  lodgeFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  dashboard: vi.fn(),
  runAuto: vi.fn(),
  approve: vi.fn(),
  parseJsonBody: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // THE DELEGATE THAT MAKES THIS TEST DISCRIMINATING — see trap 1 above.
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    lodge: { findUnique: mocks.lodgeFindUnique },
    booking: { findUnique: mocks.bookingFindUnique },
  },
}));

vi.mock("@/lib/admin-bed-allocation-routes", () => ({
  requireBedAllocationRead: () => mocks.requireRead(),
  requireBedAllocationWrite: () => mocks.requireWrite(),
  bedAllocationErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 500 },
    ),
}));

vi.mock("@/lib/bed-allocation-board", () => ({
  getBedAllocationDashboard: (...args: unknown[]) => mocks.dashboard(...args),
}));
vi.mock("@/lib/bed-allocation-auto-allocate", () => ({
  runAutoBedAllocation: (...args: unknown[]) => mocks.runAuto(...args),
}));
vi.mock("@/lib/bed-allocation-approval", () => ({
  approveBedAllocations: (...args: unknown[]) => mocks.approve(...args),
}));
vi.mock("@/lib/api-json", () => ({
  parseJsonRequestBody: (...args: unknown[]) => mocks.parseJsonBody(...args),
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));

import { GET } from "@/app/api/admin/bed-allocation/route";
import { POST as autoAllocate } from "@/app/api/admin/bed-allocation/auto-allocate/route";
import { POST as approve } from "@/app/api/admin/bed-allocation/approve/route";
import { parseBedAllocationDateRange } from "@/lib/bed-allocation-date-range";
import { requireCalendarDate } from "@/lib/club-time";

describe("the bed board's default window starts at the club's own day (#3123)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRead.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.requireWrite.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: CLUB_ZONE,
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: true });
    mocks.dashboard.mockResolvedValue({ ok: true });
    mocks.runAuto.mockResolvedValue({ count: 0 });
    mocks.approve.mockResolvedValue({ count: 0 });
  });

  it("PREMISE: the persisted zone and the container disagree at this instant", () => {
    expect(CLUB_ZONE).not.toBe("Pacific/Auckland");
    expect(CLUB_DAY).not.toBe(CONTAINER_DAY);
  });

  it("GET reads the board from the club's day when no from is supplied", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/admin/bed-allocation"),
    );

    expect(response.status).toBe(200);
    expect(mocks.dashboard).toHaveBeenCalledTimes(1);
    const range = mocks.dashboard.mock.calls[0][0].range;
    // Before the migration this was CONTAINER_DAY — the process's zone.
    expect(range.fromDate).toBe(CLUB_DAY);
    // Seven nights on from the club's day, which the parse still derives itself.
    expect(range.toDate).toBe("2026-07-07");
  });

  it("an explicit from still wins over the club's day", async () => {
    await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-08-01&to=2026-08-05",
      ),
    );

    const range = mocks.dashboard.mock.calls[0][0].range;
    expect(range.fromDate).toBe("2026-08-01");
    expect(range.toDate).toBe("2026-08-05");
  });

  it("auto-allocate writes over the club's day, not the container's", async () => {
    mocks.parseJsonBody.mockResolvedValue({
      ok: true,
      body: { lodgeId: "lodge-1" },
    });

    const response = await autoAllocate(
      new Request("http://localhost/api/admin/bed-allocation/auto-allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lodgeId: "lodge-1" }),
      }),
    );

    expect(response.status).toBe(200);
    // This one writes under the global advisory key and the lodge capacity key,
    // so the window is what gets allocated — not merely what gets shown.
    expect(mocks.runAuto.mock.calls[0][0].range.fromDate).toBe(CLUB_DAY);
  });

  it("approve fills a missing from with the club's day", async () => {
    mocks.parseJsonBody.mockResolvedValue({
      ok: true,
      body: { lodgeId: "lodge-1", to: "2026-07-05" },
    });

    const response = await approve(
      new Request("http://localhost/api/admin/bed-allocation/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lodgeId: "lodge-1", to: "2026-07-05" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.approve.mock.calls[0][0].range.fromDate).toBe(CLUB_DAY);
  });

  it("there is NO default left to police — the day is a required argument", () => {
    /*
      A compile-time claim asserted at runtime as well, because the two failure
      modes differ: a re-added default type-checks everywhere and silently answers
      from the environment again, while this call throws. `@ts-expect-error` fails
      `tsc` the moment the parameter becomes optional, and the throw fails the
      suite the moment a default value appears.
    */
    expect(() =>
      // @ts-expect-error - the club's day is required; a default must never return.
      parseBedAllocationDateRange({}),
    ).toThrow();

    // And with the day supplied it is exactly that day.
    expect(
      parseBedAllocationDateRange({}, requireCalendarDate(CLUB_DAY)).fromDate,
    ).toBe(CLUB_DAY);
  });
});
