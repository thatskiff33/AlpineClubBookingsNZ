// @vitest-environment jsdom

/*
 * #2701 owner decision 4 — the club-wide board is a read-only OVERVIEW.
 *
 * The board still shows every lodge; what it stops doing is offering choices
 * the write path was always going to refuse. Every control whose correctness
 * depends on a concrete lodge is disabled, with one explanation on screen
 * rather than a dozen unexplained disabled states.
 *
 * The real `BucketBoard`, `GuestChip`, `RoomTable`, `BoardCell` and
 * `AllocationChip` are rendered here on purpose: the lock is threaded through
 * five components, and stubbing any of them would leave the thread untested at
 * exactly the point it could break.
 *
 * Every assertion is made TWICE — once club-wide and once on a concrete lodge —
 * so the test proves a lock rather than a board that happens to be disabled for
 * some other reason. Decision 6 rides along: "Remove allocation" lives behind
 * the manage menu, whose trigger is disabled club-wide, so it can no longer be
 * a clickable silent no-op.
 */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPayload } from "@/app/(admin)/admin/bed-allocation/_components/types";
import { ALL_LODGES_ALLOCATION_LOCK_REASON } from "@/app/(admin)/admin/bed-allocation/_components/types";

const editAccessMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("from=2026-07-01&to=2026-07-08"),
}));

/*
 * The dnd stubs RECORD what they are told and expose the context's handlers
 * (PR #2885 review). The previous versions discarded the `disabled` argument
 * entirely and rendered `DndContext` as a plain `<div>`, so nothing here
 * touched the drag path at all: `handleDragEnd` never ran, and the only thing
 * actually asserted was that some buttons were disabled.
 */
const dndCalls = vi.hoisted(() => ({
  droppable: [] as boolean[],
  draggable: [] as boolean[],
  onDragEnd: null as null | ((event: unknown) => void),
  onDragStart: null as null | ((event: unknown) => void),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
    onDragStart,
  }: {
    children: ReactNode;
    onDragEnd?: (event: unknown) => void;
    onDragStart?: (event: unknown) => void;
  }) => {
    dndCalls.onDragEnd = onDragEnd ?? null;
    dndCalls.onDragStart = onDragStart ?? null;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: () => [],
  useDroppable: ({ disabled }: { disabled?: boolean }) => {
    dndCalls.droppable.push(Boolean(disabled));
    return { setNodeRef: vi.fn(), isOver: false };
  },
  useDraggable: ({ disabled }: { disabled?: boolean }) => {
    dndCalls.draggable.push(Boolean(disabled));
    return {
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      isDragging: false,
    };
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>();
  return { ...actual, useAdminAreaEditAccess: () => editAccessMock() };
});

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

/*
 * A selector stub that reports the two changes this test drives, with the REAL
 * `ALL_LODGES` value and the real change source. Radix's own menu is exercised
 * by `lodge-select.test.tsx`; driving it again here would test the same widget
 * twice and tell us nothing about the board.
 */
vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/lodge-select")>();
  return {
    ...actual,
    LodgeSelect: ({
      onChange,
    }: {
      onChange: (value: string | null, source: "user" | "auto") => void;
    }) => (
      <div>
        <button type="button" onClick={() => onChange(actual.ALL_LODGES, "user")}>
          Pick all lodges
        </button>
        <button type="button" onClick={() => onChange("lodge-1", "user")}>
          Pick lodge one
        </button>
      </div>
    ),
    useLodgeOptions: () => ({
      lodges: [
        { id: "lodge-1", name: "Alpine Lodge" },
        { id: "lodge-2", name: "River Lodge" },
      ],
      loading: false,
      failed: false,
      reload: vi.fn(),
    }),
  };
});

vi.mock("@/components/admin/bed-allocation-removal-dialog", () => ({
  bedAllocationRemovalCategoryForAnchor: () => "MANUAL_DRAFT",
  useBedAllocationRemovalDialog: () => ({
    openRemovalDialog: vi.fn(),
    dialog: <div data-testid="removal-dialog-seam" />,
  }),
}));
vi.mock("@/components/admin/bed-allocation-move-dialog", () => ({
  useBedAllocationMoveDialog: () => ({
    openMoveDialog: vi.fn(),
    dialog: <div data-testid="move-dialog-seam" />,
  }),
}));
vi.mock("@/components/admin/bed-range-assign-dialog", () => ({
  BedRangeAssignDialog: () => null,
}));
vi.mock(
  "@/app/(admin)/admin/bed-allocation/_components/allocation-preferences-section",
  () => ({
    AllocationPreferencesSection: () => (
      <div data-testid="allocation-preferences" />
    ),
  }),
);

