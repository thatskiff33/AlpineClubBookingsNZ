// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let lodgeLevel: "edit" | "view" = "edit";
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: lodgeLevel,
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import { LodgeCentralLodgeCard } from "./lodge-central-lodge-card";

/**
 * The "Central lodge" card (#62): what it says in each state, that nothing is
 * saved until Save, that the save carries THIS lodge's id and only the link,
 * and that a lodge:view administrator cannot edit.
 */

const A = { id: "ol_a", name: "Aorangi Ski Club" };
const B = { id: "ol_b", name: "Boomerang Ski Club" };

type GetBody = {
  lodgeId: string;
  lodgeName: string;
  lodgeActive: boolean;
  centralLodgeId: string | null;
  ownedLodges: Array<{ id: string; name: string }> | null;
  defaultCentralLodgeId: string | null;
  otherLodgesEnabled: boolean;
};

function body(over: Partial<GetBody> = {}): GetBody {
  return {
    lodgeId: "lodge_1",
    lodgeName: "Whakapapa",
    lodgeActive: true,
    centralLodgeId: null,
    ownedLodges: [A, B],
    defaultCentralLodgeId: null,
    otherLodgesEnabled: true,
    ...over,
  };
}

const fetchMock = vi.fn();
function serve(get: GetBody, put: GetBody = get) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => (init?.method === "PUT" ? put : get),
  }));
}

beforeEach(() => {
  lodgeLevel = "edit";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LodgeCentralLodgeCard", () => {
  it("says it is linked automatically under the one-lodge default", async () => {
    serve(body({ ownedLodges: [A], defaultCentralLodgeId: "ol_a" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(await screen.findByText(/Linked automatically to Aorangi Ski Club/)).toBeTruthy();
  });

  it("says when the central server has not said which lodges are owned, and offers no editor", async () => {
    serve(body({ ownedLodges: null }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(await screen.findByText(/has not yet said which lodges this club owns/)).toBeTruthy();
    expect(screen.queryByLabelText("Central lodge")).toBeNull();
  });

  it("says when sharing is off", async () => {
    serve(body({ otherLodgesEnabled: false }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(await screen.findByText(/sharing with the Alpine Central Server is off/)).toBeTruthy();
  });

  it("keeps a link to a no-longer-owned lodge visible so it can be cleared", async () => {
    serve(body({ centralLodgeId: "ol_gone" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(await screen.findByText(/no longer says this club owns/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "No longer owned (clear this)" })).toBeTruthy();
  });

  it("saves only the link, for THIS lodge, after Edit and Save — not on change", async () => {
    serve(body(), body({ centralLodgeId: "ol_b" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Central lodge"), { target: { value: "ol_b" } });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save central lodge" }));

    await waitFor(() => expect(screen.getByText(/Linked to Boomerang Ski Club/)).toBeTruthy());
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT")!;
    expect(url).toBe("/api/admin/lodges/lodge_1/central-lodge");
    expect(JSON.parse(init.body)).toEqual({ centralLodgeId: "ol_b" });
  });

  it("gives a lodge:view administrator no working editor", async () => {
    lodgeLevel = "view";
    serve(body());
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    const edit = await screen.findByRole("button", { name: /Edit/ });
    fireEvent.click(edit);
    expect(screen.queryByRole("button", { name: "Save central lodge" })).toBeNull();
  });
});
