// @vitest-environment jsdom

/**
 * The Subscriptions season picker selects AND names seasons by the club's
 * year-end (#5259).
 *
 * The year-end used to reach no browser, so this picker centred on an April
 * season and labelled it `(Apr-Mar)` for every club. Each case pins the clock to
 * 15 June 2026, the issue's own example, and passes the year-end the admin
 * layout would hand the page:
 *
 * - **March** is today's clubs, and must not move: the five option strings and
 *   the selected season are exactly what the page rendered before this change.
 * - **June** is the issue's example. 15 June is the last month of the season
 *   ending June 2026, so the selected season is 2025 and the list request asks
 *   for it; a page that moved only the label would select 2026.
 * - **December** is the single-calendar-year season.
 */
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, screen, waitFor } from "@/lib/__tests__/support/club-season-render";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import SubscriptionsPage from "@/app/(admin)/admin/finance/subscriptions/page";

const navigation = vi.hoisted(() => ({
  router: { replace: () => {}, push: () => {}, refresh: () => {} },
  searchParams: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.searchParams,
  usePathname: () => "/admin/finance/subscriptions",
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
  useAdminAreaViewAccess: () => true,
}));
vi.mock("@/hooks/use-xero-status", () => ({ useXeroStatus: () => ({ connected: true }) }));
vi.mock("@/hooks/use-xero-org-short-code", () => ({
  useXeroOrgShortCode: () => ({ shortCode: null }),
}));
vi.mock("@/lib/admin-xero-contact-groups", () => ({
  loadAdminXeroContactGroups: async () => ({ groups: [] }),
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: async () => true, confirmDialog: null }),
}));
vi.mock("@/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel", () => ({
  SubscriptionBillingPanel: () => null,
}));
// A native select, so the options and the selected value are plain DOM.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () =>
  Response.json({
    data: [],
    total: 0,
    summary: { total: 0, paid: 0, unpaid: 0, overdue: 0, notInvoiced: 0, notRequired: 0 },
  }),
);

/** The season picker: the one select whose options carry a month range. */
function seasonPicker(): HTMLSelectElement {
  const picker = screen
    .getAllByRole("combobox")
    .find((select) => /\(\w+-\w+\)/.test(select.textContent ?? ""));
  if (!(picker instanceof HTMLSelectElement)) throw new Error("no season picker");
  return picker;
}

function listRequestSeasons(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.startsWith("/api/admin/subscriptions?"))
    .map((url) => new URLSearchParams(url.split("?")[1]).get("seasonYear") ?? "");
}

beforeEach(() => {
  // Noon on 15 June 2026 in New Zealand.
  vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
});

describe("the Subscriptions season picker on 15 June 2026", () => {
  it.each([
    [
      3,
      "2026",
      [
        "2024 - 2025 (Apr-Mar)",
        "2025 - 2026 (Apr-Mar)",
        "2026 - 2027 (Apr-Mar)",
        "2027 - 2028 (Apr-Mar)",
        "2028 - 2029 (Apr-Mar)",
      ],
    ],
    [
      6,
      "2025",
      [
        "2023 - 2024 (Jul-Jun)",
        "2024 - 2025 (Jul-Jun)",
        "2025 - 2026 (Jul-Jun)",
        "2026 - 2027 (Jul-Jun)",
        "2027 - 2028 (Jul-Jun)",
      ],
    ],
    [
      12,
      "2026",
      [
        "2024 (Jan-Dec)",
        "2025 (Jan-Dec)",
        "2026 (Jan-Dec)",
        "2027 (Jan-Dec)",
        "2028 (Jan-Dec)",
      ],
    ],
  ])(
    "a year-end of month %i selects season %s and lists its neighbours by name",
    async (yearEndMonth, selected, options) => {
      render(<SubscriptionsPage />, { yearEndMonth });

      const picker = seasonPicker();
      expect([...picker.options].map((option) => option.textContent)).toEqual(options);
      expect(picker.value).toBe(selected);
      await waitFor(() => expect(listRequestSeasons()).toContain(selected));
      expect(new Set(listRequestSeasons())).toEqual(new Set([selected]));
    },
  );
});
