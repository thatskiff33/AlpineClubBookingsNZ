// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { RoomTable } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/room-table";
import {
  BED_ALLOCATION_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_COLUMN_WIDTH_REM,
  BED_ALLOCATION_LABEL_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_LABEL_COLUMN_WIDTH_REM,
} from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/board-cell";
import type {
  DashboardAllocation,
  DashboardRoom,
} from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/types";

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
  }),
}));

// #2286: the custodian band uses the club's own word for the role (only the
// lobby TV is pinned to the fixed word "Custodian"), so the cell reads the club
// identity. Stubbed rather than wrapped, matching the hut-leaders page tests.
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

// Stub the draggable AllocationChip so the RoomTable/BoardCell test focuses on
// cell layout (how many occupants render, the #1701 partner marker) without
// dnd-kit draggable / dropdown-menu internals.
vi.mock(
  "@/app/(admin)/admin/booking-desk/bed-allocation/_components/allocation-chip",
  () => ({
    AllocationChip: ({ allocation }: { allocation: DashboardAllocation }) => (
      <div data-testid="allocation-chip">{allocation.guestName}</div>
    ),
  }),
);

function buildRoom(): DashboardRoom {
  return {
    id: "room-1",
    name: "Example Room",
    sortOrder: 1,
    active: true,
    notes: null,
    beds: [
      {
        id: "bed-1",
        roomId: "room-1",
        name: "Bed One",
        sortOrder: 1,
        active: true,
        bedType: "SINGLE",
        bunkGroup: null,
      },
    ],
  };
}

