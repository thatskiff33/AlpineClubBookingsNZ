// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BucketBoard } from "@/app/(admin)/admin/bed-allocation/_components/bucket-board";
import type {
  BucketGuestGroup,
  DashboardBookingSummary,
} from "@/app/(admin)/admin/bed-allocation/_components/types";

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
    createdAt: "2026-06-01T00:00:00.000Z",
    checkIn: "2026-07-10",
    checkOut: "2026-07-12",
    memberName: "Example Member",
    requestedRoom: null,
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

function renderBucket(booking: DashboardBookingSummary) {
  return render(
    <BucketBoard
      bookings={[booking]}
      groupsByBooking={new Map([[booking.id, [buildGroup()]]])}
      bedOptions={[]}
      selectedBeds={{}}
      onSelectBed={vi.fn()}
      onAllocate={vi.fn()}
      pendingGuestIds={new Set()}
      highlightedBookingId=""
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
});
