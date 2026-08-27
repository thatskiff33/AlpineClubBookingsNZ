// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { EventDialog } from "../event-dialog";

// A stored MiroTalk meeting event, viewed on the member calendar (read-only:
// canEditExisting=false). The DTO deliberately carries NO join URL / token — the
// host token is minted per click on POST /api/calendar/events/[id]/join, gated
// to calendar managers and audited (see src/lib/calendar-events.ts). The
// "Join meeting" button is therefore gated on canManage alone, and clicking it
// must fetch the URL rather than read one off the event.
const meetingEvent: CalendarEventDTO = {
  id: "evt-1",
  title: "Committee meeting",
  location: "Online",
  details: "Monthly sync",
  allDay: false,
  startsAt: "2026-08-01T19:00:00.000Z",
  endsAt: "2026-08-01T20:00:00.000Z",
  isMeeting: true,
  seriesId: null,
  detachedFromSeries: false,
  recurrence: null,
};

function renderReadOnly(canManage: boolean) {
  return render(
    <EventDialog
      open
      onOpenChange={vi.fn()}
      event={meetingEvent}
      initialDate={null}
      canCreate={canManage}
      canManage={canManage}
      canEditExisting={false}
      onSaved={vi.fn()}
    />,
  );
}

type FakePopup = {
  location: { href: string };
  opener: unknown;
  close: ReturnType<typeof vi.fn>;
};

function fakePopup(): FakePopup {
  return { location: { href: "" }, opener: {}, close: vi.fn() };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EventDialog read-only Join meeting gating", () => {
  it("hides Join meeting from an ordinary member (canManage=false)", () => {
    renderReadOnly(false);
    // The event details still render for everyone…
    expect(screen.getByText("Committee meeting")).toBeInTheDocument();
    // …but the join affordance is not offered.
    expect(
      screen.queryByRole("button", { name: /Join meeting/i }),
    ).not.toBeInTheDocument();
  });

  it("mints a join URL via the per-click endpoint and opens it in a new tab", async () => {
    const popup = fakePopup();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(popup as unknown as Window);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ joinUrl: "https://meet.example.com/room/minted" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderReadOnly(true);
    fireEvent.click(screen.getByRole("button", { name: /Join meeting/i }));

    // The minted URL is pushed into the pre-opened tab…
    await waitFor(() =>
      expect(popup.location.href).toBe("https://meet.example.com/room/minted"),
    );
    // …and it came from the join endpoint, never off the event object.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/calendar/events/evt-1/join",
      expect.objectContaining({ method: "POST" }),
    );
    // A blank tab is pre-opened synchronously on the click (pop-up-blocker safe).
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    // opener is severed for noopener semantics while keeping the handle.
    expect(popup.opener).toBeNull();
  });

  it("shows an inline error and closes the tab when the join fails", async () => {
    const popup = fakePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "You cannot join this meeting." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderReadOnly(true);
    fireEvent.click(screen.getByRole("button", { name: /Join meeting/i }));

    expect(
      await screen.findByText(/You cannot join this meeting/i),
    ).toBeInTheDocument();
    // The blank tab is closed so no orphan window is left open.
    expect(popup.close).toHaveBeenCalled();
  });
});
