import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOGIN_SECURITY_POLICY,
  MIN_PASSWORD_LENGTH_CEILING,
  MIN_PASSWORD_LENGTH_FLOOR,
  PASSWORD_MAX_LENGTH,
  buildPasswordSchema,
  describePolicy,
  normalizeLoginSecurityPolicy,
  type LoginSecurityPolicy,
} from "@/lib/password-policy";

function policy(overrides: Partial<LoginSecurityPolicy> = {}): LoginSecurityPolicy {
  return { ...DEFAULT_LOGIN_SECURITY_POLICY, ...overrides };
}

describe("normalizeLoginSecurityPolicy", () => {
  it("returns the code default for an absent record (today's behaviour)", () => {
    expect(normalizeLoginSecurityPolicy(null)).toEqual(DEFAULT_LOGIN_SECURITY_POLICY);
    expect(normalizeLoginSecurityPolicy(undefined)).toEqual(
      DEFAULT_LOGIN_SECURITY_POLICY,
    );
  });

  // #4610: the breached-password check is on unless a row switches it off.
  it("defaults the breached-password check on and honours a stored off", () => {
    expect(DEFAULT_LOGIN_SECURITY_POLICY.breachedPasswordCheck).toBe(true);
    expect(normalizeLoginSecurityPolicy({}).breachedPasswordCheck).toBe(true);
    expect(
      normalizeLoginSecurityPolicy({ breachedPasswordCheck: false }).breachedPasswordCheck,
    ).toBe(false);
  });

  it("clamps the minimum length into the accepted 8–64 range", () => {
    expect(normalizeLoginSecurityPolicy({ minPasswordLength: 4 }).minPasswordLength).toBe(
      MIN_PASSWORD_LENGTH_FLOOR,
    );
    expect(
      normalizeLoginSecurityPolicy({ minPasswordLength: 999 }).minPasswordLength,
    ).toBe(MIN_PASSWORD_LENGTH_CEILING);
    expect(normalizeLoginSecurityPolicy({ minPasswordLength: 16 }).minPasswordLength).toBe(
      16,
    );
  });

  it("pins the minimum-length clamp boundary edges (7→8, 8→8, 64→64, 65→64)", () => {
    expect(normalizeLoginSecurityPolicy({ minPasswordLength: 7 }).minPasswordLength).toBe(
      8,
    );
    expect(normalizeLoginSecurityPolicy({ minPasswordLength: 8 }).minPasswordLength).toBe(
      8,
    );
    expect(normalizeLoginSecurityPolicy({ minPasswordLength: 64 }).minPasswordLength).toBe(
      64,
    );
    expect(normalizeLoginSecurityPolicy({ minPasswordLength: 65 }).minPasswordLength).toBe(
      64,
    );
  });

  it("clamps the magic-link TTL into the accepted 5–60 range", () => {
    expect(
      normalizeLoginSecurityPolicy({ magicLinkTtlMinutes: 1 }).magicLinkTtlMinutes,
    ).toBe(5);
    expect(
      normalizeLoginSecurityPolicy({ magicLinkTtlMinutes: 120 }).magicLinkTtlMinutes,
    ).toBe(60);
  });

  it("pins the magic-link TTL clamp boundary edges (4→5, 5→5, 60→60, 61→60)", () => {
    expect(
      normalizeLoginSecurityPolicy({ magicLinkTtlMinutes: 4 }).magicLinkTtlMinutes,
    ).toBe(5);
    expect(
      normalizeLoginSecurityPolicy({ magicLinkTtlMinutes: 5 }).magicLinkTtlMinutes,
    ).toBe(5);
    expect(
      normalizeLoginSecurityPolicy({ magicLinkTtlMinutes: 60 }).magicLinkTtlMinutes,
    ).toBe(60);
    expect(
      normalizeLoginSecurityPolicy({ magicLinkTtlMinutes: 61 }).magicLinkTtlMinutes,
    ).toBe(60);
  });

  it("carries the character-class flags through", () => {
    const normalized = normalizeLoginSecurityPolicy({
      requireUppercase: true,
      requireSymbol: true,
    });
    expect(normalized.requireUppercase).toBe(true);
    expect(normalized.requireSymbol).toBe(true);
    expect(normalized.requireLowercase).toBe(false);
    expect(normalized.requireDigit).toBe(false);
  });
});

describe("buildPasswordSchema", () => {
  it("with the default policy behaves like the historical min(12).max(128)", () => {
    const schema = buildPasswordSchema(DEFAULT_LOGIN_SECURITY_POLICY);
    expect(schema.safeParse("a".repeat(11)).success).toBe(false);
    expect(schema.safeParse("a".repeat(12)).success).toBe(true);
    expect(schema.safeParse("a".repeat(128)).success).toBe(true);
    expect(schema.safeParse("a".repeat(129)).success).toBe(false);
  });

  it("enforces the hard 128 ceiling regardless of a low configured minimum", () => {
    const schema = buildPasswordSchema(policy({ minPasswordLength: 8 }));
    expect(schema.safeParse("a".repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(schema.safeParse("a".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("enforces a raised minimum length", () => {
    const schema = buildPasswordSchema(policy({ minPasswordLength: 16 }));
    expect(schema.safeParse("a".repeat(15)).success).toBe(false);
    expect(schema.safeParse("a".repeat(16)).success).toBe(true);
  });

  it("enforces required character classes and reports every failure together", () => {
    const schema = buildPasswordSchema(
      policy({ minPasswordLength: 16, requireUppercase: true, requireDigit: true }),
    );
    // 16 lowercase chars: long enough, but missing uppercase AND digit.
    const result = schema.safeParse("abcdefghijklmnop");
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain("Password must include an uppercase letter");
      expect(messages).toContain("Password must include a number");
    }
    // Satisfies min length + uppercase + digit.
    expect(schema.safeParse("Abcdefghijklmno1").success).toBe(true);
  });

  it("enforces lowercase and symbol classes when required", () => {
    const schema = buildPasswordSchema(
      policy({ requireLowercase: true, requireSymbol: true }),
    );
    expect(schema.safeParse("ABCDEFGHIJKL").success).toBe(false); // no lowercase, no symbol
    expect(schema.safeParse("abcdefghijkl").success).toBe(false); // no symbol
    expect(schema.safeParse("abcdefghijk!").success).toBe(true);
  });
});

describe("describePolicy", () => {
  it("always leads with the minimum length", () => {
    expect(describePolicy(DEFAULT_LOGIN_SECURITY_POLICY)[0]).toBe(
      "At least 12 characters",
    );
  });

  it("adds one hint per enabled character class", () => {
    const hints = describePolicy(
      policy({
        minPasswordLength: 16,
        requireUppercase: true,
        requireLowercase: true,
        requireDigit: true,
        requireSymbol: true,
      }),
    );
    expect(hints).toEqual([
      "At least 16 characters",
      "An uppercase letter (A–Z)",
      "A lowercase letter (a–z)",
      "A number (0–9)",
      "A symbol (e.g. ! ? # $)",
    ]);
  });
});
