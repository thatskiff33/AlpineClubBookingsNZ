"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClubIdentity } from "@/components/club-identity-provider";
import { LodgeSelect, useLodgeOptions } from "@/components/lodge-select";
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
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import {
  BedRangeAssignDialog,
  type BedRangeAssignResult,
  type BedRangeAssignTarget,
} from "@/components/admin/bed-range-assign-dialog";
import {
  applyOptimisticAllocationBedMove,
  planAllocationMove,
} from "./_components/allocation-move";
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
import { deriveActiveDragDates } from "./_components/active-drag-dates";
import {
  BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS,
  createBedAllocationAnnouncements,
  describeBedAllocationDrop,
} from "./_components/allocation-drag-feedback";
import { useSyncedScroll } from "./_components/use-synced-scroll";
import { AllocationPreferencesSection } from "./_components/allocation-preferences-section";
import { useScopedDashboard } from "./_components/use-scoped-dashboard";

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

function todayDateOnly() {
  return formatDateOnly(getTodayDateOnly());
}

async function readApiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
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

function applyOptimisticRemove(
  payload: DashboardPayload,
  allocation: DashboardAllocation,
): DashboardPayload {
  const memberName =
    payload.bookings.find((booking) => booking.id === allocation.bookingId)
      ?.memberName ?? "";

  return {
    ...payload,
    allocations: payload.allocations.filter((item) => item.id !== allocation.id),
    unallocatedGuestNights: [
      ...payload.unallocatedGuestNights,
      {
        bookingId: allocation.bookingId,
        bookingGuestId: allocation.bookingGuestId,
        guestName: allocation.guestName,
        guestAgeTier: allocation.guestAgeTier,
        memberName,
        stayDate: allocation.stayDate,
      },
    ],
  };
}

