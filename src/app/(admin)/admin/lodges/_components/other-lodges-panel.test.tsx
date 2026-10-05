// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

// The panel reads the session permission matrix for view-only gating (#1940).
// `lodgeLevel` is switched per test so both an editing and a view-only admin
// are covered.
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

import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import type { SerializedOtherLodge } from "@/lib/other-lodges";
import { OtherLodgesPanel } from "./other-lodges-panel";

// #51: the add/edit form opens in a popup dialog over the list, not as a card
// inserted above it. These pin what the issue asked for: it opens on Add/Edit,
// nothing is inserted above the list, a save error is shown INSIDE the dialog,
// a click on the background does not close it, Escape and Cancel do, Escape is
// ignored while a save is in flight, and a view-only admin cannot open it.

const fetchMock = vi.fn();

function lodge(over: Partial<SerializedOtherLodge> = {}): SerializedOtherLodge {
  return {
    id: "ol-1",
    name: "Tararua Lodge",
    location: "Otaki Forks",
    bookingOfficerName: null,
    bookingOfficerEmail: null,
    bookingOfficerPhone: null,
    bedCapacity: 24,
    siteUrl: null,
    bookingPath: null,
    cancellationPeriod: null,
    requiresLodgeCustodian: false,
    freeWifi: false,
    quietRoom: false,
    dryingRoom: false,
    sharedKitchen: false,
    wheelchairAccessible: false,
    breakfastIncluded: false,
    lunchIncluded: false,
    dinnerIncluded: false,
    winterSeasonStart: null,
    summerSeasonStart: null,
    amenities: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

type Pending = { resolve: (value: unknown) => void };

/** GET returns the lodges; any write is answered by `onWrite`. */
function stubFetch(
  lodges: SerializedOtherLodge[],
  onWrite: (init: RequestInit) => Promise<unknown> | unknown = () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }),
) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") return onWrite(init);
    return { ok: true, status: 200, json: async () => ({ otherLodges: lodges }) };
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function renderPanel() {
  render(<OtherLodgesPanel ancestorRendersViewOnlyBanner />);
  await screen.findByText("Tararua Lodge");
}

