import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const oldFinancePages = [
  "bookings/page.tsx",
  "bookings/source/page.tsx",
  "revenue/page.tsx",
  "costs/page.tsx",
  "pricing-sensitivity/page.tsx",
  "working-capital/page.tsx",
  "cash/page.tsx",
  "balance-sheet/page.tsx",
];

describe("finance dashboard routes", () => {
  it("keeps finance as one gated dashboard route and removes old report pages", () => {
    const financeDir = path.resolve("src/app/(finance)/finance");

    for (const oldPage of oldFinancePages) {
      expect(fs.existsSync(path.join(financeDir, oldPage))).toBe(false);
    }

    const pageSource = fs.readFileSync(path.join(financeDir, "page.tsx"), "utf8");
    expect(pageSource).toContain('requireFinanceViewer("/finance")');
    expect(pageSource).toContain("buildFinanceDashboardPageModel");
  });
});
