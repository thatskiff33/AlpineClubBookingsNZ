// @vitest-environment jsdom

// #5259 review: with no override, the club's financial year-end comes from the
// connected Xero organisation, and the admin layout hands it to every season
// screen through `ClubSeasonProvider`. Next keeps that layout across client
// navigation, so a disconnect must refresh the router or the season screens
// keep the disconnected organisation's month.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  fetchWithRecentAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@/components/confirm-its-you", () => ({
  fetchWithRecentAuth: mocks.fetchWithRecentAuth,
}));

import { useXeroConnection } from "@/app/(admin)/admin/finance/xero/_hooks/use-xero-connection";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          connected: true,
          needsReentry: false,
          tenantId: "t-1",
          tokenExpiresAt: null,
        }),
        { status: 200 },
      ),
    ),
  );
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness() {
  const { handleDisconnect } = useXeroConnection();
  return (
    <button type="button" onClick={() => void handleDisconnect()}>
      Disconnect
    </button>
  );
}

async function disconnect() {
  render(<Harness />);
  await act(async () => {
    screen.getByRole("button", { name: "Disconnect" }).click();
  });
}

describe("useXeroConnection.handleDisconnect", () => {
  it("refreshes the router after a disconnect succeeds", async () => {
    mocks.fetchWithRecentAuth.mockResolvedValue(new Response("{}", { status: 200 }));
    await disconnect();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the disconnect fails", async () => {
    mocks.fetchWithRecentAuth.mockResolvedValue(new Response("{}", { status: 500 }));
    await disconnect();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
