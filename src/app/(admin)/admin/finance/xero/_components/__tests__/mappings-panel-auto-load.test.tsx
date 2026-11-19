// @vitest-environment jsdom

/**
 * The Account Mappings section's automatic load runs once per opening (#5203).
 *
 * Before the shared latch, the effect re-fired each time `loading` settled, so
 * a failing read was requested over and over and its error flickered in and
 * out. The Setup panel's contact-group load had the same loop (ALP-591); both
 * now use `useAutoLoadOncePerOpening`.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchJson = vi.fn();
vi.mock("../api", () => ({
  fetchJson: (...a: unknown[]) => mockFetchJson(...a),
  postJson: vi.fn(),
}));

// Partial mock: the module also exports the shared view-only reason string the
// admin button components read at render time.
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAdminAreaEditAccess: () => true,
}));

vi.mock("@/components/club-time-provider", () => ({
  useClubTime: () => ({ instantDateTime: () => "a date" }),
}));

import { MappingsPanel } from "../mappings-panel";

const MAPPINGS_URL = "/api/admin/xero/account-mappings";

/** The reference reads the panel makes alongside the account mappings, all succeeding. */
function referenceRead(url: string) {
  if (url.startsWith("/api/admin/xero/chart-of-accounts")) return { accounts: [], cache: null };
  if (url.startsWith("/api/admin/xero/items")) return { items: [], cache: null };
  if (url.startsWith("/api/admin/xero/item-code-mappings")) return { hutFees: {}, entranceFees: {} };
  if (url.startsWith("/api/admin/membership-types")) return { membershipTypes: [] };
  if (url.startsWith("/api/admin/age-tier-settings")) return { settings: [] };
  throw new Error(`unexpected fetch ${url}`);
}

/** Every reference read succeeds except the account mappings themselves. */
function failMappingsRead() {
  mockFetchJson.mockImplementation(async (url: string) => {
    if (url.startsWith(MAPPINGS_URL)) throw new Error("Xero is unreachable");
    return referenceRead(url);
  });
}

function mappingsRequests(): number {
  return mockFetchJson.mock.calls.filter(([url]) => String(url).startsWith(MAPPINGS_URL)).length;
}

function panel(open: boolean, connected = true) {
  return <MappingsPanel connected={connected} open={open} onToggle={() => {}} clubName="Test Club" />;
}

// Let any effect re-run that a settled load would trigger get its chance.
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

describe("MappingsPanel — auto-load runs once per opening (#5203)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failMappingsRead();
  });

  it("a failed load is requested once and stays shown until the admin retries", async () => {
    render(panel(true));

    await screen.findByText("Xero is unreachable");
    await settle();
    expect(mappingsRequests()).toBe(1);
    expect(screen.getByText("Xero is unreachable")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh Xero reference data" }));
    await waitFor(() => expect(mappingsRequests()).toBe(2));
    await screen.findByText("Xero is unreachable");
    await settle();
    // The pressed retry's failure is requested once and shown once.
    expect(mappingsRequests()).toBe(2);
    expect(screen.getAllByText("Xero is unreachable")).toHaveLength(1);
  });

  it("closing and reopening the section loads again after a failed load", async () => {
    const { rerender } = render(panel(true));
    await screen.findByText("Xero is unreachable");
    await settle();
    expect(mappingsRequests()).toBe(1);

    rerender(panel(false));
    await settle();
    expect(mappingsRequests()).toBe(1);
    rerender(panel(true));
    await settle();
    expect(mappingsRequests()).toBe(2);
  });

  it("leaving the step and coming back loads again after a failed load", async () => {
    // The setup wizard renders only the active step, so leaving the Account
    // mapping step unmounts this panel and returning mounts it afresh with
    // `open` unchanged. A fresh mount must get its own automatic load.
    const first = render(panel(true));
    await screen.findByText("Xero is unreachable");
    await settle();
    expect(mappingsRequests()).toBe(1);

    first.unmount();
    await settle();
    expect(mappingsRequests()).toBe(1);

    render(panel(true));
    await screen.findByText("Xero is unreachable");
    await settle();
    expect(mappingsRequests()).toBe(2);
  });

  it("a failed load stays shown when the admin opens editing and cancels it", async () => {
    // Edit Mappings is enabled with nothing loaded. Cancel restores the saved
    // copy, which is still empty; it must not also wipe the load error, because
    // nothing re-asserts it now that the load no longer loops.
    render(panel(true));
    await screen.findByText("Xero is unreachable");
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Edit Mappings" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(screen.getByText("Xero is unreachable")).toBeTruthy();
    expect(mappingsRequests()).toBe(1);
  });

  it("disconnecting and reconnecting Xero loads again after a failed load", async () => {
    const { rerender } = render(panel(true));
    await screen.findByText("Xero is unreachable");
    await settle();
    expect(mappingsRequests()).toBe(1);

    rerender(panel(true, false));
    await settle();
    expect(mappingsRequests()).toBe(1);
    rerender(panel(true, true));
    await settle();
    expect(mappingsRequests()).toBe(2);
  });

  it("reopening while a load is still in flight waits for it instead of starting a second request", async () => {
    // The first mappings read hangs until the test rejects it; any later one
    // fails at once. This pins the latch's `busy` guard: without it the reopen
    // would fire a second, concurrent request.
    let rejectFirstRead: (error: Error) => void = () => {};
    const firstRead = new Promise<never>((_resolve, reject) => {
      rejectFirstRead = reject;
    });
    let mappingsReads = 0;
    mockFetchJson.mockImplementation(async (url: string) => {
      if (url.startsWith(MAPPINGS_URL)) {
        mappingsReads += 1;
        if (mappingsReads === 1) return firstRead;
        throw new Error("Xero is unreachable");
      }
      return referenceRead(url);
    });

    const { rerender } = render(panel(true));
    await waitFor(() => expect(mappingsRequests()).toBe(1));

    rerender(panel(false));
    rerender(panel(true));
    await settle();
    expect(mappingsRequests()).toBe(1);

    await act(async () => {
      rejectFirstRead(new Error("Xero is unreachable"));
    });
    await screen.findByText("Xero is unreachable");
    await settle();
    // Once the first read settles the reopened section loads once, not in a loop.
    expect(mappingsRequests()).toBe(2);
  });
});
