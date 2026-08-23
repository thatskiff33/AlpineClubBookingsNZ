// @vitest-environment jsdom

/*
 * #2701 — the bed-allocation board's lodge scope means exactly one thing.
 *
 * Before this, `null` stood for three unrelated situations at once — "I chose
 * to see every lodge", "the selector has not resolved yet" and
 * "/api/admin/lodges failed" — and the board's four bed pickers offered every
 * lodge's beds in all three, including the two nobody chose. A test that only
 * proved the happy path would have missed every one of them, so each situation
 * is pinned here separately:
 *
 *   - a DIRECT visit fetches nothing until it has settled on a real lodge, so
 *     the transient club-wide board is gone rather than merely tidied up;
 *   - a FAILED lodge list is an error with a retry, and cannot produce the same
 *     screen as a deliberate All lodges;
 *   - a DEEP LINK lands on the focused booking's own lodge, even when that is
 *     not the first lodge in the options list.
 *
 * The real `LodgeSelect` and `useLodgeOptions` are used deliberately — the
 * defect lived in their normalising effect, so a stubbed selector would prove
 * nothing about it.
 *
 * THE FAKE SERVER HERE REFUSES THROUGH THE REAL PREDICATE
 * (`boardLodgeScopeMismatch`, the same function `GET /api/admin/bed-allocation`
 * calls). That is what makes "the 409 cannot fire on normal navigation" a real
 * proof rather than a restatement: if the board ever sends a contradictory
 * `bookingId`/`lodgeId` pair, these tests see the refusal.
 *
 * MUTATION PROBES THIS FILE KILLS, each verified by making the change and
 * watching it fail (PR #2885 review asked for the list to be nameable):
 *
 *   - `deferDefaultSelection={focusedBookingOwnsLodge}` reverted to the
 *     narrower pre-review expression -> 5 failures here, including a measured
 *     26-request storm against a budget of 3;
 *   - reverted to the EXACT pre-review expression, error-clears clause and all
 *     -> 8 failures, adding the transient-500 and deploy-drain cases;
 *   - the `scopedLodgeId` adoption effect deleted -> the deep-link and
 *     no-storm tests fail;
 *   - `enabled: scopeCanLoadBoard` dropped from the dashboard hook -> the
 *     direct-visit and lodge-list-failure tests fail;
 *   - the route's 409 disabled -> `bed-allocation-get-lodge-validation.test.ts`
 *     fails;
 *   - the drain tolerance (`scopedLodgeId !== undefined`) weakened to
 *     `payload !== null` -> the drain test fails.
 *
 * ORDERING IS PART OF SEVERAL OF THESE TESTS. The adoption effect only re-runs
 * when the served lodge CHANGES, so when the lodge options land in the same
 * commit as the first payload, adoption happens to overwrite the normaliser's
 * write and the defect hides. `holdLodges` / `holdFirstBoard` pin the order
 * that actually occurs in production, where the two endpoints are not a
 * photo finish.
 */

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPayload } from "@/app/(admin)/admin/bed-allocation/_components/types";
import {
  BOARD_LODGE_MISMATCH_CODE,
  BOARD_LODGE_MISMATCH_MESSAGE,
  boardLodgeScopeMismatch,
} from "@/lib/bed-allocation-board-scope";

const search = vi.hoisted(() => ({ current: "from=2026-07-01&to=2026-07-08" }));
const editAccessMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.current),
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
// Its own suite covers it; here it would only add a second endpoint to fake.
vi.mock(
  "@/app/(admin)/admin/bed-allocation/_components/allocation-preferences-section",
  () => ({
    AllocationPreferencesSection: () => (
      <div data-testid="allocation-preferences" />
    ),
  }),
);

import AdminBedAllocationPage from "@/app/(admin)/admin/bed-allocation/page";

const LODGES = [
  { id: "lodge-1", name: "Alpine Lodge", active: true },
  { id: "lodge-2", name: "River Lodge", active: true },
];

// booking-b lives at the SECOND lodge, so every "first lodge wins" defect shows
// up as a visible disagreement rather than an accidental pass.
const BOOKING_LODGE: Record<string, string> = { "booking-b": "lodge-2" };

