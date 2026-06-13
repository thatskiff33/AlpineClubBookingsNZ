"use client";

import { useEffect, useMemo, useState } from "react";
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
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlertTriangle,
  BedDouble,
  Check,
  LoaderCircle,
  RefreshCw,
  Save,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { BucketBoard } from "./_components/bucket-board";
import { RoomTable } from "./_components/room-table";
import {
  type BedOption,
  type BucketGuestGroup,
  type BulkAllocationConflict,
  type DashboardAllocation,
  type DashboardGuestNight,
  type DashboardPayload,
  type DragData,
  type DropData,
} from "./_components/types";

// Mirrors MAX_BED_ALLOCATION_RANGE_NIGHTS in src/lib/admin-bed-allocation.ts.
const MAX_RANGE_NIGHTS = 31;

function todayDateOnly() {
  return formatDateOnly(getTodayDateOnly());
}

function clampRange(from: string, to: string): string {
  if (!isDateOnlyString(from) || !isDateOnlyString(to)) return to;

  const fromDate = parseDateOnly(from);
  let toDate = parseDateOnly(to);
  if (toDate <= fromDate) {
    toDate = addDaysDateOnly(fromDate, 1);
  }

  const maxTo = addDaysDateOnly(fromDate, MAX_RANGE_NIGHTS);
  if (toDate > maxTo) {
    toDate = maxTo;
  }

  return formatDateOnly(toDate);
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
    }));

  return {
    ...payload,
    allocations: [...payload.allocations, ...newAllocations],
  };
}

