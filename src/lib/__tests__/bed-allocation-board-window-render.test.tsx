// @vitest-environment jsdom

/*
 * The board's REFUSED-WINDOW render guard (#2251).
 *
 * `boardWindowError()` withholds the fetch, but a payload from the PREVIOUS good
 * window survives in React state. Without the `payload && !windowError` guard in
 * the page, the board keeps rendering those stale rows underneath an Alert that
 * says the window is out of range — the admin sees a board for a window they no
 * longer asked for. The board-window unit tests cover the helper; this covers the
 * page actually honouring it.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPayload } from "@/app/(admin)/admin/bed-allocation/_components/types";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { APP_TIME_ZONE } from "@/config/operational";
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone";

const openRemovalDialogMock = vi.hoisted(() => vi.fn());
const openMoveDialogMock = vi.hoisted(() => vi.fn());
const moveDialogOptionsMock = vi.hoisted(() => vi.fn());
const editAccessMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>();
  return { ...actual, useAdminAreaEditAccess: () => editAccessMock() };
});

// #2286: the board's custodian copy uses the club's own word for the role.
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

// Partially mocked (#2701): the board reads this module's own `ALL_LODGES`
// constant, so replacing the whole module breaks it at import.
vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/lodge-select")>();
  return {
    ...actual,
    LodgeSelect: ({ onChange }: { onChange: (value: string) => void }) => {
      useEffect(() => onChange("lodge-1"), [onChange]);
      return null;
    },
    useLodgeOptions: () => ({
      lodges: [{ id: "lodge-1", name: "Test Lodge" }],
      loading: false,
      failed: false,
      reload: vi.fn(),
    }),
  };
});
vi.mock("@/components/admin/bed-allocation-removal-dialog", () => ({
  bedAllocationRemovalCategoryForAnchor: (
    source: "AUTO" | "MANUAL",
    approvedAt: string | null,
  ) => (approvedAt ? "APPROVED" : source === "AUTO" ? "AUTO_DRAFT" : "MANUAL_DRAFT"),
  useBedAllocationRemovalDialog: () => ({
    openRemovalDialog: openRemovalDialogMock,
    dialog: <div data-testid="removal-dialog-seam" />,
  }),
}));
vi.mock("@/components/admin/bed-allocation-move-dialog", () => ({
  useBedAllocationMoveDialog: (options: unknown) => {
    moveDialogOptionsMock(options);
    return {
      openMoveDialog: openMoveDialogMock,
      dialog: <div data-testid="move-dialog-seam" />,
    };
  },
}));

// The board's contents are covered by their own component tests; here we only
// need to know WHETHER the board rendered at all.
vi.mock("@/app/(admin)/admin/bed-allocation/_components/room-table", () => ({
  RoomTable: ({
    onReassignBed,
  }: {
    onReassignBed: (
      allocation: {
        id: string;
        guestName: string;
        stayDate: string;
      },
      bedId: string,
      focusOrigin?: HTMLElement | null,
    ) => void;
  }) => (
    <div data-testid="room-table">
      <button
        type="button"
        onClick={(event) =>
          onReassignBed(
            {
              id: "allocation-1",
              guestName: "Ada Guest",
              stayDate: "2026-07-01",
            },
            "bed-1",
            event.currentTarget,
          )
        }
      >
        Open allocation move
      </button>
    </div>
  ),
}));
vi.mock("@/app/(admin)/admin/bed-allocation/_components/bucket-board", () => ({
  BucketBoard: () => <div data-testid="bucket-board" />,
}));
vi.mock("@/components/admin/bed-range-assign-dialog", () => ({
  BedRangeAssignDialog: () => null,
}));

import AdminBedAllocationPage from "@/app/(admin)/admin/bed-allocation/page";

function buildPayload(): DashboardPayload {
  return {
    settings: {
      autoAllocationEnabled: true,
      allocationPriorityOrder: [
        "BOOKING_COHESION",
        "STAY_CONTINUITY",
        "REQUESTED_ROOM",
        "FAMILY_COHESION",
      ],
      updatedAt: null,
      updatedByMemberId: null,
    },
    range: { fromDate: "2026-06-01", toDate: "2026-06-08" },
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
            bunkGroupId: null,
            bunkPosition: null,
          },
        ],
      },
    ],
    bookings: [],
    allocations: [],
    unallocatedGuestNights: [],
    exclusiveHolds: [],
    suggestedAllocations: [],
    suggestedUnallocatedGuestNights: [],
    warnings: [],
    focusedBooking: null,
  } as unknown as DashboardPayload;
}

describe("bed allocation board — refused window", () => {
  beforeEach(() => {
    openRemovalDialogMock.mockReset();
    openMoveDialogMock.mockReset();
    moveDialogOptionsMock.mockReset();
    editAccessMock.mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => buildPayload(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("stops rendering the previous window's board once the typed window is refused", async () => {
    render(<AdminBedAllocationPage />);

    // A good window first: the board is on screen and a payload is in state.
    await waitFor(() => {
      expect(screen.getByTestId("room-table")).toBeInTheDocument();
    });

    const fetchCallsAfterLoad = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls.length;

    // Now type a window longer than the board's 31-night maximum.
    fireEvent.change(screen.getByLabelText("Date In"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText("Date Out"), {
      target: { value: "2026-09-01" },
    });

    await waitFor(() => {
      expect(
        screen.getByText("The board window is out of range"),
      ).toBeInTheDocument();
    });

    // The stale board is GONE — the refusal is the only thing on screen for a
    // window the board will not show.
    expect(screen.queryByTestId("room-table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bucket-board")).not.toBeInTheDocument();
    // And no request was issued for the refused window.
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      fetchCallsAfterLoad,
    );

    // Back inside the limit, the board returns.
    fireEvent.change(screen.getByLabelText("Date Out"), {
      target: { value: "2026-06-08" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("room-table")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("The board window is out of range"),
    ).not.toBeInTheDocument();
  });

  it("opens the shared staged dialog from Reset allocations", async () => {
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    const reset = screen.getByRole("button", { name: "Reset allocations…" });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);

    expect(openRemovalDialogMock).toHaveBeenCalledWith({
      allocations: [],
      lodgeId: "lodge-1",
      lodgeName: "Test Lodge",
      window: { from: "2026-07-01", to: "2026-07-08" },
      initialScope: "WINDOW",
      initialCategories: [],
    });
  });

  it("lets a view-only admin open the non-mutating reset preview", async () => {
    editAccessMock.mockReturnValue(false);
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    const reset = screen.getByRole("button", { name: /Reset allocations/ });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    expect(openRemovalDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lodgeId: "lodge-1",
        initialScope: "WINDOW",
        initialCategories: [],
      }),
    );
  });

  it("lets a view-only admin open a move preview from the integrated board", async () => {
    editAccessMock.mockReturnValue(false);
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    const origin = screen.getByRole("button", { name: "Open allocation move" });
    fireEvent.click(origin);

    expect(openMoveDialogMock).toHaveBeenCalledWith(
      {
        allocationId: "allocation-1",
        guestName: "Ada Guest",
        stayDate: "2026-07-01",
      },
      {
        destinationBedId: "bed-1",
        destinationLabel: "Example Room / Bed One",
      },
      origin,
    );
  });

  it("rejects the real page move callback when its committed move cannot refresh", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => buildPayload() });
    vi.stubGlobal("fetch", fetch);
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");
    const callsBeforeRefresh = fetch.mock.calls.length;
    fetch.mockRejectedValueOnce(new Error("refresh unavailable"));

    const options = moveDialogOptionsMock.mock.calls.at(-1)?.[0] as {
      onApplied: (result: {
        noop: boolean;
        movedRowCount: number;
        promotedRowCount: number;
        affectedNights: string[];
      }) => Promise<void>;
    };
    await expect(
      options.onApplied({
        noop: false,
        movedRowCount: 1,
        promotedRowCount: 0,
        affectedNights: ["2026-07-01"],
      }),
    ).rejects.toThrow(
      "The allocation moved, but the board could not be refreshed",
    );
    expect(fetch).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
  });
});

/*
 * #2286 review L4: the deploy-drain tolerance, pinned DELIBERATELY.
 *
 * The fixture above happens to omit `custodianHolds`, so this file already
 * exercised the tolerance by accident — and an accident is not a contract. A
 * new-colour browser bundle can be served an OLD-colour payload during a drain,
 * and crashing the entire allocation board in that window would be far worse
 * than the drain exposure the feature already accepts and documents. The
 * assertion is explicit so a later refactor that dereferences the field again
 * fails here with the reason attached.
 */
