// @vitest-environment jsdom

// #2244: an export capped at the server's row limit used to download silently,
// so a partial CSV was indistinguishable from a complete one. The panel must
// say so on screen and mark the file it hands over.

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromoRedemptionsPanel } from "@/app/(admin)/admin/promo-codes/promo-redemptions-panel";

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

const ROW = {
  id: "redemption-1",
  createdAt: "2026-07-01T10:00:00.000Z",
  member: { id: "member-1", name: "Jane Doe", email: "jane@example.test" },
  booking: {
    id: "booking-1",
    reference: "ABC123",
    lodgeId: "lodge-1",
    lodgeName: "Lodge One",
    checkIn: "2026-07-10",
    checkOut: "2026-07-12",
    nights: 2,
  },
  eligibleGuestCount: 2,
  discountCents: 2000,
  priceAdjustmentCents: 0,
  freeNightsUsed: 0,
  gaveBenefit: true,
  memberUseIndex: 1,
  // Two allocations so the row carries an expander: Reset clears the truncation
  // notice but must NOT collapse open rows (see promo-redemptions-reset.test.tsx).
  allocations: [
    {
      memberId: "member-1",
      name: "Jane Doe",
      discountCents: 1000,
      freeNightsUsed: 0,
    },
    {
      memberId: "member-2",
      name: "John Doe",
      discountCents: 1000,
      freeNightsUsed: 0,
    },
  ],
};

const TOTALS = {
  redemptions: 12_345,
  uniqueMembers: 400,
  discountCents: 2000,
  freeNightsUsed: 0,
  benefitFreeRedemptions: 0,
};

function listResponse() {
  return {
    code: {
      id: "promo-1",
      code: "WINTER20",
      description: null,
      type: "PERCENTAGE",
      active: true,
      archived: false,
      internal: false,
      capUsage: { redemptions: 1, uniqueMembers: 1 },
      caps: {
        maxRedemptionsTotal: null,
        maxUniqueMembersTotal: null,
        maxUsesPerMember: null,
        lifetimeFreeNightsCap: null,
      },
    },
    totals: { all: TOTALS, filtered: TOTALS },
    pagination: { page: 1, pageSize: 50, total: 12_345 },
    export: null,
    rows: [ROW],
  };
}

/** The export response, with the server's completeness marker attached. */
function exportResponse(truncated: boolean) {
  return {
    ...listResponse(),
    export: {
      truncated,
      limit: 10_000,
      rowCount: truncated ? 10_000 : 12_345,
      matchedRowCount: 12_345,
    },
  };
}

const urlAny = URL as unknown as {
  createObjectURL: unknown;
  revokeObjectURL: unknown;
};
const realCreateObjectURL = urlAny.createObjectURL;
const realRevokeObjectURL = urlAny.revokeObjectURL;
let downloadedNames: string[] = [];
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  downloadedNames = [];
  urlAny.createObjectURL = vi.fn(() => "blob:mock");
  urlAny.revokeObjectURL = vi.fn();
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      downloadedNames.push(this.download);
    });
});

afterEach(() => {
  clickSpy.mockRestore();
  urlAny.createObjectURL = realCreateObjectURL;
  urlAny.revokeObjectURL = realRevokeObjectURL;
  vi.unstubAllGlobals();
});

function renderPanel() {
  render(
    <PromoRedemptionsPanel
      promo={{
        id: "promo-1",
        code: "WINTER20",
        description: null,
        type: "PERCENTAGE",
        archived: false,
      }}
      onBack={() => undefined}
    />,
  );
}

/** Responds to the list GET, then to the `export=1` GET. */
function stubFetch(truncated: boolean) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes("export=1") ? exportResponse(truncated) : listResponse(),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PromoRedemptionsPanel export truncation (#2244)", () => {
  it("warns that a capped export is incomplete and names the file -partial", async () => {
    stubFetch(true);
    renderPanel();
    await screen.findByText("ABC123");

    fireEvent.click(screen.getByRole("button", { name: /CSV/ }));

    // The live region is mounted from the first paint (house rule), so the
    // assertion is on its CONTENT arriving, not on the region appearing.
    await screen.findByText(/Incomplete export/);
    const notice = screen.getByRole("status");
    // Counts are digit-grouped: the operator is being asked to compare two
    // five-figure numbers, so "10,000 of 12,345" is the readable form and it
    // matches how the operator guide states the cap.
    expect(notice).toHaveTextContent(
      "Incomplete export: 10,000 of 12,345 matching redemptions",
    );
    // The counts an operator needs to act on: the cap, and what to do instead.
    expect(notice).toHaveTextContent("capped at 10,000 rows");
    expect(notice).toHaveTextContent(/narrow the redeemed-date range/i);

    // The file is still delivered — a partial export beats none — but it is
    // named so the shortfall survives past the on-screen notice.
    await waitFor(() => expect(downloadedNames).toHaveLength(1));
    expect(downloadedNames[0]).toMatch(
      /^promo-WINTER20-redemptions-\d{4}-\d{2}-\d{2}-partial\.csv$/,
    );
  });

  it("shows no notice and no -partial suffix for a complete export", async () => {
    stubFetch(false);
    renderPanel();
    await screen.findByText("ABC123");

    fireEvent.click(screen.getByRole("button", { name: /CSV/ }));

    await waitFor(() => expect(downloadedNames).toHaveLength(1));
    expect(downloadedNames[0]).toMatch(
      /^promo-WINTER20-redemptions-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    // The live region stays mounted but empty: no message, no warning styling.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByText(/Incomplete export/)).toBeNull();
  });

  it("clears the notice when the filter changes, so it never describes another set", async () => {
    stubFetch(true);
    renderPanel();
    await screen.findByText("ABC123");

    fireEvent.click(screen.getByRole("button", { name: /CSV/ }));
    await screen.findByText(/Incomplete export/);

    fireEvent.change(screen.getByLabelText("Redeemed from"), {
      target: { value: "2026-07-01" },
    });
    await waitFor(() =>
      expect(screen.queryByText(/Incomplete export/)).toBeNull(),
    );
  });

  // Reset is the documented way to restore all dates, all lodges and page 1, so
  // it is a filter change too: leaving the notice up would have it quote the
  // count matched by the filter the operator has just cleared.
  it("clears the notice when the filters are reset", async () => {
    stubFetch(true);
    renderPanel();
    await screen.findByText("ABC123");

    // Reset only becomes available once a filter is set, so filter first, then
    // export under that filter, then reset.
    fireEvent.change(screen.getByLabelText("Redeemed from"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: /CSV/ }));
    await screen.findByText(/Incomplete export/);
    fireEvent.click(screen.getByRole("button", { name: "Show member split" }));
    expect(screen.getByText("Per-member split (2 members)")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(screen.queryByText(/Incomplete export/)).toBeNull(),
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    // Reset clears the notice WITHOUT collapsing open rows — the distinction
    // #2358 established and this fix must not undo by routing Reset through
    // the ordinary filter-change path.
    expect(screen.getByText("Per-member split (2 members)")).toBeVisible();
  });
});
