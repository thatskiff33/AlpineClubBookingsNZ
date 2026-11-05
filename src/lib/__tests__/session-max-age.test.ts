/**
 * #4611 (INV-AUTH-007): the maximum session age rule, as a pure function.
 * The end-to-end proof through the Auth.js handler is
 * `auth-session-max-age.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  KIOSK_SESSION_MAX_AGE_HOURS,
  SESSION_MAX_AGE_DEFAULT_HOURS,
  SESSION_MAX_AGE_MAX_HOURS,
  SESSION_MAX_AGE_MIN_HOURS,
  isSessionPastMaxAge,
  readTokenSessionIssuedAtMs,
  sessionMaxAgeHoursFor,
} from "@/lib/session-max-age";
import {
  DEFAULT_LOGIN_SECURITY_POLICY,
  normalizeLoginSecurityPolicy,
} from "@/lib/password-policy";
import { getTokenSessionIssuedAtMs } from "@/lib/session-member-security";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";

const HOUR_MS = 60 * 60 * 1000;
const ORDINARY = { kioskAccount: false, clubSessionMaxAgeHours: 168 };
const KIOSK = { kioskAccount: true, clubSessionMaxAgeHours: 168 };

describe("the maximum session age (#4611)", () => {
  it("has the settled bounds and defaults: 8 hours to 30 days, 7 days by default, kiosk 30 days", () => {
    expect(SESSION_MAX_AGE_MIN_HOURS).toBe(8);
    expect(SESSION_MAX_AGE_MAX_HOURS).toBe(30 * 24);
    expect(SESSION_MAX_AGE_DEFAULT_HOURS).toBe(7 * 24);
    expect(KIOSK_SESSION_MAX_AGE_HOURS).toBe(30 * 24);
    expect(DEFAULT_LOGIN_SECURITY_POLICY.sessionMaxAgeHours).toBe(
      SESSION_MAX_AGE_DEFAULT_HOURS,
    );
  });

  it("ends a session at the limit, and one millisecond before it is still live", () => {
    const issuedAt = frozenTestNow().getTime();
    const token = { sessionIssuedAt: issuedAt };
    expect(isSessionPastMaxAge(token, ORDINARY, issuedAt + 168 * HOUR_MS - 1)).toBe(
      false,
    );
    expect(isSessionPastMaxAge(token, ORDINARY, issuedAt + 168 * HOUR_MS)).toBe(true);
    expect(isSessionPastMaxAge(token, ORDINARY, issuedAt + 400 * HOUR_MS)).toBe(true);
  });

  it("measures from sessionIssuedAt, never from iat, which every refresh renews", () => {
    const issuedAt = frozenTestNow().getTime();
    const now = issuedAt + 168 * HOUR_MS;
    // A token refreshed a minute ago carries a fresh iat; its session is still
    // seven days old.
    const token = {
      sessionIssuedAt: issuedAt,
      iat: Math.floor((now - 60_000) / 1000),
    };
    expect(isSessionPastMaxAge(token, ORDINARY, now)).toBe(true);
  });

  it.each([
    ["absent", {}],
    ["undefined", { sessionIssuedAt: undefined }],
    ["a string", { sessionIssuedAt: "1782864000000" }],
    ["NaN", { sessionIssuedAt: Number.NaN }],
    ["infinite", { sessionIssuedAt: Number.POSITIVE_INFINITY }],
    ["null", { sessionIssuedAt: null }],
  ])(
    "treats a token whose sessionIssuedAt is %s as expired, even with a fresh iat",
    (_label, claims) => {
      const now = frozenTestNow().getTime();
      const token = { ...claims, iat: Math.floor(now / 1000) };
      expect(readTokenSessionIssuedAtMs(token)).toBeNull();
      expect(isSessionPastMaxAge(token, ORDINARY, now)).toBe(true);
      expect(isSessionPastMaxAge(token, KIOSK, now)).toBe(true);
    },
  );

  it("treats a session as expired when the limit is not a finite number", () => {
    const now = frozenTestNow().getTime();
    expect(
      isSessionPastMaxAge(
        { sessionIssuedAt: now },
        { kioskAccount: false, clubSessionMaxAgeHours: Number.NaN },
        now,
      ),
    ).toBe(true);
  });

  it.each([
    [SESSION_MAX_AGE_MIN_HOURS],
    [SESSION_MAX_AGE_DEFAULT_HOURS],
    [SESSION_MAX_AGE_MAX_HOURS],
  ])(
    "gives the kiosk 30 days whatever the club sets (club %i hours)",
    (clubSessionMaxAgeHours) => {
      expect(
        sessionMaxAgeHoursFor({ kioskAccount: true, clubSessionMaxAgeHours }),
      ).toBe(KIOSK_SESSION_MAX_AGE_HOURS);
      expect(
        sessionMaxAgeHoursFor({ kioskAccount: false, clubSessionMaxAgeHours }),
      ).toBe(clubSessionMaxAgeHours);

      const issuedAt = frozenTestNow().getTime();
      const token = { sessionIssuedAt: issuedAt };
      const kiosk = { kioskAccount: true, clubSessionMaxAgeHours };
      expect(isSessionPastMaxAge(token, kiosk, issuedAt + 720 * HOUR_MS - 1)).toBe(
        false,
      );
      expect(isSessionPastMaxAge(token, kiosk, issuedAt + 720 * HOUR_MS)).toBe(true);
    },
  );

  it("shares its stamp parse with the revocation rules' reader, which alone falls back", () => {
    const now = frozenTestNow().getTime();
    expect(getTokenSessionIssuedAtMs({ sessionIssuedAt: 123 })).toBe(123);
    // The revocation reader keeps its iat fallback; the cap never takes it.
    expect(getTokenSessionIssuedAtMs({ iat: now / 1000 })).toBe(now);
    expect(readTokenSessionIssuedAtMs({ iat: now / 1000 })).toBeNull();
  });
});

describe("normalizeLoginSecurityPolicy: sessionMaxAgeHours (#4611)", () => {
  it("reads an absent row or value as the 7-day default", () => {
    expect(normalizeLoginSecurityPolicy(null).sessionMaxAgeHours).toBe(168);
    expect(normalizeLoginSecurityPolicy({}).sessionMaxAgeHours).toBe(168);
  });

  it.each([
    [7, 8],
    [8, 8],
    [24, 24],
    [720, 720],
    [721, 720],
    [-5, 8],
    [Number.NaN, 168],
    [12.7, 12],
  ])("clamps a stored %s into 8..720 as %i", (stored, effective) => {
    expect(
      normalizeLoginSecurityPolicy({ sessionMaxAgeHours: stored }).sessionMaxAgeHours,
    ).toBe(effective);
  });
});