beforeEach(() => {
  lodgeLevel = "edit";
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Other lodges add/edit popup (#51)", () => {
  it("opens the edit form in a dialog, not above the list", async () => {
    stubFetch([lodge()]);
    await renderPanel();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit other lodge")).toBeTruthy();
    // The form lives inside the dialog and nowhere else on the page.
    const nameInputs = screen.getAllByLabelText("Name");
    expect(nameInputs).toHaveLength(1);
    expect(dialog.contains(nameInputs[0])).toBe(true);
    expect((nameInputs[0] as HTMLInputElement).value).toBe("Tararua Lodge");
    // The list is still there behind it.
    expect(screen.getByText("Otaki Forks")).toBeTruthy();
  });

  it("opens an empty form in a dialog for Add other lodge", async () => {
    stubFetch([lodge()]);
    await renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /add other lodge/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Add other lodge")).toBeTruthy();
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("");
  });

  it("shows a validation error inside the dialog, not on the page behind it", async () => {
    stubFetch([lodge()]);
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /add other lodge/i }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    // Exactly one alert on the page — hidden ones included, because a dialog
    // hides everything behind it from the accessibility tree — and it is the
    // one in the dialog.
    expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
    // Nothing was sent: the form refused it before any request.
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("shows a save failure inside the dialog and keeps what was typed", async () => {
    stubFetch([lodge()], () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "A lodge with that name already exists." }),
    }));
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /add other lodge/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Tararua Lodge" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("A lodge with that name already exists.");
    expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
    // Still open, still holding the typed value.
    expect((within(screen.getByRole("dialog")).getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Tararua Lodge",
    );
  });

  it("closes after a successful save and refreshes the list", async () => {
    stubFetch([lodge()]);
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Tararua Lodge (renamed)" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/api/admin/other-lodges/ol-1");
    // The list was loaded again after the save (GET twice: first load + refresh).
    const gets = fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET");
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT close when the dimmed background is clicked", async () => {
    stubFetch([lodge()]);
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    await screen.findByRole("dialog");

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes on Escape, and on Cancel, discarding the edit", async () => {
    stubFetch([lodge()]);
    await renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Changed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Nothing was written, and reopening shows the stored name, not "Changed".
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Tararua Lodge");
  });

  it("ignores Escape and the close button while a save is in flight", async () => {
    const pending: Pending = { resolve: () => undefined };
    stubFetch([lodge()], () => new Promise((resolve) => (pending.resolve = resolve)));
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await within(dialog).findByRole("button", { name: /saving/i });

    // No clickable close button that does nothing: it is hidden while saving.
    expect(within(dialog).queryByRole("button", { name: /^close$/i })).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Once the save lands, the dialog closes.
    pending.resolve({ ok: true, status: 200, json: async () => ({}) });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("returns focus to the Edit button that opened it", async () => {
    stubFetch([lodge()]);
    await renderPanel();
    const editButton = screen.getByRole("button", { name: /^edit$/i });
    // NOT focused first: a click does not focus a button in every browser
    // (Safari, Firefox on macOS), and jsdom's fireEvent.click does not either.
    // Radix would then restore focus to the page body, so only the panel's own
    // return-to-opener can pass this.
    expect(document.activeElement).not.toBe(editButton);
    fireEvent.click(editButton);
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The same button is still mounted (a refresh keeps the table), so focus
    // has somewhere to return to, and it HOLDS it once everything has settled.
    expect(screen.getByRole("button", { name: /^edit$/i })).toBe(editButton);
    await expectRecoveryAlertToHoldFocus(editButton);
  });

  it("returns focus to the Add button that opened it", async () => {
    stubFetch([lodge()]);
    await renderPanel();
    const addButton = screen.getByRole("button", { name: /add other lodge/i });
    fireEvent.click(addButton);
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await expectRecoveryAlertToHoldFocus(addButton);
  });

  it("keeps the table (and the Edit button's focus target) while the list refreshes after a SAVE", async () => {
    // The refresh after a save is held open by hand, so the "list is loading"
    // state is actually on screen when we look; an instantly-answered mock lets
    // React batch it away and the check proves nothing.
    let gets = 0;
    let releaseRefresh: () => void = () => undefined;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        // The server answers a save with the saved lodge.
        return {
          ok: true,
          status: 200,
          json: async () => ({ otherLodge: lodge({ name: "Tararua Lodge (renamed)" }) }),
        };
      }
      gets += 1;
      if (gets > 1) await new Promise<void>((resolve) => (releaseRefresh = resolve));
      return { ok: true, status: 200, json: async () => ({ otherLodges: [lodge()] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();
    const editButton = screen.getByRole("button", { name: /^edit$/i });
    fireEvent.click(editButton);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Tararua Lodge (renamed)" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(gets).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Refresh still in flight: a spinner in place of the table would have
    // unmounted this button, leaving focus nowhere to return to.
    expect(screen.queryByText(/loading other lodges/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBe(editButton);
    await expectRecoveryAlertToHoldFocus(editButton);
    // And the saved name is on screen already, not the stale one: an Edit click
    // on the old row during the refresh cannot overwrite this save.
    expect(screen.getByText("Tararua Lodge (renamed)")).toBeTruthy();
    expect(screen.queryByText("Tararua Lodge")).toBeNull();

    releaseRefresh();
    await waitFor(() => expect(screen.getByRole("button", { name: /^edit$/i })).toBe(editButton));
  });

  it("a discarded edit's error does not reappear on the page after the dialog closes", async () => {
    stubFetch([lodge()]);
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /add other lodge/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await within(dialog).findByRole("alert");

    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(screen.queryByRole("alert", { hidden: true })).toBeNull();

    // Same for Escape.
    fireEvent.click(screen.getByRole("button", { name: /add other lodge/i }));
    const second = await screen.findByRole("dialog");
    fireEvent.click(within(second).getByRole("button", { name: /^save$/i }));
    await within(second).findByRole("alert");
    fireEvent.keyDown(second, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alert", { hidden: true })).toBeNull();
  });

  it("shows the error directly above Save and Cancel, after the fields", async () => {
    stubFetch([lodge()]);
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /add other lodge/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    const alert = await within(dialog).findByRole("alert");

    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    // After the last field of the form, before the buttons it explains.
    expect(follows(within(dialog).getByLabelText("Name"), alert)).toBe(true);
    expect(
      follows(within(dialog).getByRole("button", { name: /add amenity/i }), alert),
    ).toBe(true);
    expect(follows(alert, within(dialog).getByRole("button", { name: /^save$/i }))).toBe(true);
    expect(follows(alert, within(dialog).getByRole("button", { name: /^cancel$/i }))).toBe(true);
  });

  it("applies the results of overlapping refreshes newest-first, never letting an older one win", async () => {
    // A save's refresh and a delete's refresh can be in flight together. If the
    // older response arrived last it would put back the row the newer one removed.
    const releases: Array<() => void> = [];
    const answers: SerializedOtherLodge[][] = [[lodge()], [lodge()], []];
    let get = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return { ok: true, status: 200, json: async () => ({ otherLodge: lodge() }) };
      }
      if (init?.method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const mine = get;
      get += 1;
      if (mine >= 1) await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true, status: 200, json: async () => ({ otherLodges: answers[mine] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", () => true);
    await renderPanel();

    // Save -> refresh #1 (held open).
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(releases).toHaveLength(1));

    // Delete -> refresh #2 (held open), while #1 is still pending.
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(releases).toHaveLength(2));

    // The NEWER refresh answers first (the lodge is gone), then the older one
    // answers late with the stale list that still contains it.
    releases[1]();
    await screen.findByText(/no other lodges yet/i);
    releases[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("Tararua Lodge")).toBeNull();
    expect(screen.getByText(/no other lodges yet/i)).toBeTruthy();
  });

  it("a view-only admin cannot open the add or edit dialog", async () => {
    lodgeLevel = "view";
    stubFetch([lodge()]);
    await renderPanel();

    const add = screen.getByRole("button", { name: /add other lodge/i });
    const edit = screen.getByRole("button", { name: /^edit$/i });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect((edit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(add);
    fireEvent.click(edit);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a failed delete shows its error on the page, since no dialog is open", async () => {
    stubFetch([lodge()], () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "This lodge is used by a booking." }),
    }));
    vi.stubGlobal("confirm", () => true);
    await renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This lodge is used by a booking.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
