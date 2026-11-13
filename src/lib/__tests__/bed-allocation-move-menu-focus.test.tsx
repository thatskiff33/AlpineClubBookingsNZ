// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AllocationChip } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/allocation-chip";
import type {
  BedOption,
  BedOptionGroup,
  DashboardAllocation,
} from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/types";
import { useBedAllocationMoveDialog } from "@/components/admin/bed-allocation-move-dialog";
import type { BedAllocationMovePreview } from "@/lib/bed-allocation-move";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    attributes: {},
    listeners: {},
    transform: null,
    isDragging: false,
  }),
}));

const fetchMock = vi.fn();

const allocation: DashboardAllocation = {
  id: "allocation-1",
  bookingId: "booking-1",
  bookingGuestId: "guest-1",
  guestName: "Ada Guest",
  guestAgeTier: "ADULT",
  roomId: "room-1",
  roomName: "Room One",
  bedId: "bed-1",
  bedName: "Bed A",
  stayDate: "2026-08-01",
  source: "MANUAL",
  approvedAt: null,
  approvedByName: null,
  bookingStatus: "CONFIRMED",
  holdsCapacity: true,
  isSecondOccupant: false,
};

const beds: BedOption[] = [
  {
    id: "bed-1",
    roomId: "room-1",
    roomName: "Room One",
    bedName: "Bed A",
    label: "Room One / Bed A",
  },
  {
    id: "bed-2",
    roomId: "room-2",
    roomName: "Room Two",
    bedName: "Bed B",
    label: "Room Two / Bed B",
  },
];

const groups: BedOptionGroup[] = [
  {
    roomId: "room-1",
    roomName: "Room One",
    beds: [beds[0]],
  },
  {
    roomId: "room-2",
    roomName: "Room Two",
    beds: [beds[1]],
  },
];

function preview(): BedAllocationMovePreview {
  return {
    digestVersion: "v1",
    digest: "v1:move-preview",
    scope: "ALLOCATION_NIGHT",
    anchor: {
      allocationId: allocation.id,
      guestName: allocation.guestName,
      stayDate: allocation.stayDate,
    },
    destination: { bedId: beds[1].id, label: beds[1].label, available: true },
    resolvedRowCount: 1,
    changedRowCount: 1,
    unchangedRowCount: 0,
    approvedToDraftCount: 0,
    changed: [
      {
        allocationId: allocation.id,
        stayDate: allocation.stayDate,
        source: allocation.source,
        approved: false,
        sourceRoomName: allocation.roomName,
        sourceBedName: allocation.bedName,
      },
    ],
    unchanged: [],
    promotions: [],
    conflicts: [],
  };
}

function MenuHarness({ refreshes = false }: { refreshes?: boolean }) {
  const [version, setVersion] = useState(0);
  const move = useBedAllocationMoveDialog({
    canEdit: true,
    onApplied: async () => {
      if (refreshes) setVersion((current) => current + 1);
    },
  });

  return (
    <main>
      <section>
        <AllocationChip
          key={version}
          allocation={allocation}
          bedOptions={beds}
          bedOptionGroups={groups}
          onReassignBed={(bedId, focusOrigin) => {
            const bed = beds.find((candidate) => candidate.id === bedId);
            if (!bed) return;
            move.openMoveDialog(
              {
                allocationId: allocation.id,
                guestName: allocation.guestName,
                stayDate: allocation.stayDate,
              },
              {
                destinationBedId: bed.id,
                destinationLabel: bed.label,
              },
              focusOrigin,
            );
          }}
          onRemove={vi.fn()}
          onAssignRange={vi.fn()}
          pending={false}
          canEdit
        />
      </section>
      {move.dialog}
    </main>
  );
}

async function openFromNestedMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", {
      name: `Manage allocation for ${allocation.guestName}`,
    }),
    { button: 0, ctrlKey: false, pointerType: "mouse" },
  );
  const room = await screen.findByRole("menuitem", {
    name: `Move ${allocation.guestName} to a bed in Room Two`,
  });
  room.focus();
  fireEvent.keyDown(room, { key: "ArrowRight" });
  const destination = await screen.findByRole("menuitem", {
    name: `Move ${allocation.guestName} to ${beds[1].label}`,
  });
  fireEvent.click(destination);
  await screen.findByRole("dialog");
}

describe("bed allocation nested move-menu focus", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("returns focus to the allocation trigger after cancel", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => preview() });
    render(<MenuHarness />);

    await openFromNestedMenu();
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `Manage allocation for ${allocation.guestName}`,
        }),
      ).toHaveFocus(),
    );
  });

  it("returns focus to the reconciled allocation trigger after success", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => preview() })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          noop: false,
          movedRowCount: 1,
          promotedRowCount: 0,
          affectedNights: [allocation.stayDate],
        }),
      });
    render(<MenuHarness refreshes />);

    await openFromNestedMenu();
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `Manage allocation for ${allocation.guestName}`,
        }),
      ).toHaveFocus(),
    );
  });
});
