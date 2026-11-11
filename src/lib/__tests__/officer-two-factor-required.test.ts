import { describe, expect, it } from "vitest";

import { DEFAULT_ACCESS_ROLE_DEFINITIONS } from "@/lib/access-role-definitions";
import { asClubTimeZone } from "@/lib/club-time";
import { OFFICER_SIGN_IN_RELEASE_ENABLED } from "@/lib/officer-sign-in-release";
import {
  officerGraceClosedByReset,
  officerGraceHasEnded,
  officerTwoFactorGraceEnd,
  officerGraceDeadlineDate,
  formatOfficerGraceDeadline,
} from "@/lib/officer-two-factor-grace";
import {
  isOfficerTwoFactorRequired,
  type OfficerTwoFactorAssignment,
} from "@/lib/second-factor-enrolment";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const ZONE = asClubTimeZone("Pacific/Auckland");
const FROZEN_NOW = new Date("2026-07-01T00:00:00.000Z");

function assignment(
  role: string | null,
  requiresTwoFactor: boolean | null,
  financeLevel: string | null,
  supportLevel: string | null,
): OfficerTwoFactorAssignment {
  return { role, requiresTwoFactor, financeLevel, supportLevel };
}

function seeded(systemRole: string): OfficerTwoFactorAssignment {
  const definition = DEFAULT_ACCESS_ROLE_DEFINITIONS.find(
    (row) => row.systemRole === systemRole,
  );
  if (!definition) throw new Error(`no seeded definition for ${systemRole}`);
  return assignment(
    systemRole,
    null,
    definition.financeLevel,
    definition.supportLevel,
  );
}

describe("isOfficerTwoFactorRequired (#4618)", () => {
  it("pins the release constant off until #4620", () => {
    expect(OFFICER_SIGN_IN_RELEASE_ENABLED).toBe(false);
  });

  it("requires a Full Admin whenever the policy and the release are on", () => {
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        assignments: [assignment("ADMIN", false, "NONE", "NONE")],
      }),
    ).toBe(true);
  });

  it("never requires the kiosk, a signed-out member, or a club with the policy off", () => {
    const admin = [assignment("ADMIN", null, null, null)];
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: true,
        assignments: admin,
      }),
    ).toBe(false);
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        canLogin: false,
        assignments: admin,
      }),
    ).toBe(false);
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: false,
        kiosk: false,
        assignments: admin,
      }),
    ).toBe(false);
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: false,
        policyEnabled: true,
        kiosk: false,
        assignments: [seeded("FINANCE_ADMIN")],
      }),
    ).toBe(false);
  });

  it("covers every system role at the seeded Default", () => {
    const required = new Set(["ADMIN", "FINANCE_ADMIN"]);
    const roles = [
      "USER",
      "ADMIN",
      "ADMIN_READONLY",
      "ADMIN_BOOKINGS",
      "ADMIN_MEMBERSHIP",
      "ADMIN_CONTENT",
      "LODGE",
      "FINANCE_USER",
      "FINANCE_ADMIN",
      "ORG",
    ];
    for (const role of roles) {
      const row =
        role === "ADMIN" || role === "LODGE" || role === "USER" || role === "ORG"
          ? assignment(role, null, null, null)
          : seeded(role);
      expect(
        isOfficerTwoFactorRequired({
          releaseEnabled: true,
          policyEnabled: true,
          kiosk: false,
          assignments: [row],
        }),
        role,
      ).toBe(required.has(role));
    }
  });

  it("lets Not required drop only that role", () => {
    const customView = assignment("custom", false, "EDIT", "EDIT");
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        assignments: [customView],
      }),
    ).toBe(false);
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        assignments: [customView, seeded("FINANCE_ADMIN")],
      }),
    ).toBe(true);
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        assignments: [assignment("ADMIN", null, null, null), customView],
      }),
    ).toBe(true);
  });

  it("requires a custom role that is Required, or Default with finance or support edit", () => {
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        assignments: [assignment(null, true, "VIEW", "VIEW")],
      }),
    ).toBe(true);
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        assignments: [assignment("custom", null, "VIEW", "EDIT")],
      }),
    ).toBe(true);
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        assignments: [assignment("custom", null, "EDIT", "VIEW")],
      }),
    ).toBe(true);
    expect(
      isOfficerTwoFactorRequired({
        releaseEnabled: true,
        policyEnabled: true,
        kiosk: false,
        assignments: [assignment("custom", null, "VIEW", "VIEW")],
      }),
    ).toBe(false);
  });

  it("keeps the existing challenge equal to the club-wide module, policy or not", () => {
    function existingChallenge(moduleOn: boolean): boolean {
      return moduleOn === true;
    }
    for (const policy of [true, false]) {
      for (const release of [true, false]) {
        for (const role of ["USER", "FINANCE_ADMIN", "ADMIN"] as const) {
          const officer = isOfficerTwoFactorRequired({
            releaseEnabled: release,
            policyEnabled: policy,
            kiosk: false,
            assignments: [
              role === "FINANCE_ADMIN"
                ? seeded("FINANCE_ADMIN")
                : assignment(role, null, null, null),
            ],
          });
          expect(existingChallenge(true)).toBe(true);
          expect(existingChallenge(false)).toBe(false);
          expect(typeof officer).toBe("boolean");
        }
      }
    }
  });
});

