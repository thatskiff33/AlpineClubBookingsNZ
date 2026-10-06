import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  checkServerVersion: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/servernz-version-check", () => ({
  checkServerVersion: mocks.checkServerVersion,
}));

import { GET } from "@/app/api/admin/alpine-server/version/route";

/**
 * GET /api/admin/alpine-server/version (#49): runs the check and reports it.
 * Finance VIEW, like the setup page's other read surfaces; the body carries
 * two version numbers and a timestamp, never the key or the address.
 */

const fullAdmin = { user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] } };
const member = { user: { id: "member-1", role: "USER", accessRoles: ["USER"] } };
// The Treasurer bundle carries finance at edit; a Content admin does not hold
// finance at all.
const treasurer = { user: { id: "t-1", role: "USER", accessRoles: ["FINANCE_ADMIN"] } };
const contentAdmin = { user: { id: "c-1", role: "USER", accessRoles: ["ADMIN_CONTENT"] } };

const RESULT = {
  status: "mismatch",
  serverVersion: "2.1",
  expected: "2.0",
  checkedAt: "2026-07-01T00:00:00.000Z",
  couldNotCheck: false,
  missingBaseUrl: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.checkServerVersion.mockResolvedValue(RESULT);
});

describe("GET /api/admin/alpine-server/version", () => {
  it("rejects an unauthenticated caller without asking the server", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mocks.checkServerVersion).not.toHaveBeenCalled();
  });

  it("rejects a member and an admin without finance view", async () => {
    mocks.auth.mockResolvedValue(member);
    expect((await GET()).status).toBe(403);
    mocks.auth.mockResolvedValue(contentAdmin);
    expect((await GET()).status).toBe(403);
    expect(mocks.checkServerVersion).not.toHaveBeenCalled();
  });

  it("runs the THROTTLED check and returns it for finance view and up", async () => {
    for (const session of [fullAdmin, treasurer]) {
      mocks.auth.mockResolvedValue(session);
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RESULT);
    }
    expect(mocks.checkServerVersion).toHaveBeenCalledTimes(2);
    // Throttled: an answer recorded inside the recheck interval is returned
    // without a call, so a reload cannot trip the server's rate limit.
    expect(mocks.checkServerVersion).toHaveBeenCalledWith({ throttle: true });
  });
});
