import { describe, expect, it, vi } from "vitest";

import { adminHref } from "@/lib/admin-hubs";

const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));

// The retired Fee Configuration page only forwards to the consolidated fee
// console (#1933). Its target comes from the registry (C6 #4803), so it is one
// hop in either switch state; in-app links go straight to the fee console.
describe("the Fee Configuration stub", () => {
  it("redirects to the fee console's registry address", async () => {
    const { default: FeeConfigurationRedirect } = await import(
      "@/app/(admin)/admin/rules/fee-configuration/page"
    );
    expect(() => FeeConfigurationRedirect()).toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(adminHref("fees"));
    expect(adminHref("fees")).not.toContain("fee-configuration");
  });
});
