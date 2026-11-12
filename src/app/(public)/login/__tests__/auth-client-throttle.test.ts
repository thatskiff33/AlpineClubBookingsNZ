// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { signIn } from "next-auth/react";
import { rateLimitedResponse } from "@/lib/rate-limit";
import { authRateLimitedResponse } from "@/lib/auth-rate-limit";
import { ADDRESS_THROTTLED_CODE } from "@/lib/login-throttle-policy";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
afterEach(() => vi.unstubAllGlobals());

it("the installed next-auth client returns the address wait code on 429 without throwing", async () => {
  const denied = authRateLimitedResponse(rateLimitedResponse({
    success: false, limit: 30, remaining: 0, resetAt: Date.now() + 900_000,
  }), "http://localhost/api/auth/callback/credentials");
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ credentials: { id: "credentials", type: "credentials" } }))
    .mockResolvedValueOnce(Response.json({ csrfToken: "test-csrf" }))
    .mockResolvedValueOnce(denied));
  await expect(signIn("credentials", { redirect: false, email: "member@example.org", password: "test" }))
    .resolves.toMatchObject({ code: ADDRESS_THROTTLED_CODE, status: 429, ok: false, url: null });
});
