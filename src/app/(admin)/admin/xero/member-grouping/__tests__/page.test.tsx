// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Edit-level finance admin so canEdit/canView both resolve true (#1934/#2065).
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

// The rule editor uses the Radix Select, which jsdom cannot drive through its
// pointer-capture flow. Following the repo pattern (membership-types-page-*),
// swap it for a native <select> so the group picker can be exercised.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children?: ReactNode;
  }) => <option value={value}>{children}</option>,
}));

import XeroMemberGroupingPage from "@/app/(admin)/admin/xero/member-grouping/page";

const ALL_TIERS = ["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"];

type Rule = {
  id: string;
  membershipTypeId: string | null;
  membershipTypeName: string | null;
  ageTiers: string[];
  mode: string;
  groupId: string;
  groupName: string | null;
  isActive: boolean;
  sortOrder: number;
};

function baseConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mode: "MEMBERSHIP_TYPE_AND_AGE",
    rules: [] as Rule[],
    groups: [{ id: "g_adults", name: "Adults group", contactCount: 4 }],
    lastRefreshedAt: "2026-07-10T00:00:00.000Z",
    membershipTypes: [{ id: "mt_full", name: "Full" }],
    ageTiers: ALL_TIERS,
    ...overrides,
  };
}

const fetchMock = vi.fn();

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

const GROUPING_URL = "/api/admin/xero/member-grouping";
const CONTACT_GROUPS_URL = "/api/admin/xero/contact-groups";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  global.fetch = fetchMock as typeof fetch;
});

async function renderLoaded() {
  render(<XeroMemberGroupingPage />);
  await screen.findByText("Grouping rules");
}

/** Native <select> group picker (3rd combobox: type, kind, group). */
function groupSelect() {
  return screen.getAllByRole("combobox")[2] as HTMLSelectElement;
}

