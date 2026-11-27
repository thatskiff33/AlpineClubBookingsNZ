/**
 * The combined lock-out walk (#4620 §4 item 4).
 *
 * A required officer in every factor state, with the club-wide `twoFactor`
 * module on and off, can always reach enrolment or verification, and is never
 * refused by both the password-change route and enrolment at once. The claims
 * are built with the release on, as they are once #4620 flips the switch.
 */

import { describe, expect, it } from "vitest";

import { requireClubTimeZone } from "@/lib/club-time";
import { buildOfficerTwoFactorClaims } from "@/lib/officer-two-factor-claims";
import {
  authenticatorEnrolmentBlock,
  isSecondFactorEnrolled,
} from "@/lib/second-factor-enrolment";
import {
  factorGateRedirect,
  isOfficerEnrolmentPathAllowed,
  type TwoFactorSessionUser,
} from "@/lib/two-factor-gate";

const ZONE = requireClubTimeZone("Pacific/Auckland");
const NOW = new Date("2026-07-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 14;
const LONG_AGO = new Date(NOW.getTime() - 30 * DAY_MS);
const AN_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);

type FactorState = {
  name: string;
  twoFactorEnabled: boolean;
  twoFactorMethod: "TOTP" | "EMAIL" | null;
  hasPasskey: boolean;
  graceStartedAt: Date | null;
  factorsResetAt: Date | null;
};

// Every state starts its grace long ago, so an unsatisfied officer is past it.
// An emailed-link, Google or recovery-code sign-in changes only the recent-proof
// stamp, never these claims, so those states share the rows below. "No password
// and no app" is the no-factor row: nothing in the gate reads a password.
const STATES: FactorState[] = [
  { name: "no factor", twoFactorEnabled: false, twoFactorMethod: null, hasPasskey: false, graceStartedAt: LONG_AGO, factorsResetAt: null },
  { name: "emailed code only", twoFactorEnabled: true, twoFactorMethod: "EMAIL", hasPasskey: false, graceStartedAt: LONG_AGO, factorsResetAt: null },
  { name: "authenticator app", twoFactorEnabled: true, twoFactorMethod: "TOTP", hasPasskey: false, graceStartedAt: LONG_AGO, factorsResetAt: null },
  { name: "passkey only", twoFactorEnabled: false, twoFactorMethod: null, hasPasskey: true, graceStartedAt: LONG_AGO, factorsResetAt: null },
  { name: "just reset (in the app or by auth:reset-factors)", twoFactorEnabled: false, twoFactorMethod: null, hasPasskey: false, graceStartedAt: LONG_AGO, factorsResetAt: AN_HOUR_AGO },
  { name: "reset before grace ever started", twoFactorEnabled: false, twoFactorMethod: null, hasPasskey: false, graceStartedAt: null, factorsResetAt: AN_HOUR_AGO },
];

const ENROLMENT_PATHS: Array<[string, string]> = [
  ["/login/enroll", "GET"],
  ["/login/verify", "GET"],
  ["/profile", "GET"],
  ["/api/auth/2fa/status", "GET"],
  ["/api/auth/2fa/totp/setup", "POST"],
  ["/api/auth/2fa/enroll/totp", "POST"],
  ["/api/auth/2fa/webauthn/register/options", "POST"],
  ["/api/auth/2fa/webauthn/register/verify", "POST"],
  ["/api/auth/signout", "POST"],
];

function fullAdminSession(state: FactorState, module: { on: boolean; verified: boolean }) {
  const claims = buildOfficerTwoFactorClaims({
    releaseEnabled: true,
    policyEnabled: true,
    graceDays: GRACE_DAYS,
    kiosk: false,
    canLogin: true,
    assignments: [{ role: "ADMIN" }],
    twoFactorEnabled: state.twoFactorEnabled,
    twoFactorMethod: state.twoFactorMethod,
    hasPasskey: state.hasPasskey,
    graceStartedAt: state.graceStartedAt,
    factorsResetAt: state.factorsResetAt,
    zone: ZONE,
    now: NOW,
  });
  const enrolled = isSecondFactorEnrolled({
    twoFactorEnabled: state.twoFactorEnabled,
    hasPasskey: state.hasPasskey,
  });
  // Mirrors session-refresh: module off verifies at once; module on with
  // nothing enrolled cannot have verified yet.
  const twoFactorVerified = !module.on || (enrolled && module.verified);
  const sessionUser: TwoFactorSessionUser = {
    id: "officer-1",
    twoFactorRequired: module.on,
    twoFactorVerified,
    twoFactorEnrolled: enrolled,
    hasPasskey: state.hasPasskey,
    officerTwoFactorRequired: claims.officerTwoFactorRequired,
    twoFactorSatisfiesOfficer: claims.twoFactorSatisfiesOfficer,
    officerTwoFactorGraceEndsAt: claims.officerTwoFactorGraceEndsAt,
  };
  return { claims, sessionUser };
}

