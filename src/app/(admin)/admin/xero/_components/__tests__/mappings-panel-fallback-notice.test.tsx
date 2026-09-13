// @vitest-environment jsdom

/**
 * The Xero setup screen's fallback notice tells the truth (#2717,
 * `INV-INT-021`).
 *
 * The owner's decision has two halves and this file is about the second: while
 * `goodwillWriteOffs` is unset the screen must say so, name where goodwill is
 * actually going, and say what setting it would change — driven by the
 * canonical "did this club CHOOSE a code" rule, never by a bespoke null check.
 *
 * Three things the first cut got wrong, each pinned below. It showed the
 * fallback key's RAW ROW code, so on a deployment where that key has no code
 * either the screen named no account at all while goodwill really posted to the
 * application default. It read a configuredness flag the SERVER had sent, so an
 * officer clearing a previously-configured mapping saw no notice and was never
 * told that saving would send goodwill back to the revenue account. And it said
 * "entries" where it could say "goodwill entries" at no cost.
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchJson = vi.fn();
vi.mock("../api", () => ({
  fetchJson: (...a: unknown[]) => mockFetchJson(...a),
  postJson: vi.fn(),
}));

// Partial mock: the module also exports the shared view-only reason string the
// admin button components read at render time (the widened-graph trap in
// AGENTS.md §5), so replacing the module wholesale kills the file at import.
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAdminAreaEditAccess: () => true,
}));

vi.mock("@/components/club-time-provider", () => ({
  useClubTime: () => ({ instantDateTime: () => "a date" }),
}));

// Render the design-system Select as a native <select> so its options and its
// onValueChange are reachable from the test.
vi.mock("@/components/ui/select", () => {
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange?.(event.target.value)}>
      {children}
    </select>
  );
  return {
    Select,
    SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

import { MappingsPanel } from "../mappings-panel";

/** The connected org's chart, as the chart-of-accounts route serialises it. */
const CHART = [
  { code: "200", name: "Sales", type: "REVENUE", class: "REVENUE" },
  { code: "202", name: "Hut Fee Refunds", type: "REVENUE", class: "REVENUE" },
  { code: "429", name: "General Expenses", type: "OVERHEADS", class: "EXPENSE" },
];

function mountPanel(mappings: Record<string, { code: string | null; itemCode: string | null }>) {
  mockFetchJson.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/admin/xero/account-mappings")) return mappings;
    if (url.startsWith("/api/admin/xero/chart-of-accounts")) return { accounts: CHART, cache: null };
    if (url.startsWith("/api/admin/xero/items")) return { items: [], cache: null };
    if (url.startsWith("/api/admin/xero/item-code-mappings")) return { hutFees: {}, entranceFees: {} };
    if (url.startsWith("/api/admin/membership-types")) return { membershipTypes: [] };
    if (url.startsWith("/api/admin/age-tier-settings")) return { settings: [] };
    throw new Error(`unexpected fetch ${url}`);
  });
  return render(
    <MappingsPanel connected open onToggle={() => {}} clubName="Test Club" />,
  );
}

/** Every writable key present with a null code, then the overrides applied. */
function mappingRows(overrides: Record<string, { code: string | null; itemCode?: string | null }>) {
  const base: Record<string, { code: string | null; itemCode: string | null }> = {};
  for (const key of [
    "hutFeesIncome",
    "hutFeeRefunds",
    "goodwillWriteOffs",
    "stripeBankAccount",
    "stripeFees",
    "subscriptionIncome",
    "membershipCancellationCredit",
    "hutFeeItem",
    "hutFeeRefundItem",
    "entranceFeeItem",
  ]) {
    base[key] = { code: null, itemCode: null };
  }
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = { code: value.code, itemCode: value.itemCode ?? null };
  }
  return base;
}

describe("the goodwill fallback notice (#2717)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the account goodwill really posts to when the fallback key is ALSO unset", async () => {
    // Neither key carries a code, so goodwill posts to the application default
    // for hut-fee refunds — 200. Showing the empty row instead told a treasurer
    // that two mappings were unconfigured and named no account anywhere.
    mountPanel(mappingRows({}));
    const notice = await screen.findByText(/goodwill entries keep posting/i);
    expect(notice.textContent).toContain("Hut Fee Refunds");
    expect(notice.textContent).toContain("200 - Sales");
  });

  it("names the club's own refund account when it has chosen one", async () => {
    mountPanel(mappingRows({ hutFeeRefunds: { code: "202" } }));
    const notice = await screen.findByText(/goodwill entries keep posting/i);
    expect(notice.textContent).toContain("202 - Hut Fee Refunds");
  });

  it("says goodwill entries, not just entries", async () => {
    mountPanel(mappingRows({}));
    await screen.findByText(/so goodwill entries keep posting/i);
  });

  it("shows NO notice once the club has chosen a goodwill account", async () => {
    mountPanel(mappingRows({ goodwillWriteOffs: { code: "429" } }));
    await screen.findByText("Goodwill & Write-Offs");
    expect(screen.queryByText(/goodwill entries keep posting/i)).toBeNull();
  });

  it("warns the moment an officer CLEARS a configured goodwill mapping", async () => {
    // The notice is about the staged code, not the saved one. Read off a
    // server-sent flag it would still say "configured" here, and the officer
    // would save goodwill back onto the revenue account never having been told.
    mountPanel(mappingRows({ goodwillWriteOffs: { code: "429" } }));
    await screen.findByText("Goodwill & Write-Offs");
    fireEvent.click(screen.getByRole("button", { name: /edit mappings/i }));

    const goodwillSelect = screen
      .getAllByRole("combobox")
      .find((select) =>
        Array.from((select as HTMLSelectElement).options).some(
          (option) => option.value === "429",
        ),
      ) as HTMLSelectElement;
    expect(goodwillSelect.value).toBe("429");
    expect(screen.queryByText(/goodwill entries keep posting/i)).toBeNull();

    fireEvent.change(goodwillSelect, { target: { value: "__none__" } });
    await waitFor(() => {
      expect(screen.getByText(/goodwill entries keep posting/i)).toBeTruthy();
    });
  });

  it("offers the whole expense class in the goodwill picker", async () => {
    // 429 is typed OVERHEADS, which is expense CLASS. A type filter would leave
    // this picker empty on the standard New Zealand chart.
    mountPanel(mappingRows({}));
    await screen.findByText("Goodwill & Write-Offs");
    fireEvent.click(screen.getByRole("button", { name: /edit mappings/i }));
    await waitFor(() => {
      expect(screen.getAllByText("429 - General Expenses").length).toBeGreaterThan(0);
    });
  });
});
