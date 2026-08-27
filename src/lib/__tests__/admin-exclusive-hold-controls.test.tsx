// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Exclusive whole-lodge hold controls: what the officer is TOLD (#2285 review).
//
// The toggle is destructive on both directions — setting it deletes every bed
// assignment the booking owns (manual and admin-approved included), clearing it
// re-plans them and can move other bookings' provisional placements — and the
// surface used to say none of that: the set dialog only described the capacity
// effect, the clear dialog actively claimed "the booking itself is unchanged",
// and both toasts reported a bare success. These tests pin the corrected copy
// and the counts the toasts now report, so a regression to reassuring-but-wrong
// wording fails here.
// ---------------------------------------------------------------------------

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// The controls are edit-gated (#1997); grant bookings:edit so the buttons are
// live and the dialogs can be opened.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "edit",
          membership: "view",
          finance: "view",
          lodge: "view",
          content: "view",
          support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}));

import {
  AdminExclusiveHoldControls,
  describeBedAllocationReconcile,
} from "@/components/admin/admin-exclusive-hold-controls";

const baseProps = {
  bookingId: "booking-1",
  wholeLodgeHold: false,
  wholeLodgeHoldAt: null,
  heldByName: null,
  holdsCapacity: true,
};

function mockRoute(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("describeBedAllocationReconcile (#2285 review)", () => {
  it("reports what the SET removed and what the CLEAR re-planned", () => {
    expect(
      describeBedAllocationReconcile(true, {
        enabled: true,
        deletedCount: 12,
        createdCount: 0,
        promotedCount: 0,
      }),
    ).toBe(" 12 bed assignments removed.");
    expect(
      describeBedAllocationReconcile(false, {
        enabled: true,
        deletedCount: 0,
        createdCount: 9,
        promotedCount: 0,
      }),
    ).toBe(" 9 beds re-planned.");
  });

  it("singularises, and says so when nothing happened", () => {
    expect(
      describeBedAllocationReconcile(true, {
        enabled: true,
        deletedCount: 1,
        createdCount: 0,
        promotedCount: 0,
      }),
    ).toBe(" 1 bed assignment removed.");
    expect(
      describeBedAllocationReconcile(true, {
        enabled: true,
        deletedCount: 0,
        createdCount: 0,
        promotedCount: 0,
      }),
    ).toContain("no bed assignments to remove");
    // A CLEAR that re-planned nothing means auto-allocation is off — the
    // officer has to place the beds by hand, so silence would be wrong.
    expect(
      describeBedAllocationReconcile(false, {
        enabled: true,
        deletedCount: 0,
        createdCount: 0,
        promotedCount: 0,
      }),
    ).toContain("bed allocation board");
  });

  it("says nothing at all when the bed allocation module is off or absent", () => {
    expect(
      describeBedAllocationReconcile(true, {
        enabled: false,
        deletedCount: 0,
        createdCount: 0,
        promotedCount: 0,
      }),
    ).toBe("");
    expect(describeBedAllocationReconcile(true, undefined)).toBe("");
  });
});

describe("exclusive hold confirmation copy (#2285 review)", () => {
  it("the SET dialog warns that existing bed assignments — including approved ones — are removed", async () => {
    render(<AdminExclusiveHoldControls {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /Set exclusive hold/i }));

    const description = await screen.findByText(/bed assignments will be removed/i);
    expect(description).toHaveTextContent(/already approved/i);
    expect(description).toHaveTextContent(/placed by hand/i);
    expect(description).toHaveTextContent(/audit log/i);
  });

  it("the CLEAR dialog no longer claims the booking is unchanged and explains the re-plan", async () => {
    render(
      <AdminExclusiveHoldControls
        {...baseProps}
        wholeLodgeHold
        wholeLodgeHoldAt="2026-07-01T00:00:00.000Z"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Clear exclusive hold/i }),
    );

    const description = await screen.findByText(/given beds again/i);
    // The retired sentence: it was simply false — the clear re-plans beds.
    expect(description).not.toHaveTextContent(/booking itself is unchanged/i);
    expect(description).toHaveTextContent(/auto-allocation is on/i);
    expect(description).toHaveTextContent(/other bookings' provisional bed placements/i);
  });
});

describe("exclusive hold toasts report the bed-assignment change (#2285 review)", () => {
  it("SET reports how many assignments were removed", async () => {
    mockRoute({
      success: true,
      wholeLodgeHold: true,
      conflicts: [],
      bedAllocationReconcile: {
        enabled: true,
        deletedCount: 12,
        createdCount: 0,
        promotedCount: 0,
      },
    });
    render(<AdminExclusiveHoldControls {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /Set exclusive hold/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^Set hold$/i }),
    );

    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Exclusive whole-lodge hold set. 12 bed assignments removed.",
      ),
    );
  });

  it("SET with overlapping bookings keeps the conflict warning AND the removal count", async () => {
    mockRoute({
      success: true,
      wholeLodgeHold: true,
      conflicts: [{ id: "other-1" }],
      bedAllocationReconcile: {
        enabled: true,
        deletedCount: 3,
        createdCount: 0,
        promotedCount: 0,
      },
    });
    render(<AdminExclusiveHoldControls {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /Set exclusive hold/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^Set hold$/i }),
    );

    await waitFor(() =>
      expect(toastMocks.warning).toHaveBeenCalledWith(
        "Exclusive hold set. 3 bed assignments removed. 1 existing booking overlap these nights — resolve manually.",
      ),
    );
  });

  it("CLEAR reports how many beds were re-planned", async () => {
    mockRoute({
      success: true,
      wholeLodgeHold: false,
      conflicts: [],
      bedAllocationReconcile: {
        enabled: true,
        deletedCount: 0,
        createdCount: 9,
        promotedCount: 0,
      },
    });
    render(
      <AdminExclusiveHoldControls
        {...baseProps}
        wholeLodgeHold
        wholeLodgeHoldAt="2026-07-01T00:00:00.000Z"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Clear exclusive hold/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Clear hold$/i }),
    );

    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Exclusive whole-lodge hold cleared. 9 beds re-planned.",
      ),
    );
  });

  it("falls back to the plain message when the route reports no reconcile (module off)", async () => {
    mockRoute({ success: true, wholeLodgeHold: true, conflicts: [] });
    render(<AdminExclusiveHoldControls {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /Set exclusive hold/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^Set hold$/i }),
    );

    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "Exclusive whole-lodge hold set.",
      ),
    );
  });
});
