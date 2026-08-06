// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import { AllocationPreferencesSection } from "../allocation-preferences-section";

const LOADED = {
  autoAllocationEnabled: true,
  allocationPriorityOrder: ["BOOKING_COHESION", "STAY_CONTINUITY"],
};

function response(settings = LOADED) {
  return new Response(JSON.stringify({ settings }), { status: 200 });
}

async function renderLoaded(
  options: {
    canEdit?: boolean;
    onSaved?: ReturnType<typeof vi.fn>;
    renderViewOnlyBanner?: boolean;
  } = {},
) {
  const onSaved = options.onSaved ?? vi.fn();
  const view = render(
    <AllocationPreferencesSection
      lodgeId="lodge-1"
      canEdit={options.canEdit ?? true}
      onSaved={onSaved}
      renderViewOnlyBanner={options.renderViewOnlyBanner}
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
      screen.getAllByRole("button", { name: "Disable", exact: true })[0],
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
      screen.getAllByRole("button", { name: "Disable", exact: true })[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(authoritative));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).toBeNull();
    expect(screen.getAllByText("Disabled")).toHaveLength(3);
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
      screen.getAllByRole("button", { name: "Disable", exact: true })[0],
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
      name: /^(Enable|Disable)$/,
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
      screen.getAllByRole("button", { name: "Disable", exact: true })[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.unmount();
    release(response());

    await Promise.resolve();
    await Promise.resolve();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
