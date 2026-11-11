import { afterEach, describe, expect, it, vi } from "vitest";

import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  isWithinRecentAuthWindow,
  RECENT_AUTH_WINDOW_MS,
  recentAuthRefusalBody,
} from "@/lib/recent-auth-factors";

const mockAuth = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

import { requireRecentAuth } from "@/lib/require-recent-auth";

describe("recent authentication window (#4616)", () => {
  afterEach(() => {
    vi.setSystemTime(frozenTestNow());
    mockAuth.mockReset();
  });

  it("uses the frozen clock, and five minutes still passes", () => {
    const signedInAt = Date.now();
    expect(signedInAt).toBe(frozenTestNow().getTime());
    expect(isWithinRecentAuthWindow(signedInAt, signedInAt)).toBe(true);
    expect(
      isWithinRecentAuthWindow(signedInAt, signedInAt + RECENT_AUTH_WINDOW_MS),
    ).toBe(true);
    expect(
      isWithinRecentAuthWindow(
        signedInAt,
        signedInAt + RECENT_AUTH_WINDOW_MS + 1000,
      ),
    ).toBe(false);
    expect(isWithinRecentAuthWindow(undefined, signedInAt)).toBe(false);
    expect(isWithinRecentAuthWindow("1000", signedInAt)).toBe(false);
    expect(isWithinRecentAuthWindow(Number.NaN, signedInAt)).toBe(false);
  });

  it("passes a fresh sign-in and refuses five minutes and one second later", async () => {
    const signedInAt = Date.now();
    mockAuth.mockResolvedValue({
      user: { id: "member-1", lastAuthenticatedAt: signedInAt },
    });

    expect((await requireRecentAuth()).ok).toBe(true);

    vi.setSystemTime(signedInAt + RECENT_AUTH_WINDOW_MS);
    expect((await requireRecentAuth()).ok).toBe(true);

    vi.setSystemTime(signedInAt + RECENT_AUTH_WINDOW_MS + 1000);
    const refused = await requireRecentAuth();
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.response.status).toBe(403);
      await expect(refused.response.json()).resolves.toEqual(recentAuthRefusalBody());
    }
  });

  it("refuses a session with no stamp, and an unknown caller", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    const stale = await requireRecentAuth();
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.response.status).toBe(403);

    mockAuth.mockResolvedValue(null);
    const anonymous = await requireRecentAuth();
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.response.status).toBe(401);
  });
});
