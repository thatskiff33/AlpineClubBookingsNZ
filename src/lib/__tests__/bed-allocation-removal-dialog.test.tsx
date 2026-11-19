// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedAllocationRemovalDialog,
  type BedAllocationRemovalDialogAnchor,
  useBedAllocationRemovalDialog,
} from "@/components/admin/bed-allocation-removal-dialog";

const fetchMock = vi.fn();

const anchorA: BedAllocationRemovalDialogAnchor = {
  allocations: [
    {
      allocationId: "alloc-a1",
      bookingId: "booking-a",
      bookingGuestId: "guest-a",
      lodgeId: "lodge-a",
      stayDate: "2026-08-01",
    },
  ],
  lodgeId: "lodge-a",
  lodgeName: "Lodge Alpha",
  window: { from: "2026-08-01", to: "2026-08-03" },
  guestName: "Ada Guest",
  initialScope: "ALLOCATION",
  initialCategories: ["AUTO_DRAFT"],
};

const anchorB: BedAllocationRemovalDialogAnchor = {
  ...anchorA,
  allocations: [
    {
      allocationId: "alloc-b1",
      bookingId: "booking-b",
      bookingGuestId: "guest-b",
      lodgeId: "lodge-b",
      stayDate: "2026-08-02",
    },
  ],
  lodgeId: "lodge-b",
  lodgeName: "Lodge Beta",
  guestName: "Bea Guest",
};

const twoNightAnchor: BedAllocationRemovalDialogAnchor = {
  ...anchorA,
  allocations: [
    anchorA.allocations[0],
    { ...anchorA.allocations[0], allocationId: "alloc-a2", stayDate: "2026-08-02" },
  ],
};

function preview(
  anchor: BedAllocationRemovalDialogAnchor = anchorA,
  matchedRowCount = 1,
) {
  const allocation = anchor.allocations[0];
  return {
    digestVersion: "v1",
    digest: `v1:${allocation.allocationId}`,
    scope: {
      type: "ALLOCATION",
      ...allocation,
    },
    context: {
      lodgeId: anchor.lodgeId,
      lodgeName: anchor.lodgeName ?? anchor.lodgeId,
      from: allocation.stayDate,
      to: allocation.stayDate,
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      guestName: anchor.guestName ?? null,
      anchorNight: allocation.stayDate,
    },
    categories: {
      AUTO_DRAFT: matchedRowCount,
      MANUAL_DRAFT: 0,
      APPROVED: 0,
    },
    matchedRowCount,
    affectedBookingCount: matchedRowCount ? 1 : 0,
    affectedNights: matchedRowCount ? [allocation.stayDate] : [],
    promotions: [],
    reopenedBookings: [],
  };
}

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof BedAllocationRemovalDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onApplied = vi.fn();
  const props: React.ComponentProps<typeof BedAllocationRemovalDialog> = {
    open: true,
    onOpenChange,
    anchor: anchorA,
    canEdit: true,
    onApplied,
    ...overrides,
  };
  const rendered = render(<BedAllocationRemovalDialog {...props} />);
  return { ...rendered, props, onOpenChange, onApplied };
}

