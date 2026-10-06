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
import {
  OTHER_LODGE_NOT_OWNED_CODE,
  type AdminOtherLodge,
  type AdminOtherLodgesResponse,
} from "@/lib/other-lodges";
import { OtherLodgesPanel } from "./other-lodges-panel";

// #52: a site changes only the lodge(s) the central server says it owns. The
// list has no Add, Edit or Delete; each OWNED lodge gets one "Edit my Lodge"
// button (named when there are several) that opens the #51 popup with the name
// read-only; the panel is read-only with a note while the owned list is
// unknown or empty; and no booking officer's phone is shown in the list.
//
// The #51 popup pins (opens over the list, error INSIDE the dialog above Save,
// background click does not close, Escape and Cancel do, Escape ignored while
// saving, focus returns to the opener, newest refresh wins, view-only admin
// cannot open it) are kept, now opened through Edit my Lodge.

const fetchMock = vi.fn();

function lodge(over: Partial<AdminOtherLodge> = {}): AdminOtherLodge {
  return {
    id: "ol-1",
    name: "Tararua Lodge",
    location: "Otaki Forks",
    bookingOfficerName: "Ann Officer",
    bookingOfficerEmail: "bookings@tararua.test",
    bookingOfficerPhone: "021 555 0000",
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
    owned: true,
    ...over,
  };
}

/** Another club's lodge as the API sends it: not owned, and NO phone key. */
function theirs(over: Partial<AdminOtherLodge> = {}): AdminOtherLodge {
  const { bookingOfficerPhone: _dropped, ...rest } = lodge({
    id: "ol-2",
    name: "Ruapehu Hut",
    location: "Whakapapa",
    bookingOfficerName: "Sam Officer",
    bookingOfficerEmail: "bookings@ruapehu.test",
    owned: false,
    ...over,
  });
  void _dropped;
  return rest;
}

type Pending = { resolve: (value: unknown) => void };

/** GET returns the list; any write is answered by `onWrite`. */
function stubFetch(
  body: AdminOtherLodgesResponse,
  onWrite: (init: RequestInit) => Promise<unknown> | unknown = () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }),
) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") return onWrite(init);
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The common case: one owned lodge (ours) and one other club's. */
function oneOwned(): AdminOtherLodgesResponse {
  return {
    otherLodges: [lodge(), theirs()],
    ownedLodgeNames: ["Tararua Lodge"],
    serverVersionStatus: "match",
  };
}

async function renderPanel() {
  render(<OtherLodgesPanel ancestorRendersViewOnlyBanner />);
  await screen.findByText("Tararua Lodge");
}

const editMyLodge = () => screen.getByRole("button", { name: /edit my lodge/i });

