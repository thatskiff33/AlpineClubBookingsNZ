import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  getClientIp,
  applyRateLimit,
  _testStore,
  type RateLimitConfig,
} from "../rate-limit";

describe("rate-limit", () => {
  beforeEach(() => {
    _testStore.clear();
  });

  describe("checkRateLimit", () => {
    const config: RateLimitConfig = {
      id: "test",
      limit: 3,
      windowSeconds: 60,
    };

    it("allows requests within the limit", () => {
      const r1 = checkRateLimit(config, "ip1");
      expect(r1.success).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = checkRateLimit(config, "ip1");
      expect(r2.success).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = checkRateLimit(config, "ip1");
      expect(r3.success).toBe(true);
      expect(r3.remaining).toBe(0);
    });

    it("blocks requests exceeding the limit", () => {
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      const r4 = checkRateLimit(config, "ip1");
      expect(r4.success).toBe(false);
      expect(r4.remaining).toBe(0);
    });

    it("tracks different IPs independently", () => {
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      // ip2 should still be allowed
      const r = checkRateLimit(config, "ip2");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(2);
    });

    it("tracks different configs independently", () => {
      const config2: RateLimitConfig = { id: "test2", limit: 5, windowSeconds: 60 };

      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");
      checkRateLimit(config, "ip1");

      // Different config, same IP should still be allowed
      const r = checkRateLimit(config2, "ip1");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(4);
    });

    it("resets after window expires", () => {
      // Manually set an expired entry
      _testStore.set("test:ip1", { count: 5, resetAt: Date.now() - 1000 });

      const r = checkRateLimit(config, "ip1");
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(2);
    });

    it("returns correct resetAt timestamp", () => {
      const before = Date.now();
      const r = checkRateLimit(config, "ip1");
      const after = Date.now();

      expect(r.resetAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(r.resetAt).toBeLessThanOrEqual(after + 60_000);
    });
  });

  describe("getClientIp", () => {
    it("extracts IP from x-forwarded-for", () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      });
      expect(getClientIp(req)).toBe("1.2.3.4");
    });

    it("extracts IP from x-real-ip", () => {
      const req = new Request("http://localhost", {
        headers: { "x-real-ip": "9.8.7.6" },
      });
      expect(getClientIp(req)).toBe("9.8.7.6");
    });

    it("returns unknown when no headers present", () => {
      const req = new Request("http://localhost");
      expect(getClientIp(req)).toBe("unknown");
    });

    it("prefers x-forwarded-for over x-real-ip", () => {
      const req = new Request("http://localhost", {
        headers: {
          "x-forwarded-for": "1.1.1.1",
          "x-real-ip": "2.2.2.2",
        },
      });
      expect(getClientIp(req)).toBe("1.1.1.1");
    });
  });

  describe("applyRateLimit", () => {
    const config: RateLimitConfig = { id: "apply-test", limit: 2, windowSeconds: 60 };

    it("returns null when within limit", () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      const result = applyRateLimit(config, req);
      expect(result).toBeNull();
    });

    it("returns 429 Response when limit exceeded", () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });

      applyRateLimit(config, req);
      applyRateLimit(config, req);
      const result = applyRateLimit(config, req);

      expect(result).not.toBeNull();
      expect(result!.status).toBe(429);
      expect(result!.headers.get("Retry-After")).toBeTruthy();
    });

    it("includes rate limit headers on 429", async () => {
      const req = new Request("http://localhost", {
        headers: { "x-forwarded-for": "10.0.0.3" },
      });

      applyRateLimit(config, req);
      applyRateLimit(config, req);
      const result = applyRateLimit(config, req);

      expect(result!.headers.get("X-RateLimit-Limit")).toBe("2");
      expect(result!.headers.get("X-RateLimit-Remaining")).toBe("0");

      const body = await result!.json();
      expect(body.error).toContain("Too many requests");
    });
  });
});