describe("BedAllocationRemovalDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("keeps live regions mounted and names the lodge before preview", () => {
    renderDialog();

    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByText("Lodge Alpha")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    ).toBeDisabled();
  });

  it("clears a successful preview before showing a failed re-preview", async () => {
    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockResolvedValueOnce(response({ error: "Preview refused" }, false, 409));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));

    expect(screen.queryByText(/matching allocation/)).not.toBeInTheDocument();
    expect(await screen.findByText("Preview refused")).toBeInTheDocument();
  });

  it("renders one assertive alert role when a preview fails", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ error: "Preview refused" }, false, 500),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));

    expect(await screen.findByText("Preview refused")).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("lets view-only admins preview but explains and disables apply", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    renderDialog({ canEdit: false });

    expect(
      screen.getByText(
        "Your admin role can view this area but cannot make changes.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);

    expect(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    ).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT"),
    ).toHaveLength(0);
  });

  it("clears preview, error, and status when the explicit night changes", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    renderDialog({ anchor: twoNightAnchor });

    const nightSelect = screen.getByLabelText("Removal night");
    nightSelect.focus();
    fireEvent.keyDown(nightSelect, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "2026-08-01" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    expect(screen.getByText(/Preview ready/)).toBeInTheDocument();

    nightSelect.focus();
    fireEvent.keyDown(nightSelect, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "2026-08-02" }));

    expect(screen.queryByText(/matching allocation/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Preview ready/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("ignores an old anchor's preview response after switching anchors", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const rendered = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    rendered.rerender(
      <BedAllocationRemovalDialog
        {...rendered.props}
        anchor={anchorB}
      />,
    );
    await act(async () => pending.resolve(response(preview(anchorA))));

    expect(screen.getByText("Lodge Beta")).toBeInTheDocument();
    expect(screen.queryByText(/matching allocation/)).not.toBeInTheDocument();
  });

  it("ignores an old anchor's delayed preview error body", async () => {
    const errorBody = deferred<{ error: string }>();
    const readErrorBody = vi.fn(() => errorBody.promise);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: readErrorBody,
    });
    const rendered = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await waitFor(() => expect(readErrorBody).toHaveBeenCalledTimes(1));
    rendered.rerender(
      <BedAllocationRemovalDialog
        {...rendered.props}
        anchor={anchorB}
      />,
    );
    await screen.findByText("Lodge Beta");
    await act(async () => errorBody.resolve({ error: "Old preview failed" }));

    expect(screen.queryByText("Old preview failed")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("keeps the selected scope and categories while replacing counts on a refreshed 409", async () => {
    const bookingScope = {
      type: "BOOKING" as const,
      ...anchorA.allocations[0],
    };
    const initialPreview = { ...preview(), scope: bookingScope };
    const refreshedPreview = {
      ...preview(anchorA, 2),
      scope: bookingScope,
      categories: { AUTO_DRAFT: 1, MANUAL_DRAFT: 1, APPROVED: 0 },
    };
    fetchMock
      .mockResolvedValueOnce(response(initialPreview))
      .mockResolvedValueOnce(
        response(
          {
            error: "Allocations changed after the preview.",
            refreshedPreview,
          },
          false,
          409,
        ),
      );
    renderDialog();

    const scope = screen.getByLabelText("Removal scope");
    fireEvent.keyDown(scope, { key: "ArrowDown" });
    fireEvent.click(
      await screen.findByRole("option", {
        name: "Whole booking, including off-screen people and nights",
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /^Manual draft/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/1 matching allocation across 1 booking/);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    );

    expect(await screen.findByText(/2 matching allocations across 1 booking/)).toBeInTheDocument();
    expect(screen.getByText("Auto draft: 1")).toBeInTheDocument();
    expect(screen.getByText("Manual draft: 1")).toBeInTheDocument();
    expect(scope).toHaveTextContent(
      "Whole booking, including off-screen people and nights",
    );
    expect(
      screen.getByRole("checkbox", { name: /^Auto draft/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /^Manual draft/i }),
    ).toBeChecked();
    expect(screen.getByText("Preview refreshed; nothing was removed.")).toBeInTheDocument();
  });

  it("invalidates the preview when a 409 has no refreshed preview", async () => {
    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockResolvedValueOnce(
        response({ error: "Concurrent removal collided." }, false, 409),
      );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    );

    expect(await screen.findByText("Concurrent removal collided.")).toBeInTheDocument();
    expect(screen.queryByText(/matching allocation/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Preview is no longer current; nothing was removed. Load a new preview before trying again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Preview removal" }),
    ).toBeEnabled();
  });

  it("guards a same-tick double apply with one PUT", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    const apply = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(apply.promise);
    const { onApplied } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    const remove = screen.getByRole("button", {
      name: "Remove reviewed allocations",
    });
    fireEvent.click(remove);
    fireEvent.click(remove);

    expect(
      fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT"),
    ).toHaveLength(1);
    await act(async () =>
      apply.resolve(
        response({
          removedRowCount: 1,
          promotedRowCount: 0,
          affectedBookingCount: 1,
          affectedNights: ["2026-08-01"],
        }),
      ),
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it("does not let an old apply response close a newly opened anchor", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    const apply = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(apply.promise);
    const rendered = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    );
    rendered.rerender(
      <BedAllocationRemovalDialog {...rendered.props} open={false} />,
    );
    rendered.rerender(
      <BedAllocationRemovalDialog {...rendered.props} anchor={anchorB} />,
    );

    await act(async () =>
      apply.resolve(
        response({
          removedRowCount: 1,
          promotedRowCount: 0,
          affectedBookingCount: 1,
          affectedNights: ["2026-08-01"],
        }),
      ),
    );

    expect(rendered.onApplied).toHaveBeenCalledTimes(1);
    expect(rendered.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText("Lodge Beta")).toBeInTheDocument();
  });

  it("ignores an old anchor's delayed apply error body", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    const errorBody = deferred<{ error: string }>();
    const readErrorBody = vi.fn(() => errorBody.promise);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: readErrorBody,
    });
    const rendered = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    );
    await waitFor(() => expect(readErrorBody).toHaveBeenCalledTimes(1));
    rendered.rerender(
      <BedAllocationRemovalDialog {...rendered.props} open={false} />,
    );
    rendered.rerender(
      <BedAllocationRemovalDialog {...rendered.props} anchor={anchorB} />,
    );
    await screen.findByText("Lodge Beta");
    await act(async () => errorBody.resolve({ error: "Old apply failed" }));

    expect(screen.queryByText("Old apply failed")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  /**
   * #2668. The apply used to answer a rejected `fetch` with "Removal failed;
   * nothing was removed." A rejected `fetch` covers the PUT that ran and lost
   * its answer as well as the PUT that never arrived, so that sentence could be
   * the exact opposite of what the board now holds. The two 409 branches keep
   * their confident wording, because there the SERVER reported the removal was
   * not applied — the difference between the two is the whole point.
   */
  it("claims no outcome for an apply whose response never arrives", async () => {
    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    );

    const alert = await screen.findByRole("alert");
    await waitFor(() =>
      expect(alert).toHaveTextContent(
        "The service response could not be read, so we could not verify whether the removal was applied. Reload the board to see the current allocations before trying again.",
      ),
    );
    expect(alert).not.toHaveTextContent("nothing was removed");
  });

  it("returns focus to the shared entry trigger after cancel", async () => {
    function Harness() {
      const [applied] = useState(vi.fn());
      const removal = useBedAllocationRemovalDialog({
        canEdit: true,
        onApplied: applied,
      });
      return (
        <>
          <button
            type="button"
            onClick={() => removal.openRemovalDialog(anchorA)}
          >
            Open removal
          </button>
          {removal.dialog}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open removal" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("moves focus to a stable landmark when the entry trigger disconnects", async () => {
    function Harness() {
      const [triggerVisible, setTriggerVisible] = useState(true);
      const [applied] = useState(vi.fn());
      const removal = useBedAllocationRemovalDialog({
        canEdit: true,
        onApplied: applied,
      });
      return (
        <main data-testid="focus-fallback">
          {triggerVisible ? (
            <button
              type="button"
              onClick={() => {
                removal.openRemovalDialog(anchorA);
                setTriggerVisible(false);
              }}
            >
              Open transient removal
            </button>
          ) : null}
          {removal.dialog}
        </main>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", {
      name: "Open transient removal",
    });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByTestId("focus-fallback")).toHaveFocus(),
    );
  });

  it("waits for the success refresh before closing and restores focus safely", async () => {
    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockResolvedValueOnce(
        response({
          removedRowCount: 1,
          promotedRowCount: 0,
          affectedBookingCount: 1,
          affectedNights: ["2026-08-01"],
        }),
      );
    const refresh = deferred<void>();

    function Harness() {
      const [triggerVisible, setTriggerVisible] = useState(true);
      const removal = useBedAllocationRemovalDialog({
        canEdit: true,
        onApplied: async () => {
          await refresh.promise;
          setTriggerVisible(false);
        },
      });
      return (
        <main data-testid="success-focus-fallback">
          {triggerVisible ? (
            <button
              type="button"
              onClick={() => removal.openRemovalDialog(anchorA)}
            >
              Open successful removal
            </button>
          ) : null}
          {removal.dialog}
        </main>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", {
      name: "Open successful removal",
    });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => refresh.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId("success-focus-fallback")).toHaveFocus(),
    );
    // And it stays there. Focusing the region must not strip the tabindex that
    // lets it hold focus, or a browser (and jsdom 31) drops focus to the page
    // a frame later (#5183).
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(screen.getByTestId("success-focus-fallback")).toHaveFocus();
  });
});
