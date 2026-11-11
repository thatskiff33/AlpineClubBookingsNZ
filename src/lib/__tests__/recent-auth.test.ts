import { afterEach, describe, expect, it, vi } from "vitest";

import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  isWithinRecentAuthWindow,
  RECENT_AUTH_WINDOW_MS,
  recentAuthSignInCounts,
  recentAuthSignInProofFromChallengeKind,
  type RecentAuthSignInProof,
} from "@/lib/recent-auth";

const mockAuth = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

import { OFFICER_SIGN_IN_ENFORCED } from "@/lib/officer-sign-in-switch";
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

  it("does not read the session while officer sign-in is off", async () => {
    expect(OFFICER_SIGN_IN_ENFORCED).toBe(false);
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    expect((await requireRecentAuth()).ok).toBe(true);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("counts a password only when no authenticator is owed, and an authenticator app always", () => {
    expect(recentAuthSignInCounts("password", false)).toBe(true);
    expect(recentAuthSignInCounts("password", true)).toBe(false);
    expect(recentAuthSignInCounts("TOTP", false)).toBe(true);
    expect(recentAuthSignInCounts("TOTP", true)).toBe(true);
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
    expect(recentAuthSignInProofFromChallengeKind("EMAIL")).toBe("email");
    expect(recentAuthSignInProofFromChallengeKind("RECOVERY")).toBe("recovery");
    expect(recentAuthSignInProofFromChallengeKind(null)).toBeNull();
    expect(recentAuthSignInProofFromChallengeKind("password")).toBeNull();
  });
});
