// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * After an API key is saved (server onboarding, B1/B2/B5): the page says what
 * registering this site's address came to, then offers to link the club's
 * lodges in a dialog, saving only on Save (#4262) — and links to the lodges
 * page under "Other Clubs details".
 */

vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated", data: { user: { id: "admin-1", accessRoles: ["ADMIN"] } } }),
}));
vi.mock("@/components/club-time-provider", () => ({
  useClubTime: () => ({ instantDateTime: () => "a date" }),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { AlpineServerSetup } from "./alpine-server-setup";

const fetchMock = vi.fn();
const VERSION = { status: "match", serverVersion: "2.6", expected: "2.6", checkedAt: null, couldNotCheck: false, missingBaseUrl: false };

const initialState = {
  apiKeySet: false,
  apiKeyUpdatedAt: null,
  baseUrl: "https://central.test",
  otherLodgesEnabled: true,
  otherLodgesLastUploadAt: null,
  otherLodgesLastDownloadAt: null,
  serverVersion: null,
  serverVersionCheckedAt: null,
};

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

/** The routes the page calls, answering the key save and the link step as given. */
function routes(pushRegistration: string, linkStep?: unknown) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/version")) return json(VERSION);
    if (path.includes("/integrations/credentials")) return json({ ok: true, pushRegistration });
    if (path.includes("/lodge-links") && init?.method === "POST") return json({ download: "downloaded", step: linkStep });
    if (path.includes("/lodge-links") && init?.method === "PUT") return json({ ok: true });
    throw new Error(`unexpected fetch ${path}`);
  });
}

async function saveKey() {
  render(<AlpineServerSetup initialState={initialState} />);
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: "acs_new" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
}

const linkCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/lodge-links"));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("after the API key is saved", () => {
  it("says the address is registered, then offers the one lodge preselected, linked only on Save (#4262)", async () => {
    routes("registered", {
      kind: "choose",
      lodges: [{ id: "l1", name: "Whakapapa", active: true, centralLodgeId: null, suggestedCentralLodgeId: "c_a" }],
      owned: [{ id: "c_a", name: "Whakapapa Lodge", label: "Whakapapa Lodge" }],
    });
    await saveKey();
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByText(/registered with the central server/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Whakapapa") as HTMLSelectElement).value).toBe("c_a");
    expect(linkCalls().filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save links" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const put = linkCalls().find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      links: [{ lodgeId: "l1", centralLodgeId: "c_a", expectCurrent: null }],
    });
  });

  it("asks for the server address when there is none, without linking lodges", async () => {
    routes("no-address");
    await saveKey();
    await waitFor(() => expect(screen.getByText(/Save the server base URL above/)).toBeTruthy());
    expect(linkCalls()).toHaveLength(0);
  });

  it("waits for the server's approval without trying to link lodges", async () => {
    routes("awaiting-approval");
    await saveKey();
    await waitFor(() => expect(screen.getByText(/has not approved this club's connection yet/)).toBeTruthy());
    expect(linkCalls()).toHaveLength(0);
  });

  it("explains a poll-only site and still links lodges", async () => {
    routes("not-https", { kind: "no-owned" });
    await saveKey();
    await waitFor(() => expect(screen.getByTestId("lodge-link-status").textContent).toContain("does not list a lodge for this club"));
    expect(screen.getByText(/address is not https/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks which lodge is which: current link or suggestion preselected, a chosen lodge disabled elsewhere, Save sends the changed rows", async () => {
    routes("registered", {
      kind: "choose",
      lodges: [
        { id: "l1", name: "Iwikau", active: true, centralLodgeId: "c_b", suggestedCentralLodgeId: null },
        { id: "l2", name: "Whakapapa", active: true, centralLodgeId: null, suggestedCentralLodgeId: null },
      ],
      owned: [
        { id: "c_a", name: "Whakapapa Lodge", label: "Whakapapa Lodge" },
        { id: "c_b", name: "Iwikau Lodge", label: "Iwikau Lodge" },
      ],
    });
    await saveKey();
    const dialog = await screen.findByRole("dialog");
    const iwikau = within(dialog).getByLabelText("Iwikau") as HTMLSelectElement;
    const whakapapa = within(dialog).getByLabelText("Whakapapa") as HTMLSelectElement;
    expect(iwikau.value).toBe("c_b");
    expect(whakapapa.value).toBe("");
    // c_b is Iwikau's, so Whakapapa cannot take it.
    expect((within(whakapapa).getByRole("option", { name: "Iwikau Lodge" }) as HTMLOptionElement).disabled).toBe(true);

    fireEvent.change(whakapapa, { target: { value: "c_a" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save links" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const put = linkCalls().find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      links: [{ lodgeId: "l2", centralLodgeId: "c_a", expectCurrent: null }],
    });
    expect(screen.getByTestId("lodge-link-status").textContent).toBe("Lodge links saved.");
  });

});

describe("Other Clubs details", () => {
  it("links to every lodge's details", async () => {
    routes("registered");
    render(<AlpineServerSetup initialState={initialState} />);
    expect(screen.getByRole("link", { name: "View all lodge details" }).getAttribute("href")).toBe("/admin/lodges");
  });
});
