// @vitest-environment jsdom

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #2108: render/mode smoke test plus an interaction test that drives the panel
// into "both" mode, picks a type + tier, and asserts the payload emitted to
// postJson matches the route's zod contract (membershipTypeId present, a bookable
// tier only, unmapped SKIP groups excluded).

const mockLoadGroups = vi.fn();
vi.mock("@/lib/admin-xero-contact-groups", () => ({
  loadAdminXeroContactGroups: (...a: unknown[]) => mockLoadGroups(...a),
}));

const mockFetchJson = vi.fn();
const mockPostJson = vi.fn();
vi.mock("../api", () => ({
  fetchJson: (...a: unknown[]) => mockFetchJson(...a),
  postJson: (...a: unknown[]) => mockPostJson(...a),
}));

// Auto-confirm the import confirmation dialog so the interaction test can reach
// the postJson call without driving the Radix dialog.
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({
    confirm: vi.fn().mockResolvedValue(true),
    prompt: vi.fn(),
    confirmDialog: null,
  }),
}));

// Render the design-system Select as a native <select> so onValueChange is
// testable. The aria-label / id set on the SelectTrigger is lifted onto the
// native control so getByLabelText resolves each of the three selects.
vi.mock("@/components/ui/select", () => {
  const Select = ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => {
    let ariaLabel: string | undefined;
    let id: string | undefined;
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return;
      const props = child.props as { ["aria-label"]?: string; id?: string };
      if (props["aria-label"] && !ariaLabel) ariaLabel = props["aria-label"];
      if (props.id && !id) id = props.id;
    });
    return (
      <select
        aria-label={ariaLabel}
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange?.(event.target.value)}
      >
        {children}
      </select>
    );
  };
  return {
    Select,
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

import { SetupPanels } from "../setup-panels";
import { xeroSectionId } from "../types";

function renderPanel() {
  return render(
    <SetupPanels
      connected
      open
      onToggle={vi.fn()}
      clubName="Test Club"
      bookingsName="Bookings"
      syncing={null}
      setSyncing={vi.fn()}
      setSyncResult={vi.fn()}
      onMessage={vi.fn()}
      onRefreshOperations={vi.fn()}
      onRefreshDiagnostics={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadGroups.mockResolvedValue({
    groups: [
      { id: "group_1", name: "Adults", contactCount: 3 },
      { id: "group_2", name: "Life Members", contactCount: 1 },
    ],
  });
  mockPostJson.mockResolvedValue({ created: 0, assignmentsCreated: 0 });
  mockFetchJson.mockImplementation(async (url: string) => {
    if (url === "/api/admin/membership-types") {
      return {
        membershipTypes: [
          { id: "type_full", name: "Full", isActive: true, allowedAgeTiers: ["ADULT"] },
          { id: "type_org", name: "School", isActive: true, allowedAgeTiers: ["NOT_APPLICABLE"] },
        ],
      };
    }
    return {};
  });
});

describe("SetupPanels is a reveal target (#2934)", () => {
  it("is a region named by its own visible title, at the id the reveal looks up", () => {
    // `use-xero-connection.ts` resolves a "go to section" request with
    // `getElementById(xeroSectionId(section))` and hands the card to the shared
    // reveal primitive, which focuses it. Focus landing on an unnamed card
    // announces only "group", so the card carries `role="region"` and takes its
    // name from the title a sighted user reads — and the id both sides use is
    // minted once, in `_components/types.ts`.
    renderPanel();

    const region = screen.getByRole("region", { name: "Setup Tools" });
    expect(region.id).toBe(xeroSectionId("setup"));
    expect(region.getAttribute("tabindex")).toBe("-1");
    expect(document.getElementById(xeroSectionId("setup"))).toBe(region);
  });
});

describe("SetupPanels — Import Members mode (#2108)", () => {
  it("renders the mode selector and defaults to Age tiers with the Import button disabled", async () => {
    renderPanel();

    // Groups load from the mocked contact-group loader.
    await waitFor(() => expect(screen.getByText("Adults")).toBeTruthy());

    // The mode selector is present and defaults to Age tiers, with an age-tier
    // control rendered per group.
    expect(screen.getByText("Map groups to")).toBeTruthy();
    expect(screen.getByText("Age tiers")).toBeTruthy();
    expect(screen.getByLabelText("Age tier for Adults")).toBeTruthy();

    // Import is disabled until a group is fully mapped (default tier is Skip).
    const importButton = screen.getByRole("button", {
      name: /import members/i,
    }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
  });

  it("both mode emits a zod-shaped payload (type + bookable tier, SKIP groups excluded)", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Adults")).toBeTruthy());

    // Switch to "Membership types + age tiers".
    fireEvent.change(screen.getByLabelText("Map groups to"), {
      target: { value: "both" },
    });

    // Wait for the membership types to load so the type select is populated.
    await waitFor(() =>
      expect(
        screen.getAllByRole("option", { name: "Full" }).length,
      ).toBeGreaterThan(0),
    );

    // Map only the Adults group; leave Life Members unmapped (SKIP).
    fireEvent.change(screen.getByLabelText("Membership type for Adults"), {
      target: { value: "type_full" },
    });
    fireEvent.change(screen.getByLabelText("Age tier for Adults"), {
      target: { value: "ADULT" },
    });

    const importButton = screen.getByRole("button", {
      name: /import members/i,
    }) as HTMLButtonElement;
    await waitFor(() => expect(importButton.disabled).toBe(false));
    fireEvent.click(importButton);

    await waitFor(() => expect(mockPostJson).toHaveBeenCalledTimes(1));
    const [url, payload] = mockPostJson.mock.calls[0] as [
      string,
      {
        groupMappings: Array<Record<string, unknown>>;
        sendInvites: boolean;
        repairMissingContactCache: boolean;
      },
    ];
    expect(url).toBe("/api/admin/xero/import-members");
    // Only the mapped group is sent; it carries the type and a bookable tier —
    // never an explicit NOT_APPLICABLE.
    expect(payload.groupMappings).toEqual([
      {
        groupId: "group_1",
        groupName: "Adults",
        membershipTypeId: "type_full",
        ageTier: "ADULT",
      },
    ]);
    expect(payload.sendInvites).toBe(false);
    expect(payload.repairMissingContactCache).toBe(false);
  });
});
