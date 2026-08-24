"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClubIdentity } from "@/components/club-identity-provider";
import {
  ALL_LODGES,
  LodgeSelect,
  useLodgeOptions,
  type LodgeChangeSource,
} from "@/components/lodge-select";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  BedDouble,
  Check,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";
import {
  addCalendarDays,
  isCalendarDate,
  requireCalendarDate,
} from "@/lib/club-time";
import {
  BedRangeAssignDialog,
  type BedRangeAssignResult,
  type BedRangeAssignTarget,
} from "@/components/admin/bed-range-assign-dialog";
import { useBedAllocationMoveDialog } from "@/components/admin/bed-allocation-move-dialog";
import {
  MAX_RANGE_NIGHTS,
  boardNights,
  boardWindowError,
  fitBoardWindow,
  stepBoardWindowByMonths,
} from "@/lib/bed-allocation-board-window";
import { BucketBoard } from "./_components/bucket-board";
import { RoomTable } from "./_components/room-table";
import {
  ALL_LODGES_ALLOCATION_LOCK_REASON,
  LODGE_LIST_FAILED_ALLOCATION_LOCK_REASON,
  NO_ACTIVE_LODGE_ALLOCATION_LOCK_REASON,
  NO_LODGE_PERMISSION_ALLOCATION_LOCK_REASON,
  UNSCOPED_ALLOCATION_LOCK_REASON,
  type AllocationLockReason,
  type BedOption,
  type BedOptionGroup,
  type BucketGuestGroup,
  type BulkAllocationConflict,
  type DashboardAllocation,
  type DashboardCustodianHold,
  type DashboardGuestNight,
  type DashboardPayload,
  type DragData,
  type DropData,
} from "./_components/types";
import {
  BOARD_LODGE_MISMATCH_CODE,
  BOARD_LODGE_MISMATCH_MESSAGE,
} from "@/lib/bed-allocation-board-scope";
import { deriveActiveDragDates } from "./_components/active-drag-dates";
import {
  BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS,
  createBedAllocationAnnouncements,
  describeBedAllocationDrop,
} from "./_components/allocation-drag-feedback";
import { useSyncedScroll } from "./_components/use-synced-scroll";
import { AllocationPreferencesSection } from "./_components/allocation-preferences-section";
import { useScopedDashboard } from "./_components/use-scoped-dashboard";
import {
  bedAllocationRemovalCategoryForAnchor,
  useBedAllocationRemovalDialog,
} from "@/components/admin/bed-allocation-removal-dialog";

// #2286: a bulk drop can now be refused for two different reasons on different
// nights, and they need different fixes — "someone else is in that bed" (clear
// it on this board) vs "a custodian holds that bed" (edit the assignment on the
// Hut Leaders page). Merging them into one "just taken" sentence would send the
// admin to the wrong place, so each reason gets its own clause.
function describeBulkConflicts(
  guestName: string,
  conflicts: BulkAllocationConflict[],
  // The club's own word for the role (#2286 review M8): admin copy is
  // label-driven; only the lobby TV is pinned to the fixed word "Custodian".
  hutLeaderLabel: string,
): string {
  const nightsFor = (reason: BulkAllocationConflict["reason"]) =>
    conflicts
      .filter((conflict) => conflict.reason === reason)
      .map((conflict) => conflict.stayDate);
  const taken = nightsFor("BED_TAKEN");
  const custodian = nightsFor("CUSTODIAN_HOLD");
  const clauses: string[] = [];
  if (taken.length > 0) {
    clauses.push(`that bed was just taken for ${taken.join(", ")}`);
  }
  if (custodian.length > 0) {
    clauses.push(
      `that bed is held for a ${hutLeaderLabel.toLowerCase()} on ${custodian.join(", ")} (change it on the ${hutLeaderLabel} Assignments page)`,
    );
  }
  return `${guestName}: ${clauses.join("; ")} — refreshing the board`;
}

/**
 * The night after a lodge night — a CALENDAR DATE, so no timezone is involved
 * (CT-4, #2870). `addCalendarDays` is proleptic-Gregorian civil arithmetic
 * rather than the `parseDateOnly`/`addDaysDateOnly`/`formatDateOnly` round trip
 * it replaces, and it refuses a value that is not a `yyyy-MM-dd` day.
 */
function nightAfter(stayDate: string): string {
  return addCalendarDays(requireCalendarDate(stayDate), 1);
}

