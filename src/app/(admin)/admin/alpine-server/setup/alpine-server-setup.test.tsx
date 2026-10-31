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
    versionRouteAnswers({ status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: "2026-07-01T00:00:00.000Z", couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial()} />);

    expect(screen.getByTestId("server-version-expected").textContent).toBe("2.6");
    await waitFor(() => expect(screen.getByTestId("server-version-actual").textContent).toBe("2.6"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
    expect(screen.queryByTestId("server-version-unchecked")).toBeNull();
  });

  it("shows the mismatch message with both numbers when the server differs", async () => {
    versionRouteAnswers({ status: "mismatch", serverVersion: "2.7", expected: "2.6", checkedAt: "2026-07-01T00:00:00.000Z", couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial()} />);

    const message = await screen.findByTestId("server-version-mismatch");
    expect(message.textContent).toMatch(/built for server version 2.6 and the server reports 2.7/);
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.7");
  });

  it("explains a 404 answer rather than printing 'unknown' as a number", async () => {
    versionRouteAnswers({ status: "mismatch", serverVersion: "unknown", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial()} />);
    const message = await screen.findByTestId("server-version-mismatch");
    expect(message.textContent).toMatch(/does not report a version/);
  });

  it("says free beds need a saved Central lodge link, even for a one-lodge club (#4262)", async () => {
    versionRouteAnswers({ status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: "2026-07-01T00:00:00.000Z", couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial()} />);
    expect(
      await screen.findByText(/Until a lodge's Central lodge link is saved .*shows\s+its free beds as unknown, even for a club with one lodge/),
    ).toBeTruthy();
  });

  it("shows 0 and no message while no API key is stored", async () => {
    versionRouteAnswers({ status: "no-key", serverVersion: "0", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false, apiKeyUpdatedAt: null })} />);

    expect(screen.getByTestId("server-version-actual").textContent).toBe("0");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("server-version-actual").textContent).toBe("0");
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
  });

  it("says could-not-check with the last known answer, and does NOT call it a mismatch", async () => {
    versionRouteAnswers({ status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: "2026-06-30T03:00:00.000Z", couldNotCheck: true, missingBaseUrl: false });
    render(<AlpineServerSetup initialState={initial({ serverVersion: "2.6", serverVersionCheckedAt: "2026-06-30T03:00:00.000Z" })} />);

    const note = await screen.findByTestId("server-version-unchecked");
    expect(note.textContent).toMatch(/Could not check just now/);
    expect(note.textContent).toMatch(/last known 2.6/);
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
    versionRouteAnswers({ status: "unchecked", serverVersion: "0", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: true });
    render(<AlpineServerSetup initialState={initial({ baseUrl: null })} />);
    const note = await screen.findByTestId("server-version-no-address");
    expect(note.textContent).toMatch(/server address is missing/);
    expect(screen.queryByTestId("server-version-unchecked")).toBeNull();
  });

  it("refreshes the numbers from a refused Upload and does not say the pause sentence twice (items 6 and 7)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/alpine-server/version")) {
        return { ok: true, status: 200, json: async () => ({ status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false }) };
      }
      if (String(url).includes("/other-lodges/upload") && init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Syncing with the Alpine Central Server is paused: this site is built for server version 2.6 and the server reports 2.7. Nothing is sent or received until the two match.",
            code: "server-version-mismatch",
            expected: "2.6",
            serverVersion: "2.7",
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<AlpineServerSetup initialState={initial()} />);
    await waitFor(() => expect(screen.getByTestId("server-version-actual").textContent).toBe("2.6"));

    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    await screen.findByTestId("server-version-mismatch");
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.7");
    // No second version call: the 409 carried the numbers.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/version"))).toHaveLength(1);
    // The pause sentence appears ONCE, in the status block; the message points at it.
    expect(screen.getAllByText(/built for server version 2.6 and the server reports 2.7/)).toHaveLength(1);
    expect(screen.getByText(/Upload paused: the server is on a different software version/)).toBeTruthy();
  });

  it("keeps the stored answer when the route itself cannot be reached", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<AlpineServerSetup initialState={initial({ serverVersion: "2.7", serverVersionCheckedAt: "2026-06-30T03:00:00.000Z" })} />);

    await screen.findByTestId("server-version-unchecked");
    // The stored mismatch is still a mismatch: a failed CHECK is not a match.
    expect(screen.getByTestId("server-version-actual").textContent).toBe("2.7");
    expect(screen.getByTestId("server-version-mismatch")).toBeTruthy();
  });
});

