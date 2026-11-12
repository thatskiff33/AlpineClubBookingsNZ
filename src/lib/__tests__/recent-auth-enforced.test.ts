import { afterEach, describe, expect, it, vi } from "vitest";

import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  RECENT_AUTH_WINDOW_MS,
  recentAuthRefusalBody,
} from "@/lib/recent-auth";

const mockAuth = vi.hoisted(() => vi.fn());

vi.mock("@/lib/officer-sign-in-switch", () => ({
  OFFICER_SIGN_IN_ENFORCED: true,
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

import { requireRecentAuth } from "@/lib/require-recent-auth";

describe("recent authentication when officer sign-in is enforced (#4619)", () => {
  afterEach(() => {
    vi.setSystemTime(frozenTestNow());
    mockAuth.mockReset();
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

  it("refuses an emailed-link session with no stamp, and an unknown caller", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "member-1", email: "member@example.com" },
    });
    const emailedLink = await requireRecentAuth();
    expect(emailedLink.ok).toBe(false);
    if (!emailedLink.ok) {
      expect(emailedLink.response.status).toBe(403);
      await expect(emailedLink.response.json()).resolves.toEqual(recentAuthRefusalBody());
    }

    mockAuth.mockResolvedValue(null);
    const anonymous = await requireRecentAuth();
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.response.status).toBe(401);
  });
});
