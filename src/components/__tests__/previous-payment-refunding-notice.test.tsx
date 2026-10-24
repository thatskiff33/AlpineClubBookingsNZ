// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreviousPaymentRefundingNotice } from "@/components/previous-payment-refunding-notice";
import { PREVIOUS_PAYMENT_REFUNDING_NOTICE } from "@/lib/payment-recovery-contract";

/**
 * #4300 (`INV-PAY-138`, `INV-SSOT`): one going-back notice for both card pages.
 * Its live region stays mounted and only its content changes (#2160's rule).
 */
const REPO_ROOT = resolve(__dirname, "../../..");

/** Every source file under src (no tests), read from disk. */
function sourceFiles(dir = join(REPO_ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("PreviousPaymentRefundingNotice", () => {
  it("keeps an empty status region mounted when there is nothing to say", () => {
    render(<PreviousPaymentRefundingNotice show={false} />);
    const region = screen.getByTestId("previous-payment-refunding");
    expect(region).toHaveAttribute("role", "status");
    expect(region.textContent).toBe("");
  });

  it("says the earlier payment is going back, in the contract's words", () => {
    render(<PreviousPaymentRefundingNotice show />);
    expect(screen.getByRole("status")).toHaveTextContent(PREVIOUS_PAYMENT_REFUNDING_NOTICE);
  });

  it("is the one renderer of the notice, and both card pages use it", () => {
    for (const page of ["src/components/stripe/BookingPaymentWrapper.tsx", "src/app/(public)/pay/[token]/page.tsx"]) {
      expect(readFileSync(resolve(REPO_ROOT, page), "utf8"), page).toContain("<PreviousPaymentRefundingNotice");
    }
    const users = sourceFiles()
      .filter((file) => readFileSync(file, "utf8").includes("PREVIOUS_PAYMENT_REFUNDING_NOTICE"))
      .map((file) => relative(REPO_ROOT, file));
    expect(users.sort()).toEqual(["src/components/previous-payment-refunding-notice.tsx", "src/lib/payment-recovery-contract.ts"]);
  });
});
