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
  answersForCentralLodgeId: string | null;
  linkHeldBy: string | null;
  suggestedCentralLodgeId: string | null;
  otherLodgesEnabled: boolean;
  registeredWithCentralServer: boolean;
};

function body(over: Partial<GetBody> = {}): GetBody {
  return {
    lodgeId: "lodge_1",
    lodgeName: "Whakapapa",
    lodgeActive: true,
    centralLodgeId: null,
    ownedLodges: [A, B],
    answersForCentralLodgeId: null,
    linkHeldBy: null,
    suggestedCentralLodgeId: null,
    otherLodgesEnabled: true,
    registeredWithCentralServer: true,
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
  // #4262 (owner decision, 24 Oct 2026): every club links explicitly. A
  // one-lodge club is offered its only central lodge, preselected on Edit,
  // and nothing is linked (or answered) until Save.
  it("never says a one-lodge club is linked automatically: it is not linked until Save", async () => {
    serve(body({ ownedLodges: [A], suggestedCentralLodgeId: "ol_a" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(
      await screen.findByText(/Not linked yet, so the central server's lodge search shows its free beds as unknown\. Click Edit: Aorangi Ski Club is chosen for you, and Save links it\./),
    ).toBeTruthy();
    expect(screen.queryByText(/automatically/i)).toBeNull();
    const select = screen.getByRole("combobox", { name: "Central lodge" }) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "Not linked" })).toBeTruthy();
  });

  it("preselects the suggestion on Edit and links it only on Save", async () => {
    serve(
      body({ ownedLodges: [A], suggestedCentralLodgeId: "ol_a" }),
      body({ ownedLodges: [A], centralLodgeId: "ol_a", answersForCentralLodgeId: "ol_a" }),
    );
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const select = screen.getByRole("combobox", { name: "Central lodge" }) as HTMLSelectElement;
    expect(select.value).toBe("ol_a");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    const save = screen.getByRole("button", { name: "Save central lodge" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.click(save);

    await waitFor(() => expect(screen.getByText(/Linked to Aorangi Ski Club/)).toBeTruthy());
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT")!;
    expect(JSON.parse(init.body)).toEqual({ centralLodgeId: "ol_a" });
  });

  it("leaves the lodge unlinked when the preselected Edit is cancelled", async () => {
    serve(body({ ownedLodges: [A], suggestedCentralLodgeId: "ol_a" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const select = screen.getByRole("combobox", { name: "Central lodge" }) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("says an unlinked lodge with no suggestion must be chosen and saved", async () => {
    serve(body());
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(await screen.findByText(/Not linked, so the central server's lodge search shows its free beds as unknown\. Click Edit, choose/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByRole("combobox", { name: "Central lodge" }) as HTMLSelectElement).value).toBe("");
  });

  it("says when the central server has not said which lodges are owned, and offers no editor", async () => {
    serve(body({ ownedLodges: null }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(await screen.findByText(/has not yet said which lodges this club owns/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Central lodge" })).toBeNull();
  });

  it("says why nothing is answered when another lodge holds the link", async () => {
    serve(body({ ownedLodges: [A], linkHeldBy: "Old Hut" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(await screen.findByText(/linked to Old Hut\. Unlink it there/)).toBeTruthy();
  });

  it("says when this site has not registered with the central server", async () => {
    serve(body({ registeredWithCentralServer: false, centralLodgeId: "ol_a" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(await screen.findByText(/has not registered with the central server/)).toBeTruthy();
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
    serve(body(), body({ centralLodgeId: "ol_b", answersForCentralLodgeId: "ol_b" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Central lodge" }), { target: { value: "ol_b" } });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save central lodge" }));

    await waitFor(() => expect(screen.getByText(/Linked to Boomerang Ski Club/)).toBeTruthy());
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT")!;
    expect(url).toBe("/api/admin/lodges/lodge_1/central-lodge");
    expect(JSON.parse(init.body)).toEqual({ centralLodgeId: "ol_b" });
  });

  // #4262 review (C1): before Save the lodge answers as it did, so the status
  // line describes the SAVED link, never the choice in the editor.
  it("never says Linked to before Save, and says the change is not saved yet", async () => {
    serve(body({ ownedLodges: [A], suggestedCentralLodgeId: "ol_a" }));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect((screen.getByRole("combobox", { name: "Central lodge" }) as HTMLSelectElement).value).toBe("ol_a");
    expect(screen.queryByText(/Linked to/)).toBeNull();
    expect(screen.getByText(/Not linked yet.*Your change is not saved yet\./)).toBeTruthy();
  });

  // #4262 review (C2): a lodge:view administrator cannot Edit, so is not told to.
  it.each([
    ["with a suggestion", { ownedLodges: [A], suggestedCentralLodgeId: "ol_a" }],
    ["without one", {}],
  ])("tells a lodge:view administrator who can link it, not to click Edit (%s)", async (_case, over) => {
    lodgeLevel = "view";
    serve(body(over));
    render(<LodgeCentralLodgeCard lodgeId="lodge_1" />);
    expect(
      await screen.findByText(/An administrator with lodge edit access needs to choose this lodge's entry and save it\./),
    ).toBeTruthy();
    expect(screen.queryByText(/Click Edit/)).toBeNull();
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
