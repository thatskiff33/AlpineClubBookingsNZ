// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// The two cross-area cards are mocked to cheap markers: this test exercises the
// client's matrix-driven conditional (#1548), not the cards' own fetches.
vi.mock("@/components/admin/lodge-capacity-card", () => ({
  LodgeCapacityCard: () => <div data-testid="lodge-card" />,
}));
vi.mock("@/components/admin/finance-report-mappings-panel", () => ({
  FinanceReportMappingsPanel: () => <div data-testid="finance-panel" />,
}));

import { SetupPageClient } from "@/app/(admin)/admin/setup/setup-page-client";

const setupBody = {
  readiness: {
    status: "not_started",
    summary: { total: 0, complete: 0, warning: 0, blocked: 0, skipped: 0 },
    categories: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
  },
  progress: {
    completedStepIds: [],
    skippedStepIds: [],
    completedAt: null,
    completedByMemberId: null,
  },
};

function stubSetupFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => setupBody,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SetupPageClient — permission-aware cross-area cards (#1548)", () => {
  beforeEach(() => {
    stubSetupFetch();
  });

  it("hides the lodge card when the viewer lacks lodge access", async () => {
    render(<SetupPageClient permissionMatrix={matrix({ support: "view" })} />);

    await waitFor(() => {
      expect(screen.getByText("Setup Wizard")).toBeTruthy();
    });
    expect(screen.queryByTestId("lodge-card")).toBeNull();
  });

  it("renders the lodge card when the viewer has lodge view", async () => {
    render(
      <SetupPageClient
        permissionMatrix={matrix({ support: "view", lodge: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("lodge-card")).toBeTruthy();
    });
  });

  it("hides the finance panel when the viewer lacks finance access", async () => {
    render(<SetupPageClient permissionMatrix={matrix({ support: "view" })} />);

    await waitFor(() => {
      expect(screen.getByText("Setup Wizard")).toBeTruthy();
    });
    expect(screen.queryByTestId("finance-panel")).toBeNull();
  });

  it("renders the finance panel when the viewer has finance view", async () => {
    render(
      <SetupPageClient
        permissionMatrix={matrix({ support: "view", finance: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("finance-panel")).toBeTruthy();
    });
  });
});
