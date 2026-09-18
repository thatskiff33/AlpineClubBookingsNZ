// @vitest-environment jsdom

/**
 * THE MONTHLY BUDGET CARD (AID-7, #2378, owner decision 3).
 *
 * Every test here is a REFUSAL, because the refusals are what #2378 asks for: the
 * UI must "represent permission denial honestly rather than hiding tools as if the
 * evidence did not exist", and a budget card that renders empty on a 403 says there
 * is no budget rather than that you may not see it.
 *
 * The `module_unknown` case is the one worth reading twice. `moduleEnabled` is
 * tri-state (#2803) and `null` means the club's module settings could NOT BE READ.
 * Rendering that as "off" would send an operator to switch on a module that is
 * already on — the exact bug #2803 exists to prevent — so the two states are
 * separately pinned here.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiagnosticsBudgetCard } from "../_components/diagnostics-budget-card";

const mocks = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => mocks.canEdit,
}));

function settingsResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      monthlyBudgetCents: 2500,
      maxMonthlyBudgetCents: 50_000,
      usage: {
        month: {
          settledCents: 312,
          activeReservedCents: 0,
          requestCount: 7,
        },
      },
      ...overrides,
    }),
  };
}

beforeEach(() => {
  mocks.canEdit = true;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(settingsResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the module gate (#2378 decision 3, #2803)", () => {
  it("does not even ask for the budget while the module is off", async () => {
    render(<DiagnosticsBudgetCard moduleEnabled={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("budget-module-off")).toBeTruthy(),
    );
    // The route is hard-gated on the flag, so a request here could only 404.
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("Open Feature modules")).toBeTruthy();
  });

  it("says UNKNOWN, not off, when the module flag could not be read", async () => {
    render(<DiagnosticsBudgetCard moduleEnabled={null} />);
    const notice = await screen.findByTestId("budget-module-unknown");
    expect(notice.textContent).toContain("could not be established");
    // The whole point: it must not send anyone to Feature modules.
    expect(screen.queryByText("Open Feature modules")).toBeNull();
    expect(screen.queryByTestId("budget-module-off")).toBeNull();
  });

  it("treats a 404 as the module having been switched off since page render", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    render(<DiagnosticsBudgetCard moduleEnabled />);
    await waitFor(() =>
      expect(screen.getByTestId("budget-module-off")).toBeTruthy(),
    );
  });
});

describe("permission is stated, never implied by silence (#2378)", () => {
  it("says who can see the budget on a 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }),
    );
    render(<DiagnosticsBudgetCard moduleEnabled />);
    const denied = await screen.findByTestId("budget-denied");
    expect(denied.textContent).toContain("support access");
    expect(screen.queryByTestId("budget-input")).toBeNull();
  });

  it("shows the figure read-only for a view-only admin, with the reason", async () => {
    mocks.canEdit = false;
    render(<DiagnosticsBudgetCard moduleEnabled />);
    const input = (await screen.findByTestId("budget-input")) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("25.00");
    expect((screen.getByTestId("budget-save") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("budget-view-only")).toBeTruthy();
  });

  it("shows NO view-only banner while the session is still resolving", async () => {
    // `undefined` is the resolving state. Gating the banner on `!canEdit` would
    // flash "you cannot change this" at an admin who can.
    mocks.canEdit = undefined;
    render(<DiagnosticsBudgetCard moduleEnabled />);
    await screen.findByTestId("budget-input");
    expect(screen.queryByTestId("budget-view-only")).toBeNull();
  });
});

describe("the server owns the number (#2378 decision 3)", () => {
  it("shows the month's spend against the budget", async () => {
    render(<DiagnosticsBudgetCard moduleEnabled />);
    expect(await screen.findByText("$3.12 of $25.00")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("cannot save until the figure actually changed", async () => {
    render(<DiagnosticsBudgetCard moduleEnabled />);
    await screen.findByTestId("budget-input");
    expect((screen.getByTestId("budget-save") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says the budget is unavailable rather than showing a zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    render(<DiagnosticsBudgetCard moduleEnabled />);
    const unavailable = await screen.findByTestId("budget-unavailable");
    expect(unavailable.textContent).toContain("could not be read");
    // A zero budget is a real, meaningful setting (it hard-offs paid calls), so
    // rendering one here would be a lie with operational consequences.
    expect(screen.queryByTestId("budget-input")).toBeNull();
  });
});
