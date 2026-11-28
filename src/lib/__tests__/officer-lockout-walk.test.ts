/**
 * The combined lock-out walk (#4620 §4 item 4).
 *
 * A required officer in every factor state, with the club-wide `twoFactor`
 * module on and off, is always sent to the enrolment or the verification
 * page, both of which the gate lets them open, and the officer gate never
 * refuses a forced password change that enrolment is waiting on. The claims
 * are built with the release on, as they are once officer sign-in is switched
 * on.
 *
 * This walks the gate's decisions: where it sends the officer and what it
 * lets them open. It does not run the pages or routes behind those paths. The
 * route guard, the enrol page and the signed-in layout each have their own
 * case for the same officer: `session-guards.test.ts`,
 * `two-factor-detour-landing.test.tsx` and
 * `authenticated-layout-officer-gated-onboarding.test.tsx`.
 *
 * Two states the gate alone cannot open:
 *
 * - An officer with no password who is being forced to change it. The change
 *   route asks for the current password, so their way through is "Forgot
 *   password", which sets one and clears the flag.
 * - `twoFactorEnabled` on with no method stored, while the club-wide module
 *   is on. The gate sends them to verify, and the verify route answers 409
 *   because there is nothing to verify against. No writer in the app leaves a
 *   member like that; the way out is a factor reset. Pinned at the bottom.
 */

import { describe, expect, it } from "vitest";

import { requireClubTimeZone } from "@/lib/club-time";
import { buildOfficerTwoFactorClaims } from "@/lib/officer-two-factor-claims";
import {
  authenticatorEnrolmentBlock,
  isSecondFactorEnrolled,
  PROFILE_SECURITY_HREF,
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

const IN_GRACE: FactorState = { name: "no factor, still inside grace", twoFactorEnabled: false, twoFactorMethod: null, hasPasskey: false, graceStartedAt: AN_HOUR_AGO, factorsResetAt: null };

// Every other state starts its grace long ago, so an unsatisfied officer is past it.
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
  { name: "flag on with no method stored", twoFactorEnabled: true, twoFactorMethod: null, hasPasskey: false, graceStartedAt: LONG_AGO, factorsResetAt: null },
  { name: "authenticator app switched off, method left behind", twoFactorEnabled: false, twoFactorMethod: "TOTP", hasPasskey: false, graceStartedAt: LONG_AGO, factorsResetAt: null },
  IN_GRACE,
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
  const sessionUser: TwoFactorSessionUser = {
    id: "officer-1",
    twoFactorRequired: module.on,
    twoFactorVerified: module.verified,
    twoFactorEnrolled: enrolled,
    hasPasskey: state.hasPasskey,
    officerTwoFactorRequired: claims.officerTwoFactorRequired,
    twoFactorSatisfiesOfficer: claims.twoFactorSatisfiesOfficer,
    officerTwoFactorGraceEndsAt: claims.officerTwoFactorGraceEndsAt,
  };
  return { claims, sessionUser };
}

// Both answers to "has this session passed the module challenge", module on
// and off. That is more than sign-in can produce (nobody passes a challenge
// with nothing enrolled), and deliberately so: the walk holds for every
// session, without restating how the session refresh sets that claim.
const PHASES = [
  { label: "module off", on: false, verified: true },
  { label: "module off, session not marked verified", on: false, verified: false },
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

        it("is sent to an enrolment or verification page it may open, from any admin page", () => {
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

  it("does not exempt the password-change route when no change is pending", () => {
    const { sessionUser } = fullAdminSession(STATES[0], PHASES[0]);
    expect(
      factorGateRedirect({
        sessionUser,
        member: { twoFactorEnabled: false, forcePasswordChange: false },
        allowForcePasswordChange: true,
        pathname: null,
        callbackPath: null,
        now: NOW,
      }),
    ).toMatch(/^\/login\/enroll\?/);
  });

  it("lets an officer still inside grace through to the page they asked for", () => {
    const { claims, sessionUser } = fullAdminSession(IN_GRACE, PHASES[0]);
    expect(claims.officerTwoFactorRequired).toBe(true);
    expect(claims.twoFactorSatisfiesOfficer).toBe(false);
    expect(claims.officerTwoFactorGraceEndsAt).toBeGreaterThan(NOW.getTime());
    expect(
      factorGateRedirect({ sessionUser, pathname: "/admin", callbackPath: "/admin", now: NOW }),
    ).toBeNull();
  });

  it("keeps the profile security link on the gated officer's allowlist", () => {
    // The grace banner and the enrol page both link here to add a passkey.
    const path = PROFILE_SECURITY_HREF.split("#")[0];
    expect(isOfficerEnrolmentPathAllowed(path, "GET")).toBe(true);
    const { sessionUser } = fullAdminSession(STATES[0], PHASES[0]);
    expect(factorGateRedirect({ sessionUser, pathname: path, now: NOW })).toBeNull();
  });

  it("sends the flag-without-a-method officer to verify while the module is on", () => {
    // The header's second exception: the gate's answer is pinned here so a
    // change to it is seen. The verify route's 409 for this member is in
    // `two-factor-routes.test.ts`.
    const state = STATES.find((entry) => entry.name === "flag on with no method stored");
    expect(state).toBeDefined();
    if (!state) return;
    const { claims, sessionUser } = fullAdminSession(state, PHASES[2]);
    expect(claims.twoFactorSatisfiesOfficer).toBe(false);
    expect(
      factorGateRedirect({
        sessionUser,
        member: { twoFactorEnabled: true, forcePasswordChange: false },
        pathname: "/admin",
        callbackPath: "/admin",
        now: NOW,
      }),
    ).toBe("/login/verify?callbackUrl=%2Fadmin");
  });

  it("gates a past-grace officer with no factor (the walk is not vacuous)", () => {
    const { claims, sessionUser } = fullAdminSession(STATES[0], PHASES[0]);
    expect(claims.officerTwoFactorRequired).toBe(true);
    expect(
      factorGateRedirect({ sessionUser, pathname: "/admin", callbackPath: "/admin", now: NOW }),
    ).toBe("/login/enroll?callbackUrl=%2Fadmin");
  });
});