describe("XeroMemberGroupingPage (#2093)", () => {
  it("multi-select checkbox flow: the create payload carries the ticked tiers", async () => {
    let createBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GROUPING_URL && (init?.method ?? "GET") === "POST") {
        createBody = JSON.parse(String(init?.body));
        return jsonResponse(baseConfig());
      }
      if (url === GROUPING_URL) return jsonResponse(baseConfig());
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await renderLoaded();

    fireEvent.click(screen.getByLabelText("Youth"));
    fireEvent.click(screen.getByLabelText("Adult"));
    fireEvent.change(groupSelect(), { target: { value: "g_adults" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toMatchObject({
      action: "create-rule",
      // Canonical order INFANT < CHILD < YOUTH < ADULT.
      ageTiers: ["YOUTH", "ADULT"],
      mode: "MANAGED",
      groupId: "g_adults",
    });
  });

  it("ticking all 5 tiers collapses the payload to [] and the saved rule renders \"All age tiers\"", async () => {
    let createBody: Record<string, unknown> | null = null;
    const savedRule: Rule = {
      id: "rule-1",
      membershipTypeId: null,
      membershipTypeName: null,
      ageTiers: [],
      mode: "MANAGED",
      groupId: "g_adults",
      groupName: "Adults group",
      isActive: true,
      sortOrder: 0,
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GROUPING_URL && (init?.method ?? "GET") === "POST") {
        createBody = JSON.parse(String(init?.body));
        return jsonResponse(baseConfig({ rules: [savedRule] }));
      }
      if (url === GROUPING_URL) return jsonResponse(baseConfig());
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await renderLoaded();

    for (const label of ["Infant", "Child", "Youth", "Adult", "N/A"]) {
      fireEvent.click(screen.getByLabelText(label));
    }
    fireEvent.change(groupSelect(), { target: { value: "g_adults" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(createBody).not.toBeNull());
    // Full-tier selection collapses to the empty "all age tiers" shape.
    expect(createBody).toMatchObject({ ageTiers: [] });

    // The saved rule renders as "All age tiers"...
    expect(await screen.findByText(/All age tiers/)).toBeInTheDocument();
    // ...and the draft resets to none-ticked (comprehensible "all tiers" hint).
    expect(screen.getByText("None ticked = all age tiers.")).toBeInTheDocument();
    for (const label of ["Infant", "Child", "Youth", "Adult", "N/A"]) {
      expect(screen.getByLabelText(label)).not.toBeChecked();
    }
  });

  it("none ticked shows the \"all age tiers\" hint and an existing [] rule renders \"All age tiers\"", async () => {
    const allTiersRule: Rule = {
      id: "rule-all",
      membershipTypeId: null,
      membershipTypeName: null,
      ageTiers: [],
      mode: "MANAGED",
      groupId: "g_adults",
      groupName: "Everyone",
      isActive: true,
      sortOrder: 0,
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GROUPING_URL) return jsonResponse(baseConfig({ rules: [allTiersRule] }));
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await renderLoaded();

    // Draft starts none-ticked with the "all age tiers" hint.
    expect(screen.getByText("None ticked = all age tiers.")).toBeInTheDocument();
    // The stored [] rule renders in the list...
    expect(screen.getByText("Everyone")).toBeInTheDocument();
    // ...with its tier set shown as "All age tiers".
    expect(screen.getByText(/All age tiers/)).toBeInTheDocument();
  });

  it("Refresh from Xero: calls the contact-groups refresh endpoint, is busy/disabled while running, then reloads", async () => {
    let releaseRefresh: () => void = () => {};
    let refreshCalledWith: string | null = null;
    let groupingLoads = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(CONTACT_GROUPS_URL)) {
        refreshCalledWith = url;
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        return jsonResponse({ groups: [{ id: "g_adults", name: "Adults group", contactCount: 4 }] });
      }
      if (url === GROUPING_URL) {
        groupingLoads += 1;
        // Second GET (after refresh) reports a newer sync time.
        return jsonResponse(
          baseConfig({
            lastRefreshedAt:
              groupingLoads === 1 ? "2026-07-10T00:00:00.000Z" : "2026-07-18T00:00:00.000Z",
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await renderLoaded();
    expect(groupingLoads).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Refresh from Xero/ }));

    // Busy: label flips to "Refreshing…" and the button is disabled.
    const busyButton = await screen.findByRole("button", { name: /Refreshing…/ });
    expect(busyButton).toBeDisabled();
    expect(refreshCalledWith).toContain("refresh=1");

    // Release the refresh; the config reloads and a success status surfaces.
    releaseRefresh();
    await screen.findByText("Refreshed from Xero.");
    await waitFor(() => expect(groupingLoads).toBe(2));
    expect(
      screen.getByRole("button", { name: /Refresh from Xero/ }),
    ).not.toBeDisabled();
  });

  it("Refresh from Xero surfaces an inline error when the refresh fails", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(CONTACT_GROUPS_URL)) {
        return jsonResponse({ error: "Xero refresh failed." }, false);
      }
      if (url === GROUPING_URL) return jsonResponse(baseConfig());
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: /Refresh from Xero/ }));

    expect(await screen.findByText("Xero refresh failed.")).toBeInTheDocument();
    // Not stuck in the busy state after a failure.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Refresh from Xero/ }),
      ).not.toBeDisabled(),
    );
  });

  it("Last synced header renders the config lastRefreshedAt and updates after a successful refresh", async () => {
    let groupingLoads = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(CONTACT_GROUPS_URL)) {
        return jsonResponse({ groups: [{ id: "g_adults", name: "Adults group", contactCount: 4 }] });
      }
      if (url === GROUPING_URL) {
        groupingLoads += 1;
        return jsonResponse(
          baseConfig({
            // Starts un-synced, then a real timestamp arrives after refresh.
            lastRefreshedAt: groupingLoads === 1 ? null : "2026-07-18T09:30:00.000Z",
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await renderLoaded();
    // Never-synced state renders the prompt copy.
    expect(
      screen.getByText(/never — refresh from Xero to populate the contact-group cache/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Refresh from Xero/ }));

    // After the reload the "never" prompt is replaced by a rendered timestamp.
    await screen.findByText("Refreshed from Xero.");
    await waitFor(() =>
      expect(
        screen.queryByText(/never — refresh from Xero to populate the contact-group cache/),
      ).not.toBeInTheDocument(),
    );
    // The "Last synced" label persists and now shows a concrete localised date.
    expect(screen.getByText("Last synced:")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });
});
