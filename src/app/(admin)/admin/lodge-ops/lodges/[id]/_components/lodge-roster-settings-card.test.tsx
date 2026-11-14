// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// The card reads the session permission matrix for view-only gating (#1940).
// `lodge` is switched per test through this variable so the same mock serves
// both the edit-capable and the view-only cases.
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

import { LodgeRosterSettingsCard } from "./lodge-roster-settings-card";

/**
 * The member lodge roster's per-lodge name-detail card (#2942).
 *
 * What these cases are actually protecting, in order of how badly each would
 * hurt if it broke:
 *
 *  - the card must be usable while the roster module is OFF, because choosing
 *    the disclosure level before switching the feature on is the whole point of
 *    it being a separate setting;
 *  - nothing may persist until Save, so an administrator reading the options
 *    cannot publish full names by opening a dropdown;
 *  - the write must carry THIS lodge's id, the defect its sibling display card
 *    was built to fix (old backlog #64, where editing a second lodge silently
 *    edited the default one);
 *  - a lodge:view administrator gets no working editor.
 */

type GetBody = {
  lodgeId: string;
  lodgeName: string;
  rosterNameGranularity: string | null;
  defaultRosterNameGranularity: string;
  memberLodgeRosterEnabled: boolean;
};

const fetchMock = vi.fn();

function body(overrides: Partial<GetBody> = {}): GetBody {
  return {
    lodgeId: "lodge-whakapapa",
    lodgeName: "Whakapapa River Lodge",
    rosterNameGranularity: null,
    defaultRosterNameGranularity: "FULL_NAME",
    memberLodgeRosterEnabled: true,
    ...overrides,
  };
}

function stubFetch(
  getBody: GetBody,
  putResult: { ok: boolean; status?: number; body?: unknown } = { ok: true },
) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return Promise.resolve({
        ok: putResult.ok,
        status: putResult.status ?? (putResult.ok ? 200 : 500),
        json: () =>
          Promise.resolve(
            putResult.body ??
              body({
                rosterNameGranularity: JSON.parse(
                  String(init.body),
                ).rosterNameGranularity,
              }),
          ),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(getBody) });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function putCalls() {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
  );
}

beforeEach(() => {
  lodgeLevel = "edit";
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LodgeRosterSettingsCard", () => {
  it("reads this lodge's setting, naming the lodge in the URL", async () => {
    stubFetch(body({ rosterNameGranularity: "FIRST_NAME_ONLY" }));
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/admin/lodges/lodge-whakapapa/roster-settings",
    );
    const select = await screen.findByLabelText("Name detail on the roster");
    expect((select as HTMLSelectElement).value).toBe("FIRST_NAME_ONLY");
  });

  it("labels the no-choice option with the default the SERVER reported", async () => {
    // Not with a default restated in the card. The roster's fallback is
    // deliberately not the lobby display's, and a copy here could drift from
    // the one the roster actually applies.
    stubFetch(body({ defaultRosterNameGranularity: "COUNTS_ONLY" }));
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    expect(
      await screen.findByText("Use the default (Counts only (no names))"),
    ).toBeTruthy();
  });

  it("stays usable, and says so, while the roster module is off", async () => {
    stubFetch(body({ memberLodgeRosterEnabled: false }));
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    expect(
      await screen.findByText(/The member roster is off/),
    ).toBeTruthy();
    // The editor is still here: an administrator sets the level BEFORE
    // switching the roster on.
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(
      (
        (await screen.findByLabelText(
          "Name detail on the roster",
        )) as HTMLSelectElement
      ).disabled,
    ).toBe(false);
  });

  it("persists nothing until Save, and then sends only the level", async () => {
    stubFetch(body());
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Name detail on the roster"), {
      target: { value: "FIRST_NAME_SURNAME_INITIAL" },
    });
    // Changing the control writes nothing on its own.
    expect(putCalls()).toHaveLength(0);

    fireEvent.click(
      await screen.findByRole("button", { name: "Save roster name detail" }),
    );
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const [url, init] = putCalls()[0];
    expect(String(url)).toBe(
      "/api/admin/lodges/lodge-whakapapa/roster-settings",
    );
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      rosterNameGranularity: "FIRST_NAME_SURNAME_INITIAL",
    });
  });

  it("clears the per-lodge choice back to null", async () => {
    stubFetch(body({ rosterNameGranularity: "COUNTS_ONLY" }));
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Name detail on the roster"), {
      target: { value: "" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Save roster name detail" }),
    );

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(
      JSON.parse(String((putCalls()[0][1] as RequestInit).body)),
    ).toEqual({ rosterNameGranularity: null });
  });

  it("restores the saved value on Cancel and writes nothing", async () => {
    stubFetch(body({ rosterNameGranularity: "FULL_NAME" }));
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Name detail on the roster"), {
      target: { value: "COUNTS_ONLY" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(
      (
        (await screen.findByLabelText(
          "Name detail on the roster",
        )) as HTMLSelectElement
      ).value,
    ).toBe("FULL_NAME");
    expect(putCalls()).toHaveLength(0);
  });

  it("refuses a pristine save, so an unchanged draft cannot write an audit row", async () => {
    stubFetch(body({ rosterNameGranularity: "FULL_NAME" }));
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const save = await screen.findByRole("button", {
      name: "Save roster name detail",
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives a lodge:view admin the banner and no working editor", async () => {
    lodgeLevel = "view";
    stubFetch(body());
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    expect(
      await screen.findByText(
        /can see how much of a name the member roster shows but cannot change it/,
      ),
    ).toBeTruthy();
    const edit = await screen.findByRole("button", { name: "Edit" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces a rejected save rather than reporting success", async () => {
    stubFetch(body(), {
      ok: false,
      status: 400,
      body: { error: "That setting could not be saved." },
    });
    render(<LodgeRosterSettingsCard lodgeId="lodge-whakapapa" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Name detail on the roster"), {
      target: { value: "FIRST_NAME_ONLY" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Save roster name detail" }),
    );

    expect(
      await screen.findByText("That setting could not be saved."),
    ).toBeTruthy();
    expect(screen.queryByText("Roster name detail saved.")).toBeNull();
  });
});