async function readApiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The board's lodge scope, as states that cannot be confused with each other
 * (#2701).
 *
 * `null` used to stand for all of "I chose to see every lodge", "the selector
 * has not resolved yet" and "/api/admin/lodges failed", and the four bed
 * pickers behaved identically in all three — offering every lodge's beds in two
 * states nobody chose. Naming the states is the fix; everything else on this
 * page derives from which one is active.
 *
 * - `lodge`    — one concrete lodge. The only state in which allocations change.
 * - `all`      — club-wide, read-only. `reason` records how it was reached:
 *                `chosen` from the selector, or `no-lodge-permission` for a role
 *                that may open this board but may not read the lodge list at
 *                all. Both are honest club-wide views and both say so on
 *                screen; neither is an outage wearing a club-wide costume.
 * - `empty`    — the lodge list loaded and holds no ACTIVE lodge. There is
 *                nothing to scope to and nothing to choose.
 * - `resolving`— the options are still arriving, or a deep-linked booking's
 *                lodge has not been reported back yet.
 * - `unavailable` — the lodge list genuinely failed (transport, 500, anything
 *                that is not a 403), so club-wide is unreachable BY
 *                CONSTRUCTION rather than by an error message bolted onto an
 *                ambiguous state.
 *
 * **The set is TOTAL, and `deriveBoardLodgeScope` below is where that is
 * enforced.** PR #2885 review, MEDIUM 5: an earlier version had no `empty`, so
 * a club with zero active lodges and a successful response fell through to
 * `resolving` and sat on a spinner for ever with no error and a disabled
 * Refresh. Every combination of (selection, forbidden, failed, loading, option
 * count) now lands on exactly one of these, and the function returns on every
 * path rather than falling through to a default.
 */
type BoardLodgeScope =
  | { kind: "lodge"; lodgeId: string }
  | { kind: "all"; reason: "chosen" | "no-lodge-permission" }
  | { kind: "empty" }
  | { kind: "resolving" }
  | { kind: "unavailable" };

/**
 * The single place the scope is decided. Pure and exported-shaped so the branch
 * table can be read in one screen: the review that found the request storm
 * could only find it because the derivation was readable in isolation.
 */
function deriveBoardLodgeScope(input: {
  selection: string | null;
  optionsLoading: boolean;
  optionsForbidden: boolean;
  optionsFailed: boolean;
  optionCount: number;
}): BoardLodgeScope {
  // 1. A selection, once made, decides the scope on its own — this function
  //    never second-guesses one. Note what that does NOT claim: whether a
  //    selection SURVIVES is `LodgeSelect`'s business, and its ADR-002
  //    normaliser will replace one that names a lodge no longer among the
  //    active options. A comment here once asserted that a deep link's own
  //    lodgeId "still has a real scope to show" even when the options failed;
  //    that was false, the normaliser wiped it within one commit, and the
  //    false reassurance is what hid three defects (PR #2885 review).
  //    `ALL_LODGES` is a value no lodge id can collide with.
  if (input.selection === ALL_LODGES) return { kind: "all", reason: "chosen" };
  if (input.selection) return { kind: "lodge", lodgeId: input.selection };
  // 2. No selection. A role that may not read the lodge list can never make
  //    one, so club-wide read-only is the only view it can have — and it is the
  //    view it had before this issue existed.
  if (input.optionsForbidden) {
    return { kind: "all", reason: "no-lodge-permission" };
  }
  // 3. A real failure. Distinct from (2) because a retry can fix it.
  if (input.optionsFailed) return { kind: "unavailable" };
  // 4. Still arriving. Bounded: the request settles, and then 5 or 6 applies.
  if (input.optionsLoading) return { kind: "resolving" };
  // 5. Loaded, and the club has no active lodge at all.
  if (input.optionCount === 0) return { kind: "empty" };
  // 6. Loaded with options but no selection yet — the selector's own
  //    normalisation supplies one on the next commit, unless a focused booking
  //    is holding it off, in which case that booking's board is already
  //    loading. Either way this state does not persist unattended.
  return { kind: "resolving" };
}

function buildBucketGroups(
  unallocatedGuestNights: DashboardGuestNight[],
): BucketGuestGroup[] {
  const groups = new Map<string, BucketGuestGroup>();

  for (const guestNight of unallocatedGuestNights) {
    const existing = groups.get(guestNight.bookingGuestId);
    if (existing) {
      existing.stayDates.push(guestNight.stayDate);
      continue;
    }

    groups.set(guestNight.bookingGuestId, {
      bookingGuestId: guestNight.bookingGuestId,
      bookingId: guestNight.bookingId,
      guestName: guestNight.guestName,
      guestAgeTier: guestNight.guestAgeTier,
      memberName: guestNight.memberName,
      stayDates: [guestNight.stayDate],
    });
  }

  for (const group of groups.values()) {
    group.stayDates.sort();
  }

  return [...groups.values()];
}

function removeUnallocatedNights(
  payload: DashboardPayload,
  bookingGuestId: string,
  stayDates: string[],
): DashboardPayload {
  const stayDateSet = new Set(stayDates);
  return {
    ...payload,
    unallocatedGuestNights: payload.unallocatedGuestNights.filter(
      (guestNight) =>
        !(
          guestNight.bookingGuestId === bookingGuestId &&
          stayDateSet.has(guestNight.stayDate)
        ),
    ),
  };
}

function addOptimisticAllocations(
  payload: DashboardPayload,
  group: {
    bookingGuestId: string;
    bookingId: string;
    guestName: string;
    guestAgeTier: string;
  },
  bed: BedOption,
  stayDates: string[],
): DashboardPayload {
  const existingDates = new Set(
    payload.allocations
      .filter((allocation) => allocation.bookingGuestId === group.bookingGuestId)
      .map((allocation) => allocation.stayDate),
  );

  // Mirror the booking's real status and capacity-holding flag so the optimistic
  // chip picks the correct Held/Provisional state (#1251, #1254). The fallbacks
  // render as provisional and are corrected by the next loadDashboard().
  const sourceBooking = payload.bookings.find(
    (booking) => booking.id === group.bookingId,
  );
  const bookingStatus = sourceBooking?.status ?? "";
  const holdsCapacity = sourceBooking?.holdsCapacity ?? false;

  const newAllocations: DashboardAllocation[] = stayDates
    .filter((stayDate) => !existingDates.has(stayDate))
    .map((stayDate) => ({
      id: `optimistic:${group.bookingGuestId}:${stayDate}`,
      bookingId: group.bookingId,
      bookingGuestId: group.bookingGuestId,
      guestName: group.guestName,
      guestAgeTier: group.guestAgeTier,
      roomId: bed.roomId,
      roomName: bed.roomName,
      bedId: bed.id,
      bedName: bed.bedName,
      stayDate,
      source: "MANUAL",
      approvedAt: null,
      approvedByName: null,
      bookingStatus,
      holdsCapacity,
      // Optimistic drops render as a primary occupant; the server decides
      // second-occupant sharing and the next loadDashboard() corrects it (#1701).
      isSecondOccupant: false,
    }));

  return {
    ...payload,
    allocations: [...payload.allocations, ...newAllocations],
  };
}

export default function AdminBedAllocationPage() {
  const searchParams = useSearchParams();
  const requestedFrom = searchParams.get("from");
  const requestedTo = searchParams.get("to");
  const linkedBookingId = searchParams.get("bookingId") || "";
  /**
   * #2678: a focused booking PINS the board's lodge, so choosing another lodge
   * has to let the focus go.
   *
   * `GET /api/admin/bed-allocation` derives its lodge from `bookingId` and
   * refuses a contradicting `lodgeId` beside it (#2701), which is what stops
   * the four bed pickers offering another lodge's beds for this booking's
   * guests. The cost is that an admin who arrived on the deep link and then
   * picked a different lodge from the selector would have been served the
   * BOOKING's lodge under a selector reading the one they chose — a quieter lie
   * than the one being fixed, but a lie. Dropping the focus on a deliberate
   * lodge change keeps the two honest, and it is visible: the "Focused booking"
   * badge goes with it.
   *
   * Only a deliberate change counts, and since #2701 that is a fact reported by
   * `LodgeSelect` (`source === "user"`) rather than inferred from the values.
   * The component's own normalising calls report `"auto"`: the sole-lodge rule,
   * and the first-lodge default. Neither is the admin browsing away, and the
   * distinction matters most during an `/api/admin/lodges` outage, where the
   * server-side derivation from `bookingId` is the only thing keeping the board
   * off a club-wide read — so the focus must survive it.
   */
  const [lodgeChosenAwayFromBooking, setLodgeChosenAwayFromBooking] =
    useState(false);
  const highlightedBookingId = lodgeChosenAwayFromBooking ? "" : linkedBookingId;
  const canEditBookings = useAdminAreaEditAccess("bookings");
  // Admin copy uses the club's own word for the hut-leader role (#2286 review
  // M8); only the lobby TV is pinned to the fixed word "Custodian".
  const { hutLeaderLabel } = useClubIdentity();

  // The board opens on the CLUB's today when the deep link carries no date —
  // the API windows these nights in club time, so seeding it from the build's
  // `NEXT_PUBLIC_TZ` showed the wrong first night. That constant is fixed at
  // build time rather than read from the club's persisted setting, and falls
  // back to `Pacific/Auckland` for every viewer on a deployment that sets only
  // `TZ` (CT-4, #2870; INV-CONFIG-002).
  const clubTime = useClubTime();
  const initialFrom: string = isCalendarDate(requestedFrom ?? "")
    ? (requestedFrom as string)
    : clubTime.today();

  // A deep link may carry a booking's whole stay, which can be far longer than
  // the board's 31-night window (admin-booking-tools-card sends checkIn →
  // checkOut). The window is fitted rather than refused — an admin who followed
  // a link did not type this — and `windowNarrowed` puts a visible note on
  // screen so the narrowing is never silent (#2251).
  const initialWindow = isCalendarDate(requestedTo ?? "")
    ? fitBoardWindow(initialFrom, requestedTo as string)
    : fitBoardWindow(
        initialFrom,
        addCalendarDays(requireCalendarDate(initialFrom), 7),
      );

  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(initialWindow.toDate);
  const [windowNarrowed, setWindowNarrowed] = useState(initialWindow.narrowed);

  // Board lodge scope (ADR-003); LodgeSelect renders nothing (and reports
  // the sole lodge) while fewer than two lodges exist (ADR-002). Initialised
  // from the URL synchronously so the first dashboard fetch is already
  // lodge-filtered.
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    reload: reloadLodgeOptions,
  } = useLodgeOptions("admin");
  // The raw selection: a lodge id, the explicit ALL_LODGES sentinel, or null
  // for "not resolved". Never sent to the API as-is — `lodgeId` below is the
  // only value that reaches a query string, and it is a concrete lodge or
  // nothing.
  const [lodgeSelection, setLodgeSelection] = useState<string | null>(
    searchParams.get("lodgeId"),
  );
  /**
   * #2678: see `lodgeChosenAwayFromBooking` above. Since #2701 the "did the
   * admin choose this" question is answered by `LodgeSelect` itself rather than
   * inferred from the values — the old value comparison could not tell a
   * default apart from a deliberate pick that landed on the same lodge, and it
   * treated a first pick from a null selection as automatic when it was not.
   *
   * A `null` selection is never a choice: it is only ever reported by the
   * component when it has no options left, which is the outage state.
   *
   * `source` is REQUIRED, not defaulted (PR #2885 review). A default of `"user"`
   * is fail-open: any caller that forgets it silently claims the admin browsed
   * away from a focused booking, which drops the focus.
   *
   * Stable rather than inline, because `LodgeSelect`'s normalising effect lists
   * `onChange` among its dependencies — a fresh closure every render would re-run
   * that effect on every render for no reason.
   */
  const handleLodgeChange = useCallback(
    (next: string | null, source: LodgeChangeSource) => {
      if (source === "user" && next !== null && next !== lodgeSelection) {
        setLodgeChosenAwayFromBooking(true);
      }
      setLodgeSelection(next);
    },
    [lodgeSelection, setLodgeChosenAwayFromBooking, setLodgeSelection],
  );

  const lodgeScope = useMemo<BoardLodgeScope>(
    () =>
      deriveBoardLodgeScope({
        selection: lodgeSelection,
        optionsLoading: lodgesLoading,
        optionsForbidden: lodgeOptionsForbidden,
        optionsFailed: lodgeOptionsFailed,
        optionCount: lodges.length,
      }),
    [
      lodgeSelection,
      lodgesLoading,
      lodgeOptionsForbidden,
      lodgeOptionsFailed,
      lodges.length,
    ],
  );

  // The concrete lodge, or null. Everything that must not act club-wide gates
  // on this, so the ALL_LODGES sentinel can never leak into a query string or
  // a removal anchor.
  const lodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null;
  /**
   * `INV-CAP-033`, owner decisions 4 and 6: every allocation control that needs
   * a concrete lodge is disabled without one, with the reason on screen. This
   * governs what is OFFERED; the writer-side refusals are untouched and remain
   * what protects the data.
   *
   * The reason is per-STATE (PR #2885 review, LOW): telling an admin the choice
   * "becomes available once the board settles" is false in the two states that
   * never settle by themselves.
   */
  const allocationLockReason: AllocationLockReason =
    lodgeScope.kind === "lodge"
      ? undefined
      : lodgeScope.kind === "all"
        ? lodgeScope.reason === "chosen"
          ? ALL_LODGES_ALLOCATION_LOCK_REASON
          : NO_LODGE_PERMISSION_ALLOCATION_LOCK_REASON
        : lodgeScope.kind === "unavailable"
          ? LODGE_LIST_FAILED_ALLOCATION_LOCK_REASON
          : lodgeScope.kind === "empty"
            ? NO_ACTIVE_LODGE_ALLOCATION_LOCK_REASON
            : UNSCOPED_ALLOCATION_LOCK_REASON;

  const dashboardScopeKey = `${lodgeScope.kind}:${lodgeId ?? "-"}:${fromDate}:${toDate}:${highlightedBookingId}`;
  const [saving, setSaving] = useState<string | null>(null);
  const [singleNightMode, setSingleNightMode] = useState(false);
  const [selectedBeds, setSelectedBeds] = useState<Record<string, string>>({});
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragData, setActiveDragData] = useState<DragData | null>(null);
  const [activeDropPreview, setActiveDropPreview] = useState<string | null>(
    null,
  );
  // Range assignment (#2251): the dialog's target, and the outcome of the last
  // range operation, which tints the board until the admin dismisses it.
  const [rangeTarget, setRangeTarget] = useState<BedRangeAssignTarget | null>(
    null,
  );
  const [rangeDialogOpen, setRangeDialogOpen] = useState(false);
  const [rangeOutcome, setRangeOutcome] = useState<BedRangeAssignResult | null>(
    null,
  );
  const registerBoardScroller = useSyncedScroll();
  // Tracks the focused booking id we have already snapped the date window onto,
  // so we snap exactly once (#1302) and never fight an admin who later moves the
  // window off the focused booking.
  const snappedBookingIdRef = useRef<string | null>(null);

  // Refuse rather than truncate (#2251): an out-of-range window the admin typed
  // stops the fetch and explains itself instead of quietly shrinking.
  const windowError = useMemo(
    () => boardWindowError(fromDate, toDate),
    [fromDate, toDate],
  );

  const fetchDashboard = useCallback(
    async (signal: AbortSignal) => {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      // Only ever a concrete lodge. An unresolved scope sends nothing and lets
      // the server derive the lodge from the booking; a deliberate All lodges
      // sends nothing because that IS the club-wide read.
      if (lodgeId) params.set("lodgeId", lodgeId);
      if (highlightedBookingId) {
        params.set("bookingId", highlightedBookingId);
      }
      const response = await fetch(`/api/admin/bed-allocation?${params}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        // #2701: the board-level LODGE_MISMATCH backstop. Read the code, not
        // the status, so an unrelated future 409 on this route cannot borrow
        // the explanation. Normalised to the shared message so the alert below
        // can recognise it without parsing prose.
        if (response.status === 409) {
          const body = (await response
            .json()
            .catch(() => ({}))) as { code?: string; error?: string };
          if (body.code === BOARD_LODGE_MISMATCH_CODE) {
            throw new Error(BOARD_LODGE_MISMATCH_MESSAGE);
          }
          throw new Error(body.error ?? "Failed to load bed allocation");
        }
        throw new Error(
          await readApiError(response, "Failed to load bed allocation"),
        );
      }
      return (await response.json()) as DashboardPayload;
    },
    [fromDate, highlightedBookingId, lodgeId, toDate],
  );
  /**
   * #2701 decision 2: a direct visit settles on a real lodge instead of
   * rendering a transient club-wide board while `/api/admin/lodges` is still in
   * flight. The board therefore asks for nothing at all until its scope is one
   * of the three states that can answer for it:
   *
   *   - a concrete lodge, or a deliberate All lodges; or
   *   - a focused booking, which the SERVER scopes from `Booking.lodgeId`
   *     regardless of what the client knows — so the board still works during
   *     a lodge-list outage, and still is not club-wide.
   *
   * `resolving`, `unavailable` and `empty` with no focused booking fetch
   * nothing, which is what makes the club-wide read unreachable except by
   * choosing it — or by holding a role that cannot choose at all, which is the
   * `all` state's other reason and is equally deliberate.
   */
  const scopeCanLoadBoard =
    lodgeScope.kind === "lodge" ||
    lodgeScope.kind === "all" ||
    highlightedBookingId !== "";
  const scopedDashboard = useScopedDashboard({
    scopeKey: dashboardScopeKey,
    enabled: !windowError && scopeCanLoadBoard,
    load: fetchDashboard,
    onLoaded: () => setSingleNightMode(false),
  });
  const payload = scopedDashboard.value;
  const loading = scopedDashboard.loading;
  const dashboardError = scopedDashboard.error;
  const loadDashboard = scopedDashboard.reload;
  const setPayload = scopedDashboard.setValue;
  const removalDialog = useBedAllocationRemovalDialog({
    canEdit: canEditBookings,
    onApplied: async ({ removedRowCount }) => {
      toast.success(
        `${removedRowCount} reviewed allocation${removedRowCount === 1 ? "" : "s"} removed; no automatic allocation was run`,
      );
      await loadDashboard();
    },
  });
  const moveDialog = useBedAllocationMoveDialog({
    canEdit: canEditBookings,
    onApplied: async ({ movedRowCount, noop }) => {
      if (noop) {
        toast.info("No allocation nights needed to move");
      } else {
        toast.success(
          `${movedRowCount} allocation night${movedRowCount === 1 ? "" : "s"} moved`,
        );
      }
      const refreshed = await loadDashboard();
      if (!refreshed) {
        throw new Error(
          "The allocation moved, but the board could not be refreshed. Try Refresh before making another change.",
        );
      }
    },
  });

  useEffect(() => {
    if (dashboardError) toast.error(dashboardError);
  }, [dashboardError]);

  /**
   * #2701 decision 3: a booking deep link selects THAT booking's lodge.
   *
   * The server is the only party that knows it — it reads `Booking.lodgeId` —
   * so the response says which lodge it scoped to and the selector adopts it.
   * Before this, a link naming only a booking left the selector on `lodges[0]`
   * while the board below it showed the booking's own lodge: a lodge-B booking
   * dangling on lodge A's board.
   *
   * Only while a booking is focused. Adopting the echo unconditionally would
   * overwrite a deliberate All lodges the moment its club-wide payload came
   * back (`scopedLodgeId: null`, so nothing to adopt) or, worse, fight the
   * admin's own selection on every reload. Absent on an old-colour payload
   * during a deploy drain, which reads as "the server did not say".
   */
  const servedLodgeId = payload?.scopedLodgeId ?? null;
  useEffect(() => {
    if (!highlightedBookingId || !servedLodgeId) return;
    setLodgeSelection((current) =>
      current === servedLodgeId ? current : servedLodgeId,
    );
  }, [highlightedBookingId, servedLodgeId]);

  /**
   * WHILE A BOOKING IS FOCUSED, ITS LODGE IS AUTHORITATIVE AND `LodgeSelect`'S
   * DEFAULT MUST NOT WRITE AT ALL. This is the root fix for three separate
   * HIGH findings on PR #2885, and it replaces a narrower deferral that only
   * covered the window before the first payload arrived.
   *
   * The component's ADR-002 normaliser fires `onChange(lodges[0]?.id ?? null)`
   * whenever `lodges.length < 2` and the value differs — and that effect runs
   * even though the same condition makes it render nothing. So once the board
   * adopted the booking's lodge from the server echo, the normaliser overwrote
   * it on the very next commit, the scope key changed, the board refetched, the
   * echo re-adopted, and round it went. Measured by a reviewer at **62 dashboard
   * requests in about a second**, each iteration separated by a network round
   * trip so React never sees a synchronous cycle and nothing crashes — the page
   * just flickers and hammers the database for as long as the tab is open. It
   * needed neither a failure nor a deep link with no lodge: any club with fewer
   * than two ACTIVE lodges reached it, including a successful but empty list.
   *
   * The same overwrite is what fired the 409 on honest in-app links. A booking
   * at a deactivated lodge is filtered out of the options, so the normaliser
   * replaced its lodge with the one surviving active lodge and paired that with
   * the booking — `LODGE_MISMATCH`, on a link `AdminBookingToolsCard` itself
   * built. And it is what turned a one-off dashboard 500 into a permanent,
   * wrong "two different lodges" screen, because the old deferral cleared on
   * any error.
   *
   * Deferring for the WHOLE time a booking is focused fixes all three at once,
   * and it is not a special case bolted on: the normaliser exists to pick a
   * DEFAULT, and a focused booking means there is nothing left to default —
   * the server has already answered the question from `Booking.lodgeId`. The
   * deferral lifts the moment the admin deliberately changes lodge, because
   * that clears the focus.
   */
  const focusedBookingOwnsLodge = highlightedBookingId !== "";

  /**
   * Narrower, and only for COPY: the board is focused on a booking and has not
   * yet been told which lodge that is. "Told" means the server ANSWERED —
   * `scopedLodgeId` present, whether an id or an explicit null. A payload
   * without the field is the deploy-drain case (an old-colour server that
   * cannot answer), and there the board stays honestly unresolved rather than
   * guessing.
   */
  const awaitingFocusedBookingLodge =
    focusedBookingOwnsLodge &&
    lodgeSelection === null &&
    !(payload !== null && payload.scopedLodgeId !== undefined);

  // A refused window has NO columns. Enumerating it anyway would build a column
  // per night for whatever the admin typed — a year, a century — and the board
  // would try to render them all while the Alert above explains that the window
  // is invalid. The error is the only thing shown for an out-of-range window.
  const nights = useMemo(() => boardNights(fromDate, toDate), [fromDate, toDate]);

  const bedOptionGroups = useMemo<BedOptionGroup[]>(() => {
    return [...(payload?.rooms ?? [])]
      .filter((room) => room.active)
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((room) => ({
        roomId: room.id,
        roomName: room.name,
        beds: [...room.beds]
          .filter((bed) => bed.active)
          .sort((left, right) => left.sortOrder - right.sortOrder)
          .map((bed) => ({
            id: bed.id,
            roomId: room.id,
            roomName: room.name,
            bedName: bed.name,
            label: `${room.name} / ${bed.name}`,
          })),
      }))
      .filter((group) => group.beds.length > 0);
  }, [payload]);

  const bedOptions = useMemo(
    () => bedOptionGroups.flatMap((group) => group.beds),
    [bedOptionGroups],
  );

  const bedById = useMemo(() => {
    const map = new Map<string, BedOption>();
    for (const bed of bedOptions) {
      map.set(bed.id, bed);
    }
    return map;
  }, [bedOptions]);

  const activeRooms = useMemo(
    () =>
      [...(payload?.rooms ?? [])]
        .filter((room) => room.active)
        .sort((left, right) => left.sortOrder - right.sortOrder),
    [payload],
  );

  const allocationByBedAndDate = useMemo(() => {
    // #1701: a DOUBLE bed-night may hold two occupants (declared partners), so
    // each cell key maps to an array. Keep the primary occupant first so a
    // shared double renders predictably.
    const map = new Map<string, DashboardAllocation[]>();
    for (const allocation of payload?.allocations ?? []) {
      const key = `${allocation.bedId}:${allocation.stayDate}`;
      const existing = map.get(key);
      if (existing) {
        existing.push(allocation);
        existing.sort(
          (left, right) =>
            Number(left.isSecondOccupant) - Number(right.isSecondOccupant),
        );
      } else {
        map.set(key, [allocation]);
      }
    }
    return map;
  }, [payload]);

  const allocationsById = useMemo(() => {
    const map = new Map<string, DashboardAllocation>();
    for (const allocation of payload?.allocations ?? []) {
      map.set(allocation.id, allocation);
    }
    return map;
  }, [payload]);

  const bucketGroups = useMemo(
    () => buildBucketGroups(payload?.unallocatedGuestNights ?? []),
    [payload],
  );

  const bucketGroupsByGuest = useMemo(
    () => new Map(bucketGroups.map((group) => [group.bookingGuestId, group])),
    [bucketGroups],
  );

  const groupsByBooking = useMemo(() => {
    const map = new Map<string, BucketGuestGroup[]>();
    for (const group of bucketGroups) {
      const list = map.get(group.bookingId) ?? [];
      list.push(group);
      map.set(group.bookingId, list);
    }
    return map;
  }, [bucketGroups]);

  const activeDragLabel = useMemo(() => {
    if (!activeDragId) return null;
    if (activeDragId.startsWith("bucket-guest:")) {
      const id = activeDragId.slice("bucket-guest:".length);
      return bucketGroupsByGuest.get(id)?.guestName ?? null;
    }
    if (activeDragId.startsWith("allocation:")) {
      const id = activeDragId.slice("allocation:".length);
      return allocationsById.get(id)?.guestName ?? null;
    }
    return null;
  }, [activeDragId, bucketGroupsByGuest, allocationsById]);

  const activeDragDates = useMemo(() => {
    return new Set(
      deriveActiveDragDates({
        activeDrag: activeDragData,
        visibleAllocations: payload?.allocations ?? [],
        bucketGroups,
      }),
    );
  }, [activeDragData, payload?.allocations, bucketGroups]);

  const dragAnnouncements = useMemo(
    () =>
      createBedAllocationAnnouncements({
        visibleAllocations: payload?.allocations ?? [],
        bucketGroups,
        beds: bedOptions,
        singleNightMode,
      }),
    [payload?.allocations, bucketGroups, bedOptions, singleNightMode],
  );

  // Snap the date window onto a deep-linked focused booking that loaded outside
  // the current range (#1302). The server returns its stay window only while it
  // is out of range, so this fires at most once per booking; the ref guards a
  // re-snap after the follow-up load (or after the admin browses away).
  useEffect(() => {
    const focused = payload?.focusedBooking;
    if (!focused || focused.id !== highlightedBookingId) return;
    if (snappedBookingIdRef.current === focused.id) return;
    snappedBookingIdRef.current = focused.id;
    // A focused booking may be a stay of any length; the board can only show 31
    // nights of it. Fit the window and SAY the window was narrowed — the admin
    // is looking at part of the stay and needs to know that (#2251).
    const fitted = fitBoardWindow(focused.checkIn, focused.checkOut);
    setFromDate(focused.checkIn);
    setToDate(fitted.toDate);
    setWindowNarrowed(fitted.narrowed);
  }, [payload, highlightedBookingId]);

  async function withPending<T>(
    keys: string | string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    setPendingKeys((prev) => {
      const next = new Set(prev);
      for (const key of keyList) {
        next.add(key);
      }
      return next;
    });
    try {
      return await fn();
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        for (const key of keyList) {
          next.delete(key);
        }
        return next;
      });
    }
  }

  async function mutate(
    label: string,
    request: () => Promise<Response>,
    success: string,
  ) {
    setSaving(label);
    try {
      const response = await request();
      if (!response.ok) {
        throw new Error(await readApiError(response, "Request failed"));
      }
      toast.success(success);
      await loadDashboard();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed");
    } finally {
      setSaving(null);
    }
  }

  async function runAutoAllocation() {
    if (!canEditBookings || !lodgeId) return;

    await mutate(
      "auto",
      () =>
        fetch("/api/admin/bed-allocation/auto-allocate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromDate,
            to: toDate,
            lodgeId,
          }),
        }),
      "Auto allocation applied",
    );
  }

  async function approveVisible() {
    // #2701 decision 4: approving with no lodge approves the whole club's
    // visible window, which is a mutation the club-wide overview must not
    // offer. The button is disabled in that state; this is the guard behind it.
    if (!canEditBookings || !lodgeId) return;

    await mutate(
      "approve",
      () =>
        fetch("/api/admin/bed-allocation/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromDate,
            to: toDate,
            lodgeId,
          }),
        }),
      "Allocations approved",
    );
  }

  async function allocateFullStay(group: BucketGuestGroup, bedId: string) {
    // The lock guard belongs here for the same reason it belongs on the others
    // (PR #2885 review, LOW): consistency is what makes the layer a rule
    // instead of a habit. Unreachable today — every entry point is a disabled
    // control — and the bulk endpoint derives its own lodge from the guest, so
    // this is defence in depth on the OFFER, never the thing that protects the
    // write.
    if (!canEditBookings || allocationLockReason) return;

    const bed = bedById.get(bedId);
    if (!bed || !payload) return;

    const snapshot = payload;
    setPayload(
      addOptimisticAllocations(
        removeUnallocatedNights(payload, group.bookingGuestId, group.stayDates),
        group,
        bed,
        group.stayDates,
      ),
    );

    await withPending(`guest:${group.bookingGuestId}`, async () => {
      try {
        const response = await fetch("/api/admin/bed-allocation/allocations/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: group.bookingGuestId,
            bedId,
            stayDates: group.stayDates,
          }),
        });

        if (!response.ok) {
          setPayload(snapshot);
          toast.error(await readApiError(response, "Failed to allocate bed"));
          await loadDashboard();
          return;
        }

        const data = (await response.json()) as {
          conflicts: BulkAllocationConflict[];
        };

        if (data.conflicts.length > 0) {
          toast.warning(
            describeBulkConflicts(
              group.guestName,
              data.conflicts,
              hutLeaderLabel,
            ),
          );
        } else {
          toast.success("Allocation saved");
        }
        await loadDashboard();
      } catch {
        setPayload(snapshot);
        toast.error("Failed to allocate bed");
        await loadDashboard();
      }
    });
  }

  async function allocateSingleNight(
    group: BucketGuestGroup,
    bedId: string,
    stayDate: string,
  ) {
    // See `allocateFullStay`: same guard, same reasoning.
    if (!canEditBookings || allocationLockReason) return;

    if (!group.stayDates.includes(stayDate)) {
      toast.error(`${group.guestName} is not staying on ${stayDate}`);
      return;
    }

    const bed = bedById.get(bedId);
    if (!bed || !payload) return;

    const snapshot = payload;
    setPayload(
      addOptimisticAllocations(
        removeUnallocatedNights(payload, group.bookingGuestId, [stayDate]),
        group,
        bed,
        [stayDate],
      ),
    );

    await withPending(`guest:${group.bookingGuestId}`, async () => {
      try {
        const response = await fetch("/api/admin/bed-allocation/allocations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: group.bookingGuestId,
            bedId,
            stayDate,
          }),
        });

        if (!response.ok) {
          setPayload(snapshot);
          if (response.status === 409) {
            toast.warning(
              `That bed was just taken for ${stayDate} — refreshing the board`,
            );
          } else {
            toast.error(await readApiError(response, "Failed to allocate bed"));
          }
          await loadDashboard();
          return;
        }

        toast.success("Allocation saved");
        await loadDashboard();
      } catch {
        setPayload(snapshot);
        toast.error("Failed to allocate bed");
        await loadDashboard();
      }
    });
  }

  function openAllocationMoveDialog(
    allocation: DashboardAllocation,
    destinationBedId: string,
    focusOrigin?: HTMLElement | null,
  ) {
    if (canEditBookings === undefined) return;
    const bed = bedById.get(destinationBedId);
    if (!bed) return;
    moveDialog.openMoveDialog(
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
  }

  // Prefill the range dialog with the GUEST's own stay, not the booking's
  // envelope: a guest who joins late or leaves early would otherwise be handed
  // nights they are not booked on, which the server correctly refuses (#2251).
  // stayEnd is the exclusive checkout date, matching the dialog's Date Out.
  function guestStayWindow(bookingId: string, bookingGuestId: string) {
    const guest = payload?.bookings
      .find((booking) => booking.id === bookingId)
      ?.guests?.find((item) => item.id === bookingGuestId);
    if (!guest) return null;
    return { fromDate: guest.stayStart, toDate: guest.stayEnd };
  }

  function stepWindowByMonths(months: number) {
    const stepped = stepBoardWindowByMonths(fromDate, toDate, months);
    setFromDate(stepped.fromDate);
    setToDate(stepped.toDate);
    setWindowNarrowed(stepped.narrowed);
  }

  // Entry point 1 (#2251): a guest in the awaiting-allocation bucket. The range
  // is prefilled from the guest's own stay, which may extend well beyond the
  // board window.
  function openRangeForGuest(group: BucketGuestGroup) {
    if (!canEditBookings || allocationLockReason) return;
    const stay = guestStayWindow(group.bookingId, group.bookingGuestId);
    setRangeTarget({
      bookingGuestId: group.bookingGuestId,
      bookingId: group.bookingId,
      guestName: group.guestName,
      memberName: group.memberName,
      bedId: selectedBeds[group.bookingGuestId] || undefined,
      fromDate: stay?.fromDate ?? group.stayDates[0] ?? fromDate,
      toDate:
        stay?.toDate ??
        nightAfter(group.stayDates[group.stayDates.length - 1]),
    });
    setRangeDialogOpen(true);
  }

  // Entry point 2 (#2251): an already-placed chip on the board, so a guest whose
  // first nights are done can have the rest of the stay assigned in one action.
  function openRangeForAllocation(allocation: DashboardAllocation) {
    if (!canEditBookings || allocationLockReason) return;
    const booking = payload?.bookings.find(
      (item) => item.id === allocation.bookingId,
    );
    const stay = guestStayWindow(
      allocation.bookingId,
      allocation.bookingGuestId,
    );
    setRangeTarget({
      bookingGuestId: allocation.bookingGuestId,
      bookingId: allocation.bookingId,
      guestName: allocation.guestName,
      memberName: booking?.memberName,
      bedId: allocation.bedId,
      fromDate: stay?.fromDate ?? allocation.stayDate,
      toDate:
        stay?.toDate ??
        nightAfter(allocation.stayDate),
    });
    setRangeDialogOpen(true);
  }

  function handleRangeAssigned(result: BedRangeAssignResult) {
    setRangeOutcome(result);
    toast.success(
      result.refusals.length > 0
        ? `${result.writtenNights.length} of ${result.requestedNights.length} nights assigned; ${result.refusals.length} refused`
        : `${result.writtenNights.length} night${result.writtenNights.length === 1 ? "" : "s"} assigned`,
    );
    void loadDashboard();
  }

  function removeAllocation(allocation: DashboardAllocation) {
    if (!lodgeId) return;
    removalDialog.openRemovalDialog({
      allocations: [
        {
          allocationId: allocation.id,
          bookingId: allocation.bookingId,
          bookingGuestId: allocation.bookingGuestId,
          lodgeId,
          stayDate: allocation.stayDate,
        },
      ],
      lodgeId,
      lodgeName: lodges.find((lodge) => lodge.id === lodgeId)?.name,
      window: { from: fromDate, to: toDate },
      guestName: allocation.guestName,
      initialScope: "ALLOCATION",
      initialCategories: [
        bedAllocationRemovalCategoryForAnchor(
          allocation.source,
          allocation.approvedAt,
        ),
      ],
    });
  }

  function openWindowReset() {
    if (!lodgeId) return;
    removalDialog.openRemovalDialog({
      allocations: [],
      lodgeId,
      lodgeName: lodges.find((lodge) => lodge.id === lodgeId)?.name,
      window: { from: fromDate, to: toDate },
      initialScope: "WINDOW",
      initialCategories: [],
    });
  }

  function handleDragStart(event: DragStartEvent) {
    if (!canEditBookings || allocationLockReason) return;

    setActiveDragId(String(event.active.id));
    setActiveDragData((event.active.data.current as DragData | undefined) ?? null);
    setActiveDropPreview(null);
  }

  function handleDragOver(event: DragOverEvent) {
    setActiveDropPreview(
      describeBedAllocationDrop({
        activeData: event.active.data.current as DragData | undefined,
        overData: event.over?.data.current as DropData | undefined,
        visibleAllocations: payload?.allocations ?? [],
        bucketGroups,
        beds: bedOptions,
        singleNightMode,
      }),
    );
  }

  function handleDragCancel() {
    setActiveDragId(null);
    setActiveDragData(null);
    setActiveDropPreview(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    setActiveDragData(null);
    setActiveDropPreview(null);
    // Every cell and chip is already a disabled drag/drop target while the
    // board is club-wide or unscoped; this is the guard behind them, so a
    // keyboard drag or a stale sensor cannot route round the disabled state.
    if (!canEditBookings || allocationLockReason) return;

    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current as DragData | undefined;
    const overData = over.data.current as DropData | undefined;
    if (!activeData || !overData) return;

    if (activeData.type === "bucket-guest") {
      if (overData.type !== "cell") return;
      const group = bucketGroupsByGuest.get(activeData.bookingGuestId);
      if (!group) return;

      if (singleNightMode) {
        void allocateSingleNight(group, overData.bedId, overData.stayDate);
      } else {
        void allocateFullStay(group, overData.bedId);
      }
    } else if (activeData.type === "allocation") {
      const allocation = allocationsById.get(activeData.allocationId);
      if (!allocation) return;

      if (overData.type === "bucket") {
        removeAllocation(allocation);
      } else if (overData.type === "cell") {
        openAllocationMoveDialog(allocation, overData.bedId);
      }
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const pendingGuestIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of pendingKeys) {
      if (key.startsWith("guest:")) ids.add(key.slice("guest:".length));
    }
    return ids;
  }, [pendingKeys]);

  const pendingAllocationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of pendingKeys) {
      if (key.startsWith("allocation:")) ids.add(key.slice("allocation:".length));
    }
    return ids;
  }, [pendingKeys]);

  // Post-apply tinting (#2251 decision 3): after a range operation the board
  // marks the written nights green and the refused nights red on the target bed
  // until the admin dismisses it, so gaps left by a partial assign are visible
  // rather than something to hunt for. Not colour-only — each tinted cell also
  // carries an "Assigned" / "Refused" label.
  // #2286: index the payload's custodian holds by bed-night so each cell can
  // decide in O(1) whether it is a held band rather than a drop target.
  const custodianHoldList = useMemo(
    // Absent on an old-colour payload during a deploy drain (see the banner
    // below), so never dereferenced without this fallback.
    () => payload?.custodianHolds ?? [],
    [payload],
  );

  const custodianHoldByBedAndDate = useMemo(() => {
    const map = new Map<string, DashboardCustodianHold>();
    for (const hold of custodianHoldList) {
      for (const night of hold.nights) {
        map.set(`${hold.bedId}:${night}`, hold);
      }
    }
    return map;
  }, [custodianHoldList]);

  const rangeTint = useMemo(() => {
    if (!rangeOutcome) return undefined;
    return {
      bedId: rangeOutcome.bedId,
      written: new Set(rangeOutcome.writtenNights),
      refused: new Set(
        rangeOutcome.refusals.map((refusal) => refusal.stayDate),
      ),
    };
  }, [rangeOutcome]);

  const unapprovedCount =
    payload?.allocations.filter((allocation) => !allocation.approvedAt).length ?? 0;
  const activeBedCount = bedOptions.length;
  const autoAllocationEnabled =
    payload?.settings.autoAllocationEnabled ?? false;

  // A focused booking is "on the board" when it has a bucket card or a placed
  // allocation in the current range (#1302).
  const focusedBookingVisible =
    highlightedBookingId !== "" &&
    ((payload?.bookings.some((booking) => booking.id === highlightedBookingId) ??
      false) ||
      (payload?.allocations.some(
        (allocation) => allocation.bookingId === highlightedBookingId,
      ) ??
        false));

  // Residual case: a booking is focused but neither visible nor snappable (the
  // server returned no stay window — e.g. it was cancelled or removed). The snap
  // effect handles every allocatable out-of-range booking, so this only guides
  // the admin when snapping is genuinely impossible.
  const showFocusedBookingUnavailable =
    highlightedBookingId !== "" &&
    payload !== null &&
    !focusedBookingVisible &&
    payload.focusedBooking === null;

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  /**
   * The board asks for nothing until its lodge scope settles (#2701), so
   * "waiting for the lodge" is its own visible state rather than a silent blank
   * — and, critically, rather than a club-wide board rendered while the options
   * are in flight.
   *
   * `unavailable` and `empty` are excluded because their own alerts are the
   * explanation, and a spinner that never resolves would contradict them. So is
   * every state that IS loading a board: a focused booking's board can render
   * while the selector is still unresolved (the deploy-drain case), and a
   * permanent spinner under a rendered board would be nonsense.
   */
  const boardBusyLabel = loading
    ? "Loading bed allocation"
    : lodgeScope.kind === "resolving" && !scopeCanLoadBoard && !windowError
      ? "Choosing which lodge to show"
      : null;

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditBookings} className="mb-6">
      Your admin role can view bed allocation but cannot change allocation
      preferences, move or allocate guests, approve placements, or save
      assignments.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Bed Allocation</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant={autoAllocationEnabled ? "success" : "outline"}>
              {autoAllocationEnabled ? "Auto allocation" : "Admin only"}
            </Badge>
            {payload ? (
              <>
                <Badge variant="secondary">{payload.rooms.length} rooms</Badge>
                <Badge variant="secondary">{activeBedCount} active beds</Badge>
                <Badge variant="secondary">
                  {payload.allocations.length} allocations
                </Badge>
                {highlightedBookingId ? (
                  <Badge variant="warning">Focused booking</Badge>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,200px)_auto_minmax(0,150px)_minmax(0,150px)_auto_auto]">
          <LodgeSelect
            lodges={lodges}
            value={lodgeSelection}
            onChange={handleLodgeChange}
            loading={lodgesLoading}
            // #2701 decision 1: club-wide is a deliberate operator view here,
            // and this is the only page that offers it.
            allowAllLodges
            deferDefaultSelection={focusedBookingOwnsLodge}
          />
          {/*
            Month steppers (#2251): one press moves the whole window a calendar
            month, so a long stay is browsed a month at a time instead of by
            retyping both dates.
          */}
          <div className="flex items-end">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous month"
              title="Step the board window back one month"
              onClick={() => stepWindowByMonths(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bed-from">Date In</Label>
            <Input
              id="bed-from"
              type="date"
              value={fromDate}
              onChange={(event) => {
                const value = event.target.value;
                if (!isCalendarDate(value)) return;
                setFromDate(value);
                setWindowNarrowed(false);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bed-to">Date Out</Label>
            <Input
              id="bed-to"
              type="date"
              value={toDate}
              onChange={(event) => {
                const value = event.target.value;
                if (!isCalendarDate(value)) return;
                setToDate(value);
                setWindowNarrowed(false);
              }}
            />
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              size="icon"
              aria-label="Next month"
              title="Step the board window forward one month"
              onClick={() => stepWindowByMonths(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Button
            variant="outline"
            onClick={() => void loadDashboard()}
            // Nothing to refresh while the scope is unsettled: the reload is a
            // no-op there, and an enabled button that does nothing is the same
            // defect class #2701 is fixing on the allocation controls.
            disabled={loading || !scopeCanLoadBoard}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The board shows up to {MAX_RANGE_NIGHTS} nights at a time — use ‹ › to
        step a month. Assigning a guest to a bed is not limited to the window:
        use <strong>Assign range…</strong> for a stay of any length.
      </p>

      {windowError ? (
        <Alert variant="error" title="The board window is out of range">
          {windowError}
        </Alert>
      ) : null}

      {/*
        #2701 decision 5. A failed lodge list is an error with a retry, never a
        club-wide board. The two are distinguishable BY CONSTRUCTION and not
        only by this message: with no options there is nothing to select, so
        "All lodges" cannot have been chosen, and the board below asks for
        nothing at all unless a focused booking scopes it server-side.

        A 403 is deliberately NOT this state (PR #2885 review, HIGH 2): for a
        role that may open this board and may not read the lodge list, a refusal
        is the normal answer, and a retry could only refuse again.
      */}
      {lodgeOptionsFailed ? (
        <Alert variant="error" title="The lodge list could not be loaded">
          <p className="mb-3">
            The lodge selector is unavailable, so the board cannot be pointed at
            a lodge. This is a failure, not a club-wide view — nothing here is
            showing every lodge.
          </p>
          <Button variant="outline" onClick={reloadLodgeOptions}>
            Try again
          </Button>
        </Alert>
      ) : null}

      {/*
        #2701 decision 4: one explanation for the whole read-only board, at the
        top, instead of scattering unexplained disabled states across a dozen
        controls. Every control below also carries the same sentence as its
        tooltip. The two ways of reaching club-wide say different things,
        because "choose a single lodge" is not advice you can act on when your
        role cannot read the lodge list.
      */}
      {lodgeScope.kind === "all" && lodgeScope.reason === "chosen" ? (
        <Alert variant="info" title="All lodges — read-only overview">
          {ALL_LODGES_ALLOCATION_LOCK_REASON} Choose a single lodge to allocate,
          move, approve or remove beds.
        </Alert>
      ) : null}

      {lodgeScope.kind === "all" &&
      lodgeScope.reason === "no-lodge-permission" ? (
        <Alert variant="info" title="Every lodge — read-only overview">
          {NO_LODGE_PERMISSION_ALLOCATION_LOCK_REASON} Ask for lodge access if
          you need to allocate beds at a particular lodge.
        </Alert>
      ) : null}

      {lodgeScope.kind === "empty" ? (
        <Alert variant="warning" title="No active lodge">
          {NO_ACTIVE_LODGE_ALLOCATION_LOCK_REASON} Add or reactivate a lodge in{" "}
          <Link className="underline" href="/admin/lodge">
            Lodge settings
          </Link>{" "}
          before allocating beds.
        </Alert>
      ) : null}

      {/*
        The board-level LODGE_MISMATCH backstop (#2701). It cannot be reached by
        navigating: while a booking is focused, the board sends that booking's
        own lodge or no lodge at all, and the selector's default is held off
        entirely so it can never substitute another one. Reaching it means the
        URL was hand-made or something is wrong.

        It still offers a way OUT (PR #2885 review): dropping the link's lodge
        and letting the server scope the board from the booking is both the
        correct recovery and the only one that can succeed, so it is a button
        rather than advice.
      */}
      {dashboardError === BOARD_LODGE_MISMATCH_MESSAGE ? (
        <Alert
          variant="error"
          title="This link points at two different lodges"
        >
          <p className="mb-3">{BOARD_LODGE_MISMATCH_MESSAGE}</p>
          <Button
            variant="outline"
            onClick={() => handleLodgeChange(null, "auto")}
          >
            Show this booking&rsquo;s lodge
          </Button>
        </Alert>
      ) : null}

      {windowNarrowed && !windowError ? (
        <Alert variant="info" title="Showing part of this stay">
          The window was narrowed to the {MAX_RANGE_NIGHTS}-night maximum. Step
          forward with › to see the rest.
        </Alert>
      ) : null}

      {rangeOutcome ? (
        <Alert
          variant={rangeOutcome.refusals.length > 0 ? "warning" : "success"}
          title={`${rangeOutcome.writtenNights.length} night${rangeOutcome.writtenNights.length === 1 ? "" : "s"} assigned for ${rangeOutcome.guestName}`}
        >
          <p className="mb-2">
            {rangeOutcome.roomName} / {rangeOutcome.bedName} ·{" "}
            {rangeOutcome.fromDate} → {rangeOutcome.toDate}.{" "}
            {rangeOutcome.refusals.length > 0
              ? `${rangeOutcome.refusals.length} night${rangeOutcome.refusals.length === 1 ? " was" : "s were"} refused and left unassigned — refused nights are tinted red on the board, assigned nights green.`
              : "Every night in the range was written; they are tinted green on the board."}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRangeOutcome(null)}
          >
            Dismiss
          </Button>
        </Alert>
      ) : null}

      {showFocusedBookingUnavailable ? (
        <Alert variant="warning">
          Focused booking is not on the board — it may be cancelled or removed.
          Adjust Date In / Date Out to browse the board.
        </Alert>
      ) : null}

      {lodgeId ? (
        <AllocationPreferencesSection
          key={lodgeId}
          lodgeId={lodgeId}
          canEdit={canEditBookings}
          renderViewOnlyBanner={false}
          onSaved={async () => {
            // Preferences change both the header state and the planner output;
            // reload the complete dashboard instead of patching one field.
            await loadDashboard();
          }}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Allocation preferences</CardTitle>
          </CardHeader>
          {/*
            One card, one honest message per scope state (#2701). This used to
            say "Choose a lodge to continue" in every state, including the three
            where there is nothing to choose from.
          */}
          <CardContent className="text-sm text-muted-foreground">
            {lodgeScope.kind === "all"
              ? lodgeScope.reason === "chosen"
                ? "Preferences are set per lodge. Choose a single lodge to see and edit them."
                : "Preferences are set per lodge, and your admin role cannot choose one."
              : lodgeScope.kind === "unavailable"
                ? "The lodge list could not be loaded, so preferences cannot be shown. Retry above."
                : lodgeScope.kind === "empty"
                  ? "This club has no active lodge, so there are no preferences to show."
                  : lodgesLoading || awaitingFocusedBookingLodge
                    ? "Loading lodge…"
                    : "Choose a lodge to continue."}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Board drag controls</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 text-sm font-medium">
            <Checkbox
              checked={singleNightMode}
              onCheckedChange={(checked) => setSingleNightMode(checked === true)}
            />
            Single-night drag mode (not saved)
          </label>
        </CardContent>
      </Card>

      {/*
        The board asks for nothing until its lodge scope settles (#2701), so
        "waiting for the lodge" is its own visible state rather than a silent
        blank — and, critically, rather than a club-wide board rendered while
        the options are in flight. `unavailable` is excluded: its own error
        alert above is the explanation, and a spinner that never resolves would
        contradict it.
      */}
      {boardBusyLabel ? (
        <div className="flex items-center gap-2 rounded-md border bg-card p-6 text-sm text-muted-foreground">
          <Spinner size="sm" label={boardBusyLabel} />
          <span aria-hidden="true">{boardBusyLabel}</span>
        </div>
      ) : null}

      {/* The lodge-mismatch 409 has its own alert above and no retry: retrying
          the same contradictory link would only refuse again. */}
      {!loading &&
      dashboardError &&
      dashboardError !== BOARD_LODGE_MISMATCH_MESSAGE &&
      !windowError ? (
        <Alert variant="error" title="Bed allocation could not be loaded">
          <p className="mb-3">{dashboardError}</p>
          <Button variant="outline" onClick={() => void loadDashboard()}>
            Try again
          </Button>
        </Alert>
      ) : null}

      {/* A dashboard is exposed only when its lodge/date key matches the
          controls above. Loading and failures therefore leave no stale action
          surface from the previous scope. */}
      {payload && !windowError ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{
            announcements: dragAnnouncements,
            screenReaderInstructions:
              BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS,
          }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          {payload.exclusiveHolds.length > 0 ? (
            <Alert
              variant="info"
              title="Exclusive whole-lodge hold — no per-bed allocation needed"
            >
              <p className="mb-1">
                {payload.exclusiveHolds.length === 1
                  ? "This booking holds the whole lodge for its nights"
                  : "These bookings hold the whole lodge for their nights"}
                , so its guests are not placed on individual beds. The lodge is
                taken.
              </p>
              <ul className="space-y-1">
                {payload.exclusiveHolds.map((hold) => (
                  <li key={hold.bookingId}>
                    <span className="font-medium">{hold.memberName}</span> ·{" "}
                    <span className="font-mono text-xs">{hold.bookingId}</span> ·{" "}
                    {hold.checkIn} → {hold.checkOut} · {hold.guestCount} guest
                    {hold.guestCount === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {/* Read through the indexed map, not `payload.custodianHolds`
              directly: during a deploy drain a new-colour browser bundle can be
              served a payload from the old colour, which has no custodianHolds
              at all. Crashing the entire allocation board in that window would
              be far worse than the drain exposure the feature already accepts,
              so every client read of this field tolerates its absence. */}
          {custodianHoldList.length > 0 ? (
            <Alert
              variant="info"
              title={`Bed held for a ${hutLeaderLabel.toLowerCase()} — not available to allocate`}
            >
              <p className="mb-1">
                {/* #2286 review L4: read the LENGTH from the same tolerant
                    list this block is gated on, not from `payload.custodianHolds`
                    — the comment above says exactly that, and a deploy-drain
                    payload with no `custodianHolds` would crash the board here. */}
                {custodianHoldList.length === 1
                  ? "This bed is"
                  : "These beds are"}{" "}
                held for a {hutLeaderLabel.toLowerCase()} with no booking, so no
                guest can be placed on them for those nights. Change the dates or
                the bed on the{" "}
                <Link className="underline" href="/admin/hut-leaders">
                  {hutLeaderLabel} Assignments
                </Link>{" "}
                page.
              </p>
              <ul className="space-y-1">
                {custodianHoldList.map((hold) => (
                  <li key={hold.assignmentId}>
                    <span className="font-medium">{hold.memberName}</span> ·{" "}
                    {hold.roomName} · {hold.bedName} · {hold.startDate} →{" "}
                    {hold.endDate}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Bookings approved, awaiting allocation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <ViewOnlyActionButton
                  canEdit={canEditBookings}
                  describeReason={false}
                  onClick={() => void runAutoAllocation()}
                  disabled={
                    !lodgeId ||
                    !payload.settings.autoAllocationEnabled ||
                    payload.suggestedAllocations.length === 0 ||
                    saving === "auto"
                  }
                  title={allocationLockReason}
                  className="gap-2"
                >
                  <Wand2 className="h-4 w-4" />
                  Run Auto Allocation
                </ViewOnlyActionButton>
                <ViewOnlyActionButton
                  canEdit={canEditBookings}
                  describeReason={false}
                  variant="outline"
                  onClick={() => void approveVisible()}
                  // #2701: without a lodge this approved the whole club's
                  // visible window — the one mutation on this card that did
                  // not already gate on a concrete lodge.
                  disabled={
                    !lodgeId || unapprovedCount === 0 || saving === "approve"
                  }
                  title={allocationLockReason}
                  className="gap-2"
                >
                  <Check className="h-4 w-4" />
                  Approve Visible
                </ViewOnlyActionButton>
                <Button
                  variant="destructive"
                  onClick={openWindowReset}
                  disabled={!lodgeId}
                  title={allocationLockReason}
                >
                  Reset allocations…
                </Button>
                <Badge variant="outline">
                  {payload.suggestedAllocations.length} suggested
                </Badge>
                <Badge
                  variant={unapprovedCount > 0 ? "warning" : "success"}
                  title="Draft bed placements on the Allocation Board below that still need approving — distinct from bookings still awaiting a bed."
                >
                  {unapprovedCount} draft allocations to approve
                </Badge>
              </div>

              {payload.warnings.length > 0 ? (
                <Alert variant="warning" title="Warnings">
                  <ul className="space-y-1">
                    {payload.warnings.map((warning) => (
                      <li key={warning.id}>{warning.message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              <BucketBoard
                bookings={payload.bookings}
                groupsByBooking={groupsByBooking}
                bedOptions={bedOptions}
                bedOptionGroups={bedOptionGroups}
                selectedBeds={selectedBeds}
                onSelectBed={(bookingGuestId, bedId) =>
                  setSelectedBeds((current) => ({
                    ...current,
                    [bookingGuestId]: bedId,
                  }))
                }
                onAllocate={(group) => {
                  const bedId = selectedBeds[group.bookingGuestId];
                  if (!bedId || bedId === "none") {
                    toast.error("Select a bed first");
                    return;
                  }
                  void allocateFullStay(group, bedId);
                }}
                onAssignRange={openRangeForGuest}
                pendingGuestIds={pendingGuestIds}
                highlightedBookingId={highlightedBookingId}
                canEdit={canEditBookings}
                lockReason={allocationLockReason}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Allocation Board</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {payload.rooms.length === 0 ? (
                <EmptyState
                  icon={BedDouble}
                  title="No rooms available"
                  description="Set up rooms and beds before allocating."
                  className="rounded-md border border-dashed"
                />
              ) : null}

              {activeBedCount === 0 && payload.rooms.length > 0 ? (
                <Alert variant="warning">No active beds available.</Alert>
              ) : null}

              {activeRooms.map((room) => (
                <RoomTable
                  key={room.id}
                  room={room}
                  nights={nights}
                  allocationByBedAndDate={allocationByBedAndDate}
                  bedOptions={bedOptions}
                  bedOptionGroups={bedOptionGroups}
                  onReassignBed={openAllocationMoveDialog}
                  onRemove={removeAllocation}
                  onAssignRange={openRangeForAllocation}
                  rangeTint={rangeTint}
                  custodianHoldByBedAndDate={custodianHoldByBedAndDate}
                  pendingAllocationIds={pendingAllocationIds}
                  highlightedBookingId={highlightedBookingId}
                  activeDragDates={activeDragDates}
                  registerScroller={registerBoardScroller}
                  canEdit={canEditBookings}
                  lockReason={allocationLockReason}
                />
              ))}
            </CardContent>
          </Card>

          <DragOverlay>
            {activeDragLabel ? (
              // The drop target must follow the dragged CHIP, never the size of
              // this floating card. dnd-kit measures the DragOverlay's own child
              // and uses that rect — not the draggable's — for closestCenter
              // (`draggingNodeRect = dragOverlay.rect ?? activeNodeRect`,
              // @dnd-kit/core), re-measuring it through a ResizeObserver while
              // the drag is live. The card grows the moment `activeDropPreview`
              // appears, so if the card were the measured child its centre would
              // sink below the cursor's cell mid-drag and the drop would land on
              // the row BELOW the one the preview just named — a full lodge night
              // on the wrong bed. This frame is the element DragOverlay sizes
              // from the chip's own rect, so keeping it as the measured child
              // pins collisions to the chip; the card is taken out of flow and
              // may be any height without moving the target.
              <div className="relative h-full w-full">
                <div
                  data-testid="bed-allocation-drag-feedback"
                  className="absolute left-0 top-0 w-full rounded-md border bg-card px-3 py-2 text-sm font-medium text-card-foreground shadow-lg"
                >
                  <div>{activeDragLabel}</div>
                  {activeDropPreview ? (
                    <div className="mt-1 text-xs font-normal text-muted-foreground">
                      {activeDropPreview}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}

      <BedRangeAssignDialog
        open={rangeDialogOpen}
        onOpenChange={setRangeDialogOpen}
        target={rangeTarget}
        bedOptionGroups={bedOptionGroups}
        // Unreachable while the board is club-wide or unscoped — both entry
        // points refuse to open it — but gated here too, so the dialog cannot
        // become writable through some future third entry point (#2701).
        canEdit={canEditBookings && !allocationLockReason}
        onAssigned={handleRangeAssigned}
      />
      {removalDialog.dialog}
      {moveDialog.dialog}
      </div>
    </div>
  );
}
