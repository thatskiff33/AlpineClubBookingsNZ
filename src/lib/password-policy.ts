import { z } from "zod";
import {
  MAGIC_LINK_TTL_MAX_MINUTES,
  MAGIC_LINK_TTL_MIN_MINUTES,
} from "@/lib/magic-link";
import {
  SESSION_MAX_AGE_DEFAULT_HOURS,
  SESSION_MAX_AGE_MAX_HOURS,
  SESSION_MAX_AGE_MIN_HOURS,
} from "@/lib/session-max-age";

// Shared password-policy validator + hints (epic #2030, child #2033).
//
// This module is deliberately PRISMA-FREE so it can be imported from any
// surface (server routes, the public policy-hints endpoint, and tests). The
// database-backed loader that reads the club's configured policy lives in
// src/lib/login-security-settings.ts and imports from here — not the other way
// round.
//
// The policy governs USER-CHOSEN passwords only (reset-password /
// change-password). It is enforced at SET time; existing hashes are never
// re-validated. buildPasswordSchema() always applies the hard 128-character
// ceiling regardless of configuration (a DoS / bcrypt-input bound), and layers
// the configured minimum length + optional character-class requirements on top.

/** The effective password/login policy (either configured or the code default). */
export interface LoginSecurityPolicy {
  minPasswordLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  magicLinkTtlMinutes: number;
  /**
   * #4610: refuse a chosen password that the public breached-password range
   * service already lists. Club setting, default on (INV-AUTH-006). Applied by
   * `screenChosenPassword` in `@/lib/breached-password`, never by the zod
   * schema below, because it needs a network call.
   */
  breachedPasswordCheck: boolean;
  /**
   * #4611: the most hours a signed-in session lasts from sign-in, however
   * active (INV-AUTH-007). Club setting, default 7 days, 8 hours to 30 days;
   * the lodge kiosk account keeps its own ceiling (`@/lib/session-max-age`).
   */
  sessionMaxAgeHours: number;
}

/**
 * Code default = today's behaviour. An un-configured club (no
 * LoginSecuritySetting row) resolves to exactly this, so both password routes
 * behave byte-identically to the historical inline `min(12).max(128)`.
 */
export const DEFAULT_LOGIN_SECURITY_POLICY: LoginSecurityPolicy = {
  minPasswordLength: 12,
  requireUppercase: false,
  requireLowercase: false,
  requireDigit: false,
  requireSymbol: false,
  magicLinkTtlMinutes: 15,
  breachedPasswordCheck: true,
  sessionMaxAgeHours: SESSION_MAX_AGE_DEFAULT_HOURS,
};

// Configurable minimum-length bounds (owner-locked on the epic): admins may set
// 8–64; the code default is 12.
export const MIN_PASSWORD_LENGTH_FLOOR = 8;
export const MIN_PASSWORD_LENGTH_CEILING = 64;

// Non-configurable hard maximum applied to every user-chosen password. Bounds
// the bcrypt input and blocks a long-string CPU DoS; independent of settings.
export const PASSWORD_MAX_LENGTH = 128;

// Magic-link TTL bounds are owned by `@/lib/magic-link` (the module named for
// the feature and imported by the client card). #2103 collapsed the duplicate
// that used to be defined here; this module now imports the single canonical
// pair (used below by normalizeLoginSecurityPolicy).

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Coerce a partial/absent record (or out-of-range persisted values) into a safe
 * effective policy. Missing fields fall back to the code default; the minimum
 * length is clamped to [8, 64], the magic-link TTL to [5, 60] and the session
 * maximum age to [8, 720] hours, so a stray value can never widen or break the
 * validator or the session cap.
 */
export function normalizeLoginSecurityPolicy(
  record?: Partial<LoginSecurityPolicy> | null,
): LoginSecurityPolicy {
  return {
    minPasswordLength: clampInt(
      record?.minPasswordLength ?? DEFAULT_LOGIN_SECURITY_POLICY.minPasswordLength,
      MIN_PASSWORD_LENGTH_FLOOR,
      MIN_PASSWORD_LENGTH_CEILING,
      DEFAULT_LOGIN_SECURITY_POLICY.minPasswordLength,
    ),
    requireUppercase:
      record?.requireUppercase ?? DEFAULT_LOGIN_SECURITY_POLICY.requireUppercase,
    requireLowercase:
      record?.requireLowercase ?? DEFAULT_LOGIN_SECURITY_POLICY.requireLowercase,
    requireDigit: record?.requireDigit ?? DEFAULT_LOGIN_SECURITY_POLICY.requireDigit,
    requireSymbol:
      record?.requireSymbol ?? DEFAULT_LOGIN_SECURITY_POLICY.requireSymbol,
    magicLinkTtlMinutes: clampInt(
      record?.magicLinkTtlMinutes ?? DEFAULT_LOGIN_SECURITY_POLICY.magicLinkTtlMinutes,
      MAGIC_LINK_TTL_MIN_MINUTES,
      MAGIC_LINK_TTL_MAX_MINUTES,
      DEFAULT_LOGIN_SECURITY_POLICY.magicLinkTtlMinutes,
    ),
    breachedPasswordCheck:
      record?.breachedPasswordCheck ?? DEFAULT_LOGIN_SECURITY_POLICY.breachedPasswordCheck,
    sessionMaxAgeHours: clampInt(
      record?.sessionMaxAgeHours ?? DEFAULT_LOGIN_SECURITY_POLICY.sessionMaxAgeHours,
      SESSION_MAX_AGE_MIN_HOURS,
      SESSION_MAX_AGE_MAX_HOURS,
      DEFAULT_LOGIN_SECURITY_POLICY.sessionMaxAgeHours,
    ),
  };
}

/**
 * A zod schema for a user-chosen password under `policy`. Always enforces the
 * hard 128-character ceiling; then the configured minimum length and any
 * required character classes. All violations are reported together (superRefine)
 * so the member sees every rule they still fail. With the default policy (min
 * 12, classes off) this is behaviourally identical to `min(12).max(128)`.
 */
export function buildPasswordSchema(policy: LoginSecurityPolicy) {
  const min = policy.minPasswordLength;
  return z
    .string()
    .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
    .superRefine((value, ctx) => {
      if (value.length < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Password must be at least ${min} characters`,
        });
      }
      if (policy.requireUppercase && !/[A-Z]/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Password must include an uppercase letter",
        });
      }
      if (policy.requireLowercase && !/[a-z]/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Password must include a lowercase letter",
        });
      }
      if (policy.requireDigit && !/[0-9]/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Password must include a number",
        });
      }
      if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Password must include a symbol",
        });
      }
    });
}

/**
 * Human-readable requirement hints for the current policy, shown live on the
 * reset/change-password forms. The first entry is always the minimum length;
 * each enabled character class adds a line.
 */
export function describePolicy(policy: LoginSecurityPolicy): string[] {
  const hints = [`At least ${policy.minPasswordLength} characters`];
  if (policy.requireUppercase) hints.push("An uppercase letter (A–Z)");
  if (policy.requireLowercase) hints.push("A lowercase letter (a–z)");
  if (policy.requireDigit) hints.push("A number (0–9)");
  if (policy.requireSymbol) hints.push("A symbol (e.g. ! ? # $)");
  return hints;
}
