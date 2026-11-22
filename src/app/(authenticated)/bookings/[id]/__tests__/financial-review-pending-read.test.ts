// The booking page's read of "is a financial review open on this booking".
//
// #3214 put a "Record what these nights sold for" section on the Admin tools
// card and gated it on that flag. #4344 (wave C1 of #4302) retired the section
// with the officer review, and `retired-edit-review-screens-census.test.ts`
// keeps it gone. What is left to hold here is the ONE-read rule: the member's
// banner and the admin's warning row read the same flag, so the page must ask
// once and hand the answer on.
//
// WHY THIS IS A SOURCE-TEXT CONTRACT AND NOT A RENDER TEST. The page is an async
// React Server Component that loads a booking, a session, module flags,
// payments, credits, group state and lodge settings before it renders anything,
// and standing all of that up tests the mocks. Comments are stripped before
// matching, so the paragraph explaining a guard can never stand in for it.
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const ROUTE_DIR = "src/app/(authenticated)/bookings/[id]";
const ADMIN_TOOLS = `${ROUTE_DIR}/_lib/booking-detail-admin-tools.ts`;

/** Every production source file the booking page load spans, comments stripped. */
function readRouteSources(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  walk(path.resolve(process.cwd(), ROUTE_DIR));
  expect(files.length).toBeGreaterThan(10);
  return files.map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");
}

describe("the booking page's open-review flag", () => {
  it("is read once and handed on, never queried again by the admin tools", () => {
    const reads = readRouteSources().match(/bookingHasOpenFinancialReview\(/g) ?? [];
    expect(reads).toHaveLength(1);
    const adminTools = stripComments(
      readFileSync(path.resolve(process.cwd(), ADMIN_TOOLS), "utf8"),
    );
    expect(adminTools).toContain("financialReviewPending");
    expect(adminTools).not.toContain("bookingHasOpenFinancialReview");
  });
});
