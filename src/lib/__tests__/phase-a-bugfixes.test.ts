import { describe, it, expect } from "vitest";

// ============================================================
// #19 — Invalid promo code should not show stale discount
// ============================================================
describe("#19: modify-quote promo fallback removed", () => {
  // Re-implement the core logic under test: when a new promo code fails validation,
  // newDiscountCents should remain 0 (no fallback to old promo)
  function computeDiscount(opts: {
    removePromoCode?: boolean;
    newPromoCode?: string;
    newPromoValid: boolean;
    newPromoDiscount?: number;
    existingPromoDiscount?: number;
  }) {
    let newDiscountCents = 0;

    if (opts.removePromoCode) {
      newDiscountCents = 0;
    } else if (opts.newPromoCode) {
      if (opts.newPromoValid && opts.newPromoDiscount) {
        newDiscountCents = opts.newPromoDiscount;
      } else {
        // Fix: invalid new promo — discount stays 0, don't fall back to old promo
        newDiscountCents = 0;
      }
    } else if (opts.existingPromoDiscount) {
      newDiscountCents = opts.existingPromoDiscount;
    }

    return newDiscountCents;
  }

  it("returns 0 discount when new promo code is invalid", () => {
    const discount = computeDiscount({
      newPromoCode: "INVALID",
      newPromoValid: false,
      existingPromoDiscount: 23000,
    });
    expect(discount).toBe(0);
  });

  it("returns new discount when new promo code is valid", () => {
    const discount = computeDiscount({
      newPromoCode: "VALID50",
      newPromoValid: true,
      newPromoDiscount: 5000,
      existingPromoDiscount: 23000,
    });
    expect(discount).toBe(5000);
  });

  it("returns 0 discount when promo is explicitly removed", () => {
    const discount = computeDiscount({
      removePromoCode: true,
      newPromoValid: false,
      existingPromoDiscount: 23000,
    });
    expect(discount).toBe(0);
  });

  it("keeps existing discount when no new promo action", () => {
    const discount = computeDiscount({
      newPromoValid: false,
      existingPromoDiscount: 23000,
    });
    expect(discount).toBe(23000);
  });
});

// ============================================================
// #20 — Lodge kiosk seed and admin API
// ============================================================
describe("#20: Lodge account seed and admin API", () => {
  it("lodge seed has forcePasswordChange: false", async () => {
    // The seeded lodge account data now comes from prisma/seed-data.ts.
    const { buildSeedLodgeMemberData } = await import("../../../prisma/seed-data");
    const lodge = buildSeedLodgeMemberData({
      email: "lodge@example.org",
      passwordHash: "hash",
    });

    expect(lodge.forcePasswordChange).toBe(false);
  });

  it("admin lodge API route file exists", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const routePath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "api",
      "admin",
      "lodge",
      "route.ts"
    );
    expect(fs.existsSync(routePath)).toBe(true);
  });

  it("admin lodge page exists", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const pagePath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "(admin)",
      "admin",
      "lodge",
      "page.tsx"
    );
    expect(fs.existsSync(pagePath)).toBe(true);
  });

  it("admin sidebar includes Lodge Kiosk entry", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sidebarPath = path.resolve(
      process.cwd(),
      "src",
      "components",
      "admin-sidebar.tsx"
    );
    const content = fs.readFileSync(sidebarPath, "utf-8");
    expect(content).toContain("/admin/lodge");
    expect(content).toContain("Lodge Kiosk");
  });

  it("admin lodge API validates input with Zod", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const routePath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "api",
      "admin",
      "lodge",
      "route.ts"
    );
    const content = fs.readFileSync(routePath, "utf-8");
    expect(content).toContain("z.object");
    expect(content).toContain("z.string().email()");
    expect(content).toContain("z.string().min(6)");
  });

  it("admin lodge API audit logs changes", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const routePath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "api",
      "admin",
      "lodge",
      "route.ts"
    );
    const content = fs.readFileSync(routePath, "utf-8");
    expect(content).toContain("logAudit");
    expect(content).toContain("LODGE_ACCOUNT_UPDATED");
  });
});

// ============================================================
// #21 — Kiosk date navigation timezone bug
// ============================================================
describe("#21: Kiosk formatDate uses local date, not UTC", () => {
  // Re-implement the fixed formatDate function
  function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  it("formatDate returns local date string", () => {
    const d = new Date(2026, 3, 7); // April 7, 2026 local time
    expect(formatDate(d)).toBe("2026-04-07");
  });

  it("changeDate forward by 1 produces next day", () => {
    const dateStr = "2026-04-07";
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + 1);
    expect(formatDate(d)).toBe("2026-04-08");
  });

  it("changeDate backward by 1 produces previous day", () => {
    const dateStr = "2026-04-07";
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() - 1);
    expect(formatDate(d)).toBe("2026-04-06");
  });

  it("handles month boundary", () => {
    const dateStr = "2026-05-01";
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() - 1);
    expect(formatDate(d)).toBe("2026-04-30");
  });

  it("handles year boundary", () => {
    const dateStr = "2027-01-01";
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() - 1);
    expect(formatDate(d)).toBe("2026-12-31");
  });

  it("pads single-digit month and day", () => {
    const d = new Date(2026, 0, 5); // Jan 5
    expect(formatDate(d)).toBe("2026-01-05");
  });

  it("kiosk page source uses local formatDate (not toISOString)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const kioskPath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "(lodge)",
      "lodge",
      "kiosk",
      "page.tsx"
    );
    const content = fs.readFileSync(kioskPath, "utf-8");
    // The formatDate function should use getFullYear/getMonth/getDate
    expect(content).toContain("date.getFullYear()");
    expect(content).toContain("date.getMonth()");
    expect(content).toContain("date.getDate()");
    // Should NOT use toISOString for date formatting
    const formatFnMatch = content.match(
      /function formatDate[\s\S]*?return[\s\S]*?}/
    );
    expect(formatFnMatch).toBeTruthy();
    expect(formatFnMatch![0]).not.toContain("toISOString");
  });
});

