import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { GET } from "../route";

const browserDsn = "https://public@example.ingest.sentry.io/1";
afterEach(() => vi.unstubAllEnvs());

describe("public runtime browser Sentry configuration", () => {
  it.each([undefined, "", "   ", `  ${browserDsn}  `])("returns only the trimmed browser DSN for %s", async (value) => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", value);
    vi.stubEnv("SENTRY_DSN", "server-only-dsn");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "server-only-token");
    vi.stubEnv("SENTRY_ORG", "server-only-org");
    vi.stubEnv("SENTRY_PROJECT", "server-only-project");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ dsn: value?.trim() || null });
  });
});