describe("RoomTable active drag lane rendering", () => {
  it("renders the active date lane tint while preserving fixed board widths", () => {
    const nights = ["2026-07-01", "2026-07-02"];
    const { container } = render(
      <RoomTable
        canEdit={true}
        room={buildRoom()}
        nights={nights}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        onAssignRange={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
        activeDragDates={new Set(["2026-07-02"])}
      />,
    );

    const table = container.querySelector("table");
    // Assert the AUTHORED inline style rather than the computed one. `toHaveStyle`
    // reads through the CSSOM, and jsdom 30 resolves `rem` to `px` there (36rem ->
    // 576px), so a computed-style assertion silently stops checking the unit. The
    // unit is the point: #2150 sizes this board in `rem` so the columns scale with
    // the root font size, and a `px` width would look identical to that assertion
    // while breaking the property it exists to protect.
    expect(table?.getAttribute("style")).toContain(
      `width: ${BED_ALLOCATION_LABEL_COLUMN_WIDTH_REM + nights.length * BED_ALLOCATION_COLUMN_WIDTH_REM}rem`,
    );

    const cols = container.querySelectorAll("col");
    expect(cols).toHaveLength(nights.length + 1);
    const labelWidthClasses = BED_ALLOCATION_LABEL_COLUMN_WIDTH_CLASS.split(" ");
    const columnWidthClasses = BED_ALLOCATION_COLUMN_WIDTH_CLASS.split(" ");
    // The first (label) column is wider than the date columns; every
    // remaining column shares the fixed date-column width (#2150).
    expect(cols[0]).toHaveClass(...labelWidthClasses);
    for (const col of Array.from(cols).slice(1)) {
      expect(col).toHaveClass(...columnWidthClasses);
    }

    const inactiveCell = container.querySelector(
      'td[data-stay-date="2026-07-01"]',
    );
    const activeCell = container.querySelector(
      'td[data-stay-date="2026-07-02"]',
    );

    expect(inactiveCell).not.toHaveAttribute("data-active-drag-lane");
    expect(activeCell).toHaveAttribute("data-active-drag-lane", "true");
    expect(activeCell).toHaveClass("bg-accent");
    expect(activeCell).toHaveClass(...columnWidthClasses);

    const fixedCells = Array.from(container.querySelectorAll("th, td")).filter(
      (cell) => columnWidthClasses.every((className) => cell.classList.contains(className)),
    );
    expect(fixedCells).toHaveLength(nights.length * 2);

    const labelCells = Array.from(container.querySelectorAll("th, td")).filter(
      (cell) => labelWidthClasses.every((className) => cell.classList.contains(className)),
    );
    expect(labelCells).toHaveLength(2);
  });

  it("marks a focused booking cell with text, an icon, and a dashed border", () => {
    const allocation: DashboardAllocation = {
      id: "allocation-1",
      bookingId: "booking-focused",
      bookingGuestId: "guest-1",
      guestName: "Focused Guest",
      guestAgeTier: "ADULT",
      roomId: "room-1",
      roomName: "Example Room",
      bedId: "bed-1",
      bedName: "Bed One",
      stayDate: "2026-07-01",
      source: "MANUAL",
      approvedAt: null,
      approvedByName: null,
      bookingStatus: "CONFIRMED",
      holdsCapacity: true,
      isSecondOccupant: false,
    };
    const { container } = render(
      <RoomTable
        canEdit={true}
        room={buildRoom()}
        nights={["2026-07-01"]}
        allocationByBedAndDate={new Map([["bed-1:2026-07-01", [allocation]]])}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        onAssignRange={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId="booking-focused"
      />,
    );
    const cell = container.querySelector('td[data-stay-date="2026-07-01"]');
    const label = screen.getByText("Focused");

    expect(cell).toHaveClass("border-dashed");
    expect(label.parentElement?.querySelector("svg")).toBeTruthy();
  });
});

describe("RoomTable bed-type icon (#1675)", () => {
  function renderRoom(room: DashboardRoom) {
    return render(
      <RoomTable
        canEdit={true}
        room={room}
        nights={["2026-07-01"]}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        onAssignRange={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
      />,
    );
  }

  it("shows an accessible bed-type label alongside the bed name (never icon-only)", () => {
    renderRoom(buildRoom());
    // The single bed's icon carries a screen-reader label + tooltip.
    expect(screen.getByText("Single bed")).toBeTruthy();
    expect(screen.getByText("Bed One")).toBeTruthy();
  });

  it("labels a paired bunk with its group and top/bottom position", () => {
    const room: DashboardRoom = {
      ...buildRoom(),
      beds: [
        {
          id: "bed-top",
          roomId: "room-1",
          name: "Top",
          sortOrder: 1,
          active: true,
          bedType: "BUNK_TOP",
          bunkGroup: "Bunk A",
        },
        {
          id: "bed-bottom",
          roomId: "room-1",
          name: "Bottom",
          sortOrder: 2,
          active: true,
          bedType: "BUNK_BOTTOM",
          bunkGroup: "Bunk A",
        },
      ],
    };
    renderRoom(room);
    expect(screen.getByText("Bunk A · top")).toBeTruthy();
    expect(screen.getByText("Bunk A · bottom")).toBeTruthy();
  });

  it("does not imply a partner for a half-pair whose group holds only one bed", () => {
    // A surviving bunk-top whose bottom was deleted must not read as "Bunk A ·
    // top" (that implies a partner). It falls back to the plain type label.
    const room: DashboardRoom = {
      ...buildRoom(),
      beds: [
        {
          id: "bed-top",
          roomId: "room-1",
          name: "Top",
          sortOrder: 1,
          active: true,
          bedType: "BUNK_TOP",
          bunkGroup: "Bunk A",
        },
      ],
    };
    renderRoom(room);
    expect(screen.queryByText("Bunk A · top")).toBeNull();
    expect(screen.getByText("Bunk (top)")).toBeTruthy();
  });
});

describe("RoomTable double-bed sharing (#1701)", () => {
  function allocation(
    overrides: Partial<DashboardAllocation> & Pick<DashboardAllocation, "id" | "guestName">,
  ): DashboardAllocation {
    return {
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      guestAgeTier: "ADULT",
      roomId: "room-1",
      roomName: "Example Room",
      bedId: "bed-dbl",
      bedName: "Double One",
      stayDate: "2026-07-01",
      source: "MANUAL",
      approvedAt: null,
      approvedByName: null,
      bookingStatus: "CONFIRMED",
      holdsCapacity: true,
      isSecondOccupant: false,
      ...overrides,
    };
  }

  it("renders both occupants of a shared double and marks the partner", () => {
    const room: DashboardRoom = {
      ...buildRoom(),
      beds: [
        {
          id: "bed-dbl",
          roomId: "room-1",
          name: "Double One",
          sortOrder: 1,
          active: true,
          bedType: "DOUBLE",
          bunkGroup: null,
        },
      ],
    };
    const map = new Map<string, DashboardAllocation[]>([
      [
        "bed-dbl:2026-07-01",
        [
          allocation({ id: "a-primary", guestName: "Primary Guest" }),
          allocation({
            id: "a-second",
            bookingGuestId: "guest-2",
            guestName: "Second Guest",
            isSecondOccupant: true,
          }),
        ],
      ],
    ]);

    render(
      <RoomTable
        canEdit={true}
        room={room}
        nights={["2026-07-01"]}
        allocationByBedAndDate={map}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        onAssignRange={vi.fn()}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
      />,
    );

    // Both occupants are visible (the old single-value map hid the partner).
    expect(screen.getByText("Primary Guest")).toBeTruthy();
    expect(screen.getByText("Second Guest")).toBeTruthy();
    // The second occupant is marked as a shared-bed partner.
    expect(screen.getByText("Shares bed · partner")).toBeTruthy();
  });
});

// #2251 decision 3: after a range operation the target bed's nights are tinted
// green (written) and red (refused) until dismissed. The tint is never the only
// signal — each cell also carries a word.
describe("RoomTable range outcome tinting", () => {
  it("labels written and refused nights on the bed the range targeted", () => {
    render(
      <RoomTable
        canEdit={true}
        room={buildRoom()}
        nights={["2026-07-01", "2026-07-02", "2026-07-03"]}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        onAssignRange={vi.fn()}
        rangeTint={{
          bedId: "bed-1",
          written: new Set(["2026-07-01"]),
          refused: new Set(["2026-07-02"]),
        }}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
      />,
    );

    expect(screen.getByText("Assigned")).toBeInTheDocument();
    expect(screen.getByText("Refused")).toBeInTheDocument();
  });

  it("leaves another bed's cells untinted", () => {
    render(
      <RoomTable
        canEdit={true}
        room={buildRoom()}
        nights={["2026-07-01", "2026-07-02"]}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        onAssignRange={vi.fn()}
        rangeTint={{
          bedId: "bed-other",
          written: new Set(["2026-07-01"]),
          refused: new Set(["2026-07-02"]),
        }}
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
      />,
    );

    expect(screen.queryByText("Assigned")).not.toBeInTheDocument();
    expect(screen.queryByText("Refused")).not.toBeInTheDocument();
  });
});


/*
 * #2286 custodian band. The band used to be an EARLY RETURN that rendered its
 * own <td>, which silently dropped every other signal the cell carries — the
 * range-assign green/red tint, the ?bookingId= focus outline, the partner
 * marker. It is now an overlay inside the one cell body, and these cases pin
 * that: the promise that a refused range shows red, and that a deep link to a
 * booking still finds its cell, must hold on a custodian-held bed-night too.
 */
describe("RoomTable custodian band (#2286)", () => {
  const HOLD = {
    assignmentId: "assignment-1",
    memberName: "Sam Ranger",
    bedId: "bed-1",
    bedName: "Bed One",
    roomId: "room-1",
    roomName: "Example Room",
    startDate: "2026-06-01",
    endDate: "2026-09-30",
    nights: ["2026-07-01"],
  };

  function renderWithHold(
    extra: Partial<ComponentProps<typeof RoomTable>> = {},
  ) {
    return render(
      <RoomTable
        canEdit={true}
        room={buildRoom()}
        nights={["2026-07-01", "2026-07-02"]}
        allocationByBedAndDate={new Map()}
        bedOptions={[]}
        onReassignBed={vi.fn()}
        onRemove={vi.fn()}
        onAssignRange={vi.fn()}
        custodianHoldByBedAndDate={
          new Map([["bed-1:2026-07-01", HOLD]])
        }
        pendingAllocationIds={new Set()}
        highlightedBookingId=""
        {...extra}
      />,
    );
  }

  it("marks the held cell with a pill and a hatch, never colour alone", () => {
    const { container } = renderWithHold();

    const held = container.querySelector(
      'td[data-stay-date="2026-07-01"][data-custodian-hold="true"]',
    );
    expect(held).not.toBeNull();
    // The club's own word for the role, not a hardcoded "Custodian".
    expect(held).toHaveTextContent("Hut Leader");
    // The hatch is a SECOND signal beside the pill, and it is inline-styled.
    expect(
      held!.querySelector<HTMLElement>('[style*="repeating-linear-gradient"]'),
    ).not.toBeNull();
    // The neighbouring night is untouched.
    expect(
      container.querySelector(
        'td[data-stay-date="2026-07-02"][data-custodian-hold="true"]',
      ),
    ).toBeNull();
  });

  it("names the holder for a screen reader as well as in the tooltip", () => {
    const { container } = renderWithHold();
    const held = container.querySelector<HTMLElement>(
      'td[data-custodian-hold="true"]',
    );
    expect(held!.getAttribute("title")).toContain("Sam Ranger");
    expect(held!.querySelector(".sr-only")?.textContent).toContain("Sam Ranger");
  });

  it("KEEPS the refused-red range tint on a held bed-night", () => {
    const { container } = renderWithHold({
      rangeTint: {
        bedId: "bed-1",
        written: new Set<string>(),
        refused: new Set(["2026-07-01"]),
      },
    });

    const held = container.querySelector<HTMLElement>(
      'td[data-custodian-hold="true"]',
    );
    // The word AND the tint — a refusal on the very bed-night that caused it is
    // the most important place for this signal to survive.
    expect(held).toHaveTextContent("Refused");
    expect(held).toHaveClass("bg-danger-muted");
  });

  it("KEEPS the ?bookingId= focus outline on a held bed-night", () => {
    const allocation: DashboardAllocation = {
      id: "allocation-1",
      bookingId: "booking-focused",
      bookingGuestId: "guest-1",
      guestName: "Focused Guest",
      guestAgeTier: "ADULT",
      roomId: "room-1",
      roomName: "Example Room",
      bedId: "bed-1",
      bedName: "Bed One",
      stayDate: "2026-07-01",
      source: "MANUAL",
      approvedAt: null,
      approvedByName: null,
      bookingStatus: "CONFIRMED",
      holdsCapacity: true,
      isSecondOccupant: false,
    };
    const { container } = renderWithHold({
      allocationByBedAndDate: new Map([["bed-1:2026-07-01", [allocation]]]),
      highlightedBookingId: "booking-focused",
    });

    const held = container.querySelector<HTMLElement>(
      'td[data-custodian-hold="true"]',
    );
    expect(held).toHaveClass("border-dashed");
    expect(held).toHaveTextContent("Focused");
    // The row itself stays visible and removable: it is exactly the
    // CUSTODIAN_BED_CONFLICT warning's subject.
    expect(screen.getByText("Focused Guest")).toBeInTheDocument();
  });
});
