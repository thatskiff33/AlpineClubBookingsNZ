import { afterEach, describe, expect, it, vi } from "vitest";

import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  isWithinRecentAuthWindow,
  RECENT_AUTH_WINDOW_MS,
  recentAuthRefusalBody,
  recentAuthSignInCounts,
  recentAuthSignInProofFromChallengeKind,
  type RecentAuthSignInProof,
} from "@/lib/recent-auth";

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

  it("refuses an emailed-link session with no stamp, and an unknown caller", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "member-1", email: "member@example.com" },
    });
    const emailedLink = await requireRecentAuth();
    expect(emailedLink.ok).toBe(false);
    if (!emailedLink.ok) {
      expect(emailedLink.response.status).toBe(403);
      await expect(emailedLink.response.json()).resolves.toEqual(
        recentAuthRefusalBody(),
      );
    }

    mockAuth.mockResolvedValue(null);
    const anonymous = await requireRecentAuth();
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.response.status).toBe(401);
  });

  it("counts a password only when no authenticator is owed, and an authenticator app always", () => {
    expect(recentAuthSignInCounts("password", false)).toBe(true);
    expect(recentAuthSignInCounts("password", true)).toBe(false);
    expect(recentAuthSignInCounts("TOTP", false)).toBe(true);
    expect(recentAuthSignInCounts("TOTP", true)).toBe(true);
    expect(recentAuthSignInCounts("passkey", false)).toBe(true);
    expect(recentAuthSignInCounts("passkey", true)).toBe(true);
    const never: RecentAuthSignInProof[] = [
      "magic-link",
      "google",
      "email",
      "recovery",
    ];
    for (const proof of never) {
      expect(recentAuthSignInCounts(proof, false)).toBe(false);
      expect(recentAuthSignInCounts(proof, true)).toBe(false);
    }
    expect(recentAuthSignInProofFromChallengeKind("TOTP")).toBe("TOTP");
    expect(recentAuthSignInProofFromChallengeKind("PASSKEY")).toBe("passkey");
    expect(recentAuthSignInProofFromChallengeKind("EMAIL")).toBe("email");
    expect(recentAuthSignInProofFromChallengeKind("RECOVERY")).toBe("recovery");
    expect(recentAuthSignInProofFromChallengeKind(null)).toBeNull();
    expect(recentAuthSignInProofFromChallengeKind("password")).toBeNull();
  });
});