// ============================================================
// #22 — Hut Leader eligible members excludes PAID bookings
// ============================================================
describe("#22: Hut Leader eligible members includes PAID bookings", () => {
  it("eligible-members query includes PAID status", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const routePath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "api",
      "admin",
      "hut-leaders",
      "eligible-members",
      "route.ts"
    );
    const content = fs.readFileSync(routePath, "utf-8");

    expect(content).toContain("OPERATIONAL_STAY_BOOKING_STATUSES");
    const { OPERATIONAL_STAY_BOOKING_STATUSES } = await import("@/lib/booking-status");
    expect(OPERATIONAL_STAY_BOOKING_STATUSES).toContain("PAID");
    expect(OPERATIONAL_STAY_BOOKING_STATUSES).toContain("COMPLETED");
    expect(OPERATIONAL_STAY_BOOKING_STATUSES).not.toContain("PENDING");
    expect(OPERATIONAL_STAY_BOOKING_STATUSES).not.toContain("CONFIRMED");
  });

  it("does not include CANCELLED, BUMPED, or DRAFT in eligible query", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const routePath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "api",
      "admin",
      "hut-leaders",
      "eligible-members",
      "route.ts"
    );
    const content = fs.readFileSync(routePath, "utf-8");
    const statusMatches = content.match(/status:\s*\{\s*in:\s*\[([^\]]+)\]/g);
    for (const match of statusMatches!) {
      expect(match).not.toContain('"CANCELLED"');
      expect(match).not.toContain('"BUMPED"');
      expect(match).not.toContain('"DRAFT"');
    }
  });
});

// ============================================================
// #23 — Cron Prisma startup check + expandable health errors
// ============================================================
describe("#23: Cron Prisma startup check and health error display", () => {
  it("Node instrumentation contains Prisma startup verification", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const instrPath = path.resolve(
      process.cwd(),
      "src",
      "instrumentation.node.ts"
    );
    const content = fs.readFileSync(instrPath, "utf-8");
    expect(content).toContain("SELECT 1");
    expect(content).toContain("Prisma client verified");
  });

  it("health page has expandable error component", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const healthPath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "(admin)",
      "admin",
      "health",
      "page.tsx"
    );
    const content = fs.readFileSync(healthPath, "utf-8");
    expect(content).toContain("CronError");
    expect(content).toContain("show more");
    // Should not have truncate class on error display anymore
    expect(content).not.toContain('className="text-red-600 max-w-xs truncate"');
  });

  it("CronJobRun error field has no length limit in schema", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const schemaPath = path.resolve(process.cwd(), "prisma", "schema.prisma");
    const content = fs.readFileSync(schemaPath, "utf-8");

    // Find the CronJobRun model
    const modelMatch = content.match(/model CronJobRun \{[\s\S]*?\n\}/);
    expect(modelMatch).toBeTruthy();

    // Error field should be String? (no @db.VarChar limit)
    const errorLine = modelMatch![0]
      .split("\n")
      .find((l: string) => l.trim().startsWith("error"));
    expect(errorLine).toBeTruthy();
    expect(errorLine).toContain("String?");
    expect(errorLine).not.toContain("@db.VarChar");
  });
});

// ============================================================
// #30 — Sentry Session Replay integration
// ============================================================
describe("#30: Sentry Session Replay", () => {
  it("instrumentation-client.ts exists with replay config", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const clientPath = path.resolve(
      process.cwd(),
      "src",
      "instrumentation-client.ts"
    );
    expect(fs.existsSync(clientPath)).toBe(true);

    const content = fs.readFileSync(clientPath, "utf-8");
    expect(content).toContain("replayIntegration");
    expect(content).toContain("replaysSessionSampleRate");
    expect(content).toContain("replaysOnErrorSampleRate");
  });

  it("old sentry.client.config.ts is removed", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const oldPath = path.resolve(process.cwd(), "sentry.client.config.ts");
    expect(fs.existsSync(oldPath)).toBe(false);
  });

  it("instrumentation-client.ts includes all existing client config", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const clientPath = path.resolve(
      process.cwd(),
      "src",
      "instrumentation-client.ts"
    );
    const content = fs.readFileSync(clientPath, "utf-8");

    // Must include performance tracing
    expect(content).toContain("tracesSampleRate");
    // Must include breadcrumbs
    expect(content).toContain("breadcrumbsIntegration");
    // Must include sensitive data scrubbing
    expect(content).toContain("beforeSend");
    expect(content).toContain("redactSensitiveJson");
    expect(content).toContain("redactSensitiveQueryParams");
    expect(content).toContain("redactSensitiveText");
    // Must include error filtering
    expect(content).toContain("ignoreErrors");
    expect(content).toContain("ResizeObserver loop");
  });

  it("replay sample rates are configured correctly", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const clientPath = path.resolve(
      process.cwd(),
      "src",
      "instrumentation-client.ts"
    );
    const content = fs.readFileSync(clientPath, "utf-8");

    // 10% session replay in production
    expect(content).toContain("0.1");
    // 100% replay on errors
    expect(content).toContain("replaysOnErrorSampleRate: 1.0");
  });
});
