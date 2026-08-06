// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllocationPreferencesSection } from "../allocation-preferences-section";
import { useScopedDashboard } from "../use-scoped-dashboard";

interface DashboardSummary {
  autoAllocationEnabled: boolean;
  suggestionCount: number;
}

function Harness({
  loadDashboard,
}: {
  loadDashboard: (signal: AbortSignal) => Promise<DashboardSummary>;
}) {
  const dashboard = useScopedDashboard({
    scopeKey: "lodge-1:2026-08-01:2026-08-08",
    load: loadDashboard,
  });
  return (
    <>
      <p data-testid="header-mode">
        {dashboard.value
          ? dashboard.value.autoAllocationEnabled
            ? "Auto allocation"
            : "Admin only"
          : "Unavailable"}
      </p>
      <p data-testid="suggestions">
        {dashboard.value?.suggestionCount ?? "Unavailable"}
      </p>
      {dashboard.error ? (
        <div>
          <p role="alert">{dashboard.error}</p>
          <button type="button" onClick={() => void dashboard.reload()}>
            Try dashboard again
          </button>
        </div>
      ) : null}
      <AllocationPreferencesSection
        lodgeId="lodge-1"
        canEdit
        renderViewOnlyBanner={false}
        onSaved={async () => dashboard.reload()}
      />
    </>
  );
}

function settingsResponse(autoAllocationEnabled: boolean) {
  return new Response(
    JSON.stringify({
      settings: {
        autoAllocationEnabled,
        allocationPriorityOrder: ["BOOKING_COHESION"],
      },
    }),
    { status: 200 },
  );
}

function settingsFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) =>
    settingsResponse(init?.method === "PUT" ? false : true),
  );
}

async function saveDisabledMode() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Auto allocation enabled" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("allocation preferences dashboard refresh", () => {
  it("reports the successful save while a failed recompute clears the board and offers retry", async () => {
    vi.stubGlobal("fetch", settingsFetch());
    const loadDashboard = vi
      .fn<(signal: AbortSignal) => Promise<DashboardSummary>>()
      .mockResolvedValueOnce({
        autoAllocationEnabled: true,
        suggestionCount: 1,
      })
      .mockRejectedValueOnce(new Error("Dashboard refresh failed"))
      .mockResolvedValueOnce({
        autoAllocationEnabled: false,
        suggestionCount: 3,
      });
    render(<Harness loadDashboard={loadDashboard} />);
    await waitFor(() =>
      expect(screen.getByTestId("header-mode").textContent).toBe(
        "Auto allocation",
      ),
    );

    await saveDisabledMode();

    await waitFor(() =>
      expect(screen.getByText("Allocation preferences saved")).toBeTruthy(),
    );
    expect(screen.getByTestId("header-mode").textContent).toBe("Unavailable");
    expect(screen.getByTestId("suggestions").textContent).toBe("Unavailable");
    expect(screen.getByText("Dashboard refresh failed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try dashboard again" }));
    await waitFor(() =>
      expect(screen.getByTestId("header-mode").textContent).toBe("Admin only"),
    );
    expect(screen.getByTestId("suggestions").textContent).toBe("3");
  });

  it("recomputes header mode and suggestions after a successful save", async () => {
    vi.stubGlobal("fetch", settingsFetch());
    const loadDashboard = vi
      .fn<(signal: AbortSignal) => Promise<DashboardSummary>>()
      .mockResolvedValueOnce({
        autoAllocationEnabled: true,
        suggestionCount: 1,
      })
      .mockResolvedValueOnce({
        autoAllocationEnabled: false,
        suggestionCount: 4,
      });
    render(<Harness loadDashboard={loadDashboard} />);
    await waitFor(() =>
      expect(screen.getByTestId("suggestions").textContent).toBe("1"),
    );

    await saveDisabledMode();

    await waitFor(() =>
      expect(screen.getByTestId("header-mode").textContent).toBe("Admin only"),
    );
    expect(screen.getByTestId("suggestions").textContent).toBe("4");
    expect(loadDashboard).toHaveBeenCalledTimes(2);
  });
});
