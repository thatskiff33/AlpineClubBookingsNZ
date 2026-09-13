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
import { AllocationPreferencesSection } from "../allocation-preferences-section";

const LOADED = {
  autoAllocationEnabled: true,
  allocationPriorityOrder: ["BOOKING_COHESION", "STAY_CONTINUITY"],
};
type SavedSettings = typeof LOADED;

function response(settings = LOADED) {
  return new Response(JSON.stringify({ settings }), { status: 200 });
}

async function renderLoaded(
  options: {
    canEdit?: boolean;
    onSaved?: (settings: SavedSettings) => Promise<void> | void;
    renderViewOnlyBanner?: boolean;
  } = {},
) {
  const onSaved = options.onSaved ?? vi.fn();
  const view = render(
    <AllocationPreferencesSection
      lodgeId="lodge-1"
      canEdit={options.canEdit ?? true}
      onSaved={onSaved}
      {...(options.renderViewOnlyBanner === undefined
        ? {}
        : { renderViewOnlyBanner: options.renderViewOnlyBanner })}
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

  it("suppresses its banner when the page vouches and still gates view-only Edit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await renderLoaded({ canEdit: false, renderViewOnlyBanner: false });

    expect(screen.queryByText(ADMIN_VIEW_ONLY_SECTION_HEADING)).toBeNull();
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

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(authoritative));
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
});
