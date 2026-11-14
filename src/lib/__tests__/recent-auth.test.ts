import { afterEach, describe, expect, it, vi } from "vitest";

import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  isWithinRecentAuthWindow,
  passwordSignInOwesStrongerFactor,
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

  // #4618 review: a passkey-only required officer must not get a password
  // stamp, or a phished password reaches every step-up route for five minutes.
  it("owes a required officer's app or passkey, and the module's app, never an emailed code", () => {
    const passkeyOnly = { twoFactorEnabled: false, twoFactorMethod: null, hasPasskey: true };
    const app = { twoFactorEnabled: true, twoFactorMethod: "TOTP", hasPasskey: false };
    const emailOnly = { twoFactorEnabled: true, twoFactorMethod: "EMAIL", hasPasskey: false };
    const none = { twoFactorEnabled: false, twoFactorMethod: null, hasPasskey: false };
    const owes = (
      // The production parameter's own factor fields: `twoFactorMethod` is a
      // nullable column, so `typeof app` (method: string) was too narrow.
      factors: Omit<
        Parameters<typeof passwordSignInOwesStrongerFactor>[0],
        "moduleRequired" | "officerRequired"
      >,
      moduleRequired: boolean,
      officerRequired: boolean,
    ) => passwordSignInOwesStrongerFactor({ moduleRequired, officerRequired, ...factors });

    // A required officer owes either strong factor, module on or off.
    expect(owes(passkeyOnly, false, true)).toBe(true);
    expect(owes(app, false, true)).toBe(true);
    expect(owes({ ...emailOnly, hasPasskey: true }, false, true)).toBe(true);
    // The club-wide module alone owes an app, as before this change.
    expect(owes(app, true, false)).toBe(true);
    expect(owes(passkeyOnly, true, false)).toBe(false);
    // Nothing required, an emailed code, or no factor: nothing owed.
    expect(owes(app, false, false)).toBe(false);
    expect(owes(passkeyOnly, false, false)).toBe(false);
    expect(owes(emailOnly, true, true)).toBe(false);
    expect(owes(none, true, true)).toBe(false);
  });
});
