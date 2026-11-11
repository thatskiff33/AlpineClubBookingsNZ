import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { authenticatorEnrolmentBlock } from "@/lib/second-factor-enrolment";
import { factorGateRedirect } from "@/lib/two-factor-gate";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") return [];
      return walk(path);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("officer enrolment gate callers (#4618)", () => {
  it("consults the officer gate wherever the club-wide challenge is consulted", () => {
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), "src"))) {
      if (file.endsWith(`${join("lib", "two-factor-gate.ts")}`)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("isTwoFactorSessionBlocked(")) continue;
      if (
        source.includes("factorGateRedirect(") ||
        source.includes("isOfficerEnrolmentSessionBlocked(")
      ) {
        continue;
      }
      offenders.push(file.slice(process.cwd().length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it("lets a gated officer through an enrolment path and nowhere else", () => {
    const gated = {
      officerTwoFactorRequired: true,
      twoFactorSatisfiesOfficer: false,
      officerTwoFactorGraceEndsAt: Date.parse("2026-07-01T00:00:00.000Z"),
      twoFactorRequired: false,
      twoFactorVerified: true,
    };
    const now = new Date("2026-07-01T00:00:01.000Z");
    expect(
      factorGateRedirect({
        sessionUser: gated,
        pathname: "/profile",
        now,
      }),
    ).toBeNull();
    expect(
      factorGateRedirect({
        sessionUser: gated,
        pathname: "/api/auth/2fa/webauthn/register/verify",
        method: "POST",
        now,
      }),
    ).toBeNull();
    expect(
      factorGateRedirect({
        sessionUser: gated,
        pathname: "/dashboard",
        callbackPath: "/dashboard",
        now,
      }),
    ).toBe("/login/enroll?callbackUrl=%2Fdashboard");
  });

  it("still sends a module challenge to verify, including on an enrolment path", () => {
    expect(
      factorGateRedirect({
        sessionUser: {
          twoFactorRequired: true,
          twoFactorVerified: false,
          twoFactorEnrolled: true,
        },
        member: { twoFactorEnabled: true },
        pathname: "/profile",
        callbackPath: "/profile",
      }),
    ).toBe("/login/verify?callbackUrl=%2Fprofile");
  });
});

describe("authenticator enrolment for a required officer (#4618)", () => {
  it("allows a required officer who is not already on the app, module off", () => {
    expect(
      authenticatorEnrolmentBlock({
        twoFactorRequired: false,
        twoFactorVerified: true,
        officerTwoFactorRequired: true,
        twoFactorSatisfiesOfficer: false,
        twoFactorEnabled: true,
        twoFactorMethod: "EMAIL",
      }),
    ).toBeNull();
  });

  it("refuses an officer who is already on the app", () => {
    expect(
      authenticatorEnrolmentBlock({
        twoFactorRequired: false,
        officerTwoFactorRequired: true,
        twoFactorSatisfiesOfficer: true,
        twoFactorEnabled: true,
        twoFactorMethod: "TOTP",
      })?.status,
    ).toBe(409);
  });

  it("keeps today's refusal for a member the officer rule does not require", () => {
    expect(
      authenticatorEnrolmentBlock({
        twoFactorRequired: true,
        twoFactorVerified: false,
        twoFactorEnabled: true,
        twoFactorMethod: "TOTP",
      })?.status,
    ).toBe(409);
    expect(
      authenticatorEnrolmentBlock({
        twoFactorRequired: false,
        twoFactorEnabled: true,
        twoFactorMethod: "TOTP",
      })?.status,
    ).toBe(400);
  });
});

describe("the factor reset route (#4618)", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "src/app/api/admin/security/two-factor-reset/[memberId]/route.ts",
    ),
    "utf8",
  );

  it("refuses without a fresh proof", () => {
    expect(source).toContain("requireRecentAuth(");
  });

  it("refuses a reset of the caller", () => {
    expect(source).toContain("memberId === guard.session.user.id");
  });
});