describe("AlpineServerSetup Download summary (#64)", () => {
  function downloadAnswers(body: unknown) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/alpine-server/version")) {
        return { ok: true, status: 200, json: async () => ({ status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false }) };
      }
      if (String(url).includes("/other-lodges/download") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => body };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("counts renames and names each lodge that could not be placed, as a warning (#69)", async () => {
    downloadAnswers({
      fetched: 3,
      created: 0,
      updated: 2,
      unchanged: 1,
      renamed: 1,
      nameConflicts: [
        { lodge: null, wanted: "Iwikau Lodge" },
        { lodge: null, wanted: "Tasman Lodge" },
      ],
    });
    render(<AlpineServerSetup initialState={initial()} />);
    fireEvent.click(screen.getByRole("button", { name: /^download$/i }));

    const message = await screen.findByText(
      `Downloaded 3 entries: 0 added, 2 updated (1 renamed), 1 unchanged. Not added, because they could not be matched to one lodge here (the next Download tries again): "Iwikau Lodge", "Tasman Lodge".`,
    );
    expect(message.className).toMatch(/text-warning-11/);
  });

  it("says nothing was uploaded, and keeps the last-upload time, while the owned list is unknown (#69)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/alpine-server/version")) {
        return { ok: true, status: 200, json: async () => ({ status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false }) };
      }
      if (String(url).includes("/other-lodges/upload") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, results: [], sent: 0, ownedUnknown: true }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<AlpineServerSetup initialState={initial()} />);
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    const message = await screen.findByText(
      "Nothing uploaded: press Download first, so this site knows which lodge is yours.",
    );
    expect(message.className).toMatch(/text-warning-11/);
  });

  it("reads as before when nothing was renamed", async () => {
    downloadAnswers({ fetched: 1, created: 1, updated: 0, unchanged: 0, renamed: 0, nameConflicts: [] });
    render(<AlpineServerSetup initialState={initial()} />);
    fireEvent.click(screen.getByRole("button", { name: /^download$/i }));

    const message = await screen.findByText("Downloaded 1 entry: 1 added, 0 updated, 0 unchanged.");
    expect(message.className).toMatch(/text-success-11/);
  });
});