function applyOptimisticMove(
  payload: DashboardPayload,
  allocationId: string,
  bed: BedOption,
  stayDate: string,
): DashboardPayload {
  return {
    ...payload,
    allocations: payload.allocations.map((allocation) =>
      allocation.id === allocationId
        ? {
            ...allocation,
            bedId: bed.id,
            bedName: bed.bedName,
            roomId: bed.roomId,
            roomName: bed.roomName,
            stayDate,
            source: "MANUAL",
            approvedAt: null,
            approvedByName: null,
          }
        : allocation,
    ),
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

  const initialFrom = isDateOnlyString(requestedFrom ?? "")
    ? (requestedFrom as string)
    : todayDateOnly();

  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(() =>
    isDateOnlyString(requestedTo ?? "")
      ? clampRange(initialFrom, requestedTo as string)
      : clampRange(initialFrom, formatDateOnly(addDaysDateOnly(parseDateOnly(initialFrom), 7))),
  );

  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [autoAllocationEnabled, setAutoAllocationEnabled] = useState(true);
  const [singleNightMode, setSingleNightMode] = useState(false);
  const [selectedBeds, setSelectedBeds] = useState<Record<string, string>>({});
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const nights = useMemo(() => {
    if (!isDateOnlyString(fromDate) || !isDateOnlyString(toDate)) return [];
    return eachDateOnlyInRange(parseDateOnly(fromDate), parseDateOnly(toDate)).map(
      formatDateOnly,
    );
  }, [fromDate, toDate]);

  const bedById = useMemo(() => {
    const map = new Map<string, BedOption>();
    for (const room of payload?.rooms ?? []) {
      if (!room.active) continue;
      for (const bed of room.beds) {
        if (!bed.active) continue;
        map.set(bed.id, {
          id: bed.id,
          roomId: room.id,
          roomName: room.name,
          bedName: bed.name,
          label: `${room.name} / ${bed.name}`,
        });
      }
    }
    return map;
  }, [payload]);

  const bedOptions = useMemo(() => [...bedById.values()], [bedById]);

  const allocationByBedAndDate = useMemo(() => {
    const map = new Map<string, DashboardAllocation>();
    for (const allocation of payload?.allocations ?? []) {
      map.set(`${allocation.bedId}:${allocation.stayDate}`, allocation);
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

  async function loadDashboard() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const response = await fetch(`/api/admin/bed-allocation?${params}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Failed to load bed allocation"),
        );
      }

      const data = (await response.json()) as DashboardPayload;
      setPayload(data);
      setAutoAllocationEnabled(data.settings.autoAllocationEnabled);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load bed allocation",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate]);

  async function withPending<T>(key: string, fn: () => Promise<T>): Promise<T> {
    setPendingKeys((prev) => new Set(prev).add(key));
    try {
      return await fn();
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
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

  async function saveSettings() {
    await mutate(
      "settings",
      () =>
        fetch("/api/admin/bed-allocation/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoAllocationEnabled }),
        }),
      "Bed allocation mode saved",
    );
  }

  async function runAutoAllocation() {
    await mutate(
      "auto",
      () =>
        fetch("/api/admin/bed-allocation/auto-allocate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromDate, to: toDate }),
        }),
      "Auto allocation applied",
    );
  }

  async function approveVisible() {
    await mutate(
      "approve",
      () =>
        fetch("/api/admin/bed-allocation/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromDate, to: toDate }),
        }),
      "Allocations approved",
    );
  }

  async function allocateFullStay(group: BucketGuestGroup, bedId: string) {
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
            `${group.guestName}: that bed was just taken for ${data.conflicts
              .map((conflict) => conflict.stayDate)
              .join(", ")} — refreshing the board`,
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
    if (target.bedId === allocation.bedId && target.stayDate === allocation.stayDate) {
      return;
    }
    if (!nights.includes(target.stayDate)) {
      return;
    }

    const bed = bedById.get(target.bedId);
    if (!bed || !payload) return;

    const snapshot = payload;
    setPayload(applyOptimisticMove(payload, allocation.id, bed, target.stayDate));

    await withPending(`allocation:${allocation.id}`, async () => {
      try {
        const postResponse = await fetch("/api/admin/bed-allocation/allocations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: allocation.bookingGuestId,
            bedId: target.bedId,
            stayDate: target.stayDate,
          }),
        });

        if (!postResponse.ok) {
          setPayload(snapshot);
          if (postResponse.status === 409) {
            toast.warning(
              `That bed was just taken for ${target.stayDate} — refreshing the board`,
            );
          } else {
            toast.error(await readApiError(postResponse, "Failed to move allocation"));
          }
          await loadDashboard();
          return;
        }

        if (target.stayDate !== allocation.stayDate) {
          const deleteResponse = await fetch(
            `/api/admin/bed-allocation/allocations/${allocation.id}`,
            { method: "DELETE" },
          );
          if (!deleteResponse.ok) {
            toast.error(
              "Allocation moved, but the original night could not be cleared — refreshing the board",
            );
            await loadDashboard();
            return;
          }
        }

        toast.success("Allocation moved");
        await loadDashboard();
      } catch {
        setPayload(snapshot);
        toast.error("Failed to move allocation");
        await loadDashboard();
      }
    });
  }

  async function removeAllocation(allocation: DashboardAllocation) {
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
    setActiveDragId(String(event.active.id));
  }

  function handleDragCancel() {
    setActiveDragId(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);

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

  const unapprovedCount =
    payload?.allocations.filter((allocation) => !allocation.approvedAt).length ?? 0;
  const activeBedCount = bedOptions.length;
  const activeRooms = payload?.rooms.filter((room) => room.active) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bed Allocation</h1>
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
        <div className="grid gap-3 sm:grid-cols-[minmax(0,150px)_minmax(0,150px)_auto]">
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
                setToDate((current) => clampRange(value, current));
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
                setToDate(clampRange(fromDate, value));
              }}
            />
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
        The board shows up to {MAX_RANGE_NIGHTS} nights at a time.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BedDouble className="h-4 w-4" />
            Allocation Mode
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <label className="flex items-center gap-3 text-sm font-medium">
              <Checkbox
                checked={autoAllocationEnabled}
                onCheckedChange={(checked) =>
                  setAutoAllocationEnabled(checked === true)
                }
              />
              Auto allocation enabled
            </label>
            <label className="flex items-center gap-3 text-sm font-medium">
              <Checkbox
                checked={singleNightMode}
                onCheckedChange={(checked) => setSingleNightMode(checked === true)}
              />
              Single-night drag mode
            </label>
          </div>
          <Button
            onClick={() => void saveSettings()}
            disabled={saving === "settings"}
            className="gap-2 md:w-auto"
          >
            <Save className="h-4 w-4" />
            Save Mode
          </Button>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-white p-6 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading bed allocation
        </div>
      ) : null}

      {payload ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Bookings approved, awaiting allocation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={() => void runAutoAllocation()}
                  disabled={
                    !payload.settings.autoAllocationEnabled ||
                    payload.suggestedAllocations.length === 0 ||
                    saving === "auto"
                  }
                  className="gap-2"
                >
                  <Wand2 className="h-4 w-4" />
                  Run Auto Allocation
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void approveVisible()}
                  disabled={unapprovedCount === 0 || saving === "approve"}
                  className="gap-2"
                >
                  <Check className="h-4 w-4" />
                  Approve Visible
                </Button>
                <Badge variant="outline">
                  {payload.suggestedAllocations.length} suggested
                </Badge>
                <Badge variant={unapprovedCount > 0 ? "warning" : "success"}>
                  {unapprovedCount} awaiting approval
                </Badge>
              </div>

              {payload.warnings.length > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
                  <div className="mb-2 flex items-center gap-2 font-medium text-amber-900">
                    <AlertTriangle className="h-4 w-4" />
                    Warnings
                  </div>
                  <ul className="space-y-1 text-sm text-amber-900">
                    {payload.warnings.map((warning) => (
                      <li key={warning.id}>{warning.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <BucketBoard
                bookings={payload.bookings}
                groupsByBooking={groupsByBooking}
                bedOptions={bedOptions}
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
                pendingGuestIds={pendingGuestIds}
                highlightedBookingId={highlightedBookingId}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Allocation Board</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {payload.rooms.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                  No rooms available.
                </div>
              ) : null}

              {activeBedCount === 0 && payload.rooms.length > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  No active beds available.
                </div>
              ) : null}

              {activeRooms.map((room) => (
                <RoomTable
                  key={room.id}
                  room={room}
                  nights={nights}
                  allocationByBedAndDate={allocationByBedAndDate}
                  bedOptions={bedOptions}
                  onReassignBed={(allocation, bedId) =>
                    void moveAllocation(allocation, {
                      bedId,
                      roomId: bedById.get(bedId)?.roomId ?? allocation.roomId,
                      stayDate: allocation.stayDate,
                    })
                  }
                  onRemove={(allocation) => void removeAllocation(allocation)}
                  pendingAllocationIds={pendingAllocationIds}
                  highlightedBookingId={highlightedBookingId}
                />
              ))}
            </CardContent>
          </Card>

          <DragOverlay>
            {activeDragLabel ? (
              <div className="rounded-md border bg-white px-3 py-2 text-sm font-medium shadow-lg">
                {activeDragLabel}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}
    </div>
  );
}