describe("bed allocation board — a payload with no custodianHolds (#2286)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the whole board, with no custodian banner and no crash", async () => {
    const drainPayload = buildPayload() as unknown as Record<string, unknown>;
    delete drainPayload.custodianHolds;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => drainPayload }),
    );

    render(<AdminBedAllocationPage />);

    await waitFor(() => {
      expect(screen.getByTestId("room-table")).toBeInTheDocument();
    });
    // The banner is absent (nothing is held) rather than the board being gone.
    expect(screen.queryByText(/not available to allocate/i)).toBeNull();
  });

  it("renders the banner when the field IS present, so the tolerance is not hiding it", async () => {
    const payload = buildPayload() as unknown as Record<string, unknown>;
    payload.custodianHolds = [
      {
        assignmentId: "a1",
        memberName: "Sam Ranger",
        bedId: "bed-1",
        bedName: "Bed One",
        roomId: "room-1",
        roomName: "Example Room",
        startDate: "2026-06-01",
        endDate: "2026-06-08",
        nights: ["2026-06-01"],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
    );

    render(<AdminBedAllocationPage />);

    await waitFor(() => {
      expect(screen.getByTestId("room-table")).toBeInTheDocument();
    });
    expect(screen.getByText(/not available to allocate/i)).toBeInTheDocument();
    // Singular wording comes from the tolerant list's own length, not from the
    // raw payload field (the bug this finding named).
    expect(screen.getByText(/This bed is/)).toBeInTheDocument();
  });
});


