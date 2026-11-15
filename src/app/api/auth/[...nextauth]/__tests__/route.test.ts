import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { post, get, counter } = vi.hoisted(() => ({
  post: vi.fn(), get: vi.fn(), counter: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ handlers: { POST: post, GET: get } }));
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: counter } }));

import { GET, POST } from "../route";
import { rateLimiters } from "@/lib/rate-limit";
import { ADDRESS_THROTTLED_CODE } from "@/lib/login-throttle-policy";

beforeEach(() => {
  vi.clearAllMocks();
  post.mockImplementation(async () => Response.json({ handled: true }));
});

describe("Auth.js POST address budget", () => {
  for (const spent of [false, true]) {
    it.each(["signout", "session"])(`%s bypasses a ${spent ? "spent" : "fresh"} counter`, async (action) => {
      counter.mockResolvedValue([{ count: spent ? rateLimiters.login.limit + 1 : 1, resetAt: new Date(Date.now() + 900_000) }]);
      const response = await POST(new NextRequest(`http://localhost/api/auth/${action}`, { method: "POST" }));
      expect(response.status).toBe(200);
      expect(post).toHaveBeenCalledOnce();
      expect(counter).not.toHaveBeenCalled();
    });

    it.each([
      "callback/credentials", "callback/magic-link", "signin/google", "future-action",
      "signout/extra", "session/extra", "callback/credentials?action=signout",
    ])(`%s counts against a ${spent ? "spent" : "fresh"} counter`, async (action) => {
      const resetAt = new Date(Date.now() + 900_000);
      counter.mockResolvedValue([{ count: spent ? rateLimiters.login.limit + 1 : 1, resetAt }]);
      const response = await POST(new NextRequest(`http://localhost/api/auth/${action}`, { method: "POST" }));
      expect(counter).toHaveBeenCalledOnce();
      expect(response.status).toBe(spent ? 429 : 200);
      expect(post).toHaveBeenCalledTimes(spent ? 0 : 1);
      if (spent) {
        const { url } = await response.json();
        const target = new URL(url);
        expect(target.pathname).toBe("/login");
        expect(target.searchParams.get("code")).toBe(ADDRESS_THROTTLED_CODE);
        expect(response.headers.get("Retry-After")).toBe("900");
        expect(response.headers.get("X-RateLimit-Limit")).toBe(String(rateLimiters.login.limit));
        expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
        expect(response.headers.get("X-RateLimit-Reset")).toBe(String(resetAt.getTime()));
      }
    });
  }

  it("leaves GET actions with Auth.js", () => {
    expect(GET).toBe(get);
    expect(counter).not.toHaveBeenCalled();
  });
});
