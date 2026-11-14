// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
// #1940: the card reads the session permission matrix for view-only gating;
// provide an edit-level admin session so the pre-existing cases keep working.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import { LodgeDisplaySettingsCard } from "./lodge-display-settings-card";

// LTV-035 (#81): the per-lodge display settings card edits THE LODGE BEING
// VIEWED. The old /admin/display/settings surface never sent a lodgeId, so it
// always read and wrote the club default lodge — the MVP bug (old backlog #64)
// where editing a second lodge's config silently edited the default lodge. These
// tests pin the fix: every GET and PUT carries the viewed lodgeId, and a second
// lodge round-trips its own id, never the default.

type GetBody = {
  lodgeId: string;
  lodgeName: string;
  displayConfig: Record<string, string>;
  displayNameGranularity: string | null;
  displayNotice: string | null;
  showGuestPhonesOnScreens: boolean;
};

const fetchMock = vi.fn();

function stubFetch(
  getBodyByLodge: Record<string, GetBody>,
  putResult: { ok: boolean; body?: unknown } = { ok: true, body: { ok: true } },
) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return Promise.resolve({
        ok: putResult.ok,
        json: () => Promise.resolve(putResult.body ?? {}),
      });
    }
    const lodgeId = new URL(url, "http://localhost").searchParams.get("lodgeId")!;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(getBodyByLodge[lodgeId]),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function lodge(overrides: Partial<GetBody>): GetBody {
  return {
    lodgeId: "lodge",
    lodgeName: "Lodge",
    displayConfig: {},
    displayNameGranularity: null,
    displayNotice: null,
    showGuestPhonesOnScreens: false,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LodgeDisplaySettingsCard", () => {
  it("loads the viewed lodge's config, passing its lodgeId to the GET", async () => {
    stubFetch({
      "lodge-whakapapa": lodge({
        lodgeId: "lodge-whakapapa",
        lodgeName: "Whakapapa River Lodge",
        displayConfig: { "wifi-code": "river-5678" },
        displayNameGranularity: "FIRST_NAME_ONLY",
        displayNotice: "Committee meets Sunday",
      }),
    });

    render(<LodgeDisplaySettingsCard lodgeId="lodge-whakapapa" />);

    await waitFor(() =>
      expect(screen.getByDisplayValue("wifi-code")).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/display/lodge-config?lodgeId=lodge-whakapapa",
    );
    expect(screen.getByDisplayValue("river-5678")).toBeTruthy();
    expect(screen.getByDisplayValue("Committee meets Sunday")).toBeTruthy();
  });

  it("saves against the viewed lodge — the PUT carries that lodgeId (regression: old #64 always wrote the default lodge)", async () => {
    stubFetch({
      "lodge-whakapapa": lodge({
        lodgeId: "lodge-whakapapa",
        lodgeName: "Whakapapa River Lodge",
        displayConfig: { "wifi-code": "river-5678" },
      }),
    });

    render(<LodgeDisplaySettingsCard lodgeId="lodge-whakapapa" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("river-5678")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save display settings" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toBe(true),
    );
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    )!;
    expect(putCall[0]).toBe("/api/admin/display/lodge-config");
    const sent = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(sent.lodgeId).toBe("lodge-whakapapa");
    expect(sent.displayConfig).toEqual({ "wifi-code": "river-5678" });
    await screen.findByText("Display settings saved.");
  });

  it("a second lodge edits ITS OWN config, never the default lodge", async () => {
    stubFetch({
      "lodge-grads": lodge({
        lodgeId: "lodge-grads",
        lodgeName: "Grads Mountain Sports Club Lodge",
        displayConfig: { "wifi-code": "grads-1234" },
      }),
    });

    render(<LodgeDisplaySettingsCard lodgeId="lodge-grads" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("grads-1234")).toBeTruthy(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/display/lodge-config?lodgeId=lodge-grads",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save display settings" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toBe(true),
    );
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    )!;
    const sent = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(sent.lodgeId).toBe("lodge-grads");
    expect(sent.lodgeId).not.toBe("lodge-default");
  });

  it("loads and round-trips the guest phone-display toggle (#126 / #37)", async () => {
    stubFetch({
      "lodge-whakapapa": lodge({
        lodgeId: "lodge-whakapapa",
        lodgeName: "Whakapapa River Lodge",
        showGuestPhonesOnScreens: false,
      }),
    });

    render(<LodgeDisplaySettingsCard lodgeId="lodge-whakapapa" />);

    const toggle = (await screen.findByLabelText(
      "Show guest phone numbers on the lobby display",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save display settings" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
        ),
      ).toBe(true),
    );
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    )!;
    const sent = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(sent.showGuestPhonesOnScreens).toBe(true);
  });

  it("surfaces the route's validation error on a bad save (400)", async () => {
    stubFetch(
      { "lodge-grads": lodge({ lodgeId: "lodge-grads" }) },
      {
        ok: false,
        body: {
          error:
            'Config key "Bad Key" must be a lower-case slug (letters, digits, hyphens; max 64 characters)',
        },
      },
    );

    render(<LodgeDisplaySettingsCard lodgeId="lodge-grads" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Save display settings" }));

    await screen.findByText(/must be a lower-case slug/);
  });
});
