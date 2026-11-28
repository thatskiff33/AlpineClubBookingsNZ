import { describe, expect, it } from "vitest";
import {
  buildTwoFactorGatePath,
  isOfficerInGrace,
  isOfficerSessionGated,
  isTwoFactorSessionBlocked,
} from "@/lib/two-factor-gate";

describe("two-factor route gate", () => {
  it("blocks sessions that require 2FA but have not verified", () => {
    expect(
      isTwoFactorSessionBlocked({
        sessionUser: {
          twoFactorRequired: true,
          twoFactorVerified: false,
        },
        member: { twoFactorEnabled: true },
      }),
    ).toBe(true);
  });

  it("allows sessions when 2FA is not required or already verified", () => {
    expect(
      isTwoFactorSessionBlocked({
        sessionUser: {
          twoFactorRequired: false,
          twoFactorVerified: false,
        },
        member: { twoFactorEnabled: false },
      }),
    ).toBe(false);

    expect(
      isTwoFactorSessionBlocked({
        sessionUser: {
          twoFactorRequired: true,
          twoFactorVerified: true,
        },
        member: { twoFactorEnabled: true },
      }),
    ).toBe(false);
  });

  it("lets forced-password-change sessions reach the password change path", () => {
    expect(
      isTwoFactorSessionBlocked({
        allowForcePasswordChange: true,
        sessionUser: {
          twoFactorRequired: true,
          twoFactorVerified: false,
        },
        member: {
          forcePasswordChange: true,
          twoFactorEnabled: false,
        },
      }),
    ).toBe(false);
  });

  it("routes unenrolled users to enroll and enrolled users to verify", () => {
    expect(
      buildTwoFactorGatePath({
        sessionUser: { twoFactorEnrolled: false },
        member: { twoFactorEnabled: false },
        callbackPath: "/admin/dashboard",
      }),
    ).toBe("/login/enroll?callbackUrl=%2Fadmin%2Fdashboard");

    expect(
      buildTwoFactorGatePath({
        sessionUser: { twoFactorEnrolled: true },
        member: { twoFactorEnabled: true },
        callbackPath: "/bookings",
      }),
    ).toBe("/login/verify?callbackUrl=%2Fbookings");
  });

  describe("an officer inside grace (#4618, #4620)", () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    const later = now.getTime() + 60_000;
    const earlier = now.getTime() - 60_000;
    const cases = [
      { name: "required, not satisfied, deadline ahead", user: { officerTwoFactorRequired: true, twoFactorSatisfiesOfficer: false, officerTwoFactorGraceEndsAt: later }, inGrace: true, gated: false },
      { name: "required, not satisfied, deadline passed", user: { officerTwoFactorRequired: true, twoFactorSatisfiesOfficer: false, officerTwoFactorGraceEndsAt: earlier }, inGrace: false, gated: true },
      { name: "required, not satisfied, deadline is this instant", user: { officerTwoFactorRequired: true, twoFactorSatisfiesOfficer: false, officerTwoFactorGraceEndsAt: now.getTime() }, inGrace: false, gated: true },
      { name: "required and satisfied", user: { officerTwoFactorRequired: true, twoFactorSatisfiesOfficer: true, officerTwoFactorGraceEndsAt: null }, inGrace: false, gated: false },
      { name: "required, grace not started", user: { officerTwoFactorRequired: true, twoFactorSatisfiesOfficer: false, officerTwoFactorGraceEndsAt: null }, inGrace: false, gated: false },
      { name: "not required", user: { officerTwoFactorRequired: false, twoFactorSatisfiesOfficer: false, officerTwoFactorGraceEndsAt: later }, inGrace: false, gated: false },
      { name: "no officer claims at all", user: {}, inGrace: false, gated: false },
    ];

    for (const { name, user, inGrace, gated } of cases) {
      it(`${name}: reminded ${inGrace}, stopped ${gated}`, () => {
        expect(isOfficerInGrace(user, now)).toBe(inGrace);
        expect(isOfficerSessionGated(user, now)).toBe(gated);
      });
    }

    it("is never both reminded and stopped, and has no session to read", () => {
      for (const { user } of cases) {
        expect(isOfficerInGrace(user, now) && isOfficerSessionGated(user, now)).toBe(false);
      }
      expect(isOfficerInGrace(null, now)).toBe(false);
    });
  });
});