function buildPayload(scopedLodgeId: string | null): DashboardPayload {
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
    custodianHolds: [],
    suggestedAllocations: [],
    suggestedUnallocatedGuestNights: [],
    warnings: [],
    focusedBooking: null,
    scopedLodgeId,
  } as unknown as DashboardPayload;
}

/**
 * The board is allowed a handful of requests while its scope settles: the first
 * read, and at most one more after adopting the lodge the server named. Anything
 * beyond this is a feedback loop, and the assertion that catches one has to be a
 * COUNT — "a request was made" passes just as happily at 62 (PR #2885 review).
 */
const SETTLED_REQUEST_BUDGET = 3;

/**
 * Hard stop inside the fake server. A loop here would otherwise run until the
 * test timed out with no useful message; this turns it into a named failure at
 * the point of the offending request.
 */
const RUNAWAY_REQUEST_CAP = 25;

/**
 * Let every pending microtask AND a few macrotask turns drain. A storm is
 * paced by its own round trips, so a single `await waitFor` can photograph it
 * mid-loop and see a perfectly innocent count.
 */
async function settle(turns = 6) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface FakeServer {
  /** Every board request the page made, in order. */
  boardRequests: URLSearchParams[];
  /** Board requests the server REFUSED with the 409 backstop. */
  refusals: URLSearchParams[];
  /** Resolve the pending `/api/admin/lodges` response. */
  releaseLodges: () => void;
  /** Resolve the pending FIRST `/api/admin/bed-allocation` response. */
  releaseFirstBoard: () => void;
  /** Make the next `/api/admin/lodges` attempt fail (or succeed again). */
  setLodgesFailing: (failing: boolean) => void;
  /** Fail the next N board reads with a 500, then behave normally. */
  failNextBoardReads: (count: number) => void;
}

function installFakeServer(options?: {
  holdLodges?: boolean;
  /** The ACTIVE lodges `/api/admin/lodges` reports. Defaults to both. */
  lodges?: Array<{ id: string; name: string; active: boolean }>;
  /**
   * Answer `/api/admin/lodges` with 403 — the shipped `ADMIN_MEMBERSHIP` and
   * `FINANCE_ADMIN` presets, which may open this board and may not read the
   * lodge list.
   */
  lodgesForbidden?: boolean;
  /**
   * Serve payloads with NO `scopedLodgeId` field at all — an old-colour server
   * during a deploy drain, which cannot answer the lodge question.
   */
  omitScopeEcho?: boolean;
  /**
   * Hold the FIRST board response open. Without this the two endpoints race,
   * and the order that matters — options land while the deep link's board read
   * is still in flight — is the one that happens to lose. It is also the
   * realistic order: `/api/admin/lodges` is the smaller query.
   */
  holdFirstBoard?: boolean;
  lodgesFailing?: boolean;
}): FakeServer {
  const state: FakeServer = {
    boardRequests: [],
    refusals: [],
    releaseLodges: () => {},
    releaseFirstBoard: () => {},
    setLodgesFailing: (failing) => {
      lodgesFailing = failing;
    },
    failNextBoardReads: (count) => {
      boardFailuresLeft = count;
    },
  };
  let lodgesFailing = options?.lodgesFailing ?? false;
  let boardFailuresLeft = 0;
  const activeLodges = options?.lodges ?? LODGES;
  let release = () => {};
  const gate = options?.holdLodges
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  state.releaseLodges = () => release();

  let releaseBoard = () => {};
  let boardGate: Promise<void> | null = options?.holdFirstBoard
    ? new Promise<void>((resolve) => {
        releaseBoard = resolve;
      })
    : null;
  state.releaseFirstBoard = () => releaseBoard();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);

      if (url.startsWith("/api/admin/lodges")) {
        await gate;
        if (options?.lodgesForbidden) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ error: "Forbidden" }),
          };
        }
        if (lodgesFailing) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "boom" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ lodges: activeLodges }),
        };
      }

      if (url.startsWith("/api/admin/bed-allocation?")) {
        const params = new URLSearchParams(url.split("?")[1]);
        state.boardRequests.push(params);
        if (state.boardRequests.length > RUNAWAY_REQUEST_CAP) {
          throw new Error(
            `runaway board requests: ${state.boardRequests.length} reads for one settled scope — ` +
              `the last two were ${state.boardRequests
                .slice(-2)
                .map((request) => request.toString())
                .join(" then ")}`,
          );
        }
        if (boardFailuresLeft > 0) {
          boardFailuresLeft -= 1;
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "The board could not be loaded" }),
          };
        }
        if (boardGate) {
          const pending = boardGate;
          boardGate = null;
          await pending;
        }
        const bookingId = params.get("bookingId");
        const requestedLodgeId = params.get("lodgeId");
        const bookingLodgeId = bookingId
          ? (BOOKING_LODGE[bookingId] ?? null)
          : null;
        // The REAL refusal rule, imported rather than restated.
        if (boardLodgeScopeMismatch(bookingLodgeId, requestedLodgeId)) {
          state.refusals.push(params);
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: BOARD_LODGE_MISMATCH_MESSAGE,
              code: BOARD_LODGE_MISMATCH_CODE,
            }),
          };
        }
        const payload = buildPayload(bookingLodgeId ?? requestedLodgeId);
        if (options?.omitScopeEcho) {
          delete (payload as { scopedLodgeId?: string | null }).scopedLodgeId;
        }
        return { ok: true, status: 200, json: async () => payload };
      }

      throw new Error(`unexpected fetch: ${url}`);
    }),
  );

  return state;
}

