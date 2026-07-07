// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FinanceReportMappingsPanel } from "@/components/admin/finance-report-mappings-panel";

// Route either load into a finance-area denial; the other succeeds. A 403 on
// EITHER initial load must hide the whole panel quietly (#1548).
function stubFetch(denied: "mappings" | "chart-of-accounts") {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const isMappings = url.includes("/api/admin/setup/finance-report-mappings");
    const isDenied =
      denied === "mappings" ? isMappings : url.includes("/api/admin/xero/chart-of-accounts");
    if (isDenied) {
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: "Forbidden" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () =>
        isMappings
          ? {
              categories: [],
              unmappedLines: [],
              snapshotCoverage: {
                latestProfitAndLossSnapshot: null,
                inspectedSnapshotCount: 0,
              },
            }
          : { accounts: [] },
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FinanceReportMappingsPanel — graceful cross-area 403 (#1548)", () => {
  it("renders nothing on a 403 from the mappings load and shows no error", async () => {
    stubFetch("mappings");
    render(<FinanceReportMappingsPanel />);

    await waitFor(() => {
      expect(screen.queryByText("Finance Report Mappings")).toBeNull();
    });
    expect(screen.queryByText("Failed to load finance mappings")).toBeNull();
  });

  it("renders nothing on a 403 from the chart-of-accounts load too", async () => {
    stubFetch("chart-of-accounts");
    render(<FinanceReportMappingsPanel />);

    await waitFor(() => {
      expect(screen.queryByText("Finance Report Mappings")).toBeNull();
    });
    expect(screen.queryByText("Failed to load Xero chart of accounts")).toBeNull();
  });
});
