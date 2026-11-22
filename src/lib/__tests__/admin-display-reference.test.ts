import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";
import { DISPLAY_CONDITION_NAMES } from "@/lib/lodge-display/conditions";

// LTV-034 (hoppers99/AlpineClubBookingsNZ#80): the live conditions status endpoint behind the Conditions
// reference. Read-only, admin-guarded, GET-only; it builds a lodge's
// DisplayState and evaluates EVERY registry condition against it. These tests
// pin the guard, the "every condition returns a boolean" contract, and lodge
// resolution (an explicit id is required). buildDisplayState and
// the lodge lookups are mocked; the conditions registry is the REAL one so the
// truth vector is genuinely computed from the payload.

const { mockRequireAdmin, mockBuildDisplayState, mockGetDefaultLodgeId } =
  vi.hoisted(() => ({
    mockRequireAdmin: vi.fn(),
    mockBuildDisplayState: vi.fn(),
    mockGetDefaultLodgeId: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...args: unknown[]) => mockGetDefaultLodgeId(...args),
}));
vi.mock("@/lib/lodge-display-state", () => ({
  buildDisplayState: (...args: unknown[]) => mockBuildDisplayState(...args),
}));

const WINDOW = ["2026-04-13", "2026-04-14", "2026-04-15"];

function state(overrides: Partial<DisplayState> = {}): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: WINDOW.map((date) => ({ date, arriving: 0, departing: 0, staying: 0 })),
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    // #2286: no custodian in residence in the base fixture.
    custodian: null,
    ...overrides,
  };
}

async function getRequest(url: string) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mockGetDefaultLodgeId.mockResolvedValue("lodge-default");
  mockBuildDisplayState.mockResolvedValue(state());
});

describe("GET /api/admin/display/reference/conditions (LTV-034)", () => {
  it("requires an admin session", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { GET } = await import(
      "@/app/api/admin/display/reference/conditions/route"
    );
    const res = await GET(
      await getRequest("http://localhost/api/admin/display/reference/conditions?lodgeId=lodge-default")
    );
    expect(res.status).toBe(401);
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
  });

  it("returns every registry condition with a boolean value", async () => {
    const { GET } = await import(
      "@/app/api/admin/display/reference/conditions/route"
    );
    const res = await GET(
      await getRequest("http://localhost/api/admin/display/reference/conditions?lodgeId=lodge-default")
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const returnedNames = body.conditions.map((c: { name: string }) => c.name);
    // The reference surfaces the CLOSED registry with no hand-maintained
    // duplication: exactly the registry names, each with a boolean.
    expect(new Set(returnedNames)).toEqual(new Set(DISPLAY_CONDITION_NAMES));
    expect(returnedNames.length).toBe(DISPLAY_CONDITION_NAMES.length);
    for (const entry of body.conditions) {
      expect(typeof entry.value).toBe("boolean");
    }
  });

  it("evaluates conditions live against the built state", async () => {
    // A committee notice set → content:notice must read true; an empty lodge
    // with no bookings → occupancy:empty-today true, arrivals-today false.
    mockBuildDisplayState.mockResolvedValue(
      state({ notice: "Committee meeting Saturday." })
    );
    const { GET } = await import(
      "@/app/api/admin/display/reference/conditions/route"
    );
    const res = await GET(
      await getRequest("http://localhost/api/admin/display/reference/conditions?lodgeId=lodge-default")
    );
    const body = await res.json();
    const byName = new Map<string, boolean>(
      body.conditions.map((c: { name: string; value: boolean }) => [c.name, c.value])
    );
    expect(byName.get("always")).toBe(true);
    expect(byName.get("content:notice")).toBe(true);
    expect(byName.get("occupancy:empty-today")).toBe(true);
    expect(byName.get("occupancy:arrivals-today")).toBe(false);
    expect(byName.get("chores:enabled")).toBe(false);
  });

  it("honours an explicit lodgeId", async () => {
    const { GET } = await import(
      "@/app/api/admin/display/reference/conditions/route"
    );
    const res = await GET(
      await getRequest(
        "http://localhost/api/admin/display/reference/conditions?lodgeId=lodge-xyz"
      )
    );
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-xyz");
    expect(mockGetDefaultLodgeId).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.lodgeId).toBe("lodge-xyz");
    expect(body.lodgeName).toBe("Silverpeak Lodge");
  });

  it("fails closed when lodgeId is omitted", async () => {
    const { GET } = await import(
      "@/app/api/admin/display/reference/conditions/route"
    );
    const res = await GET(
      await getRequest("http://localhost/api/admin/display/reference/conditions")
    );
    expect(res.status).toBe(400);
    expect(mockGetDefaultLodgeId).not.toHaveBeenCalled();
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
  });

  it("404s when the lodge cannot be built", async () => {
    mockBuildDisplayState.mockResolvedValue(null);
    const { GET } = await import(
      "@/app/api/admin/display/reference/conditions/route"
    );
    const res = await GET(
      await getRequest("http://localhost/api/admin/display/reference/conditions?lodgeId=lodge-default")
    );
    expect(res.status).toBe(404);
  });
});