beforeEach(() => {
  lodgeLevel = "edit";
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Other lodges: only the site's own lodge is editable (#52)", () => {
  it("offers no Add, Edit or Delete, and one Edit my Lodge for the one owned lodge", async () => {
    stubFetch(oneOwned());
    await renderPanel();

    expect(screen.queryByRole("button", { name: /add other lodge/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull();
    // Exactly one, on the owned row; the other club's row has no button.
    const buttons = screen.getAllByRole("button", { name: /^edit/i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toMatch(/edit my lodge/i);
    const theirRow = screen.getByText("Ruapehu Hut").closest("tr") as HTMLElement;
    expect(within(theirRow).queryByRole("button")).toBeNull();
  });

  it("names each button when the site owns several lodges", async () => {
    stubFetch({
      otherLodges: [
        lodge(),
        lodge({ id: "ol-3", name: "Tararua Annex", owned: true }),
        theirs(),
      ],
      ownedLodgeNames: ["Tararua Lodge", "Tararua Annex"],
      serverVersionStatus: "match",
    });
    await renderPanel();

    expect(screen.getByRole("button", { name: "Edit Tararua Lodge" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Tararua Annex" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /edit my lodge/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^edit/i })).toHaveLength(2);
  });

  it("opens the popup for the owned lodge with its name READ-ONLY", async () => {
    stubFetch(oneOwned());
    await renderPanel();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(editMyLodge());

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit my Lodge")).toBeTruthy();
    const name = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Tararua Lodge");
    // The central server matches lodges by name; a rename here would create a
    // second lodge there. The route refuses it too — this is the UI half.
    expect(name.readOnly).toBe(true);
    expect(within(dialog).getByText(/cannot be changed here/i)).toBeTruthy();
    // The rest of the form is still editable, including the phone.
    expect((within(dialog).getByLabelText("Booking officer's phone") as HTMLInputElement).readOnly).toBe(false);
    expect((within(dialog).getByLabelText("Booking officer's phone") as HTMLInputElement).value).toBe("021 555 0000");
    // The list is still there behind it.
    expect(screen.getByText("Otaki Forks")).toBeTruthy();
  });

  it("shows no booking officer phone anywhere in the list, including the owned row", async () => {
    stubFetch(oneOwned());
    await renderPanel();

    expect(screen.queryByText("021 555 0000")).toBeNull();
    // Name and email are still shown.
    expect(screen.getByText("Ann Officer")).toBeTruthy();
    expect(screen.getByText("bookings@tararua.test")).toBeTruthy();
    expect(screen.getByText("Sam Officer")).toBeTruthy();
  });

  it("is read-only with a note, and no buttons, while the owned list is UNKNOWN", async () => {
    stubFetch({
      otherLodges: [lodge({ owned: false }), theirs()],
      ownedLodgeNames: null,
      serverVersionStatus: "match",
    });
    await renderPanel();

    expect(screen.queryByRole("button", { name: /^edit/i })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /actions/i })).toBeNull();
    const note = screen.getByTestId("owned-unknown");
    expect(note.textContent).toMatch(/set on the central server/i);
    expect(note.textContent).toMatch(/download/i);
    expect(screen.queryByTestId("owned-none")).toBeNull();
  });

  it("is read-only with a different note while the owned list is known but EMPTY", async () => {
    stubFetch({
      otherLodges: [lodge({ owned: false }), theirs()],
      ownedLodgeNames: [],
      serverVersionStatus: "match",
    });
    await renderPanel();

    expect(screen.queryByRole("button", { name: /^edit/i })).toBeNull();
    const note = screen.getByTestId("owned-none");
    expect(note.textContent).toMatch(/no lodge assigned to this site/i);
    expect(screen.queryByTestId("owned-unknown")).toBeNull();
  });

  it("says syncing is paused, linking to setup, while the server version differs (#49)", async () => {
    stubFetch({ ...oneOwned(), serverVersionStatus: "mismatch" });
    await renderPanel();

    const note = screen.getByTestId("server-version-paused");
    expect(note.textContent).toMatch(/paused/i);
    expect(note.textContent).toMatch(/different software version/i);
    const link = within(note).getByRole("link", { name: /setup page/i });
    expect(link.getAttribute("href")).toBe("/admin/alpine-server/setup");
    // The list is still shown, and the owned lodge is still editable: a pause
    // stops the transfer, not the local edit.
    expect(screen.getByText("Tararua Lodge")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^edit/i })).toBeTruthy();
  });

  it("shows no paused note while the versions match, are unchecked, or no key is stored (#49)", async () => {
    for (const status of ["match", "unchecked", "no-key"] as const) {
      cleanup();
      stubFetch({ ...oneOwned(), serverVersionStatus: status });
      await renderPanel();
      expect(screen.queryByTestId("server-version-paused")).toBeNull();
    }
  });

  it("shows no note once the owned list is known and an owned row is on screen", async () => {
    stubFetch(oneOwned());
    await renderPanel();
    expect(screen.queryByTestId("owned-unknown")).toBeNull();
    expect(screen.queryByTestId("owned-none")).toBeNull();
    expect(screen.queryByTestId("owned-not-downloaded")).toBeNull();
  });

  it("explains, with no button, when the server names a lodge that has not been downloaded yet", async () => {
    // The list says "Tararua Lodge" but no local row carries that name.
    stubFetch({
      otherLodges: [theirs()],
      ownedLodgeNames: ["Tararua Lodge"],
      serverVersionStatus: "match",
    });
    render(<OtherLodgesPanel ancestorRendersViewOnlyBanner />);
    await screen.findByText("Ruapehu Hut");

    expect(screen.queryByRole("button", { name: /^edit/i })).toBeNull();
    const note = screen.getByTestId("owned-not-downloaded");
    expect(note.textContent).toMatch(/Tararua Lodge/);
    expect(note.textContent).toMatch(/not been downloaded/i);
    expect(note.textContent).toMatch(/download/i);
    expect(screen.queryByTestId("owned-unknown")).toBeNull();
    expect(screen.queryByTestId("owned-none")).toBeNull();
  });

  it("labels the button by the owned rows ON SCREEN, not by the server's count", async () => {
    // The server names two lodges; only one has been downloaded. One button,
    // and it reads "Edit my Lodge" rather than naming a lodge to tell it apart
    // from a sibling that is not there.
    stubFetch({
      otherLodges: [lodge(), theirs()],
      ownedLodgeNames: ["Tararua Lodge", "Tararua Annex"],
      serverVersionStatus: "match",
    });
    await renderPanel();

    expect(screen.getAllByRole("button", { name: /^edit/i })).toHaveLength(1);
    expect(editMyLodge()).toBeTruthy();
    expect(screen.queryByTestId("owned-not-downloaded")).toBeNull();
  });

  it("a view-only admin cannot open the popup", async () => {
    lodgeLevel = "view";
    stubFetch(oneOwned());
    await renderPanel();

    const edit = editMyLodge();
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(edit);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the route's own ownership refusal inside the dialog, and the generic one for a bare 403", async () => {
    stubFetch(oneOwned(), () => ({
      ok: false,
      status: 403,
      json: async () => ({
        error: "Only this site's own lodge can be changed here.",
        code: OTHER_LODGE_NOT_OWNED_CODE,
      }),
    }));
    await renderPanel();
    fireEvent.click(editMyLodge());
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    let alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Only this site's own lodge can be changed here.");
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // A permissions 403 carries no code: the generic view-only message.
    stubFetch(oneOwned(), () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden" }),
    }));
    fireEvent.click(editMyLodge());
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/cannot make changes/i);
  });
});

describe("Other lodges edit popup (#51, opened through Edit my Lodge)", () => {
  it("shows a validation error inside the dialog, not on the page behind it", async () => {
    stubFetch(oneOwned());
    await renderPanel();
    fireEvent.click(editMyLodge());
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bed capacity"), {
      target: { value: "999999" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    const alert = await within(dialog).findByRole("alert");
    // Over the shared bound, which jsdom lets through a number input (a
    // non-numeric value it would sanitise to empty before the form saw it).
    expect(alert.textContent).toMatch(/too large/i);
    // Exactly one alert on the page — hidden ones included, because a dialog
    // hides everything behind it from the accessibility tree — and it is the
    // one in the dialog.
    expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
    // Nothing was sent: the form refused it before any request.
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("shows a save failure inside the dialog and keeps what was typed", async () => {
    stubFetch(oneOwned(), () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid input" }),
    }));
    await renderPanel();
    fireEvent.click(editMyLodge());
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Location"), {
      target: { value: "Otaki Forks, Tararua Range" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Invalid input");
    expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
    // Still open, still holding the typed value.
    expect(
      (within(screen.getByRole("dialog")).getByLabelText("Location") as HTMLInputElement).value,
    ).toBe("Otaki Forks, Tararua Range");
  });

  it("closes after a successful save and refreshes the list", async () => {
    stubFetch(oneOwned());
    await renderPanel();
    fireEvent.click(editMyLodge());
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bed capacity"), {
      target: { value: "30" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/api/admin/other-lodges/ol-1");
    // The payload carries the stored name, unchanged, with the edit.
    expect(JSON.parse(writes[0][1].body)).toMatchObject({ name: "Tararua Lodge", bedCapacity: 30 });
    // No POST, no DELETE, ever.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "DELETE")).toBe(false);
    // The list was loaded again after the save (GET twice: first load + refresh).
    const gets = fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET");
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT close when the dimmed background is clicked", async () => {
    stubFetch(oneOwned());
    await renderPanel();
    fireEvent.click(editMyLodge());
    await screen.findByRole("dialog");

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes on Escape, and on Cancel, discarding the edit", async () => {
    stubFetch(oneOwned());
    await renderPanel();

    fireEvent.click(editMyLodge());
    let dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(editMyLodge());
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: "Changed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Nothing was written, and reopening shows the stored value, not "Changed".
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.click(editMyLodge());
    dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Location") as HTMLInputElement).value).toBe("Otaki Forks");
  });

  it("ignores Escape and the close button while a save is in flight", async () => {
    const pending: Pending = { resolve: () => undefined };
    stubFetch(oneOwned(), () => new Promise((resolve) => (pending.resolve = resolve)));
    await renderPanel();
    fireEvent.click(editMyLodge());
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

  it("returns focus to the Edit my Lodge button that opened it", async () => {
    stubFetch(oneOwned());
    await renderPanel();
    const editButton = editMyLodge();
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
    expect(editMyLodge()).toBe(editButton);
    await expectRecoveryAlertToHoldFocus(editButton);
  });

  it("keeps the table (and the button's focus target) while the list refreshes after a SAVE", async () => {
    // The refresh after a save is held open by hand, so the "list is loading"
    // state is actually on screen when we look; an instantly-answered mock lets
    // React batch it away and the check proves nothing.
    let gets = 0;
    let releaseRefresh: () => void = () => undefined;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        // The server answers a save with the saved lodge, in the list shape.
        return {
          ok: true,
          status: 200,
          json: async () => ({ otherLodge: lodge({ location: "Otaki Forks (upper)" }) }),
        };
      }
      gets += 1;
      if (gets > 1) await new Promise<void>((resolve) => (releaseRefresh = resolve));
      return { ok: true, status: 200, json: async () => oneOwned() };
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();
    const editButton = editMyLodge();
    fireEvent.click(editButton);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Location"), {
      target: { value: "Otaki Forks (upper)" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(gets).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Refresh still in flight: a spinner in place of the table would have
    // unmounted this button, leaving focus nowhere to return to.
    expect(screen.queryByText(/loading other lodges/i)).toBeNull();
    expect(editMyLodge()).toBe(editButton);
    await expectRecoveryAlertToHoldFocus(editButton);
    // And the saved value is on screen already, not the stale one.
    expect(screen.getByText("Otaki Forks (upper)")).toBeTruthy();
    expect(screen.queryByText("Otaki Forks")).toBeNull();

    releaseRefresh();
    await waitFor(() => expect(editMyLodge()).toBe(editButton));
  });

  it("a discarded edit's error does not reappear on the page after the dialog closes", async () => {
    stubFetch(oneOwned());
    await renderPanel();
    fireEvent.click(editMyLodge());
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bed capacity"), { target: { value: "999999" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await within(dialog).findByRole("alert");

    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(screen.queryByRole("alert", { hidden: true })).toBeNull();

    // Same for Escape.
    fireEvent.click(editMyLodge());
    const second = await screen.findByRole("dialog");
    fireEvent.change(within(second).getByLabelText("Bed capacity"), { target: { value: "999999" } });
    fireEvent.click(within(second).getByRole("button", { name: /^save$/i }));
    await within(second).findByRole("alert");
    fireEvent.keyDown(second, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alert", { hidden: true })).toBeNull();
  });

  it("shows the error directly above Save and Cancel, after the fields", async () => {
    stubFetch(oneOwned());
    await renderPanel();
    fireEvent.click(editMyLodge());
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Bed capacity"), { target: { value: "999999" } });
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
    // Two saves' refreshes can be in flight together. If the older response
    // arrived last it would put back the value the newer one had replaced.
    const releases: Array<() => void> = [];
    const answers: AdminOtherLodgesResponse[] = [
      oneOwned(),
      oneOwned(),
      { ...oneOwned(), otherLodges: [lodge({ location: "Final" }), theirs()] },
    ];
    let get = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      const mine = get;
      get += 1;
      if (mine >= 1) await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true, status: 200, json: async () => answers[mine] };
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();

    // Save -> refresh #1 (held open).
    fireEvent.click(editMyLodge());
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(releases).toHaveLength(1));

    // Save again -> refresh #2 (held open), while #1 is still pending.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(editMyLodge());
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(releases).toHaveLength(2));

    // The NEWER refresh answers first, then the older one answers late with
    // the stale list.
    releases[1]();
    await screen.findByText("Final");
    releases[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText("Final")).toBeTruthy();
    expect(screen.queryByText("Otaki Forks")).toBeNull();
  });
});
