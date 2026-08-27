// @vitest-environment jsdom

/*
 * The bed-allocation board's own half of the #2678 fix.
 *
 * WHY THIS FILE EXISTS AT ALL. `bed-allocation-get-lodge-validation.test.ts`
 * proves the API derives the board's lodge from `bookingId` and (since #2701)
 * refuses a `lodgeId` that contradicts it. That proof is worth nothing to the
 * board unless the board
 * actually SENDS `bookingId` on its own fetch — and nothing pinned that. The
 * whole of #2678's fix for the four board bed pickers (bucket "Select bed", the
 * allocation chip's "Move to bed", drag-and-drop onto a cell, and
 * `BedRangeAssignDialog` from the board) rests on one line in
 * `admin/bed-allocation/page.tsx` that nothing was asserting. Delete it and every
 * server-side test still passes while the board goes club-wide again.
 *
 * AND THE FLIP SIDE, which is the regression the fix itself created. Because the
 * API does not take its scope from a `lodgeId` sent beside a `bookingId`, an
 * admin who arrived on
 * the deep link and then chose a DIFFERENT lodge from the board's own selector
 * would have been served the booking's lodge under a selector reading the lodge
 * they picked. The board answers that by letting the focus go on a deliberate
 * lodge change — and by NOT letting it go when `LodgeSelect` reports `null` on
 * its own, because that is the `/api/admin/lodges` outage in which the
 * server-side derivation is the only thing keeping the board off a club-wide
 * read.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPayload } from "@/app/(admin)/admin/bed-allocation/_components/types";
import { settleLodgeScopedPage } from "@/lib/__tests__/helpers/lodge-scope-settle";

const editAccessMock = vi.hoisted(() => vi.fn());

// The deep link `AdminBookingToolsCard` builds (#2678): the booking, its own
// lodge, and its stay window.
vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams(
      "bookingId=booking-1&lodgeId=lodge-1&from=2026-07-01&to=2026-07-08",
    ),
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>();
  return { ...actual, useAdminAreaEditAccess: () => editAccessMock() };
});

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

/*
 * A LodgeSelect that fires nothing by itself. The real one normalises through
 * `onChange` in an effect, which is exactly the call this test has to be able to
 * tell apart from an admin's, so the two are driven explicitly here instead.
 *
 * Partially mocked (#2701): the board now reads the module's own `ALL_LODGES`
 * constant, so a factory that replaced the whole module would break at import
 * rather than at an assertion.
 *
 * Both buttons pass an explicit SOURCE (PR #2885 review). They used to pass
 * none and rely on the page defaulting to `"user"`, which was fail-open — a
 * caller that forgets the argument silently claims the admin browsed away from
 * the focused booking. The page now requires it, so the mock states which it
 * is, which is also what the real component does.
 *
 * The lodge list here is EMPTY, because `onChange(null)` is only something the
 * real `LodgeSelect` ever reports when it has no options left. With two lodges
 * in the list the old version of this mock was driving a state the component
 * cannot produce, so the test that used it was pinning nothing reachable.
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
        <button type="button" onClick={() => onChange("lodge-2", "user")}>
          Pick lodge two
        </button>
        <button type="button" onClick={() => onChange(null, "auto")}>
          Report no lodge
        </button>
      </div>
    ),
    useLodgeOptions: () => ({
      lodges: [],
      loading: false,
      failed: true,
      forbidden: false,
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
vi.mock("@/app/(admin)/admin/bed-allocation/_components/room-table", () => ({
  RoomTable: () => <div data-testid="room-table" />,
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
    // #2701: the board adopts the lodge the server says it scoped to. This
    // fixture is served for every request, including the ones made after a
    // deliberate lodge change, so it must agree with the deep link's own lodge
    // or the adoption would fight the assertions below.
    scopedLodgeId: "lodge-1",
  } as unknown as DashboardPayload;
}

/*
 * The board's own read, once its lodge scope has settled — the settle signal for
 * `settleLodgeScopedPage` below. It really is a PREFIX: `fetchDashboard` builds
 * the query as `from`, then `to`, then `lodgeId`, and `from`/`to` are fixed by
 * the deep link mocked at the top of this file.
 */
const SETTLED_BOARD_READ =
  "/api/admin/bed-allocation?from=2026-07-01&to=2026-07-08&lodgeId=";

function boardRequests(): URLSearchParams[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/admin/bed-allocation?"))
    .map((url) => new URLSearchParams(url.split("?")[1]));
}

