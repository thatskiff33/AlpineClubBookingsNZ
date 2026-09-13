// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import { MODULE_DISABLED_ERROR_CODE } from "@/lib/api-error-message";
import {
  ALLOCATION_PREFERENCES_MODULE_OFF_REASON,
  ALLOCATION_PREFERENCES_NOT_FOUND_REASON,
  ALLOCATION_PREFERENCES_SIGNED_OUT_REASON,
  ALLOCATION_PREFERENCES_VIEW_FORBIDDEN_REASON,
  AllocationPreferencesSection,
} from "../allocation-preferences-section";

/**
 * The EDITABLE half of a settings payload — what the draft is, what a PUT body
 * carries, and what `onSaved` receives.
 */
const LOADED = {
  autoAllocationEnabled: true,
  allocationPriorityOrder: ["BOOKING_COHESION", "STAY_CONTINUITY"],
};
type SavedSettings = typeof LOADED;

/**
 * #2931 — the read-only provenance the server ACTUALLY sends alongside those
 * two fields (`EffectiveBedAllocationSettings`). Every fixture here used to be
 * the two editable fields alone, and that omission is what hid the defect: the
 * section spread its whole draft into the save body, the route's `.strict()`
 * schema refused the six extra keys with 400 "Invalid input", and the fixture
 * that never carried them made the PUT-body assertions below pass anyway. Every
 * response in this file is built through `response`, so the provenance is now
 * present in all of them and no future fixture can quietly drop it.
 */