import AdminBedAllocationPage from "@/app/(admin)/admin/bed-allocation/page";

function buildPayload(): DashboardPayload {
  return {
    settings: {
      autoAllocationEnabled: true,
      allocationPriorityOrder: [],
      updatedAt: null,
      updatedByMemberId: null,
    },
    range: { fromDate: "2026-07-01", toDate: "2026-07-08" },
    rooms: [
      {
        id: "room-1",
        name: "Example Room",
        sortOrder: 1,
        active: true,
        notes: null,
        beds: [
          {
            id: "bed-1",
            name: "Bed One",
            sortOrder: 1,
            active: true,
            bedType: "SINGLE",
            notes: null,
            bunkGroup: null,
          },
        ],
      },
    ],
    bookings: [
      {
        id: "booking-1",
        status: "CONFIRMED",
        holdsCapacity: true,
        createdAt: "2026-06-01",
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        memberName: "Ken King",
        requestedRoom: null,
        parentBookingId: null,
        wholeLodgeHold: false,
        overlapsExclusiveHold: false,
        guests: [{ id: "guest-1", stayStart: "2026-07-01", stayEnd: "2026-07-03" }],
      },
    ],
    allocations: [
      {
        id: "allocation-1",
        bookingId: "booking-1",
        bookingGuestId: "guest-2",
        guestName: "Placed Guest",
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
      },
    ],
    unallocatedGuestNights: [
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        guestName: "Waiting Guest",
        guestAgeTier: "ADULT",
        memberName: "Ken King",
        stayDate: "2026-07-02",
      },
    ],
    exclusiveHolds: [],
    custodianHolds: [],
    suggestedAllocations: [
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-1",
        bedId: "bed-1",
        stayDate: "2026-07-02",
      },
    ],
    suggestedUnallocatedGuestNights: [],
    warnings: [],
    focusedBooking: null,
    scopedLodgeId: null,
  } as unknown as DashboardPayload;
}

function boardRequests(): URLSearchParams[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/admin/bed-allocation?"))
    .map((url) => new URLSearchParams(url.split("?")[1]));
}

/** Every lodge-dependent control the board offers, by how an admin finds it. */
function allocationControls() {
  return {
    autoAllocate: screen.getByRole("button", { name: /Run Auto Allocation/ }),
    approve: screen.getByRole("button", { name: /Approve Visible/ }),
    reset: screen.getByRole("button", { name: /Reset allocations/ }),
    bucketDrag: screen.getByRole("button", {
      name: "Drag Waiting Guest to a bed",
    }),
    allocate: screen.getByRole("button", { name: "Allocate" }),
    assignRange: screen.getByRole("button", { name: "Assign range…" }),
    chipDrag: screen.getByRole("button", {
      name: /Drag Placed Guest to another bed/,
    }),
    manageChip: screen.getByRole("button", {
      name: "Manage allocation for Placed Guest",
    }),
    // The bucket's "Select bed" picker: a Radix trigger, so a combobox.
    selectBed: screen.getByRole("combobox"),
  };
}

