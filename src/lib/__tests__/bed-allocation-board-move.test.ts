import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS,
  createBedAllocationAnnouncements,
  describeBedAllocationDrop,
} from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/allocation-drag-feedback";
import { deriveActiveDragDates } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/active-drag-dates";
import type {
  BedOption,
  BucketGuestGroup,
  DashboardAllocation,
} from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/types";

function buildAllocation(
  overrides: Partial<DashboardAllocation> = {},
): DashboardAllocation {
  return {
    id: "allocation-1",
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    guestName: "Example Guest",
    guestAgeTier: "ADULT",
    roomId: "room-1",
    roomName: "Room One",
    bedId: "bed-1",
    bedName: "Bed One",
    stayDate: "2026-07-01",
    source: "AUTO",
    approvedAt: "2026-06-01T00:00:00.000Z",
    approvedByName: "Allocator",
    bookingStatus: "CONFIRMED",
    holdsCapacity: true,
    isSecondOccupant: false,
    ...overrides,
  };
}

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

function dragObjects(bedId = "bed-2") {
  return {
    active: {
      id: "allocation:allocation-1",
      data: {
        current: { type: "allocation", allocationId: "allocation-1" },
      },
    },
    over: {
      id: `cell:${bedId}:2026-07-09`,
      data: {
        current: {
          type: "cell",
          bedId,
          roomId: bedId === "bed-1" ? "room-1" : "room-2",
          stayDate: "2026-07-09",
        },
      },
    },
  };
}

describe("authoritative allocation move entry seam (#2595)", () => {
  it("highlights only the anchor night instead of inferring scope from visible rows", () => {
    const allocations = [
      buildAllocation(),
      buildAllocation({ id: "allocation-2", stayDate: "2026-07-02" }),
    ];

    expect(
      deriveActiveDragDates({
        activeDrag: { type: "allocation", allocationId: "allocation-1" },
        visibleAllocations: allocations,
        bucketGroups: [],
      }),
    ).toEqual(["2026-07-01"]);
  });

  it("keeps all booked dates highlighted for an unallocated bucket guest", () => {
    const bucketGroups: BucketGuestGroup[] = [
      {
        bookingGuestId: "guest-1",
        bookingId: "booking-1",
        guestName: "Example Guest",
        guestAgeTier: "ADULT",
        memberName: "Example Member",
        stayDates: ["2026-07-02", "2026-07-01", "2026-07-02"],
      },
    ];

    expect(
      deriveActiveDragDates({
        activeDrag: { type: "bucket-guest", bookingGuestId: "guest-1" },
        visibleAllocations: [],
        bucketGroups,
      }),
    ).toEqual(["2026-07-01", "2026-07-02"]);
  });

  it("describes a pointer or keyboard destination as opening exact-scope review", () => {
    const allocation = buildAllocation();
    const input = {
      activeData: { type: "allocation", allocationId: allocation.id } as const,
      overData: {
        type: "cell" as const,
        bedId: "bed-2",
        roomId: "room-2",
        // Hovered columns never become persisted move dates.
        stayDate: "2026-07-09",
      },
      visibleAllocations: [allocation],
      bucketGroups: [],
      beds,
      singleNightMode: false,
    };

    expect(describeBedAllocationDrop(input)).toBe(
      "Open move options for Example Guest to Room Two / Bed Two; choose the exact scope before confirming and keep every original lodge night",
    );
    const announcements = createBedAllocationAnnouncements({
      visibleAllocations: [allocation],
      bucketGroups: [],
      beds,
      singleNightMode: false,
    });
    const { active, over } = dragObjects();
    expect(
      announcements.onDragEnd({ active, over } as unknown as Parameters<
        typeof announcements.onDragEnd
      >[0]),
    ).toBe(
      "Open move options for Example Guest to Room Two / Bed Two; choose the exact scope before confirming and keep every original lodge night. No move has been sent.",
    );
  });

  it("opens authoritative review even for a same-bed destination", () => {
    const allocation = buildAllocation();
    expect(
      describeBedAllocationDrop({
        activeData: { type: "allocation", allocationId: allocation.id },
        overData: {
          type: "cell",
          bedId: "bed-1",
          roomId: "room-1",
          stayDate: "2026-07-09",
        },
        visibleAllocations: [allocation],
        bucketGroups: [],
        beds,
        singleNightMode: false,
      }),
    ).toContain("Open move options");
  });

  it("announces cancellation as unchanged and teaches the scope dialog", () => {
    const allocation = buildAllocation();
    const announcements = createBedAllocationAnnouncements({
      visibleAllocations: [allocation],
      bucketGroups: [],
      beds,
      singleNightMode: false,
    });
    const { active } = dragObjects();

    expect(
      announcements.onDragCancel({ active, over: null } as unknown as Parameters<
        typeof announcements.onDragCancel
      >[0]),
    ).toBe("Cancelled Example Guest drag. No allocation changed.");
    expect(BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS.draggable).toContain(
      "choose one night or every existing allocation night",
    );
    expect(BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS.draggable).toContain(
      "Original lodge nights are always kept",
    );
  });

  it("retains the unallocated single-night refusal before any write", () => {
    const bucketGroups: BucketGuestGroup[] = [
      {
        bookingGuestId: "guest-1",
        bookingId: "booking-1",
        guestName: "Example Guest",
        guestAgeTier: "ADULT",
        memberName: "Example Member",
        stayDates: ["2026-07-01"],
      },
    ];

    expect(
      describeBedAllocationDrop({
        activeData: { type: "bucket-guest", bookingGuestId: "guest-1" },
        overData: {
          type: "cell",
          bedId: "bed-2",
          roomId: "room-2",
          stayDate: "2026-07-02",
        },
        visibleAllocations: [],
        bucketGroups,
        beds,
        singleNightMode: true,
      }),
    ).toBe(
      "No allocation will be made for Example Guest: 2026-07-02 is not a booked lodge night",
    );
  });

  it("contains no client-side move planner or optimistic move mutation", () => {
    const pageSource = readFileSync(
      resolve(
        process.cwd(),
        "src/app/(admin)/admin/booking-desk/bed-allocation/page.tsx",
      ),
      "utf8",
    );

    expect(pageSource).not.toMatch(
      /planAllocationMove|applyOptimisticAllocationBedMove/,
    );
    expect(pageSource).toContain("moveDialog.openMoveDialog");
  });
});
