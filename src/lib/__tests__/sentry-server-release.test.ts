import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION_ENV_VAR, getAppVersion } from "@/lib/app-version";

// Only `init` matters here: the test reads the options the server config hands it.
const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  nativeNodeFetchIntegration: vi.fn(() => ({ name: "NodeFetch" })),
}));
vi.mock("@sentry/nextjs", () => sentry);

async function loadServerInitOptions(): Promise<{ release?: string }> {
  vi.resetModules();
  await import("../../../sentry.server.config");
  expect(sentry.init).toHaveBeenCalledTimes(1);
  return sentry.init.mock.calls[0][0] as { release?: string };
}

describe("server Sentry release tag (#4985)", () => {
  beforeEach(() => sentry.init.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it("files server events under the build's version, not a constant", async () => {
    vi.stubEnv(APP_VERSION_ENV_VAR, "sentry-release-under-test");
    const options = await loadServerInitOptions();
    expect(options.release).toBe(getAppVersion());
    expect(options.release).toBe("sentry-release-under-test");
  });

  it("uses `unknown`, never a made-up version, when the build was not stamped", async () => {
    vi.stubEnv(APP_VERSION_ENV_VAR, "");
    const options = await loadServerInitOptions();
    expect(options.release).toBe("unknown");
  });
});