describe("bed-allocation board — All lodges is a read-only overview (#2701)", () => {
  beforeEach(() => {
    editAccessMock.mockReturnValue(true);
    dndCalls.droppable.length = 0;
    dndCalls.draggable.length = 0;
    dndCalls.onDragEnd = null;
    dndCalls.onDragStart = null;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => buildPayload(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("leaves every lodge-dependent control live on a concrete lodge", async () => {
    // The control half of the pair. Without it, a board that was disabled for
    // any unrelated reason would satisfy the club-wide assertions below.
    render(<AdminBedAllocationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Pick lodge one" }));
    await screen.findByText("Placed Guest");

    for (const [name, control] of Object.entries(allocationControls())) {
      // "Allocate" stays disabled until a bed is picked, which is its own
      // pre-existing rule and nothing to do with lodge scope.
      if (name === "allocate") continue;
      expect(control, name).toBeEnabled();
    }
    expect(
      screen.queryByText(ALL_LODGES_ALLOCATION_LOCK_REASON),
    ).not.toBeInTheDocument();
  });

  it("disables every lodge-dependent control club-wide, with one explanation", async () => {
    render(<AdminBedAllocationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Pick all lodges" }));
    await screen.findByText("Placed Guest");

    // The board is still THERE — a read-only overview, not a hidden one.
    expect(screen.getByText("Waiting Guest")).toBeInTheDocument();
    expect(screen.getByText("Example Room")).toBeInTheDocument();

    for (const [name, control] of Object.entries(allocationControls())) {
      expect(control, name).toBeDisabled();
    }

    // One explanation, at the top, rather than a dozen silent disabled states.
    expect(
      screen.getByText(new RegExp(ALL_LODGES_ALLOCATION_LOCK_REASON)),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Allocate" }),
    ).toHaveAttribute("title", ALL_LODGES_ALLOCATION_LOCK_REASON);
  });

  it("reads club-wide deliberately: the request carries no lodge at all", async () => {
    render(<AdminBedAllocationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Pick all lodges" }));
    await screen.findByText("Placed Guest");

    await waitFor(() => {
      const latest = boardRequests().at(-1);
      expect(latest?.has("lodgeId")).toBe(false);
      expect(latest?.has("bookingId")).toBe(false);
    });
  });

  it("takes every cell and chip out of the drag/drop path club-wide", async () => {
    // The lock has to reach dnd-kit itself, not only the buttons beside it: a
    // keyboard drag never touches a button's `disabled`.
    render(<AdminBedAllocationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Pick lodge one" }));
    await screen.findByText("Placed Guest");

    // Concrete lodge: real drop targets and real drag sources exist.
    expect(dndCalls.droppable.some((disabled) => !disabled)).toBe(true);
    expect(dndCalls.draggable.some((disabled) => !disabled)).toBe(true);

    dndCalls.droppable.length = 0;
    dndCalls.draggable.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Pick all lodges" }));
    await screen.findByText("Placed Guest");

    // Club-wide: every single one is disabled — the bucket, every board cell,
    // every bucket guest and every placed chip.
    expect(dndCalls.droppable.length).toBeGreaterThan(0);
    expect(dndCalls.droppable.every((disabled) => disabled)).toBe(true);
    expect(dndCalls.draggable.length).toBeGreaterThan(0);
    expect(dndCalls.draggable.every((disabled) => disabled)).toBe(true);
  });

  it("refuses a drop that reaches the handler anyway", async () => {
    // The guard behind the disabled targets. A stale sensor or a future entry
    // point must not be able to route round them, so `handleDragEnd` is driven
    // directly with a drop dnd-kit would never deliver.
    render(<AdminBedAllocationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Pick all lodges" }));
    await screen.findByText("Placed Guest");

    const before = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(dndCalls.onDragEnd).toBeTypeOf("function");
    act(() => {
      dndCalls.onDragEnd?.({
        active: {
          id: "bucket-guest:guest-1",
          data: { current: { type: "bucket-guest", bookingGuestId: "guest-1" } },
        },
        over: {
          id: "cell:bed-1:2026-07-02",
          data: {
            current: {
              type: "cell",
              bedId: "bed-1",
              roomId: "room-1",
              stayDate: "2026-07-02",
            },
          },
        },
      });
    });

    // No allocation write, and no optimistic board mutation either.
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      before,
    );
  });

  it("cannot leave Remove allocation as a clickable silent no-op (decision 6)", async () => {
    // `removeAllocation` returns immediately without a lodge, so the menu item
    // behind this trigger used to do nothing at all and say nothing about it.
    render(<AdminBedAllocationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Pick all lodges" }));
    await screen.findByText("Placed Guest");

    const manage = screen.getByRole("button", {
      name: "Manage allocation for Placed Guest",
    });
    expect(manage).toBeDisabled();
    expect(manage).toHaveAttribute("title", ALL_LODGES_ALLOCATION_LOCK_REASON);

    fireEvent.click(manage);
    expect(
      screen.queryByRole("menuitem", { name: "Remove allocation" }),
    ).not.toBeInTheDocument();
  });
});