beforeEach(() => {
  editAccessMock.mockReturnValue(true);
  search.current = "from=2026-07-01&to=2026-07-08";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("bed-allocation board — a direct visit settles on a real lodge (#2701)", () => {
  it("asks for no board at all while the lodge options are still in flight", async () => {
    const server = installFakeServer({ holdLodges: true });

    render(<AdminBedAllocationPage />);

    // MUTATION PROBE: drop `scopeCanLoadBoard` from the dashboard hook's
    // `enabled` and this fails immediately — the board fires an unscoped
    // request on every mount, which is the transient club-wide read this issue
    // exists to remove. Nothing else in the repo notices.
    // Two matches by design: the Spinner's screen-reader label and the visible
    // text beside it say the same thing.
    await screen.findAllByText("Choosing which lodge to show");
    expect(server.boardRequests).toHaveLength(0);

    server.releaseLodges();

    await waitFor(() => expect(server.boardRequests).toHaveLength(1));
    // And the FIRST thing it ever asks for is a concrete lodge, never the
    // club-wide read.
    expect(server.boardRequests[0]?.get("lodgeId")).toBe("lodge-1");
    await screen.findByTestId("room-table");
  });

  it("honours a lodgeId already on the URL rather than defaulting past it", async () => {
    search.current = "from=2026-07-01&to=2026-07-08&lodgeId=lodge-2";
    const server = installFakeServer();

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    expect(
      server.boardRequests.every(
        (request) => request.get("lodgeId") === "lodge-2",
      ),
    ).toBe(true);
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
  });
});

describe("bed-allocation board — a failed lodge list is not a club-wide view (#2701)", () => {
  it("shows an error with a retry, loads no board, and never looks like All lodges", async () => {
    const server = installFakeServer({ lodgesFailing: true });

    render(<AdminBedAllocationPage />);

    await screen.findByText("The lodge list could not be loaded");

    // The distinction is BY CONSTRUCTION, not by the message: with no options
    // there is nothing to select, so the board asks for nothing rather than
    // reading the whole club.
    expect(server.boardRequests).toHaveLength(0);
    // And the deliberate club-wide screen is definitively absent, so the two
    // states cannot be confused with each other.
    expect(
      screen.queryByText("All lodges — read-only overview"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/This board is showing every lodge/),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("room-table")).not.toBeInTheDocument();
  });

  it("recovers through the retry affordance", async () => {
    const server = installFakeServer({ lodgesFailing: true });

    render(<AdminBedAllocationPage />);
    await screen.findByText("The lodge list could not be loaded");

    server.setLodgesFailing(false);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByTestId("room-table");
    expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-1");
    expect(
      screen.queryByText("The lodge list could not be loaded"),
    ).not.toBeInTheDocument();
  });
});

describe("bed-allocation board — a deep-linked booking brings its own lodge (#2701)", () => {
  it("lands a second-lodge booking on the SECOND lodge's board when the link names no lodge", async () => {
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    // The order that matters: the lodge options arrive while the board read is
    // still in flight, so the selector is holding two lodges and no selection
    // at the exact moment it would otherwise default to the first one.
    const server = installFakeServer({ holdFirstBoard: true });

    render(<AdminBedAllocationPage />);
    // The selector renders as soon as two lodges are known (ADR-002).
    await screen.findByRole("combobox");

    // MUTATION PROBE for the deferral: drop `deferDefaultSelection` from the
    // board's `LodgeSelect` and this is where it breaks — the selector fires
    // `lodges[0]`, the board asks again pairing booking-b with lodge-1, and
    // the server refuses it. That is the defence firing on ordinary
    // navigation, which is the one thing it must never do.
    expect(server.boardRequests).toHaveLength(1);
    expect(server.boardRequests[0]?.has("lodgeId")).toBe(false);

    server.releaseFirstBoard();
    await screen.findByTestId("room-table");

    // The selector, the board and the focus all agree on lodge two — the
    // booking's own lodge — even though lodge one is first in the options list
    // and used to win by default.
    await waitFor(() =>
      expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-2"),
    );
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
    expect(server.boardRequests.at(-1)?.get("bookingId")).toBe("booking-b");
    expect(server.refusals).toEqual([]);
    // MUTATION PROBE for the adoption effect: delete it and the selection never
    // becomes lodge-2, so no request ever carries it.
    expect(
      server.boardRequests.some(
        (request) => request.get("lodgeId") === "lodge-1",
      ),
    ).toBe(false);
  });

  it("keeps the deep link the booking page actually builds on its own lodge", async () => {
    // `AdminBookingToolsCard` sends the booking AND `booking.lodgeId`. That
    // pair agrees, so it is served, and the selector reads the same lodge the
    // data came from.
    search.current =
      "from=2026-07-01&to=2026-07-08&bookingId=booking-b&lodgeId=lodge-2";
    const server = installFakeServer();

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    expect(server.refusals).toHaveLength(0);
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
  });
});

/*
 * PR #2885 review, HIGH 1 — the request storm, and its root cause.
 *
 * `LodgeSelect`'s ADR-002 normaliser fires whenever fewer than two ACTIVE
 * lodges are offered, and it fires even though the same condition makes it
 * render nothing. So it overwrote the lodge the board had just adopted from the
 * server, the scope key changed, the board refetched, the echo re-adopted, and
 * round it went — 62 dashboard reads in about a second, paced by network round
 * trips so React never saw a synchronous cycle and nothing crashed.
 *
 * Every test here asserts a COUNT. "A request was made" passes at 62 too.
 */
describe("bed-allocation board — the scope settles instead of looping (#2701)", () => {
  it("stops after adopting the lodge when the lodge list has FAILED", async () => {
    // The state the board's own comment calls the one that "matters most", and
    // the one with no test before this.
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    const server = installFakeServer({ lodgesFailing: true });

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");
    await settle();

    expect(server.boardRequests.length).toBeLessThanOrEqual(
      SETTLED_REQUEST_BUDGET,
    );
    expect(server.refusals).toEqual([]);
    // And it settled on the RIGHT lodge, not merely quietly.
    expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-2");
  });

  it("stops when the lodge list is SUCCESSFUL but empty", async () => {
    // Not only the failure path: the trigger is `lodges.length < 2`, so a
    // perfectly healthy club with no active lodges looped identically — and
    // without even the error alert to hint at it.
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    const server = installFakeServer({ lodges: [] });

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");
    await settle();

    expect(server.boardRequests.length).toBeLessThanOrEqual(
      SETTLED_REQUEST_BUDGET,
    );
    expect(server.refusals).toEqual([]);
  });

  it("stops with ONE active lodge and the booking's lodge on the link", async () => {
    // The half of the defect that a same-tick test photographs as "exactly 1
    // request" and calls clean. The loop needs the lodge options to land after
    // the first board read — which is what happens in production, where the
    // lodges query is the smaller one.
    search.current =
      "from=2026-07-01&to=2026-07-08&bookingId=booking-b&lodgeId=lodge-2";
    const server = installFakeServer({
      lodges: [{ id: "lodge-1", name: "Alpine Lodge", active: true }],
      holdFirstBoard: true,
    });

    render(<AdminBedAllocationPage />);
    await settle();
    server.releaseFirstBoard();
    await screen.findByTestId("room-table");
    await settle();

    expect(server.boardRequests.length).toBeLessThanOrEqual(
      SETTLED_REQUEST_BUDGET,
    );
    expect(server.refusals).toEqual([]);
  });
});

/*
 * PR #2885 review, HIGH 2 — `unavailable` was reachable by ROLE.
 *
 * `/admin/bed-allocation` is gated on `bookings`; `GET /api/admin/lodges` needs
 * `lodge:view`. The shipped `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` presets hold
 * `bookings: "view"` and no `lodge` entry at all, so for them the 403 is the
 * normal answer. Treating it as an outage handed them a permanent error and a
 * retry that could only 403 again, where before #2701 they had a working
 * club-wide board.
 */
describe("bed-allocation board — a role that may not read the lodge list (#2701)", () => {
  it("gets the club-wide read-only board, not an error it cannot clear", async () => {
    const server = installFakeServer({ lodgesForbidden: true });

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");
    await settle();

    // The board they had before, and a club-wide read they did not have to
    // choose because they cannot choose anything.
    expect(server.boardRequests.at(-1)?.has("lodgeId")).toBe(false);
    expect(
      screen.queryByText("The lodge list could not be loaded"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();

    // Distinguishable from a deliberate All lodges, and from an outage: it says
    // which one it is.
    expect(
      screen.getByText("Every lodge — read-only overview"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("All lodges — read-only overview"),
    ).not.toBeInTheDocument();

    // Still read-only. Their role is view-only anyway, but the lock does not
    // depend on that.
    expect(
      screen.getByRole("button", { name: /Reset allocations/ }),
    ).toBeDisabled();
  });
});

/*
 * PR #2885 review, MEDIUM 5 — the state set has to be TOTAL.
 */
describe("bed-allocation board — a club with no active lodge (#2701)", () => {
  it("says so instead of spinning for ever", async () => {
    const server = installFakeServer({ lodges: [] });

    render(<AdminBedAllocationPage />);
    await screen.findByText("No active lodge");
    await settle();

    // It is a terminal state, not a stuck one: no endless spinner, and no
    // request it cannot scope.
    expect(
      screen.queryAllByText("Choosing which lodge to show"),
    ).toHaveLength(0);
    expect(server.boardRequests).toHaveLength(0);
  });
});

describe("bed-allocation board — the LODGE_MISMATCH backstop (#2701)", () => {
  it("never fires on normal navigation: arrive on a deep link, then browse to another lodge", async () => {
    // This is the test the 409 exists for. The fake server refuses through the
    // same predicate the route uses, so any contradictory pair the board sends
    // — on the first load, on the adoption reload, or after the admin changes
    // lodge — is recorded here and fails the assertion.
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    const server = installFakeServer({ holdFirstBoard: true });

    render(<AdminBedAllocationPage />);
    await screen.findByRole("combobox");
    server.releaseFirstBoard();
    await screen.findByTestId("room-table");
    await waitFor(() =>
      expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-2"),
    );

    // The admin now picks the OTHER lodge from the selector — the one the
    // focused booking does not belong to. That drops the focus, so the pair
    // that would contradict is never sent in the first place.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Alpine Lodge" }));

    await waitFor(() => {
      const latest = server.boardRequests.at(-1);
      expect(latest?.get("lodgeId")).toBe("lodge-1");
      expect(latest?.has("bookingId")).toBe(false);
    });
    await waitFor(() =>
      expect(screen.queryByText("Focused booking")).not.toBeInTheDocument(),
    );

    expect(server.refusals).toEqual([]);
    expect(
      screen.queryByText("This link points at two different lodges"),
    ).not.toBeInTheDocument();
  });

  it("does not fire during a deploy drain, when the server cannot say which lodge it used", async () => {
    // An old-colour payload carries no `scopedLodgeId`, so the board is never
    // told the booking's lodge. Letting the selector fall back to `lodges[0]`
    // there would pair booking-b with lodge-1 and earn a 409 on a link that is
    // perfectly legitimate. It stays deferred instead: the board still shows
    // the booking's own server-scoped data, read-only, and recovers by itself
    // once the drain ends.
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    const server = installFakeServer({ omitScopeEcho: true });

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");
    await screen.findByRole("combobox");

    expect(server.refusals).toEqual([]);
    expect(
      server.boardRequests.some((request) => request.has("lodgeId")),
    ).toBe(false);
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
    // Read-only rather than wrong: no lodge is known, so nothing that needs one
    // is offered.
    expect(
      screen.getByRole("button", { name: /Reset allocations/ }),
    ).toBeDisabled();
  });

  it("does not fire on a booking whose lodge has been DEACTIVATED", async () => {
    // PR #2885 review, HIGH 3 — an honest in-app link, refused.
    //
    // `useLodgeOptions` drops inactive lodges, so a booking still sitting at a
    // deactivated lodge-2 leaves the selector holding only lodge-1. The
    // ADR-002 normaliser would substitute lodge-1 and pair it with the
    // booking — a 409 on the exact URL `AdminBookingToolsCard` builds, with no
    // board and no way back.
    // ORDERING IS THE WHOLE TEST. The lodge options must land AFTER the board
    // has adopted the booking's lodge, which is the sequence the reviewer
    // observed and the only one in which the normaliser's overwrite survives:
    // the adoption effect re-runs only when the served lodge CHANGES, so once
    // it has settled it is no longer there to undo a later default. Let the
    // options arrive first and the two writes race in the same commit, the
    // adoption happens to win, and the defect hides.
    search.current =
      "from=2026-07-01&to=2026-07-08&bookingId=booking-b&lodgeId=lodge-2";
    const server = installFakeServer({
      lodges: [{ id: "lodge-1", name: "Alpine Lodge", active: true }],
      holdLodges: true,
    });

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");
    server.releaseLodges();
    await settle();

    expect(server.refusals).toEqual([]);
    expect(
      screen.queryByText("This link points at two different lodges"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
    // Never substituted the surviving active lodge for the booking's own.
    expect(
      server.boardRequests.some(
        (request) => request.get("lodgeId") === "lodge-1",
      ),
    ).toBe(false);
  });

  it("does not fire on a deactivated-lodge booking linked by booking id alone", async () => {
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    const server = installFakeServer({
      lodges: [{ id: "lodge-1", name: "Alpine Lodge", active: true }],
    });

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");
    await settle();

    expect(server.refusals).toEqual([]);
    expect(server.boardRequests.length).toBeLessThanOrEqual(
      SETTLED_REQUEST_BUDGET,
    );
  });

  it("does not turn a one-off board failure into a permanent wrong 409", async () => {
    // PR #2885 review, MEDIUM 4. The deferral used to clear on ANY dashboard
    // error, so a single 500 let the selector default to the first lodge and
    // the retry came back 409 — a recoverable blip converted into an
    // unrecoverable and actively misleading one. Same ordering point as above:
    // the options land while the board is showing its error.
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    const server = installFakeServer({ holdLodges: true });
    server.failNextBoardReads(1);

    render(<AdminBedAllocationPage />);
    await screen.findByText("Bed allocation could not be loaded");
    server.releaseLodges();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("room-table");
    await settle();

    expect(server.refusals).toEqual([]);
    expect(
      screen.queryByText("This link points at two different lodges"),
    ).not.toBeInTheDocument();
    expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-2");
  });

  it("explains itself when a hand-made link names a booking at one lodge and a board at another", async () => {
    // Only reachable by typing the URL or by a bug, which is precisely why it
    // may be a hard refusal rather than a silent correction.
    search.current =
      "from=2026-07-01&to=2026-07-08&bookingId=booking-b&lodgeId=lodge-1";
    const server = installFakeServer();

    render(<AdminBedAllocationPage />);

    await screen.findByText("This link points at two different lodges");
    expect(server.refusals).toHaveLength(1);
    // No internally contradictory board is rendered underneath it, and no
    // "Try again" that could only refuse again.
    expect(screen.queryByTestId("room-table")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Bed allocation could not be loaded"),
    ).not.toBeInTheDocument();

    // It is not a dead end. Dropping the link's lodge and letting the server
    // scope from the booking is the only recovery that can succeed, so it is
    // offered as a button rather than described.
    fireEvent.click(
      screen.getByRole("button", { name: /Show this booking’s lodge/ }),
    );
    await screen.findByTestId("room-table");
    await settle();

    expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-2");
    expect(
      screen.queryByText("This link points at two different lodges"),
    ).not.toBeInTheDocument();
  });
});