export default function AdminBedAllocationPage() {
  const searchParams = useSearchParams();
  const requestedFrom = searchParams.get("from");
  const requestedTo = searchParams.get("to");
  const highlightedBookingId = searchParams.get("bookingId") || "";
  const canEditBookings = useAdminAreaEditAccess("bookings");
  // Admin copy uses the club's own word for the hut-leader role (#2286 review
  // M8); only the lobby TV is pinned to the fixed word "Custodian".
  const { hutLeaderLabel } = useClubIdentity();

  const initialFrom = isDateOnlyString(requestedFrom ?? "")
    ? (requestedFrom as string)
    : todayDateOnly();

  // A deep link may carry a booking's whole stay, which can be far longer than
  // the board's 31-night window (admin-booking-tools-card sends checkIn →
  // checkOut). The window is fitted rather than refused — an admin who followed
  // a link did not type this — and `windowNarrowed` puts a visible note on
  // screen so the narrowing is never silent (#2251).
  const initialWindow = isDateOnlyString(requestedTo ?? "")
    ? fitBoardWindow(initialFrom, requestedTo as string)
    : fitBoardWindow(
        initialFrom,
        formatDateOnly(addDaysDateOnly(parseDateOnly(initialFrom), 7)),
      );

  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(initialWindow.toDate);
  const [windowNarrowed, setWindowNarrowed] = useState(initialWindow.narrowed);

  // Board lodge scope (ADR-003); LodgeSelect renders nothing (and reports
  // the sole lodge) while fewer than two lodges exist (ADR-002). Initialised
  // from the URL synchronously so the first dashboard fetch is already
  // lodge-filtered.
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(
    searchParams.get("lodgeId"),
  );

  const dashboardScopeKey = `${lodgeId ?? "all"}:${fromDate}:${toDate}:${highlightedBookingId}`;
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
      if (lodgeId) params.set("lodgeId", lodgeId);
      if (highlightedBookingId) {
        params.set("bookingId", highlightedBookingId);
      }
      const response = await fetch(`/api/admin/bed-allocation?${params}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Failed to load bed allocation"),
        );
      }
      return (await response.json()) as DashboardPayload;
    },
    [fromDate, highlightedBookingId, lodgeId, toDate],
  );
  const scopedDashboard = useScopedDashboard({
    scopeKey: dashboardScopeKey,
    enabled: !windowError,
    load: fetchDashboard,
    onLoaded: () => setSingleNightMode(false),
  });
  const payload = scopedDashboard.value;
  const loading = scopedDashboard.loading;
  const dashboardError = scopedDashboard.error;
  const loadDashboard = scopedDashboard.reload;
  const setPayload = scopedDashboard.setValue;

  useEffect(() => {
    if (dashboardError) toast.error(dashboardError);
  }, [dashboardError]);

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
    if (!canEditBookings) return;

    await mutate(
      "approve",
      () =>
        fetch("/api/admin/bed-allocation/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromDate,
            to: toDate,
            ...(lodgeId ? { lodgeId } : {}),
          }),
        }),
      "Allocations approved",
    );
  }

  async function allocateFullStay(group: BucketGuestGroup, bedId: string) {
    if (!canEditBookings) return;

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
    if (!canEditBookings) return;

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

  async function moveAllocation(
    allocation: DashboardAllocation,
    target: { bedId: string; roomId: string; stayDate: string },
  ) {
    if (!canEditBookings) return;

    if (!payload) return;
    const bed = bedById.get(target.bedId);
    if (!bed) return;

    const movePlan = planAllocationMove({
      allocation,
      target,
      visibleAllocations: payload.allocations,
      visibleNights: nights,
    });

    if (movePlan.type === "noop") {
      return;
    }

    const snapshot = payload;
    const allocationIds =
      movePlan.type === "bulk"
        ? movePlan.allocationIds
        : [movePlan.allocationId];
    setPayload(
      applyOptimisticAllocationBedMove({
        payload,
        allocationIds,
        bed,
      }),
    );

    await withPending(
      allocationIds.map((id) => `allocation:${id}`),
      async () => {
        try {
          const response = await fetch(
            "/api/admin/bed-allocation/allocations",
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                allocationIds,
                bedId: target.bedId,
              }),
            },
          );

          if (!response.ok) {
            setPayload(snapshot);
            if (response.status === 409) {
              toast.warning(
                await readApiError(
                  response,
                  "No allocations were moved because the destination bed is unavailable on an original lodge night",
                ),
              );
            } else {
              toast.error(
                await readApiError(response, "Failed to move allocation"),
              );
            }
            await loadDashboard();
            return;
          }

          toast.success(
            movePlan.type === "bulk"
              ? "Visible guest nights moved"
              : "Allocation moved",
          );
          await loadDashboard();
        } catch {
          setPayload(snapshot);
          toast.error("Failed to move allocation");
          await loadDashboard();
        }
      },
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
    if (!canEditBookings) return;
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
        formatDateOnly(
          addDaysDateOnly(
            parseDateOnly(group.stayDates[group.stayDates.length - 1]),
            1,
          ),
        ),
    });
    setRangeDialogOpen(true);
  }

  // Entry point 2 (#2251): an already-placed chip on the board, so a guest whose
  // first nights are done can have the rest of the stay assigned in one action.
  function openRangeForAllocation(allocation: DashboardAllocation) {
    if (!canEditBookings) return;
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
        formatDateOnly(addDaysDateOnly(parseDateOnly(allocation.stayDate), 1)),
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

  async function removeAllocation(allocation: DashboardAllocation) {
    if (!canEditBookings) return;

    if (!payload) return;

    const snapshot = payload;
    setPayload(applyOptimisticRemove(payload, allocation));

    await withPending(`allocation:${allocation.id}`, async () => {
      try {
        const response = await fetch(
          `/api/admin/bed-allocation/allocations/${allocation.id}`,
          { method: "DELETE" },
        );

        if (!response.ok) {
          setPayload(snapshot);
          toast.error(await readApiError(response, "Failed to remove allocation"));
          await loadDashboard();
          return;
        }

        toast.success("Allocation removed");
        await loadDashboard();
      } catch {
        setPayload(snapshot);
        toast.error("Failed to remove allocation");
        await loadDashboard();
      }
    });
  }

  function handleDragStart(event: DragStartEvent) {
    if (!canEditBookings) return;

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
    if (!canEditBookings) return;

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
        void removeAllocation(allocation);
      } else if (overData.type === "cell") {
        void moveAllocation(allocation, {
          bedId: overData.bedId,
          roomId: overData.roomId,
          stayDate: overData.stayDate,
        });
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
            value={lodgeId}
            onChange={setLodgeId}
            loading={lodgesLoading}
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
                if (!isDateOnlyString(value)) return;
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
                if (!isDateOnlyString(value)) return;
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
            disabled={loading}
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
          <CardContent className="text-sm text-muted-foreground">
            {lodgesLoading ? "Loading lodge…" : "Choose a lodge to continue."}
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

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-card p-6 text-sm text-muted-foreground">
          <Spinner size="sm" label="Loading bed allocation" />
          <span aria-hidden="true">Loading bed allocation</span>
        </div>
      ) : null}

      {!loading && dashboardError && !windowError ? (
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
                  disabled={unapprovedCount === 0 || saving === "approve"}
                  className="gap-2"
                >
                  <Check className="h-4 w-4" />
                  Approve Visible
                </ViewOnlyActionButton>
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
                  onReassignBed={(allocation, bedId) =>
                    void moveAllocation(allocation, {
                      bedId,
                      roomId: bedById.get(bedId)?.roomId ?? allocation.roomId,
                      stayDate: allocation.stayDate,
                    })
                  }
                  onRemove={(allocation) => void removeAllocation(allocation)}
                  onAssignRange={openRangeForAllocation}
                  rangeTint={rangeTint}
                  custodianHoldByBedAndDate={custodianHoldByBedAndDate}
                  pendingAllocationIds={pendingAllocationIds}
                  highlightedBookingId={highlightedBookingId}
                  activeDragDates={activeDragDates}
                  registerScroller={registerBoardScroller}
                  canEdit={canEditBookings}
                />
              ))}
            </CardContent>
          </Card>

          <DragOverlay>
            {activeDragLabel ? (
              <div
                data-testid="bed-allocation-drag-feedback"
                className="rounded-md border bg-card px-3 py-2 text-sm font-medium text-card-foreground shadow-lg"
              >
                <div>{activeDragLabel}</div>
                {activeDropPreview ? (
                  <div className="mt-1 text-xs font-normal text-muted-foreground">
                    {activeDropPreview}
                  </div>
                ) : null}
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
        canEdit={canEditBookings}
        onAssigned={handleRangeAssigned}
      />
      </div>
    </div>
  );
}