const PROVENANCE = {
  authoritativeLodgeId: "lodge-1",
  settingsId: "lodge-1",
  source: "LODGE",
  fallback: "NONE",
  updatedByMemberId: "admin-1",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function response(settings = LOADED) {
  return new Response(
    JSON.stringify({ settings: { ...settings, ...PROVENANCE } }),
    { status: 200 },
  );
}

async function renderLoaded(
  options: {
    canEdit?: boolean;
    onSaved?: (settings: SavedSettings) => Promise<void> | void;
  } = {},
) {
  const onSaved = options.onSaved ?? vi.fn();
  const view = render(
    <AllocationPreferencesSection
      lodgeId="lodge-1"
      canEdit={options.canEdit ?? true}
      onSaved={onSaved}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "Auto allocation enabled" }),
    ).toBeTruthy(),
  );
  return { ...view, onSaved };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AllocationPreferencesSection", () => {
  it("retries a failed load in place", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AllocationPreferencesSection
        lodgeId="lodge-1"
        canEdit
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Auto allocation enabled" }),
      ).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loads read-only and Cancel restores the complete saved snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await renderLoaded();

    const toggle = screen.getByRole("checkbox", {
      name: "Auto allocation enabled",
    }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(toggle);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Disable Keep each booking together",
      }),
    );

    expect(toggle.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(screen.getAllByText("Disabled")).toHaveLength(2);
  });

  it("renders every disabled priority in canonical order, including empty read-only state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ autoAllocationEnabled: false, allocationPriorityOrder: [] }),
      ),
    );
    await renderLoaded();

    const disabled = screen.getAllByText("Disabled");
    expect(disabled).toHaveLength(4);
    const labels = disabled.map((badge) => badge.parentElement?.textContent);
    expect(labels).toEqual([
      "Keep each booking togetherDisabled",
      "Keep guests in the same room and bedDisabled",
      "Honour the requested roomDisabled",
      "Keep direct family members togetherDisabled",
    ]);
  });

  /*
    #2937: the card used to be able to SUPPRESS its own banner, because the
    bed-allocation page it sat on already carried one for the bookings area and
    two banners in a row said the same thing twice. Its host is now Bookings
    Setup -> Rooms & Beds, which states its view-only position for the rooms
    inventory rather than for this card, so the section states its own — and the
    suppression prop is gone rather than left as an option nothing passes.

    The rule that makes this load-bearing is `view-only-banner-contract`: both
    control sites here pass `describeReason={false}`, which is only allowed
    where a banner renders in the SAME FILE. An unconditional banner is what
    keeps that true no matter who mounts the card.
  */
  it("states its own view-only reason and gates Edit on it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await renderLoaded({ canEdit: false });

    expect(
      screen.getByText(`${ADMIN_VIEW_ONLY_SECTION_HEADING}.`),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it.each([
    [
      "Move Keep guests in the same room and bed up",
      ["STAY_CONTINUITY", "BOOKING_COHESION"],
    ],
    [
      "Move Keep each booking together down",
      ["STAY_CONTINUITY", "BOOKING_COHESION"],
    ],
  ])("uses the labelled %s control and saves the exact order", async (label, order) => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? response({ ...LOADED, allocationPriorityOrder: order })
        : response(),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      (screen.getByRole("button", {
        name: "Move Keep each booking together up",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", {
        name: "Move Keep guests in the same room and bed down",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(
      (screen.getByRole("button", {
        name: "Move Keep guests in the same room and bed up",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", {
        name: "Move Keep each booking together down",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      lodgeId: "lodge-1",
      autoAllocationEnabled: true,
      allocationPriorityOrder: order,
    });
  });

  it("appends a re-enabled priority and saves it at the bottom", async () => {
    const expectedOrder = [
      "BOOKING_COHESION",
      "STAY_CONTINUITY",
      "REQUESTED_ROOM",
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? response({ ...LOADED, allocationPriorityOrder: expectedOrder })
        : response(),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const disabledRow = screen.getByText("Honour the requested room")
      .parentElement;
    expect(disabledRow).not.toBeNull();
    fireEvent.click(
      within(disabledRow as HTMLElement).getByRole("button", {
        name: "Enable Honour the requested room",
      }),
    );

    expect(
      (screen.getByRole("button", {
        name: "Move Honour the requested room down",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      lodgeId: "lodge-1",
      autoAllocationEnabled: true,
      allocationPriorityOrder: expectedOrder,
    });
  });

  /**
   * #2801 — a drag whose index no longer names a row leaves the order alone.
   *
   * `move` bounds `to` and has never bounded `from`. `from` comes from
   * `draggedIndex`, set at drag start, so unlike every other caller it OUTLIVES
   * the render that produced it; and `setDraft` applies its updater to the LIVE
   * draft, not to the one the bounds check read. Disable a preference between
   * drag start and drop and the two disagree: `splice(from, 1)` removes
   * nothing, and the insert that followed put `undefined` INTO the priority
   * order — one entry longer than it started, carrying a preference that is not
   * one. The stricter indexed-access rule is what surfaced it; this pins the
   * answer, which is to leave the draft untouched.
   */
  it("ignores a drop whose dragged index no longer exists, and saves the order intact", async () => {
    const expectedOrder = ["BOOKING_COHESION"];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? response({ ...LOADED, allocationPriorityOrder: expectedOrder })
        : response(),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const keptLabel = "Keep each booking together";
    const draggedLabel = "Keep guests in the same room and bed";
    const rowFor = (label: string) => {
      const row = screen.getByText(label).parentElement;
      expect(row).not.toBeNull();
      return row as HTMLElement;
    };

    // Drag starts on the second (last) preference: `draggedIndex` becomes 1.
    fireEvent.dragStart(rowFor(draggedLabel));
    // It is then disabled, so the list is one long and index 1 names nobody.
    fireEvent.click(
      within(rowFor(draggedLabel)).getByRole("button", {
        name: `Disable ${draggedLabel}`,
      }),
    );
    // The drop still arrives, carrying the stale index.
    const keptRow = rowFor(keptLabel);
    fireEvent.dragOver(keptRow);
    fireEvent.drop(keptRow);

    // Still exactly one enabled preference, and it is the one that was kept.
    expect(
      screen.getByRole("button", { name: `Move ${keptLabel} up` }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: `Move ${draggedLabel} up` }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      lodgeId: "lodge-1",
      autoAllocationEnabled: true,
      allocationPriorityOrder: expectedOrder,
    });
  });

  it("PUTs once, refreshes the parent, and re-seeds from the server response", async () => {
    const authoritative = {
      autoAllocationEnabled: false,
      allocationPriorityOrder: ["REQUESTED_ROOM"],
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? response(authoritative) : response(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn(async () => {});
    await renderLoaded({ onSaved });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Disable Keep each booking together",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The draft carries the lodge it was loaded from (#2937), so `onSaved`
    // reports WHICH lodge was written as well as what was written.
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({
        lodgeId: "lodge-1",
        ...authoritative,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).toBeNull();
    expect(screen.getAllByText("Disabled")).toHaveLength(3);
  });

  it("refreshes its parent after Save under StrictMode effect rehearsal", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn(async () => {});
    render(
      <StrictMode>
        <AllocationPreferencesSection
          lodgeId="lodge-1"
          canEdit
          onSaved={onSaved}
        />
      </StrictMode>,
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
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("disables every edit affordance for the full save window", async () => {
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? pending : Promise.resolve(response()),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Disable Keep each booking together",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      (screen.getByRole("checkbox", {
        name: "Auto allocation enabled",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const button of screen.getAllByRole("button", {
      name: /^(Enable|Disable) /,
    })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    release(response());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
  });

  it("does not refresh a former parent after unmount", async () => {
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === "PUT" ? pending : Promise.resolve(response()),
      ),
    );
    const onSaved = vi.fn();
    const view = await renderLoaded({ onSaved });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Disable Keep each booking together",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.unmount();
    release(response());

    await Promise.resolve();
    await Promise.resolve();
    expect(onSaved).not.toHaveBeenCalled();
  });
  /**
   * #2931 — the save body is the route's write contract and nothing else.
   *
   * The sibling assertions above already compare the whole parsed body with
   * `toEqual`, so a fourth key fails them too. What this one adds is the
   * contract stated as a NAMED key set: if a sibling is ever loosened to
   * `toMatchObject`, or a new one is written that way, the key set is still
   * pinned here and the `.strict()` PUT schema still has a local counterpart.
   */
  it("PUTs exactly the three fields of the write contract", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      response(init?.method === "PUT" ? { ...LOADED, autoAllocationEnabled: false } : LOADED),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Auto allocation enabled" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    );
    expect(
      Object.keys(JSON.parse(String(putCall?.[1]?.body))).sort(),
    ).toEqual([
      "allocationPriorityOrder",
      "autoAllocationEnabled",
      "lodgeId",
    ]);
  });

  /**
   * #2931 — a failed save says WHY, and the refusals are told apart by what the
   * BODY says, never by the status alone.
   *
   * The module row is the one that matters most. `/api/admin/bed-allocation` is
   * module-gated, so 404 is also what an anonymous caller gets
   * (`moduleGatedNotFoundResponse` in `src/lib/session-guards.ts`) — the two
   * 404 rows below carry the same status and must produce different sentences,
   * which is only possible because the route names its module refusal.
   */
  it.each([
    [
      "a permission refusal",
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
      /your admin role can view this area but cannot make changes/,
    ],
    [
      "a 403 the guard explained itself",
      new Response(
        JSON.stringify({ error: "Two-factor verification required" }),
        { status: 403 },
      ),
      /^Two-factor verification required$/,
    ],
    [
      "the module being switched off",
      new Response(
        JSON.stringify({ error: "Not found", code: MODULE_DISABLED_ERROR_CODE }),
        { status: 404 },
      ),
      new RegExp(`^${ALLOCATION_PREFERENCES_MODULE_OFF_REASON}$`),
    ],
    [
      "a 404 that names no module — an expired sign-in, not a module to switch on",
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
      new RegExp(`^${ALLOCATION_PREFERENCES_NOT_FOUND_REASON}$`),
    ],
    [
      "an expired session",
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      new RegExp(`^${ALLOCATION_PREFERENCES_SIGNED_OUT_REASON}$`),
    ],
    [
      "the server's own sentence",
      new Response(
        JSON.stringify({ error: "Lodge not found or not active" }),
        { status: 400 },
      ),
      /^Lodge not found or not active$/,
    ],
    [
      "a zod refusal, without its details",
      new Response(
        JSON.stringify({
          error: "Invalid input",
          details: { fieldErrors: { lodgeId: ["Required"] } },
        }),
        { status: 400 },
      ),
      /^Invalid input$/,
    ],
    [
      "a non-JSON body",
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
      }),
      /^Failed to save allocation preferences$/,
    ],
    [
      "a blank error string",
      new Response(JSON.stringify({ error: "   " }), { status: 500 }),
      /^Failed to save allocation preferences$/,
    ],
    [
      "a 200 whose body is not the shape this screen was promised",
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
      /^Allocation preferences may have been saved, but the reply could not be read/,
    ],
  ])("reports %s when the save fails", async (_case, failure, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PUT" ? failure : response(),
      ),
    );
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Auto allocation enabled" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByText(expected);
    expect(alert.textContent ?? "").not.toMatch(
      /<html|fieldErrors|Bad Gateway|TypeError|undefined/,
    );
    // The refusal leaves the admin in edit mode with the draft they staged, so
    // the fix is one click away rather than a re-stage. Behaviour of
    // `useSectionEditState`, pinned here rather than introduced here.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  /**
   * #2931 — the same states on the LOAD, which had no 403, no 401 and no guard
   * against a 200 of the wrong shape. Each row previously rendered either a
   * bare API word ("Forbidden", "Unauthorized") or, for the last one, a raw
   * `TypeError` from projecting `undefined`.
   */
  it.each([
    [
      "a switched-off module",
      new Response(
        JSON.stringify({ error: "Not found", code: MODULE_DISABLED_ERROR_CODE }),
        { status: 404 },
      ),
      new RegExp(`^${ALLOCATION_PREFERENCES_MODULE_OFF_REASON}$`),
    ],
    [
      "a 404 that names no module",
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
      new RegExp(`^${ALLOCATION_PREFERENCES_NOT_FOUND_REASON}$`),
    ],
    [
      "a role that cannot view bookings",
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
      new RegExp(`^${ALLOCATION_PREFERENCES_VIEW_FORBIDDEN_REASON}$`),
    ],
    [
      "a 403 the guard explained itself",
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
      }),
      /^Account is deactivated$/,
    ],
    [
      "an expired session",
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      new RegExp(`^${ALLOCATION_PREFERENCES_SIGNED_OUT_REASON}$`),
    ],
    [
      "the server's own sentence",
      new Response(JSON.stringify({ error: "A lodgeId is required." }), {
        status: 400,
      }),
      /^A lodgeId is required.$/,
    ],
    [
      "a 200 carrying no settings",
      new Response(JSON.stringify({}), { status: 200 }),
      /^Failed to load allocation preferences$/,
    ],
    [
      "a 200 whose settings are the wrong shape",
      new Response(JSON.stringify({ settings: { autoAllocationEnabled: "yes" } }), {
        status: 200,
      }),
      /^Failed to load allocation preferences$/,
    ],
  ])("explains %s when the load fails", async (_case, failure, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => failure));
    render(
      <AllocationPreferencesSection
        lodgeId="lodge-1"
        canEdit
        onSaved={vi.fn()}
      />,
    );

    const alert = await screen.findByText(expected);
    expect(alert.textContent ?? "").not.toMatch(/TypeError|undefined|\bNot found\b/);
    // Nothing loaded, so the card offers the retry rather than an editor.
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  /**
   * The module-off sentence must not send a bookings officer somewhere only a
   * `support` role can go. The repository already settled this wording on
   * `diagnostics-readiness-tiers.ts`; this pins that this card follows it.
   */
  it("names who can switch the module on, rather than ordering the reader to", () => {
    expect(ALLOCATION_PREFERENCES_MODULE_OFF_REASON).toMatch(
      /Someone who can manage Feature modules can turn it on/,
    );
    expect(ALLOCATION_PREFERENCES_MODULE_OFF_REASON).not.toMatch(/first\.$/);
  });
});
