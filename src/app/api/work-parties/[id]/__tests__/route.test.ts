import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork #118: `GET /api/work-parties/[id]`, the member work party read. The
 * access matrix: members only (owner decision 7), the module re-checked in the
 * handler, and the same 404 for everyone else and for an inactive or unknown id.
 */
const h = vi.hoisted(() => ({
  sessionUser: null as Record<string, unknown> | null,
  modules: { workParties: true },
  findMemberWorkParty: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: vi.fn(async () =>
    h.sessionUser
      ? { ok: true, session: { user: h.sessionUser } }
      : { ok: false, response: new Response("unauth", { status: 401 }) },
  ),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  rateLimiters: { bookingQuery: {} },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: vi.fn(
    async () => new Date("2026-07-01T00:00:00.000Z"),
  ),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => h.modules),
}));
vi.mock("@/lib/work-party-member", () => ({
  findMemberWorkParty: h.findMemberWorkParty,
}));

import { GET } from "../route";

const member = { id: "m-1", accessRoles: ["USER"], role: "USER", canLogin: true };
const workParty = {
  id: "wp-1",
  name: "Spring",
  description: null,
  startDate: "2026-07-10",
  endDate: "2026-07-12",
  discountPercent: 50,
  lodgeId: null,
  lodgeName: null,
  join: { checkIn: "2026-07-10", checkOut: "2026-07-13" },
};

function call() {
  return GET(new Request("http://localhost/api/work-parties/wp-1") as never, {
    params: Promise.resolve({ id: "wp-1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sessionUser = member;
  h.modules.workParties = true;
  h.findMemberWorkParty.mockResolvedValue(workParty);
});

describe("GET /api/work-parties/[id]", () => {
  it("returns the work party to a member, without a promo code", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workParty).toEqual(workParty);
    expect(JSON.stringify(body)).not.toMatch(/promo|WORKPARTY-/i);
    expect(h.findMemberWorkParty).toHaveBeenCalledWith(
      "wp-1",
      new Date("2026-07-01T00:00:00.000Z"),
    );
  });

  it("refuses a signed-out caller", async () => {
    h.sessionUser = null;
    expect((await call()).status).toBe(401);
    expect(h.findMemberWorkParty).not.toHaveBeenCalled();
  });

  it.each([
    ["an organisation account", { id: "o", accessRoles: ["ORG"], role: "USER", canLogin: true }],
    ["a school login", { id: "s", accessRoles: [], role: "SCHOOL", canLogin: true }],
    ["a non-member login", { id: "n", accessRoles: [], role: "NON_MEMBER", canLogin: true }],
  ])("answers 404 to %s without reading", async (_label, user) => {
    h.sessionUser = user;
    expect((await call()).status).toBe(404);
    expect(h.findMemberWorkParty).not.toHaveBeenCalled();
  });

  it("answers 404 while the Work Parties module is off", async () => {
    h.modules.workParties = false;
    expect((await call()).status).toBe(404);
    expect(h.findMemberWorkParty).not.toHaveBeenCalled();
  });

  it("answers 404 for an inactive or unknown work party", async () => {
    h.findMemberWorkParty.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("returns a finished work party with no join stay", async () => {
    h.findMemberWorkParty.mockResolvedValue({ ...workParty, join: null });
    const body = await (await call()).json();
    expect(body.workParty.join).toBeNull();
  });
});