/**
 * THE DISCRIMINATING ONE (CT-4, #2870).
 *
 * Every render above uses the default `CLUB_TIME_TEST_ZONE`, which is
 * deliberately the zone `APP_TIME_ZONE` also resolves to, so the board's opening
 * night is the same string whether the page read its provider or the
 * environment — and this whole file passes against either.
 *
 * The opening night is the board an officer allocates beds on. A day out and
 * every guest chip on screen belongs to a different night from the one the
 * officer thinks they are looking at, which is a bed-allocation error rather
 * than a display one. It travels in the request's `from` parameter, which is
 * where it is read back here.
 */
describe("bed allocation board — the opening night comes from the club's zone (CT-4, #2870)", () => {
  const dayIn = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      // An independent oracle rather than the kernel under test, so one defect
      // cannot satisfy both sides of the comparison.
    }).format(new Date());

  beforeEach(() => {
    editAccessMock.mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildPayload() }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("opens on the PERSISTED club zone's night, not APP_TIME_ZONE's", async () => {
    const chosen = chooseDivergentClubZone({
      subject: "the club's today at the frozen instant",
      answerKey: "day",
      cases: [
        { zone: "America/Denver", day: "2026-06-30" }, // -6: still 30 June
        { zone: "Pacific/Kiritimati", day: "2026-07-01" }, // +14: already 1 July
      ],
      answerFor: dayIn,
      // NOT `["UTC"]` — see the chooser's note on "today" assertions.
    });
    // `answerKey` makes the chooser check the literal against its own zone, so
    // `chosen.day` is provably not the environment's answer.
    const environmentDay = dayIn(APP_TIME_ZONE);

    render(<AdminBedAllocationPage />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ClubTimeProvider zone={chosen.zone}>{children}</ClubTimeProvider>
      ),
    });
    await waitFor(() => {
      expect(screen.getByTestId("room-table")).toBeInTheDocument();
    });

    const urls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      ([url]) => String(url),
    );
    expect(urls.some((url) => url.includes(`from=${chosen.day}`))).toBe(true);
    expect(urls.some((url) => url.includes(`from=${environmentDay}`))).toBe(false);
  });
});
