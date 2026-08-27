// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { EventDialog } from "../event-dialog";

const oneOff: CalendarEventDTO = {
  id: "evt-1",
  title: "Committee meeting",
  location: null,
  details: null,
  allDay: false,
  startsAt: "2026-08-03T18:00:00.000Z",
  endsAt: "2026-08-03T19:00:00.000Z",
  isMeeting: false,
  seriesId: null,
  detachedFromSeries: false,
  recurrence: null,
};

// An occurrence of a weekly series, used to exercise the series-delete chooser
// and its individually-edited-occurrences follow-up step.
const seriesOccurrence: CalendarEventDTO = {
  ...oneOff,
  id: "evt-series-1",
  seriesId: "series-1",
  recurrence: {
    frequency: "WEEKLY",
    interval: 1,
    endMode: "never",
    until: null,
    count: null,
  },
};

function renderEdit(event: CalendarEventDTO = oneOff) {
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  render(
    <EventDialog
      open
      onOpenChange={onOpenChange}
      event={event}
      initialDate={null}
      canCreate
      canManage
      canEditExisting
      onSaved={onSaved}
    />,
  );
  return { onOpenChange, onSaved };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EventDialog — in-app confirms (no native window.confirm)", () => {
  it("opens an in-app delete confirmation dialog instead of window.confirm", () => {
    // Guard: if the component ever regressed to window.confirm this spy would be
    // hit; it must NOT be.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderEdit();

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    expect(screen.getByText(/This cannot be undone/i)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("EventDialog — unsaved-changes guard", () => {
  it("closes straight away when nothing was edited", () => {
    const { onOpenChange } = renderEdit();
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText(/Discard changes\?/i)).not.toBeInTheDocument();
  });

  it("prompts before discarding when the form is dirty, and can keep editing", () => {
    const { onOpenChange } = renderEdit();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Committee meeting (moved)" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    // The dialog does not close yet — it asks first.
    expect(screen.getByText(/Discard changes\?/i)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Keep editing/i }));
    expect(screen.queryByText(/Discard changes\?/i)).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("discards and closes when confirmed", () => {
    const { onOpenChange } = renderEdit();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Discard$/ }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("EventDialog — series delete with individually-edited occurrences", () => {
  it("asks the fate of detached occurrences and deletes with exceptions=keep", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { onSaved } = renderEdit(seriesOccurrence);

    // Step 1: the recurring-event scope chooser.
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(
      screen.getByRole("button", { name: /This event only/i }),
    ).toBeInTheDocument();

    // Choosing the whole series advances to the exceptions follow-up (it does
    // NOT delete immediately).
    fireEvent.click(
      screen.getByRole("button", { name: /All events in the series/i }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Keep individually-edited events/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Delete everything/i }),
    ).toBeInTheDocument();

    // The safe (keep) path sends exceptions=keep.
    fireEvent.click(
      screen.getByRole("button", { name: /Keep individually-edited events/i }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/calendar/events/evt-series-1?scope=series&exceptions=keep",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sends exceptions=delete when the admin chooses to delete everything", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { onSaved } = renderEdit(seriesOccurrence);

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /All events in the series/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Delete everything/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/calendar/events/evt-series-1?scope=series&exceptions=delete",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("deletes a single occurrence without an exceptions param", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { onSaved } = renderEdit(seriesOccurrence);

    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(screen.getByRole("button", { name: /This event only/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/calendar/events/evt-series-1?scope=single",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
