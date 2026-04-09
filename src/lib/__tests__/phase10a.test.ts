import { describe, it, expect, beforeEach } from "vitest";
import faqSections from "@/data/faq";
import { checkRateLimit, _testStore } from "@/lib/rate-limit";
import { rateLimiters } from "@/lib/rate-limit";

// Note: Committee data tests moved to committee.test.ts (now database-driven)

// ─── FAQ data ──────────────────────────────────────────────────────────────

describe("faq data (F-PUB-04)", () => {
  it("exports an array of FAQ sections", () => {
    expect(Array.isArray(faqSections)).toBe(true);
    expect(faqSections.length).toBeGreaterThan(0);
  });

  it("every section has a title and items array", () => {
    for (const section of faqSections) {
      expect(typeof section.title).toBe("string");
      expect(section.title.length).toBeGreaterThan(0);
      expect(Array.isArray(section.items)).toBe(true);
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it("every FAQ item has a question and answer", () => {
    for (const section of faqSections) {
      for (const item of section.items) {
        expect(typeof item.question).toBe("string");
        expect(item.question.length).toBeGreaterThan(0);
        expect(typeof item.answer).toBe("string");
        expect(item.answer.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers required topics", () => {
    const allQuestions = faqSections
      .flatMap((s) => s.items)
      .map((i) => i.question.toLowerCase());

    expect(allQuestions.some((q) => q.includes("book"))).toBe(true);
    expect(allQuestions.some((q) => q.includes("cancellation"))).toBe(true);
    expect(allQuestions.some((q) => q.includes("member"))).toBe(true);
    expect(allQuestions.some((q) => q.includes("chore"))).toBe(true);
    expect(allQuestions.some((q) => q.includes("password"))).toBe(true);
  });
});

// ─── Contact rate limit (F-PUB-03) ─────────────────────────────────────────

describe("contact form rate limit (F-PUB-03)", () => {
  beforeEach(() => {
    _testStore.clear();
  });

  it("allows 10 submissions per hour", () => {
    const config = rateLimiters.contact;
    expect(config.limit).toBe(10);
    expect(config.windowSeconds).toBe(3600);

    for (let i = 0; i < 10; i++) {
      const result = checkRateLimit(config, "192.168.1.1");
      expect(result.success).toBe(true);
    }
  });

  it("blocks the 11th submission", () => {
    const config = rateLimiters.contact;

    for (let i = 0; i < 10; i++) {
      checkRateLimit(config, "10.0.0.1");
    }

    const result = checkRateLimit(config, "10.0.0.1");
    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("different IPs have independent limits", () => {
    const config = rateLimiters.contact;

    for (let i = 0; i < 10; i++) {
      checkRateLimit(config, "10.0.0.1");
    }

    // Different IP should still be allowed
    const result = checkRateLimit(config, "10.0.0.2");
    expect(result.success).toBe(true);
  });
});

// ─── Privacy & Terms pages metadata ────────────────────────────────────────

describe("compliance pages (F-COMP-01, F-COMP-02)", () => {
  it("privacy page module exports metadata with correct structure", async () => {
    const mod = await import(
      "@/app/(website)/privacy/page"
    );
    expect(mod.metadata).toBeDefined();
    expect(mod.metadata.title).toBeDefined();
    expect(String(mod.metadata.title).toLowerCase()).toContain("privacy");
  });

  it("terms page module exports metadata with correct structure", async () => {
    const mod = await import(
      "@/app/(website)/terms/page"
    );
    expect(mod.metadata).toBeDefined();
    expect(mod.metadata.title).toBeDefined();
    expect(String(mod.metadata.title).toLowerCase()).toContain("terms");
  });

  it("faq page module exports metadata", async () => {
    const mod = await import(
      "@/app/(website)/faq/page"
    );
    expect(mod.metadata).toBeDefined();
    expect(mod.metadata.title).toBeDefined();
  });
});
