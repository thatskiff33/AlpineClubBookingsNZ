// @vitest-environment jsdom

/**
 * The Xero API Budget panel's automatic load runs once per opening (#5276).
 *
 * Before the shared `useAutoLoadOncePerOpening` latch, the effect re-fired each
 * time `loading` settled, so a failing read was requested over and over and its
 * error flickered in and out — the loop #5203 fixed for Account Mappings.
 */

import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchJson = vi.fn();
vi.mock("../api", () => ({
  fetchJson: (...a: unknown[]) => mockFetchJson(...a),
  postJson: vi.fn(),
}));

import { UsagePanel } from "../usage-panel";

const USAGE_URL = "/api/admin/xero/usage";

function usageRequests(): number {
  return mockFetchJson.mock.calls.filter(([url]) => String(url).startsWith(USAGE_URL)).length;
}

function panel(open: boolean, connected = true) {
  return <UsagePanel connected={connected} open={open} onToggle={() => {}} refreshToken={0} />;
}

// Let any effect re-run that a settled load would trigger get its chance.
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

describe("UsagePanel — auto-load runs once per opening (#5276)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchJson.mockRejectedValue(new Error("Xero usage is unreachable"));
  });

  it("a failed load is requested once and stays shown until the admin retries", async () => {
    render(panel(true));

    await screen.findByText("Xero usage is unreachable");
    await settle();
    expect(usageRequests()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh Usage" }));
    await waitFor(() => expect(usageRequests()).toBe(2));
    await screen.findByText("Xero usage is unreachable");
    await settle();
    // The pressed retry's failure is requested once and shown once.
    expect(usageRequests()).toBe(2);
    expect(screen.getAllByText("Xero usage is unreachable")).toHaveLength(1);
  });

  it("closing and reopening the panel loads again after a failed load", async () => {
    const { rerender } = render(panel(true));
    await screen.findByText("Xero usage is unreachable");
    await settle();
    expect(usageRequests()).toBe(1);

    rerender(panel(false));
    await settle();
    expect(usageRequests()).toBe(1);
    rerender(panel(true));
    await settle();
    expect(usageRequests()).toBe(2);
  });

  it("disconnecting and reconnecting Xero loads again after a failed load", async () => {
    const { rerender } = render(panel(true));
    await screen.findByText("Xero usage is unreachable");
    await settle();
    expect(usageRequests()).toBe(1);

    rerender(panel(true, false));
    await settle();
    expect(usageRequests()).toBe(1);
    rerender(panel(true, true));
    await settle();
    expect(usageRequests()).toBe(2);
  });
});
