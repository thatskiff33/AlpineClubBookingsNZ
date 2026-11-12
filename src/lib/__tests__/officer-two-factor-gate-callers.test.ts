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
  // Every guard that once called the club-wide check now calls the combined
  // gate. A direct call elsewhere would skip the officer rule.
  const GATE_CALLERS = [
    "src/app/(authenticated)/layout.tsx",
    "src/app/(lodge)/layout.tsx",
    "src/app/api/finance/legacy-dashboard/auth/route.ts",
    "src/lib/admin-layout-guard.ts",
    "src/lib/finance-api-auth.ts",
    "src/lib/finance-auth.ts",
    "src/lib/session-guards.ts",
  ];

  it("calls the club-wide check only through the combined gate", () => {
    const direct: string[] = [];
    const combined: string[] = [];
    for (const file of walk(join(process.cwd(), "src"))) {
      if (file.endsWith(`${join("lib", "two-factor-gate.ts")}`)) continue;
      const source = readFileSync(file, "utf8");
      const relative = file.slice(process.cwd().length + 1).split("\\").join("/");
      if (source.includes("isTwoFactorSessionBlocked(")) direct.push(relative);
      if (source.includes("factorGateRedirect(")) combined.push(relative);
    }
    expect(direct).toEqual([]);
    expect(combined.sort()).toEqual([...GATE_CALLERS].sort());
  });

  it("refuses a gated officer whatever path the request claims, with no path", () => {
    const gated = {
      officerTwoFactorRequired: true,
      twoFactorSatisfiesOfficer: false,
      officerTwoFactorGraceEndsAt: Date.parse("2026-07-01T00:00:00.000Z"),
    };
    expect(
      factorGateRedirect({
        sessionUser: gated,
        now: new Date("2026-07-01T00:00:01.000Z"),
      }),
    ).not.toBeNull();
  });

  it("never lets an API guard pass a caller-supplied path to the gate", () => {
    for (const file of ["src/lib/session-guards.ts", "src/lib/finance-api-auth.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const calls = source.split("factorGateRedirect(").slice(1);
      for (const call of calls) {
        const args = call.slice(0, call.indexOf(")"));
        expect(args, file).not.toMatch(/pathname,|pathname:\s*pathname|method,/);
      }
    }
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

  it("refuses to replace an enrolled factor before the module challenge is passed", () => {
    expect(
      authenticatorEnrolmentBlock({
        twoFactorRequired: true,
        twoFactorVerified: false,
        officerTwoFactorRequired: true,
        twoFactorSatisfiesOfficer: false,
        twoFactorEnabled: true,
        twoFactorMethod: "EMAIL",
      })?.status,
    ).toBe(403);
    // Not yet enrolled: the module asks them to enrol, so they may.
    expect(
      authenticatorEnrolmentBlock({
        twoFactorRequired: true,
        twoFactorVerified: false,
        officerTwoFactorRequired: true,
        twoFactorSatisfiesOfficer: false,
        twoFactorEnabled: false,
        twoFactorMethod: null,
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
