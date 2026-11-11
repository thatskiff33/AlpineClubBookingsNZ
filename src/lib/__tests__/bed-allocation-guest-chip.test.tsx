// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getBookingAccent } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/booking-accent";
import { GuestChip } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/guest-chip";
import type {
  BedOption,
  BedOptionGroup,
  BucketGuestGroup,
} from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/types";
import { AGE_TIER_COLORS } from "@/lib/admin-family-group-ui-helpers";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    attributes: {},
    listeners: {},
    transform: null,
    isDragging: false,
  }),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: ReactNode }) => (
    <div role="group">{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: ReactNode;
    value: string;
  }) => <div data-value={value}>{children}</div>,
  SelectLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: ({
    children,
    placeholder,
  }: {
    children?: ReactNode;
    placeholder?: string;
  }) => (
    <span>{children ?? placeholder}</span>
  ),
}));

const group: BucketGuestGroup = {
  bookingGuestId: "guest-1",
  bookingId: "booking-1",
  guestName: "Example Guest",
  guestAgeTier: "ADULT",
  memberName: "Example Member",
  stayDates: ["2026-07-01"],
};

const beds: BedOption[] = [
  {
    id: "bed-1",
    roomId: "room-1",
    roomName: "Room One",
    bedName: "Bed One",
    label: "Room One / Bed One",
  },
  {
    id: "bed-2",
    roomId: "room-2",
    roomName: "Room Two",
    bedName: "Bed Two",
    label: "Room Two / Bed Two",
  },
];

const bedOptionGroups: BedOptionGroup[] = [
  { roomId: "room-1", roomName: "Room One", beds: [beds[0]] },
  { roomId: "room-2", roomName: "Room Two", beds: [beds[1]] },
];

describe("GuestChip bed select", () => {
  it("groups bed options by room label", () => {
    render(
      <GuestChip
        group={group}
        bedOptions={beds}
        bedOptionGroups={bedOptionGroups}
        selectedBedId=""
        onSelectBed={vi.fn()}
        onAllocate={vi.fn()}
        onAssignRange={vi.fn()}
        pending={false}
        canEdit={true}
      />,
    );

    expect(screen.getByText("Room One")).toBeInTheDocument();
    expect(screen.getByText("Bed One")).toBeInTheDocument();
    expect(screen.getByText("Room Two")).toBeInTheDocument();
    expect(screen.getByText("Bed Two")).toBeInTheDocument();
  });

  it("keeps the selected value distinguishable with the room context", () => {
    render(
      <GuestChip
        group={group}
        bedOptions={beds}
        bedOptionGroups={bedOptionGroups}
        selectedBedId="bed-1"
        onSelectBed={vi.fn()}
        onAllocate={vi.fn()}
        onAssignRange={vi.fn()}
        pending={false}
        canEdit={true}
      />,
    );

    expect(screen.getByText("Room One / Bed One")).toBeInTheDocument();
  });

  it("renders the booking accent and AgeTierBadge without plain age-tier metadata", () => {
    const { container } = render(
      <GuestChip
        group={{ ...group, bookingId: "booking-colour-1", guestAgeTier: "CHILD" }}
        bedOptions={beds}
        bedOptionGroups={bedOptionGroups}
        selectedBedId=""
        onSelectBed={vi.fn()}
        onAllocate={vi.fn()}
        onAssignRange={vi.fn()}
        pending={false}
        canEdit={true}
      />,
    );
    const card = container.firstElementChild as HTMLElement;
    const accentStrip = card.querySelector('[aria-hidden="true"]') as HTMLElement;

    expect(card).toHaveAttribute("title", "Booking booking-colour-1");
    expect(card.className).toContain(
      getBookingAccent("booking-colour-1").ringClassName,
    );
    expect(card.className).toContain("bg-card");
    expect(card.className).toContain("text-card-foreground");
    expect(accentStrip.className).toContain(
      getBookingAccent("booking-colour-1").stripClassName,
    );
    const badge = screen.getByText("CHILD");
    expect(badge).toBeInTheDocument();
    for (const className of AGE_TIER_COLORS.CHILD.split(" ")) {
      expect(badge.className).toContain(className);
    }
    expect(screen.queryByText(/CHILD · Example Member/)).not.toBeInTheDocument();
    expect(screen.getByText("Example Member")).toBeInTheDocument();
  });

  it("adds a non-colour focused cue", () => {
    const { container } = render(
      <GuestChip
        group={group}
        bedOptions={beds}
        bedOptionGroups={bedOptionGroups}
        selectedBedId=""
        onSelectBed={vi.fn()}
        onAllocate={vi.fn()}
        onAssignRange={vi.fn()}
        pending={false}
        canEdit={true}
        highlighted
      />,
    );
    const card = container.firstElementChild as HTMLElement;
    const label = screen.getByText("Focused");

    expect(card).toHaveClass("border-dashed");
    expect(label.parentElement?.querySelector("svg")).toBeTruthy();
  });
});

// #2251 entry point 1: every guest awaiting a bed can be assigned a range of any
// length, independently of whether a bed is picked in the row's select.
describe("GuestChip range assignment entry point", () => {
  it("offers Assign range… and reports the click", () => {
    const onAssignRange = vi.fn();
    render(
      <GuestChip
        group={group}
        bedOptions={beds}
        bedOptionGroups={bedOptionGroups}
        selectedBedId=""
        onSelectBed={vi.fn()}
        onAllocate={vi.fn()}
        onAssignRange={onAssignRange}
        pending={false}
        canEdit={true}
      />,
    );

    const button = screen.getByRole("button", { name: "Assign range…" });
    // Unlike Allocate, it does not need a bed chosen first — the dialog asks.
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onAssignRange).toHaveBeenCalledTimes(1);
  });

  it("disables Assign range… for a view-only admin", () => {
    render(
      <GuestChip
        group={group}
        bedOptions={beds}
        bedOptionGroups={bedOptionGroups}
        selectedBedId="bed-1"
        onSelectBed={vi.fn()}
        onAllocate={vi.fn()}
        onAssignRange={vi.fn()}
        pending={false}
        canEdit={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Assign range…" }),
    ).toBeDisabled();
  });
});

