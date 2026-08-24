import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/health-check", () => ({
  getRuntimeStatus: () => ({
    cronEnabled: false,
    role: "web-green",
    // Kept complete against RuntimeStatusReport: a double that omits a field
    // the real report carries is how a route stops being tested for it.
    environmentRole: "production",
  }),
}));

import { GET } from "@/app/api/deploy/runtime-status/route";

function request(secret?: string) {
  return new NextRequest("https://example.test/api/deploy/runtime-status", {
    headers: secret ? { "x-cron-secret": secret } : undefined,
  });
}

describe("deploy runtime status route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
  });

  it("rejects missing, wrong, and different-length cron secrets", async () => {
    for (const secret of [undefined, "wrong-secret", "short"]) {
      const response = await GET(request(secret));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Unauthorized",
      });
    }
  });

  it("returns runtime status for the deploy secret", async () => {
    const response = await GET(request("cron-secret"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cronEnabled: false,
      role: "web-green",
      environmentRole: "production",
    });
  });
});