describe("officer grace (#4618)", () => {
  it("ends 14 days later at the next club midnight, naming 16 March", () => {
    const startedAt = new Date("2026-03-01T23:00:00.000Z");
    expect(
      officerGraceDeadlineDate({ startedAt, graceDays: 14, zone: ZONE }),
    ).toBe("2026-03-16");
    const end = officerTwoFactorGraceEnd({ startedAt, graceDays: 14, zone: ZONE });
    expect(officerGraceHasEnded(new Date(end.getTime() - 1000), end)).toBe(false);
    expect(officerGraceHasEnded(end, end)).toBe(true);
    expect(formatOfficerGraceDeadline(end, ZONE, CLUB_FORMAT_TEST)).toContain("16");
  });

  it("gates immediately when grace is 0, and after 60 club days", () => {
    const end0 = officerTwoFactorGraceEnd({
      startedAt: FROZEN_NOW,
      graceDays: 0,
      zone: ZONE,
    });
    expect(end0).toBe(FROZEN_NOW);
    expect(officerGraceDeadlineDate({ startedAt: FROZEN_NOW, graceDays: 0, zone: ZONE })).toBe(
      null,
    );
    expect(officerGraceHasEnded(FROZEN_NOW, end0)).toBe(true);
    expect(officerGraceHasEnded(new Date(FROZEN_NOW.getTime() - 1000), end0)).toBe(false);

    const end60 = officerTwoFactorGraceEnd({
      startedAt: FROZEN_NOW,
      graceDays: 60,
      zone: ZONE,
    });
    expect(
      officerGraceDeadlineDate({ startedAt: FROZEN_NOW, graceDays: 60, zone: ZONE }),
    ).toBe("2026-08-30");
    expect(officerGraceHasEnded(new Date(end60.getTime() - 1000), end60)).toBe(false);
    expect(officerGraceHasEnded(end60, end60)).toBe(true);
  });

  it("does not start another grace period after a reset", () => {
    const started = new Date("2026-03-01T23:00:00.000Z");
    const reset = new Date("2026-06-01T00:00:00.000Z");
    expect(
      officerGraceClosedByReset({ graceStartedAt: started, factorsResetAt: reset }),
    ).toBe(true);
    expect(
      officerGraceClosedByReset({ graceStartedAt: null, factorsResetAt: reset }),
    ).toBe(true);
    expect(
      officerGraceClosedByReset({ graceStartedAt: reset, factorsResetAt: started }),
    ).toBe(false);
    expect(
      officerGraceClosedByReset({ graceStartedAt: null, factorsResetAt: null }),
    ).toBe(false);
  });
});
