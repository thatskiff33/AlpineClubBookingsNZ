// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getBookingAccent } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/booking-accent";
import { BucketBoard } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/bucket-board";
import type {
  BucketGuestGroup,
  DashboardBookingSummary,
} from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/types";
import { AGE_TIER_COLORS } from "@/lib/admin-family-group-ui-helpers";

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    attributes: {},
    listeners: {},
    transform: null,
    isDragging: false,
  }),
}));

function buildBooking(
  overrides: Partial<DashboardBookingSummary> = {}
): DashboardBookingSummary {
  return {
    id: "booking-1",
    status: "CONFIRMED",
    holdsCapacity: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    checkIn: "2026-07-10",
    checkOut: "2026-07-12",
    memberName: "Example Member",
    requestedRoom: null,
    parentBookingId: null,
    wholeLodgeHold: false,
    overlapsExclusiveHold: false,
    ...overrides,
  };
}

function buildGroup(): BucketGuestGroup {
  return {
    bookingGuestId: "guest-1",
    bookingId: "booking-1",
    guestName: "Example Guest",
    guestAgeTier: "ADULT",
    memberName: "Example Member",
    stayDates: ["2026-07-10", "2026-07-11"],
  };
}

function renderBucket(
  booking: DashboardBookingSummary,
  canEdit = true,
  highlightedBookingId = "",
) {
  return render(
    <BucketBoard
      bookings={[booking]}
      groupsByBooking={new Map([[booking.id, [buildGroup()]]])}
      bedOptions={[{ id: "bed-1", roomId: "room-1", roomName: "Room", bedName: "Bed 1", label: "Room / Bed 1" }]}
      selectedBeds={{ "guest-1": "bed-1" }}
      onSelectBed={vi.fn()}
      onAllocate={vi.fn()}
      onAssignRange={vi.fn()}
      pendingGuestIds={new Set()}
      highlightedBookingId={highlightedBookingId}
      canEdit={canEdit}
    />
  );
}

describe("BucketBoard requested-room badge (#706)", () => {
  it("renders the requested room badge on a bucket entry", () => {
    renderBucket(
      buildBooking({
        requestedRoom: { id: "room-1", name: "Rata Room", active: true },
      })
    );

    expect(screen.getByText("Requested: Rata Room")).toBeTruthy();
  });

  it("renders a warning chip when the requested room is inactive", () => {
    renderBucket(
      buildBooking({
        requestedRoom: { id: "room-1", name: "Rata Room", active: false },
      })
    );

    expect(
      screen.getByText("Requested room no longer active: Rata Room")
    ).toBeTruthy();
  });

  it("renders no room badge for bookings without a request", () => {
    renderBucket(buildBooking());

    expect(screen.queryByText(/Requested/)).toBeNull();
  });

  it("disables manual allocation controls for view-only booking access", () => {
    renderBucket(buildBooking(), false);

    expect(
      screen.getByRole("button", { name: /Drag Example Guest to a bed/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /Allocate/ })).toBeDisabled();
  });

  it("uses the same booking accent on the booking card and guest chip", () => {
    const { container } = renderBucket(buildBooking());
    const accent = getBookingAccent("booking-1");
    const titledCards = screen.getAllByTitle("Booking booking-1");
    const accentStrips = Array.from(
      container.querySelectorAll('span[aria-hidden="true"]'),
    );

    expect(titledCards[0].className).toContain(accent.ringClassName);
    expect(titledCards[0].className).toContain("bg-card");
    expect(titledCards[0].className).toContain("text-card-foreground");
    expect(titledCards[1].className).toContain(accent.ringClassName);
    expect(accentStrips).toHaveLength(2);
    expect(
      accentStrips.every((strip) =>
        strip.className.includes(accent.stripClassName),
      ),
    ).toBe(true);
    const badge = screen.getByText("ADULT");
    expect(badge).toBeInTheDocument();
    for (const className of AGE_TIER_COLORS.ADULT.split(" ")) {
      expect(badge.className).toContain(className);
    }
  });

  it("marks a focused booking with text, an icon, and a dashed border", () => {
    const booking = buildBooking();
    const { container } = renderBucket(booking, true, booking.id);
    const focusedLabels = screen.getAllByText("Focused");
    const bookingCard = screen.getAllByTitle(`Booking ${booking.id}`)[0];

    expect(focusedLabels).toHaveLength(2);
    expect(focusedLabels.every((label) => label.parentElement?.querySelector("svg"))).toBe(true);
    expect(bookingCard).toHaveClass("border-dashed");
    expect(container.querySelectorAll(".border-dashed").length).toBeGreaterThanOrEqual(2);
  });
});
