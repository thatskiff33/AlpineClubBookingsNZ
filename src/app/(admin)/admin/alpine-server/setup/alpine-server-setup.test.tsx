// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
    versionRouteAnswers({ status: "match", serverVersion: "2.0", expected: "2.0", checkedAt: "2026-07-01T00:00:00.000Z", couldNotCheck: false });
    render(<AlpineServerSetup initialState={initial()} />);

    expect(screen.getByTestId("server-version-expected").textContent).toBe("2.0");
    await waitFor(() => expect(screen.getByTestId("server-version-actual").textContent).toBe("2.0"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
    expect(screen.queryByTestId("server-version-unchecked")).toBeNull();
  });

  it("shows the mismatch message with both numbers when the server differs", async () => {
    versionRouteAnswers({ status: "mismatch", serverVersion: "2.1", expected: "2.0", checkedAt: "2026-07-01T00:00:00.000Z", couldNotCheck: false });
    render(<AlpineServerSetup initialState={initial()} />);

    const message = await screen.findByTestId("server-version-mismatch");
    expect(message.textContent).toMatch(/built for server version 2\.0 and the server reports 2\.1/);
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.1");
  });

  it("explains a 404 answer rather than printing 'unknown' as a number", async () => {
    versionRouteAnswers({ status: "mismatch", serverVersion: "unknown", expected: "2.0", checkedAt: null, couldNotCheck: false });
    render(<AlpineServerSetup initialState={initial()} />);
    const message = await screen.findByTestId("server-version-mismatch");
    expect(message.textContent).toMatch(/does not report a version/);
  });

  it("shows 0 and no message while no API key is stored", async () => {
    versionRouteAnswers({ status: "no-key", serverVersion: "0", expected: "2.0", checkedAt: null, couldNotCheck: false });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false, apiKeyUpdatedAt: null })} />);

    expect(screen.getByTestId("server-version-actual").textContent).toBe("0");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("server-version-actual").textContent).toBe("0");
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
  });

  it("says could-not-check with the last known answer, and does NOT call it a mismatch", async () => {
    versionRouteAnswers({ status: "match", serverVersion: "2.0", expected: "2.0", checkedAt: "2026-06-30T03:00:00.000Z", couldNotCheck: true });
    render(<AlpineServerSetup initialState={initial({ serverVersion: "2.0", serverVersionCheckedAt: "2026-06-30T03:00:00.000Z" })} />);

    const note = await screen.findByTestId("server-version-unchecked");
    expect(note.textContent).toMatch(/Could not check just now/);
    expect(note.textContent).toMatch(/last known 2\.0/);
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
  });

  it("keeps the stored answer when the route itself cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<AlpineServerSetup initialState={initial({ serverVersion: "2.1", serverVersionCheckedAt: "2026-06-30T03:00:00.000Z" })} />);

    await screen.findByTestId("server-version-unchecked");
    // The stored mismatch is still a mismatch: a failed CHECK is not a match.
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.1");
    expect(screen.getByTestId("server-version-mismatch")).toBeTruthy();
  });
});
