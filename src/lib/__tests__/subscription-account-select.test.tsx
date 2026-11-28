// @vitest-environment jsdom

/**
 * The Subscription Income picker on the subscription lockout screen (#5235,
 * `INV-INT-021`). The mapping save refuses a newly chosen account of a kind the
 * mapping does not accept, and this screen saves the lockout settings before
 * the mapping, so a picker offering every account would let an officer make a
 * choice that half-saves. It offers what the registry accepts instead.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Render the design-system Select as a native <select>.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, children }: { value?: string; children?: React.ReactNode }) => (
    <select value={value} onChange={() => {}}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { SubscriptionAccountSelect } from "@/components/admin/subscription-account-select";
import { accountsForMappingKey } from "@/lib/xero-account-mapping-keys";

const CHART = [
  { code: "200", name: "Sales", type: "REVENUE", class: "REVENUE" },
  { code: "203", name: "Annual Subs", type: "REVENUE", class: "REVENUE" },
  { code: "260", name: "Other Revenue", type: "OTHERINCOME", class: "REVENUE" },
  { code: "404", name: "Bank Fees", type: "EXPENSE", class: "EXPENSE" },
  { code: "606", name: "Business Bank Account", type: "BANK", class: "ASSET" },
];

function mount(value: string | null, accounts = CHART) {
  render(
    <SubscriptionAccountSelect
      id="sub-account"
      value={value}
      onChange={() => {}}
      accounts={accounts}
      disabled={false}
    />,
  );
  const select = screen.getByRole("combobox") as HTMLSelectElement;
  return Array.from(select.options).map((option) => [option.value, option.textContent]);
}

describe("the Subscription Income picker on the lockout screen (#5235)", () => {
  it("offers exactly the accounts the mapping's registry entry accepts", () => {
    const offered = mount(null).map(([code]) => code);
    expect(offered).toEqual([
      "__none__",
      ...accountsForMappingKey("subscriptionIncome", CHART).map((account) => account.code),
    ]);
    expect(offered).toEqual(["__none__", "200", "203", "260"]);
  });

  it("keeps a stored account of another kind listed, and says what it is not", () => {
    expect(mount("404")).toContainEqual(["404", "404 - Bank Fees (not a revenue account)"]);
  });

  it("shows a stored code as itself when no chart is loaded to judge it by", () => {
    expect(mount("203", [])).toEqual([
      ["__none__", "Not set"],
      ["203", "203"],
    ]);
  });
});