describe("bed allocation board — booking scope on the deep link (#2678)", () => {
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

  it("names the booking on its own dashboard request, which is what lets the server scope it", async () => {
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    // MUTATION PROBE: drop `params.set("bookingId", …)` from `fetchDashboard`
    // and this is the only assertion in the repo that notices. Every
    // server-side #2678 test keeps passing, because the server can only derive
    // a lodge from a booking the client bothered to name.
    const [first] = boardRequests();
    expect(first?.get("bookingId")).toBe("booking-1");
    expect(first?.get("lodgeId")).toBe("lodge-1");
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
  });

  it("lets the focus go when the admin deliberately picks another lodge", async () => {
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    // Settle before interacting — same ordering hazard as the case below
    // (#2953), which is where the mechanism is written out. The selector is
    // mocked here, so its buttons are clickable on the commit that first renders
    // the board, a commit whose passive effects — including the #2701 echo
    // adoption that writes the lodge selection — have not necessarily run yet.
    await settleLodgeScopedPage(SETTLED_BOARD_READ);
    fireEvent.click(screen.getByRole("button", { name: "Pick lodge two" }));

    // The request that follows asks for lodge two and names NO booking, so the
    // server answers with lodge two rather than silently overriding it back to
    // the booking's lodge under a selector that now reads "Other Lodge".
    await waitFor(() => {
      const latest = boardRequests().at(-1);
      expect(latest?.get("lodgeId")).toBe("lodge-2");
      expect(latest?.has("bookingId")).toBe(false);
    });
    // And the drop is visible rather than silent.
    await waitFor(() =>
      expect(screen.queryByText("Focused booking")).not.toBeInTheDocument(),
    );
  });

  it("keeps the focus when LodgeSelect reports no lodge at all", async () => {
    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    // `LodgeSelect` calls `onChange(null, "auto")` by itself when
    // `/api/admin/lodges` fails and it is left with no options — the outage
    // state this mock now models, not a choice. Losing the focus there would be
    // the worst possible moment for it: the server's derivation from
    // `bookingId` is the only thing then keeping the board off a club-wide
    // read.
    //
    // SETTLE BEFORE INTERACTING, AND NOTE WHAT THIS IS AND IS NOT (#2953). This
    // suite already carried #2944's wider 4,000ms RTL window and still reddened
    // `main` — failing here in 4,125ms on CI, reproduced locally at 4,187ms
    // under 20 competing CPU burners (1 failure in 20 runs). It burned the whole
    // window and then reported the assertion, which is the signature of an
    // ordering bug rather than a slow one: no window can reach it.
    //
    // The mechanism is this page's own #2701 echo adoption. The first payload
    // arrives with `scopedLodgeId: "lodge-1"` and an effect adopts it into
    // `lodgeSelection`. That is a PASSIVE effect, so `findByTestId` above can
    // resolve on the commit that queued it, before it has run. A click landing
    // in that gap sets the selection to null and the still-queued adoption
    // immediately puts "lodge-1" back — so `dashboardScopeKey` round-trips to
    // the value it already had, `useScopedDashboard` never sees a change, and
    // the board never issues the unscoped read this case is about. The newest
    // request stays the FIRST one, which carries `lodgeId`, permanently.
    // Measured with a probe that clicked deliberately early: exactly one board
    // request ever recorded, `lodgeId=lodge-1&bookingId=booking-1`.
    //
    // So do not "simplify" this settle away, and do not relax or re-wrap the
    // assertions below to make them retry — the state they are waiting for is
    // terminal, and retrying it longer only buys a slower failure.
    await settleLodgeScopedPage(SETTLED_BOARD_READ);
    fireEvent.click(screen.getByRole("button", { name: "Report no lodge" }));

    await waitFor(() => {
      const latest = boardRequests().at(-1);
      expect(latest?.has("lodgeId")).toBe(false);
      expect(latest?.get("bookingId")).toBe("booking-1");
    });

    // SETTLE BEFORE ASSERTING, for the same reason and against the same class
    // (#2953). The read asserted above does not leave the board at rest.
    // Measured with a probe that let it run to quiescence, it makes THREE
    // requests here, not two:
    //
    //   1. lodgeId=lodge-1&bookingId=booking-1   the deep link
    //   2. bookingId=booking-1                   the null report, asserted above
    //   3. lodgeId=lodge-1&bookingId=booking-1   #2701 re-adopts the lodge the
    //                                            server said it scoped to, which
    //                                            is the focus being KEPT, not lost
    //
    // `useScopedDashboard` clears its value whenever the scope key changes, and
    // the badge renders only inside `{payload ? … }`, so the badge is unmounted
    // twice between requests 2 and 3. Reading the DOM synchronously in one of
    // those gaps fails as `Unable to find an element with the text: Focused
    // booking` — observed 2 times in 30 runs under 20 competing CPU burners, and
    // in ~150ms each time, so it is an ordering failure and not a slow one.
    //
    // Waiting for the board to come to REST is not the same thing as retrying
    // the assertion: what is waited on below is the board's own request and
    // render, and the badge assertion still gets exactly one chance, on the
    // state the board settles in. Do not fold it into the wait.
    await waitFor(() => {
      expect(boardRequests()).toHaveLength(3);
      expect(screen.getByTestId("room-table")).toBeInTheDocument();
    });
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
  });
});