describe("AlpineServerSetup when another sync is running (#66)", () => {
  it.each(["upload", "download"])("shows the route's message when %s is refused because a sync is running", async (direction) => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/alpine-server/version")) {
        return { ok: true, status: 200, json: async () => ({ status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false }) };
      }
      if (String(url).includes(`/other-lodges/${direction}`) && init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "Another sync with the Alpine Central Server is running (the nightly sync, or a press in another window). Try again in a minute; if it was cut off by a restart, it clears within 15 minutes.",
            code: "sync-already-running",
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<AlpineServerSetup initialState={initial()} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${direction}$`, "i") }));

    const message = await screen.findByText(/another sync with the alpine central server is running/i);
    expect(message.textContent).toMatch(/try again in a minute/i);
    // A notice, not an error: nothing failed.
    expect(message.className).toMatch(/text-warning-11/);
    expect(message.className).not.toMatch(/text-destructive/);
    // Not mistaken for the version pause.
    expect(screen.queryByTestId("server-version-mismatch")).toBeNull();
  });
});

describe("AlpineServerSetup Download summary: deletions (#58)", () => {
  function downloadAnswers(body: unknown) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/alpine-server/version")) {
        return { ok: true, status: 200, json: async () => ({ status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false }) };
      }
      if (String(url).includes("/other-lodges/download") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => body };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("names the lodges hidden because the central server deleted them", async () => {
    downloadAnswers({
      fetched: 2,
      created: 0,
      updated: 0,
      unchanged: 2,
      hiddenLodges: ["Ruapehu Hut"],
    });
    render(<AlpineServerSetup initialState={initial()} />);
    fireEvent.click(screen.getByRole("button", { name: /^download$/i }));

    expect(
      await screen.findByText(
        `Downloaded 2 entries: 0 added, 0 updated, 2 unchanged. Deleted on the central server, so hidden here: "Ruapehu Hut".`,
      ),
    ).toBeTruthy();
  });
});

describe("AlpineServerSetup key save names the shown address (#4470)", () => {
  const VERSION = { status: "no-key", serverVersion: null, expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false };

  function keySaveAnswers(answer: { ok: boolean; status: number; body: unknown }) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/admin/alpine-server/version")) {
        return { ok: true, status: 200, json: async () => VERSION };
      }
      if (String(url).includes("/api/admin/integrations/credentials") && init?.method === "POST") {
        return { ok: answer.ok, status: answer.status, json: async () => answer.body };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  function saveKey(value: string) {
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: /save key/i }));
  }

  function postedBody() {
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/integrations/credentials"));
    return JSON.parse(String(call?.[1]?.body));
  }

  it("sends the saved address it shows", async () => {
    keySaveAnswers({ ok: true, status: 200, body: { ok: true } });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false })} />);
    saveKey("acs_new");
    await screen.findByText(/API key stored securely/i);
    expect(postedBody()).toEqual({ provider: "servernz", key: "api_key", value: "acs_new", expectedBaseUrl: "https://central.test" });
  });

  it("keeps Save key off, and says why, while the address field holds an unsaved address", async () => {
    keySaveAnswers({ ok: true, status: 200, body: { ok: true } });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false })} />);
    fireEvent.change(screen.getByLabelText(/server base url/i), { target: { value: "https://typed-not-saved.test" } });
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: "acs_for_typed_server" } });
    const save = screen.getByRole("button", { name: /save key/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId("api-key-address-unsaved").textContent).toMatch(/save the address first/i);
    fireEvent.click(save);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/integrations/credentials"))).toBe(false);
  });

  it("describes the key field and Save key with that hint, and only while it is shown", async () => {
    keySaveAnswers({ ok: true, status: 200, body: { ok: true } });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false })} />);
    const keyField = screen.getByLabelText(/API key/i);
    const save = screen.getByRole("button", { name: /save key/i });
    const describedIds = (element: HTMLElement) => (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(screen.queryByTestId("api-key-address-unsaved")).toBeNull();
    expect(describedIds(keyField)).toEqual([]);

    fireEvent.change(screen.getByLabelText(/server base url/i), { target: { value: "https://typed-not-saved.test" } });
    const hintId = screen.getByTestId("api-key-address-unsaved").id;
    expect(hintId).not.toBe("");
    expect(describedIds(keyField)).toContain(hintId);
    expect(describedIds(save)).toContain(hintId);
    expect(document.getElementById(hintId)?.textContent).toMatch(/save the address first/i);

    fireEvent.change(screen.getByLabelText(/server base url/i), { target: { value: "https://central.test" } });
    expect(screen.queryByTestId("api-key-address-unsaved")).toBeNull();
    expect(describedIds(keyField)).toEqual([]);
    expect(describedIds(save)).not.toContain(hintId);
  });

  it.each([
    ["the saved address with a trailing slash", "https://central.test/"],
    ["the saved address with surrounding spaces", "  https://central.test  "],
  ])("treats %s as the saved address", async (_label, typed) => {
    keySaveAnswers({ ok: true, status: 200, body: { ok: true } });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false })} />);
    fireEvent.change(screen.getByLabelText(/server base url/i), { target: { value: typed } });
    saveKey("acs_new");
    await screen.findByText(/API key stored securely/i);
    expect(screen.queryByTestId("api-key-address-unsaved")).toBeNull();
  });

  it("sends null when no address is saved", async () => {
    keySaveAnswers({ ok: true, status: 200, body: { ok: true } });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false, baseUrl: null })} />);
    saveKey("acs_new");
    await screen.findByText(/API key stored securely/i);
    expect(postedBody().expectedBaseUrl).toBeNull();
  });

  it("tells the admin the address changed and to reload, and does not show the key as stored", async () => {
    keySaveAnswers({
      ok: false,
      status: 409,
      body: { code: "address-changed", error: "The central server address was changed after this page was loaded, so the API key was not saved: it may have been issued for the old address. Reload the page, check the address, and enter the key again." },
    });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false })} />);
    saveKey("acs_old_server");
    const message = await screen.findByText(/address was changed after this page was loaded/i);
    expect(message.textContent).toMatch(/reload the page/i);
    expect(message.className).toMatch(/text-destructive/);
    expect(screen.queryByText(/^stored$/i)).toBeNull();
    expect(screen.getByText(/^not set$/i)).toBeTruthy();
  });

  it("still says to reload when the 409 carries no message", async () => {
    keySaveAnswers({ ok: false, status: 409, body: { code: "address-changed" } });
    render(<AlpineServerSetup initialState={initial({ apiKeySet: false })} />);
    saveKey("acs_old_server");
    expect((await screen.findByText(/address was changed after this page was loaded/i)).textContent).toMatch(/reload the page/i);
  });
});