const PHASES = [
  { label: "module off", on: false, verified: true },
  { label: "module on, challenge still owed", on: true, verified: false },
  { label: "module on, challenge passed", on: true, verified: true },
];

describe("officer lock-out walk (#4620)", () => {
  for (const state of STATES) {
    for (const phase of PHASES) {
      describe(`${state.name}, ${phase.label}`, () => {
        const { claims, sessionUser } = fullAdminSession(state, phase);
        const member = {
          twoFactorEnabled: state.twoFactorEnabled,
          forcePasswordChange: false,
        };

        it("is sent somewhere it can make progress from any admin page", () => {
          const destination = factorGateRedirect({
            sessionUser,
            member,
            pathname: "/admin",
            callbackPath: "/admin",
            now: NOW,
          });
          if (destination === null) {
            // Only an officer who already satisfies, or still has grace, passes.
            expect(
              claims.twoFactorSatisfiesOfficer ||
                claims.officerTwoFactorGraceEndsAt === null ||
                claims.officerTwoFactorGraceEndsAt > NOW.getTime(),
            ).toBe(true);
            return;
          }
          expect(destination).toMatch(/^\/login\/(enroll|verify)\?/);
          const target = destination.split("?")[0];
          expect(isOfficerEnrolmentPathAllowed(target, "GET")).toBe(true);
          // The page it lands on is not itself redirected elsewhere.
          const next = factorGateRedirect({
            sessionUser,
            member,
            pathname: target,
            callbackPath: "/admin",
            now: NOW,
          });
          expect(next === null || next.split("?")[0] === target).toBe(true);
        });

        it("reaches every enrolment page and route once any module challenge is passed", () => {
          if (sessionUser.twoFactorRequired && !sessionUser.twoFactorVerified) return;
          for (const [path, method] of ENROLMENT_PATHS) {
            expect(
              factorGateRedirect({ sessionUser, member, pathname: path, method, now: NOW }),
            ).toBeNull();
          }
        });

        it("may enrol an authenticator app whenever it does not yet satisfy the rule", () => {
          if (claims.twoFactorSatisfiesOfficer) return;
          const block = authenticatorEnrolmentBlock({
            twoFactorRequired: sessionUser.twoFactorRequired,
            twoFactorVerified: sessionUser.twoFactorVerified,
            officerTwoFactorRequired: claims.officerTwoFactorRequired,
            twoFactorSatisfiesOfficer: claims.twoFactorSatisfiesOfficer,
            twoFactorEnabled: state.twoFactorEnabled,
            twoFactorMethod: state.twoFactorMethod,
          });
          if (block === null) return;
          // The only refusal is "finish signing in first", and the gate sends
          // that session to the verify page, which is reachable.
          expect(block.status).toBe(403);
          expect(
            factorGateRedirect({ sessionUser, member, pathname: "/profile", now: NOW }),
          ).toMatch(/^\/login\/verify\?/);
        });

        it("can still change a forced password, which enrolment requires first", () => {
          // /api/auth/change-password reads the gate with no pathname.
          expect(
            factorGateRedirect({
              sessionUser,
              member: { ...member, forcePasswordChange: true },
              allowForcePasswordChange: true,
              pathname: null,
              callbackPath: null,
              now: NOW,
            }),
          ).toBeNull();
        });
      });
    }
  }

  it("still refuses a gated officer elsewhere while a password change is pending", () => {
    const { sessionUser } = fullAdminSession(STATES[0], PHASES[0]);
    expect(
      factorGateRedirect({
        sessionUser,
        member: { twoFactorEnabled: false, forcePasswordChange: true },
        pathname: null,
        callbackPath: null,
        now: NOW,
      }),
    ).toMatch(/^\/login\/enroll\?/);
  });

  it("gates a past-grace officer with no factor (the walk is not vacuous)", () => {
    const { claims, sessionUser } = fullAdminSession(STATES[0], PHASES[0]);
    expect(claims.officerTwoFactorRequired).toBe(true);
    expect(
      factorGateRedirect({ sessionUser, pathname: "/admin", callbackPath: "/admin", now: NOW }),
    ).toBe("/login/enroll?callbackUrl=%2Fadmin");
  });
});
