import { afterEach, describe, expect, it } from "vitest";
import {
  getAuthSecret,
  getAuthTrustHost,
  getRuntimeConfigCheck,
  getRuntimeConfigIssues,
  requireAuthSecret,
} from "@/lib/runtime-config";

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
}

describe("runtime-config", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("accepts AUTH_SECRET as the preferred auth secret", () => {
    process.env.AUTH_SECRET = "preferred-secret";
    process.env.NEXTAUTH_SECRET = "legacy-secret";

    expect(getAuthSecret()).toBe("preferred-secret");
  });

  it("falls back to NEXTAUTH_SECRET when AUTH_SECRET is absent", () => {
    delete process.env.AUTH_SECRET;
    process.env.NEXTAUTH_SECRET = "legacy-secret";

    expect(getAuthSecret()).toBe("legacy-secret");
  });

  it("requires the preferred secret, trimmed, and observes rotation at call time", () => {
    process.env.AUTH_SECRET = "  preferred-secret  ";
    process.env.NEXTAUTH_SECRET = "legacy-secret";
    expect(requireAuthSecret()).toBe("preferred-secret");
    process.env.AUTH_SECRET = "rotated-secret";
    expect(requireAuthSecret()).toBe("rotated-secret");
  });

  it.each([undefined, "", "   "])(
    "requires the trimmed legacy secret when AUTH_SECRET is %j",
    (value) => {
      if (value === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = value;
      process.env.NEXTAUTH_SECRET = "  legacy-secret  ";
      expect(requireAuthSecret()).toBe("legacy-secret");
    },
  );

  it.each([undefined, "", "   "])(
    "throws the default or caller's error when both secrets are %j",
    (value) => {
      for (const key of ["AUTH_SECRET", "NEXTAUTH_SECRET"]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      expect(() => requireAuthSecret()).toThrow(
        "AUTH_SECRET or NEXTAUTH_SECRET is required",
      );
      expect(() => requireAuthSecret("Caller-specific error")).toThrow(
        "Caller-specific error",
      );
    },
  );

  it("requires auth secret, NEXTAUTH_URL, and CRON_SECRET", () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_URL;
    delete process.env.CRON_SECRET;

    expect(getRuntimeConfigIssues()).toEqual([
      "AUTH_SECRET or NEXTAUTH_SECRET is required",
      "NEXTAUTH_URL is required",
      "CRON_SECRET is required",
    ]);
  });

  it("rejects invalid NEXTAUTH_URL and AUTH_TRUST_HOST values", () => {
    process.env.AUTH_SECRET = "secret";
    process.env.NEXTAUTH_URL = "not-a-url";
    process.env.CRON_SECRET = "cron-secret";
    process.env.AUTH_TRUST_HOST = "sometimes";

    expect(getRuntimeConfigIssues()).toEqual([
      "NEXTAUTH_URL must be a valid http(s) URL",
      "AUTH_TRUST_HOST must be true or false",
    ]);
  });

  it("returns an ok check when the critical runtime config is present", () => {
    process.env.AUTH_SECRET = "secret";
    process.env.NEXTAUTH_URL = "https://example.org";
    process.env.CRON_SECRET = "cron-secret";
    process.env.AUTH_TRUST_HOST = "true";

    expect(getAuthTrustHost()).toBe(true);
    expect(getRuntimeConfigCheck()).toEqual({
      status: "ok",
      latencyMs: expect.any(Number),
    });
  });

  it("returns an error check when critical runtime config is missing", () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    process.env.NEXTAUTH_URL = "https://example.org";
    delete process.env.CRON_SECRET;

    expect(getRuntimeConfigCheck()).toEqual({
      status: "error",
      latencyMs: expect.any(Number),
      error: "AUTH_SECRET or NEXTAUTH_SECRET is required; CRON_SECRET is required",
    });
  });

  describe("the data-encryption key ring (#4456)", () => {
    const VALID = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 29 + 3) % 256)).toString("base64");

    function readyEnv() {
      process.env.AUTH_SECRET = "secret";
      process.env.NEXTAUTH_URL = "https://example.org";
      process.env.CRON_SECRET = "cron-secret";
    }

    it("is ready with the ring unset or valid", () => {
      readyEnv();
      delete process.env.DATA_ENCRYPTION_KEYS;
      expect(getRuntimeConfigIssues()).toEqual([]);
      process.env.DATA_ENCRYPTION_KEYS = `k1:${VALID}`;
      expect(getRuntimeConfigIssues()).toEqual([]);
    });

    it("is NOT ready with an invalid ring, naming why but never the value", () => {
      readyEnv();
      process.env.DATA_ENCRYPTION_KEYS = `k1:${VALID},k1:${VALID}`;
      const check = getRuntimeConfigCheck();
      expect(check.status).toBe("error");
      expect(check.error).toMatch(/DATA_ENCRYPTION_KEYS: the id "k1" appears more than once/);
      expect(check.error).not.toContain(VALID);
    });

    it("is NOT ready with the legacy-read switch set without a ring, or to anything but retired (#4456 PR 2)", () => {
      readyEnv();
      process.env.DATA_ENCRYPTION_LEGACY_KEY = "retired";
      delete process.env.DATA_ENCRYPTION_KEYS;
      expect(getRuntimeConfigIssues()).toEqual([expect.stringMatching(/DATA_ENCRYPTION_LEGACY_KEY=retired needs DATA_ENCRYPTION_KEYS/)]);
      process.env.DATA_ENCRYPTION_KEYS = `k1:${VALID}`;
      expect(getRuntimeConfigIssues()).toEqual([]);
      process.env.DATA_ENCRYPTION_LEGACY_KEY = "yes";
      expect(getRuntimeConfigIssues()).toEqual([expect.stringMatching(/the only accepted value is "retired"/)]);
      delete process.env.DATA_ENCRYPTION_LEGACY_KEY;
    });

    it("is NOT ready when a ring key is the auth secret itself", () => {
      readyEnv();
      process.env.AUTH_SECRET = VALID;
      process.env.DATA_ENCRYPTION_KEYS = `k1:${VALID}`;
      expect(getRuntimeConfigIssues()).toEqual([expect.stringMatching(/is weak: it is the auth secret/)]);
    });
  });
});
