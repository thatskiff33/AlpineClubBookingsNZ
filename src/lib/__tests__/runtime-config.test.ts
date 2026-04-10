import { afterEach, describe, expect, it } from "vitest";
import {
  getAuthSecret,
  getAuthTrustHost,
  getRuntimeConfigCheck,
  getRuntimeConfigIssues,
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
    process.env.NEXTAUTH_URL = "https://tokoroa.org.nz";
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
    process.env.NEXTAUTH_URL = "https://tokoroa.org.nz";
    delete process.env.CRON_SECRET;

    expect(getRuntimeConfigCheck()).toEqual({
      status: "error",
      latencyMs: expect.any(Number),
      error: "AUTH_SECRET or NEXTAUTH_SECRET is required; CRON_SECRET is required",
    });
  });
});
