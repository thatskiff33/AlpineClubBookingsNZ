import { describe, expect, it } from "vitest";

import {
  isSecondFactorEnrolled,
  satisfiesOfficerSecondFactor,
} from "@/lib/second-factor-enrolment";
import { buildTwoFactorGatePath } from "@/lib/two-factor-gate";

describe("second-factor enrolment (#4617)", () => {
  it("is enrolled when any of the flag, a passkey or the session says so", () => {
    expect(
      isSecondFactorEnrolled({
        twoFactorEnabled: false,
        hasPasskey: false,
        sessionEnrolled: false,
      }),
    ).toBe(false);
    expect(isSecondFactorEnrolled({ twoFactorEnabled: true })).toBe(true);
    expect(isSecondFactorEnrolled({ hasPasskey: true })).toBe(true);
    expect(isSecondFactorEnrolled({ sessionEnrolled: true })).toBe(true);
  });

  it("accepts a passkey or an authenticator app, and never email, as an officer factor", () => {
    expect(satisfiesOfficerSecondFactor({ hasPasskey: true })).toBe(true);
    expect(
      satisfiesOfficerSecondFactor({
        twoFactorEnabled: true,
        twoFactorMethod: "TOTP",
      }),
    ).toBe(true);
    expect(
      satisfiesOfficerSecondFactor({
        twoFactorEnabled: true,
        twoFactorMethod: "EMAIL",
      }),
    ).toBe(false);
    expect(
      satisfiesOfficerSecondFactor({
        twoFactorEnabled: false,
        twoFactorMethod: "EMAIL",
        hasPasskey: false,
      }),
    ).toBe(false);
  });

  it("sends a passkey-only member to verify; the flag alone would send them to enrol", () => {
    const passkeyOnly = {
      twoFactorEnabled: false,
      hasPasskey: true,
      sessionEnrolled: false,
    };
    expect(isSecondFactorEnrolled(passkeyOnly)).toBe(true);
    // The predicate this change replaces: the flag, and nothing else.
    const flagAlone = passkeyOnly.twoFactorEnabled ? "/login/verify" : "/login/enroll";
    expect(flagAlone).toBe("/login/enroll");
    expect(
      buildTwoFactorGatePath({
        sessionUser: { twoFactorEnrolled: false, hasPasskey: true },
        member: { twoFactorEnabled: false },
        callbackPath: "/dashboard",
      }),
    ).toBe("/login/verify?callbackUrl=%2Fdashboard");
  });
});
