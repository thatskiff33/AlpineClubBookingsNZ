// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The setup page's version display (#49): both numbers beside the address and
 * the key, ONE call to the version route per page entry, `0` with no key, a
 * could-not-check note that pauses nothing, and one mismatch message inside
 * the existing Connection section.
 */

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { user: { id: "admin-1", accessRoles: ["ADMIN"] } },
  }),
}));
vi.mock("@/components/club-time-provider", () => ({
  useClubTime: () => ({ instantDateTime: () => "a date" }),
}));
// Partial: `ViewOnlyActionButton` reads the reason constants from the same
// module, so only the hook is replaced.
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { AlpineServerSetup } from "./alpine-server-setup";

const fetchMock = vi.fn();

function initial(overrides: Partial<Parameters<typeof AlpineServerSetup>[0]["initialState"]> = {}) {
  return {
    apiKeySet: true,
    apiKeyUpdatedAt: "2026-06-30T00:00:00.000Z",
    baseUrl: "https://central.test",
    otherLodgesEnabled: true,
    otherLodgesLastUploadAt: null,
    otherLodgesLastDownloadAt: null,
    serverVersion: null,
    serverVersionCheckedAt: null,
    ...overrides,
  };
}

function versionRouteAnswers(body: unknown) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("/api/admin/alpine-server/version")) {
      return { ok: true, status: 200, json: async () => body };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AlpineServerSetup version display (#49)", () => {
  it("asks the version route exactly once on entry and shows both numbers", async () => {
    versionRouteAnswers({ status: "match", serverVersion: "2.1", expected: "2.1", checkedAt: "2026-07-01T00:00:00.000Z", couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial()} />);

    expect(screen.getByTestId("server-version-expected").textContent).toBe("2.1");
    await waitFor(() => expect(screen.getByTestId("server-version-actual").textContent).toBe("2.1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
    expect(screen.queryByTestId("server-version-unchecked")).toBeNull();
  });

  it("shows the mismatch message with both numbers when the server differs", async () => {
    versionRouteAnswers({ status: "mismatch", serverVersion: "2.2", expected: "2.1", checkedAt: "2026-07-01T00:00:00.000Z", couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial()} />);

    const message = await screen.findByTestId("server-version-mismatch");
    expect(message.textContent).toMatch(/built for server version 2.1 and the server reports 2.2/);
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.2");
  });

  it("explains a 404 answer rather than printing 'unknown' as a number", async () => {
    versionRouteAnswers({ status: "mismatch", serverVersion: "unknown", expected: "2.1", checkedAt: null, couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial()} />);
    const message = await screen.findByTestId("server-version-mismatch");
    expect(message.textContent).toMatch(/does not report a version/);
  });

  it("shows 0 and no message while no API key is stored", async () => {
    versionRouteAnswers({ status: "no-key", serverVersion: "0", expected: "2.1", checkedAt: null, couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false, apiKeyUpdatedAt: null })} />);

    expect(screen.getByTestId("server-version-actual").textContent).toBe("0");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("server-version-actual").textContent).toBe("0");
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
  });

  it("says could-not-check with the last known answer, and does NOT call it a mismatch", async () => {
    versionRouteAnswers({ status: "match", serverVersion: "2.1", expected: "2.1", checkedAt: "2026-06-30T03:00:00.000Z", couldNotCheck: true, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial({ serverVersion: "2.1", serverVersionCheckedAt: "2026-06-30T03:00:00.000Z" })} />);

    const note = await screen.findByTestId("server-version-unchecked");
    expect(note.textContent).toMatch(/Could not check just now/);
    expect(note.textContent).toMatch(/last known 2.1/);
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
  });

  it("shows no could-not-check note beside 0 when the route fails and no key is stored (item 7)", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false, apiKeyUpdatedAt: null })} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("server-version-actual").textContent).toBe("0");
    expect(screen.queryByTestId("server-version-unchecked")).toBeNull();
  });

  it("says the server address is missing, not could-not-check, for a key with no address (item 9)", async () => {
    versionRouteAnswers({ status: "unchecked", serverVersion: "0", expected: "2.1", checkedAt: null, couldNotCheck: false, missingBaseUrl: true });
    render(<AlpineServerSetup initialState={initial({ baseUrl: null })} />);
    const note = await screen.findByTestId("server-version-no-address");
    expect(note.textContent).toMatch(/server address is missing/);
    expect(screen.queryByTestId("server-version-unchecked")).toBeNull();
  });

  it("refreshes the numbers from a refused Upload and does not say the pause sentence twice (items 6 and 7)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/alpine-server/version")) {
        return { ok: true, status: 200, json: async () => ({ status: "match", serverVersion: "2.1", expected: "2.1", checkedAt: null, couldNotCheck: false, missingBaseUrl: false }) };
      }
      if (String(url).includes("/other-lodges/upload") && init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Syncing with the Alpine Central Server is paused: this site is built for server version 2.1 and the server reports 2.2. Nothing is sent or received until the two match.",
            code: "server-version-mismatch",
            expected: "2.1",
            serverVersion: "2.2",
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<AlpineServerSetup initialState={initial()} />);
    await waitFor(() => expect(screen.getByTestId("server-version-actual").textContent).toBe("2.1"));

    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    await screen.findByTestId("server-version-mismatch");
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.2");
    // No second version call: the 409 carried the numbers.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/version"))).toHaveLength(1);
    // The pause sentence appears ONCE, in the status block; the message points at it.
    expect(screen.getAllByText(/built for server version 2.1 and the server reports 2.2/)).toHaveLength(1);
    expect(screen.getByText(/Upload paused: the server is on a different software version/)).toBeTruthy();
  });

  it("keeps the stored answer when the route itself cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<AlpineServerSetup initialState={initial({ serverVersion: "2.2", serverVersionCheckedAt: "2026-06-30T03:00:00.000Z" })} />);

    await screen.findByTestId("server-version-unchecked");
    // The stored mismatch is still a mismatch: a failed CHECK is not a match.
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.2");
    expect(screen.getByTestId("server-version-mismatch")).toBeTruthy();
  });
});
