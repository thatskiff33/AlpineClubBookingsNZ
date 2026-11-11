// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ComponentProps, ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AllocationChip } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/allocation-chip";
import { getBookingAccent } from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/booking-accent";
import type {
  BedOption,
  BedOptionGroup,
  DashboardAllocation,
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

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({
    children,
    className,
    collisionPadding,
  }: {
    children: ReactNode;
    className?: string;
    collisionPadding?: number;
  }) => (
    <div className={className} data-collision-padding={collisionPadding} role="menu">
      {children}
    </div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    className,
    disabled,
    "aria-label": ariaLabel,
  }: ComponentProps<"div"> & {
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <div
      aria-label={ariaLabel}
      className={className}
      role="menuitem"
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onSelect}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSubContent: ({
    children,
    className,
    collisionPadding,
  }: {
    children: ReactNode;
    className?: string;
    collisionPadding?: number;
  }) => (
    <div className={className} data-collision-padding={collisionPadding} role="group">
      {children}
    </div>
  ),
  DropdownMenuSubTrigger: ({
    children,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button aria-label={ariaLabel} type="button" disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

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
    source: "MANUAL",
    approvedAt: null,
    approvedByName: null,
    bookingStatus: "CONFIRMED",
    holdsCapacity: true,
    isSecondOccupant: false,
    ...overrides,
  };
}

const bedOptions: BedOption[] = [
  {
    id: "bed-1",
    roomId: "room-1",
    roomName: "Room One",
    bedName: "Bed One",
    label: "Room One / Bed One",
  },
  {
    id: "bed-2",
    roomId: "room-1",
    roomName: "Room One",
    bedName: "Bed Two",
    label: "Room One / Bed Two",
  },
  {
    id: "bed-3",
    roomId: "room-2",
    roomName: "Room Two",
    bedName: "Bed Three",
    label: "Room Two / Bed Three",
  },
];

const bedOptionGroups: BedOptionGroup[] = [
  {
    roomId: "room-1",
    roomName: "Room One",
    beds: [bedOptions[0], bedOptions[1]],
  },
  {
    roomId: "room-2",
    roomName: "Room Two",
    beds: [bedOptions[2]],
  },
];

function renderChip({
  allocation = buildAllocation(),
  canEdit = true,
  onReassignBed = vi.fn(),
  onRemove = vi.fn(),
  options = [],
  groups = [],
}: {
  allocation?: DashboardAllocation;
  canEdit?: boolean;
  onReassignBed?: (bedId: string, focusOrigin?: HTMLElement | null) => void;
  onRemove?: () => void;
  options?: BedOption[];
  groups?: BedOptionGroup[];
} = {}) {
  return render(
    <AllocationChip
      allocation={allocation}
      bedOptions={options}
      bedOptionGroups={groups}
      onReassignBed={onReassignBed}
      onRemove={onRemove}
      onAssignRange={vi.fn()}
      pending={false}
      canEdit={canEdit}
    />,
  );
}

describe("AllocationChip held vs provisional state (#1251)", () => {
  it("labels a capacity-holding booking as Held with a solid border", () => {
    const { container } = renderChip(
      {
        allocation: buildAllocation({ bookingStatus: "PAID", holdsCapacity: true }),
      },
    );

    expect(screen.getByText("Held")).toBeTruthy();
    expect(screen.queryByText("Provisional")).toBeNull();

    // The chip card must not use the dashed treatment reserved for provisional
    // beds — Held reads as a firm hold at a glance.
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).not.toContain("border-dashed");
  });

  it("labels a provisional booking as Provisional with a dashed border", () => {
    const { container } = renderChip(
      {
        allocation: buildAllocation({
          bookingStatus: "PENDING",
          holdsCapacity: false,
        }),
      },
    );

    expect(screen.getByText("Provisional")).toBeTruthy();
    expect(screen.queryByText("Held")).toBeNull();

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("border-dashed");
  });

  it("labels an accepted-but-unpaid quote (PENDING but holding) as Held (#1254)", () => {
    // Server sets holdsCapacity=true for a request-converted PENDING booking, so
    // the board must show it Held even though its status is PENDING.
    renderChip({
      allocation: buildAllocation({ bookingStatus: "PENDING", holdsCapacity: true }),
    });

    expect(screen.getByText("Held")).toBeTruthy();
    expect(screen.queryByText("Provisional")).toBeNull();
  });

  it.each(["PAYMENT_PENDING", "WAITLIST_OFFERED"])(
    "treats %s (bed-allocatable but not capacity-holding) as Provisional",
    (status) => {
      renderChip({
        allocation: buildAllocation({ bookingStatus: status, holdsCapacity: false }),
      });
      expect(screen.getByText("Provisional")).toBeTruthy();
    },
  );

  it("uses theme tokens (not hardcoded light colours) for both states", () => {
    const { container: held } = renderChip(
      {
        allocation: buildAllocation({
          bookingStatus: "CONFIRMED",
          holdsCapacity: true,
        }),
      },
    );
    const { container: provisional } = renderChip(
      {
        allocation: buildAllocation({
          bookingStatus: "PENDING",
          holdsCapacity: false,
        }),
      },
    );

    // Regression guard for the dark-mode requirement: the previous chip used
    // `bg-white`, which breaks in dark mode. The distinction now rides on
    // theme-aware tokens plus a non-colour signal (border style + label).
    const heldCard = held.firstElementChild as HTMLElement;
    const provisionalCard = provisional.firstElementChild as HTMLElement;
    expect(heldCard.className).not.toContain("bg-white");
    expect(provisionalCard.className).not.toContain("bg-white");
    expect(heldCard.className).toContain("bg-card");
    expect(provisionalCard.className).toContain("bg-muted");
  });

  it("renders a deterministic booking accent and age-tier badge", () => {
    const allocation = buildAllocation({
      bookingId: "booking-colour-1",
      guestAgeTier: "YOUTH",
    });
    const { container } = renderChip({ allocation });
    const card = container.firstElementChild as HTMLElement;
    const accentStrip = card.querySelector('[aria-hidden="true"]') as HTMLElement;

    expect(card).toHaveAttribute("title", "Booking booking-colour-1");
    expect(accentStrip.className).toContain(
      getBookingAccent("booking-colour-1").stripClassName,
    );
    expect(card.className).toContain(
      getBookingAccent("booking-colour-1").ringClassName,
    );
    const badge = screen.getByText("YOUTH");
    expect(badge).toBeInTheDocument();
    for (const className of AGE_TIER_COLORS.YOUTH.split(" ")) {
      expect(badge.className).toContain(className);
    }
  });

  it("keeps move and removal previews reachable while disabling view-only writes", () => {
    const onRemove = vi.fn();
    const onReassignBed = vi.fn();
    renderChip({
      canEdit: false,
      onRemove,
      onReassignBed,
      options: bedOptions,
      groups: bedOptionGroups,
    });

    expect(
      screen.getByRole("button", {
        name: /Drag Example Guest to another bed; original lodge night 2026-07-01 will be kept/i,
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Manage allocation for Example Guest/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Move Example Guest to a bed in Room One",
      }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Room One \/ Bed Two/i }),
    );
    expect(onReassignBed).toHaveBeenCalledWith("bed-2", expect.any(HTMLElement));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove allocation" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("groups move targets by room and keeps the current bed selectable", () => {
    renderChip({ options: bedOptions, groups: bedOptionGroups });

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Move to bed")).toBeInTheDocument();
    expect(menu.className).toContain("max-h-[min(60vh,20rem)]");
    expect(menu.className).toContain("overflow-y-auto");
    expect(menu).toHaveAttribute("data-collision-padding", "8");
    expect(
      screen.getByRole("button", {
        name: "Move Example Guest to a bed in Room One",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Move Example Guest to a bed in Room Two",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Bed One")).toBeInTheDocument();
    expect(screen.getByText("Bed Two")).toBeInTheDocument();
    expect(screen.getByText("Bed Three")).toBeInTheDocument();

    const submenus = screen.getAllByRole("group");
    expect(submenus[0].className).toContain("max-h-[min(60vh,18rem)]");
    expect(submenus[0].className).toContain("overflow-y-auto");
    expect(submenus[0]).toHaveAttribute("data-collision-padding", "8");
  });

  it("keeps a room whose only move target is the anchor's current bed", () => {
    renderChip({
      allocation: buildAllocation({ bedId: "bed-3" }),
      options: bedOptions,
      groups: bedOptionGroups,
    });

    expect(
      screen.getByRole("button", {
        name: "Move Example Guest to a bed in Room Two",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Room One")).toBeInTheDocument();
  });

  it("calls the reassignment and remove handlers from the menu", () => {
    const onReassignBed = vi.fn();
    const onRemove = vi.fn();
    renderChip({
      options: bedOptions,
      groups: bedOptionGroups,
      onReassignBed,
      onRemove,
    });

    fireEvent.click(screen.getByRole("menuitem", { name: /Room One \/ Bed Two/i }));
    expect(onReassignBed).toHaveBeenCalledWith("bed-2", expect.any(HTMLElement));

    fireEvent.click(screen.getByRole("menuitem", { name: "Remove allocation" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
