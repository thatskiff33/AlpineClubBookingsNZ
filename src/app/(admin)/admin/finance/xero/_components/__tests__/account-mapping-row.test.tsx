// @vitest-environment jsdom

/**
 * The Account Mapping screen's picker for one key (#5235, `INV-INT-021`).
 *
 * Hut Fee Refunds accepts a revenue or an expense account, the club's choice,
 * so its picker lists both under a heading per class. The headings and the
 * accounts under them come from the registry (`groupAccountsForMappingKey`),
 * which is the same rule the save checks a code against, so this file pins what
 * the officer sees: which accounts are offered, under which heading, and what
 * the row says about a stored code that is neither.
 */

import * as React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Render the design-system Select as a native <select>, with a group as an
// <optgroup> whose first, disabled option is its heading.
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
  SelectGroup: ({ children }: { children?: React.ReactNode }) => <optgroup data-testid="group">{children}</optgroup>,
  SelectLabel: ({ children }: { children?: React.ReactNode }) => (
    <option disabled data-testid="heading">
      {children}
    </option>
  ),
}));

import { AccountMappingRow } from "../account-mapping-row";
import type { AccountMappings } from "../types";
import type { AccountMappingKey } from "@/lib/xero-account-mapping-keys";

/** A connected organisation's chart with every class in it, as the chart route serialises it. */
const CHART = [
  { code: "200", name: "Sales", type: "REVENUE", class: "REVENUE" },
  { code: "260", name: "Other Revenue", type: "OTHERINCOME", class: "REVENUE" },
  { code: "404", name: "Bank Fees", type: "EXPENSE", class: "EXPENSE" },
  { code: "429", name: "General Expenses", type: "OVERHEADS", class: "EXPENSE" },
  { code: "606", name: "Business Bank Account", type: "BANK", class: "ASSET" },
  { code: "800", name: "Accounts Payable", type: "CURRLIAB", class: "LIABILITY" },
];

function mountRow(mappingKey: AccountMappingKey, code: string | null, isEditingMappings = true, refusal: string | null = null) {
  const mappings = { [mappingKey]: { code, itemCode: null } } as unknown as AccountMappings;
  return render(
    <AccountMappingRow
      mappingKey={mappingKey}
      mappings={mappings}
      setMappings={() => {}}
      accounts={CHART}
      isEditingMappings={isEditingMappings}
      refusal={refusal}
    />,
  );
}

/** Each heading with the accounts listed under it, in the order shown. */
function groupedOptions(): Array<[string | null, string[]]> {
  return screen.getAllByTestId("group").map((group) => {
    const [heading, ...accounts] = within(group).getAllByRole("option", { hidden: true });
    return [heading.textContent, accounts.map((option) => (option as HTMLOptionElement).value)];
  });
}

const optionValues = () =>
  Array.from((screen.getByRole("combobox") as HTMLSelectElement).options).map((option) => option.value);

describe("the Hut Fee Refunds picker (#5235)", () => {
  it("lists revenue and expense accounts, each under its own heading", () => {
    mountRow("hutFeeRefunds", null);
    expect(groupedOptions()).toEqual([
      // Other income is income (owner decision, 28 Nov 2026).
      ["Revenue accounts", ["200", "260"]],
      ["Expense accounts", ["404", "429"]],
    ]);
  });

  it("offers no bank or liability account", () => {
    mountRow("hutFeeRefunds", null);
    const offered = optionValues();
    expect(offered).not.toContain("606");
    expect(offered).not.toContain("800");
  });

  it("shows a mapped expense account by name when not editing", () => {
    mountRow("hutFeeRefunds", "429", false);
    expect(screen.getByText("429 - General Expenses")).toBeTruthy();
    expect(screen.queryByText(/is not a revenue or expense account/)).toBeNull();
  });

  it("keeps an unlisted stored code, with its own notice and no claim that it is the wrong kind (#5235 review)", () => {
    mountRow("hutFeeRefunds", "777");
    expect(screen.getByRole("option", { name: "777" })).toBeTruthy();
    expect(screen.queryByText(/not a revenue or expense account/i)).toBeNull();
    expect(screen.getByText(/This code is not an active account in the connected Xero organisation/)).toBeTruthy();
  });

  it("says nothing of a listed code, or of any code while there is no chart", () => {
    mountRow("hutFeeRefunds", "404");
    expect(screen.queryByText(/not an active account/)).toBeNull();
    cleanup();
    render(
      <AccountMappingRow
        mappingKey="hutFeeRefunds"
        mappings={{ hutFeeRefunds: { code: "777", itemCode: null } } as unknown as AccountMappings}
        setMappings={() => {}}
        accounts={[]}
        isEditingMappings
      />,
    );
    expect(screen.queryByText(/not an active account/)).toBeNull();
  });

  it("shows the last save's refusal about this mapping on its row", () => {
    mountRow("hutFeeRefunds", "429", true, "Hut Fee Refunds cannot use that expense account: Xero's tax rate OUTPUT2 cannot be used on expenses.");
    expect(screen.getByRole("alert").textContent).toContain("Hut Fee Refunds cannot use that expense account");
  });

  it("says so when the stored code is neither, and keeps it selectable as what it is", () => {
    mountRow("hutFeeRefunds", "606");
    expect(
      screen.getByText("606 - Business Bank Account (not a revenue or expense account)"),
    ).toBeTruthy();
    const notice = screen.getByText(/This code is not a revenue or expense account/);
    expect(notice.textContent).toContain("choose a revenue or expense account");
    // The out-of-class code sits under neither heading.
    expect(groupedOptions().flatMap(([, codes]) => codes)).not.toContain("606");
  });
});

describe("a key that accepts one class", () => {
  it("keeps one plain list with no heading", () => {
    mountRow("goodwillWriteOffs", null);
    expect(screen.queryAllByTestId("group")).toHaveLength(0);
    expect(screen.queryAllByTestId("heading")).toHaveLength(0);
    expect(optionValues()).toEqual(["__none__", "404", "429"]);
  });

  it("names the one kind of account it wants when the stored code is another kind", () => {
    mountRow("goodwillWriteOffs", "200");
    expect(screen.getByText("200 - Sales (not an expense account)")).toBeTruthy();
  });
});
