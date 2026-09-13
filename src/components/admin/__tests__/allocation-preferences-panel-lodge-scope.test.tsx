// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AllocationPreferencesPanel,
  AllocationPreferencesSection,
} from "../allocation-preferences-section";
import type { SettledLodgeOptionScope } from "@/lib/lodge-option-scope";

/*
  #2937 — the binding contract's lodge-scope states, proved against the ONE
  mount point rather than against whichever host happens to render it today.

  Every test here fails against a NAIVE relocation. A naive move carries the
  board's `lodgeId ? <editor/> : <card/>` shape across, which loses the states
  below the moment the new host's scope is anything but a settled lodge — and it
  leaves the write target in a render-time prop, which is what lets a draft
  cross into a lodge the officer merely switched to.
*/

const LODGE_ONE: SettledLodgeOptionScope = {
  kind: "lodge",
  lodgeId: "lodge-1",
  lodgeName: "Alpine Lodge",
};
const LODGE_TWO: SettledLodgeOptionScope = {
  kind: "lodge",
  lodgeId: "lodge-2",
  lodgeName: "River Lodge",
};

/**
 * A settings reply whose editable half DIFFERS per lodge, so "the wrong lodge's
 * values" shows up as a visible disagreement rather than an accidental pass,
 * and whose read-only provenance is present exactly as the route sends it
 * (#2931).
 */
function settingsFor(lodgeId: string, order?: string[]) {
  return new Response(
    JSON.stringify({
      settings: {
        autoAllocationEnabled: true,
        allocationPriorityOrder:
          order ??
          (lodgeId === "lodge-1"
            ? ["BOOKING_COHESION", "STAY_CONTINUITY"]
            : ["REQUESTED_ROOM"]),
        authoritativeLodgeId: lodgeId,
        settingsId: lodgeId,
        source: "LODGE",
        fallback: "NONE",
        updatedByMemberId: "admin-1",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    }),
    { status: 200 },
  );
}

/** Answers a GET for the lodge its URL names, and echoes a PUT back. */
function scopedFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        lodgeId: string;
        allocationPriorityOrder: string[];
      };
      return settingsFor(body.lodgeId, body.allocationPriorityOrder);
    }
    const lodgeId = new URL(url, "https://example.test").searchParams.get(
      "lodgeId",
    );
    return settingsFor(String(lodgeId));
  });
}

function putCalls(fetchMock: ReturnType<typeof scopedFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AllocationPreferencesPanel lodge scope", () => {
  it("loads, edits and saves only the selected lodge", async () => {
    const fetchMock = scopedFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<AllocationPreferencesPanel scope={LODGE_TWO} canEdit />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    // Every request this card makes names lodge-2 and nothing else.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toContain("lodgeId=lodge-2");
    }

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Disable Honour the requested room" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(putCalls(fetchMock)[0][1]?.body))).toEqual({
      lodgeId: "lodge-2",
      autoAllocationEnabled: true,
      allocationPriorityOrder: [],
    });
  });

  /*
    The four states that must never become write targets, plus the club with no
    active lodge. Each asserts the same two things — nothing was requested, and
    there is no edit path at all — on top of the sentence saying why.
  */
  it.each([
    [
      "all lodges",
      { kind: "all" } as SettledLodgeOptionScope,
      "Preferences are set per lodge. Choose a single lodge to see and edit them.",
    ],
    [
      "a lodge list still arriving",
      { kind: "loading" } as SettledLodgeOptionScope,
      "Loading lodge…",
    ],
    [
      "a failed lodge list",
      { kind: "failed" } as SettledLodgeOptionScope,
      "The lodge list could not be loaded, so preferences cannot be shown or changed. Use Try again above.",
    ],
    [
      "a role that cannot choose a lodge",
      { kind: "forbidden" } as SettledLodgeOptionScope,
      "Preferences are set per lodge, and your admin role cannot choose one. Ask for lodge access if you need to change them.",
    ],
    [
      "a club with no active lodge",
      { kind: "empty" } as SettledLodgeOptionScope,
      "This club has no active lodge, so there are no preferences to show.",
    ],
  ])(
    "stays read-only and fetches nothing for %s",
    async (_name, scope, reason) => {
      const fetchMock = scopedFetch();
      vi.stubGlobal("fetch", fetchMock);
      render(<AllocationPreferencesPanel scope={scope} canEdit />);

      // The card still names itself, so the setting stays VISIBLE as a concept
      // even where it cannot be shown — the contract's "visible, read-only".
      expect(screen.getByText("Allocation preferences")).toBeTruthy();
      expect(screen.getByText(reason)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(
        screen.queryByRole("checkbox", { name: "Auto allocation enabled" }),
      ).toBeNull();
      // Nothing guessed, fetched or invented: no lodge id existed to use.
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("discards a dirty draft when the scope moves to another lodge", async () => {
    const fetchMock = scopedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <AllocationPreferencesPanel scope={LODGE_ONE} canEdit />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Disable Keep each booking together",
      }),
    );
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    view.rerender(<AllocationPreferencesPanel scope={LODGE_TWO} canEdit />);

    // A naive move keeps ONE instance alive across the switch: the edit, the
    // Edit/Save form and the dirty flag all survive, and the next Save writes
    // lodge-1's edits onto lodge-2. Here the draft went with the lodge it
    // belonged to — there is no Save to press, and lodge-2's own values are
    // what is on screen.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // Only an ENABLED priority gets move controls, so these two say which
    // lodge's order is on screen: lodge-2's `REQUESTED_ROOM`, and not the
    // `STAY_CONTINUITY` that lodge-1's abandoned draft had left enabled.
    expect(
      screen.getByRole("button", { name: "Move Honour the requested room up" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Move Keep guests in the same room and bed up",
      }),
    ).toBeNull();
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it("writes a stale draft to the lodge it was loaded from, never to a newly named one", async () => {
    /*
      The second, independent defence — the one that survives a caller dropping
      the `key`. This renders the EDITOR directly and changes its `lodgeId` prop
      underneath it, which is exactly what a host that forgot to key by lodge
      would do. The draft carries its own lodge, so the save cannot reach
      lodge-2; against a render-time write target it would.
    */
    const fetchMock = scopedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <AllocationPreferencesSection lodgeId="lodge-1" canEdit />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Disable Keep each booking together",
      }),
    );

    view.rerender(<AllocationPreferencesSection lodgeId="lodge-2" canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(putCalls(fetchMock)[0][1]?.body))).toEqual({
      lodgeId: "lodge-1",
      autoAllocationEnabled: true,
      allocationPriorityOrder: ["STAY_CONTINUITY"],
    });
  });
});
