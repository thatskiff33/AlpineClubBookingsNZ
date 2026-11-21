// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import type { CalendarWorkPartyLink } from "../event-details-view";
import { EventDialog } from "../event-dialog";
import { adminHref } from "@/lib/admin-hubs";

/**
 * #5148: a work party's calendar entry opens read-only for
 * everyone, even an admin who may edit ordinary events, and its link goes to
 * the admin Work Parties page, the member page, or nowhere. A multi-night
 * entry is stored as a daily series, but it is one event: no recurrence line.
 */
const workPartyEntry: CalendarEventDTO = {
  id: "evt-wp",
  title: "Work party: Spring Working Bee",
  location: "Main Lodge",
  details: "Bring gloves",
  allDay: true,
  startsAt: "2026-07-09T12:00:00.000Z",
  endsAt: null,
  isMeeting: false,
  seriesId: "series-1",
  detachedFromSeries: false,
  // serializeCalendarEvent sends no recurrence for a work party's entry.
  recurrence: null,
  workPartyEventId: "wp 1",
};

function renderEntry(workPartyLink: CalendarWorkPartyLink) {
  return render(
    <EventDialog
      open
      onOpenChange={vi.fn()}
      event={workPartyEntry}
      initialDate={null}
      canCreate
      canManage
      canEditExisting
      workPartyLink={workPartyLink}
      onSaved={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("a work party's calendar entry", () => {
  it("opens read-only for an editor, with no edit or delete controls", () => {
    renderEntry("admin");
    expect(screen.getByText("Work party: Spring Working Bee")).toBeInTheDocument();
    expect(
      screen.getByText(/This work party is managed from Work Parties/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Title/i)).not.toBeInTheDocument();
  });

  it("links an officer to the admin Work Parties page", () => {
    renderEntry("admin");
    expect(
      screen.getByRole("link", { name: /Open the work party/ }),
    ).toHaveAttribute("href", adminHref("work-parties"));
  });

  it("links a member to the member page under /dashboard", () => {
    renderEntry("member");
    expect(
      screen.getByRole("link", { name: /Open the work party/ }),
    ).toHaveAttribute("href", "/dashboard/work-parties/wp%201");
  });

  it("offers no link to a viewer who can open neither page", () => {
    renderEntry(null);
    expect(
      screen.queryByRole("link", { name: /Open the work party/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/This work party is managed from Work Parties/),
    ).toBeInTheDocument();
  });

  it("does not describe its nights as a repeating event", () => {
    renderEntry("member");
    expect(screen.queryByText(/Daily/)).not.toBeInTheDocument();
  });
});
