import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config";
import { version } from "../../../package.json";
import { APP_VERSION_ENV_VAR, getAppVersion } from "@/lib/app-version";

afterEach(() => vi.unstubAllEnvs());

describe("app version build stamp (#4985)", () => {
  it("stamps the package version into Next's shared compiler environment", () => {
    expect(nextConfig.env?.[APP_VERSION_ENV_VAR]).toBe(version);
    vi.stubEnv(APP_VERSION_ENV_VAR, nextConfig.env?.[APP_VERSION_ENV_VAR]);
    expect(getAppVersion()).toBe(version);
  });

  it("trims the stamp and reads it without a package-manager launcher", () => {
    vi.stubEnv(APP_VERSION_ENV_VAR, "  release-under-test  ");
    expect(getAppVersion()).toBe("release-under-test");
  });

  it.each([undefined, "", "   "])("reports unknown when unbuilt (%s)", (stamp) => {
    vi.stubEnv(APP_VERSION_ENV_VAR, stamp);
    expect(getAppVersion()).toBe("unknown");
  });
});
