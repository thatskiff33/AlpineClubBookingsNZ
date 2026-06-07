"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BedDouble,
  Check,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Trash2,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

interface DashboardBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

interface DashboardRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  notes: string | null;
  beds: DashboardBed[];
}

interface DashboardAllocation {
  id: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  roomId: string;
  roomName: string;
  bedId: string;
  bedName: string;
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approvedAt: string | null;
  approvedByName: string | null;
}

interface DashboardGuestNight {
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  memberName: string;
  stayDate: string;
}

interface DashboardWarning {
  id: string;
  type: "BOOKING_SPLIT" | "MINOR_WITHOUT_BOOKING_ADULT";
  bookingId: string;
  bookingGuestId?: string;
  stayDate: string;
  roomId?: string;
  message: string;
}

interface DashboardPayload {
  settings: {
    autoAllocationEnabled: boolean;
    updatedAt: string | null;
    updatedByMemberId: string | null;
  };
  range: {
    fromDate: string;
    toDate: string;
  };
  rooms: DashboardRoom[];
  bookings: Array<{ id: string }>;
  allocations: DashboardAllocation[];
  unallocatedGuestNights: DashboardGuestNight[];
  suggestedAllocations: Array<{
    bookingId: string;
    bookingGuestId: string;
    roomId: string;
    bedId: string;
    stayDate: string;
  }>;
  suggestedUnallocatedGuestNights: Array<{
    bookingId: string;
    bookingGuestId: string;
    stayDate: string;
    reason: string;
  }>;
  warnings: DashboardWarning[];
}

interface RoomDraft {
  name: string;
  sortOrder: string;
  active: boolean;
  notes: string;
}

interface BedDraft {
  name: string;
  sortOrder: string;
  active: boolean;
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysInputValue(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function readApiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function allocationKey(bookingGuestId: string, stayDate: string) {
  return `${bookingGuestId}:${stayDate}`;
}

function roomEditFromRoom(room: DashboardRoom): RoomDraft {
  return {
    name: room.name,
    sortOrder: String(room.sortOrder),
    active: room.active,
    notes: room.notes ?? "",
  };
}

function bedEditFromBed(bed: DashboardBed): BedDraft {
  return {
    name: bed.name,
    sortOrder: String(bed.sortOrder),
    active: bed.active,
  };
}

export default function AdminBedAllocationPage() {
  const initialFrom = todayInputValue();
  const [fromDate, setFromDate] = useState(initialFrom);
  const [toDate, setToDate] = useState(addDaysInputValue(initialFrom, 7));
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [autoAllocationEnabled, setAutoAllocationEnabled] = useState(true);
  const [roomDraft, setRoomDraft] = useState<RoomDraft>({
    name: "",
    sortOrder: "0",
    active: true,
    notes: "",
  });
  const [roomEdits, setRoomEdits] = useState<Record<string, RoomDraft>>({});
  const [bedDrafts, setBedDrafts] = useState<Record<string, BedDraft>>({});
  const [bedEdits, setBedEdits] = useState<Record<string, BedDraft>>({});
  const [selectedBeds, setSelectedBeds] = useState<Record<string, string>>({});

  const activeBedOptions = useMemo(() => {
    if (!payload) return [];

    return payload.rooms.flatMap((room) =>
      room.active
        ? room.beds
            .filter((bed) => bed.active)
            .map((bed) => ({
              id: bed.id,
              label: `${room.name} / ${bed.name}`,
            }))
        : [],
    );
  }, [payload]);

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
      setRoomEdits(
        Object.fromEntries(data.rooms.map((room) => [room.id, roomEditFromRoom(room)])),
      );
      setBedEdits(
        Object.fromEntries(
          data.rooms.flatMap((room) =>
            room.beds.map((bed) => [bed.id, bedEditFromBed(bed)]),
          ),
        ),
      );
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
  }, []);

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

  function updateRoomEdit(roomId: string, patch: Partial<RoomDraft>) {
    setRoomEdits((current) => ({
      ...current,
      [roomId]: {
        ...(current[roomId] ?? {
          name: "",
          sortOrder: "0",
          active: true,
          notes: "",
        }),
        ...patch,
      },
    }));
  }

  function updateBedDraft(roomId: string, patch: Partial<BedDraft>) {
    setBedDrafts((current) => ({
      ...current,
      [roomId]: {
        ...(current[roomId] ?? { name: "", sortOrder: "0", active: true }),
        ...patch,
      },
    }));
  }

  function updateBedEdit(bedId: string, patch: Partial<BedDraft>) {
    setBedEdits((current) => ({
      ...current,
      [bedId]: {
        ...(current[bedId] ?? { name: "", sortOrder: "0", active: true }),
        ...patch,
      },
    }));
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

  async function createRoom() {
    await mutate(
      "room-new",
      () =>
        fetch("/api/admin/bed-allocation/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: roomDraft.name,
            sortOrder: Number(roomDraft.sortOrder || 0),
            active: roomDraft.active,
            notes: roomDraft.notes || null,
          }),
        }),
      "Room created",
    );
    setRoomDraft({ name: "", sortOrder: "0", active: true, notes: "" });
  }

  async function saveRoom(roomId: string) {
    const draft = roomEdits[roomId];
    if (!draft) return;

    await mutate(
      `room-${roomId}`,
      () =>
        fetch(`/api/admin/bed-allocation/rooms/${roomId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: draft.name,
            sortOrder: Number(draft.sortOrder || 0),
            active: draft.active,
            notes: draft.notes || null,
          }),
        }),
      "Room saved",
    );
  }

  async function createBed(roomId: string) {
    const draft = bedDrafts[roomId] ?? { name: "", sortOrder: "0", active: true };

    await mutate(
      `bed-new-${roomId}`,
      () =>
        fetch("/api/admin/bed-allocation/beds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomId,
            name: draft.name,
            sortOrder: Number(draft.sortOrder || 0),
            active: draft.active,
          }),
        }),
      "Bed created",
    );
    updateBedDraft(roomId, { name: "", sortOrder: "0", active: true });
  }

  async function saveBed(bedId: string) {
    const draft = bedEdits[bedId];
    if (!draft) return;

    await mutate(
      `bed-${bedId}`,
      () =>
        fetch(`/api/admin/bed-allocation/beds/${bedId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: draft.name,
            sortOrder: Number(draft.sortOrder || 0),
            active: draft.active,
          }),
        }),
      "Bed saved",
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

  async function assignGuest(bookingGuestId: string, stayDate: string) {
    const key = allocationKey(bookingGuestId, stayDate);
    const bedId = selectedBeds[key];
    if (!bedId || bedId === "none") {
      toast.error("Select a bed first");
      return;
    }

    await mutate(
      `assign-${key}`,
      () =>
        fetch("/api/admin/bed-allocation/allocations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingGuestId, stayDate, bedId }),
        }),
      "Allocation saved",
    );
  }

  async function moveAllocation(allocation: DashboardAllocation) {
    const key = `move-${allocation.id}`;
    const bedId = selectedBeds[key];
    if (!bedId || bedId === "none") {
      toast.error("Select a bed first");
      return;
    }

    await mutate(
      key,
      () =>
        fetch("/api/admin/bed-allocation/allocations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: allocation.bookingGuestId,
            stayDate: allocation.stayDate,
            bedId,
          }),
        }),
      "Allocation moved",
    );
  }

  async function deleteAllocation(allocationId: string) {
    await mutate(
      `delete-${allocationId}`,
      () =>
        fetch(`/api/admin/bed-allocation/allocations/${allocationId}`, {
          method: "DELETE",
        }),
      "Allocation removed",
    );
  }

  const unapprovedCount =
    payload?.allocations.filter((allocation) => !allocation.approvedAt).length ?? 0;
  const activeBedCount = activeBedOptions.length;

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
              onChange={(event) => setFromDate(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bed-to">Date Out</Label>
            <Input
              id="bed-to"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BedDouble className="h-4 w-4" />
            Allocation Mode
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <label className="flex items-center gap-3 text-sm font-medium">
            <Checkbox
              checked={autoAllocationEnabled}
              onCheckedChange={(checked) =>
                setAutoAllocationEnabled(checked === true)
              }
            />
            Auto allocation enabled
          </label>
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
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Rooms And Beds</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 md:grid-cols-[2fr_90px_1fr_auto_auto]">
                <Input
                  placeholder="Room name"
                  value={roomDraft.name}
                  onChange={(event) =>
                    setRoomDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                <Input
                  type="number"
                  min="0"
                  value={roomDraft.sortOrder}
                  onChange={(event) =>
                    setRoomDraft((current) => ({
                      ...current,
                      sortOrder: event.target.value,
                    }))
                  }
                />
                <Textarea
                  placeholder="Notes"
                  value={roomDraft.notes}
                  onChange={(event) =>
                    setRoomDraft((current) => ({
                      ...current,
                      notes: event.target.value,
                    }))
                  }
                  className="min-h-9"
                />
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={roomDraft.active}
                    onCheckedChange={(checked) =>
                      setRoomDraft((current) => ({
                        ...current,
                        active: checked === true,
                      }))
                    }
                  />
                  Active
                </label>
                <Button
                  onClick={() => void createRoom()}
                  disabled={saving === "room-new"}
                  className="gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add Room
                </Button>
              </div>

              {payload.rooms.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                  No rooms configured.
                </div>
              ) : (
                <div className="space-y-6">
                  {payload.rooms.map((room) => {
                    const edit = roomEdits[room.id] ?? roomEditFromRoom(room);
                    const bedDraft =
                      bedDrafts[room.id] ?? {
                        name: "",
                        sortOrder: "0",
                        active: true,
                      };

                    return (
                      <div key={room.id} className="rounded-md border p-4">
                        <div className="grid gap-3 md:grid-cols-[2fr_90px_1fr_auto_auto]">
                          <Input
                            value={edit.name}
                            onChange={(event) =>
                              updateRoomEdit(room.id, { name: event.target.value })
                            }
                          />
                          <Input
                            type="number"
                            min="0"
                            value={edit.sortOrder}
                            onChange={(event) =>
                              updateRoomEdit(room.id, {
                                sortOrder: event.target.value,
                              })
                            }
                          />
                          <Textarea
                            value={edit.notes}
                            onChange={(event) =>
                              updateRoomEdit(room.id, { notes: event.target.value })
                            }
                            className="min-h-9"
                          />
                          <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={edit.active}
                              onCheckedChange={(checked) =>
                                updateRoomEdit(room.id, {
                                  active: checked === true,
                                })
                              }
                            />
                            Active
                          </label>
                          <Button
                            variant="outline"
                            onClick={() => void saveRoom(room.id)}
                            disabled={saving === `room-${room.id}`}
                            className="gap-2"
                          >
                            <Save className="h-4 w-4" />
                            Save
                          </Button>
                        </div>

                        <div className="mt-4 space-y-3">
                          <div className="grid gap-3 md:grid-cols-[2fr_90px_auto_auto]">
                            <Input
                              placeholder="Bed name"
                              value={bedDraft.name}
                              onChange={(event) =>
                                updateBedDraft(room.id, {
                                  name: event.target.value,
                                })
                              }
                            />
                            <Input
                              type="number"
                              min="0"
                              value={bedDraft.sortOrder}
                              onChange={(event) =>
                                updateBedDraft(room.id, {
                                  sortOrder: event.target.value,
                                })
                              }
                            />
                            <label className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={bedDraft.active}
                                onCheckedChange={(checked) =>
                                  updateBedDraft(room.id, {
                                    active: checked === true,
                                  })
                                }
                              />
                              Active
                            </label>
                            <Button
                              variant="outline"
                              onClick={() => void createBed(room.id)}
                              disabled={saving === `bed-new-${room.id}`}
                              className="gap-2"
                            >
                              <Plus className="h-4 w-4" />
                              Add Bed
                            </Button>
                          </div>

                          {room.beds.length === 0 ? (
                            <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                              No beds in this room.
                            </div>
                          ) : (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Bed</TableHead>
                                  <TableHead className="w-24">Sort</TableHead>
                                  <TableHead className="w-24">Active</TableHead>
                                  <TableHead className="w-28" />
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {room.beds.map((bed) => {
                                  const bedEdit =
                                    bedEdits[bed.id] ?? bedEditFromBed(bed);

                                  return (
                                    <TableRow key={bed.id}>
                                      <TableCell>
                                        <Input
                                          value={bedEdit.name}
                                          onChange={(event) =>
                                            updateBedEdit(bed.id, {
                                              name: event.target.value,
                                            })
                                          }
                                        />
                                      </TableCell>
                                      <TableCell>
                                        <Input
                                          type="number"
                                          min="0"
                                          value={bedEdit.sortOrder}
                                          onChange={(event) =>
                                            updateBedEdit(bed.id, {
                                              sortOrder: event.target.value,
                                            })
                                          }
                                        />
                                      </TableCell>
                                      <TableCell>
                                        <Checkbox
                                          checked={bedEdit.active}
                                          onCheckedChange={(checked) =>
                                            updateBedEdit(bed.id, {
                                              active: checked === true,
                                            })
                                          }
                                        />
                                      </TableCell>
                                      <TableCell>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => void saveBed(bed.id)}
                                          disabled={saving === `bed-${bed.id}`}
                                        >
                                          Save
                                        </Button>
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Allocation Board</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
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

              <div>
                <h2 className="mb-3 text-sm font-semibold text-slate-900">
                  Unallocated Guest Nights
                </h2>
                {payload.unallocatedGuestNights.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    No unallocated guest nights in this range.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Guest</TableHead>
                        <TableHead>Booking</TableHead>
                        <TableHead>Bed</TableHead>
                        <TableHead className="w-28" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payload.unallocatedGuestNights.map((guestNight) => {
                        const key = allocationKey(
                          guestNight.bookingGuestId,
                          guestNight.stayDate,
                        );

                        return (
                          <TableRow key={key}>
                            <TableCell>{guestNight.stayDate}</TableCell>
                            <TableCell>
                              <div className="font-medium">
                                {guestNight.guestName}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {guestNight.guestAgeTier}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="font-mono text-xs">
                                {guestNight.bookingId}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {guestNight.memberName}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Select
                                value={selectedBeds[key] ?? "none"}
                                onValueChange={(value) =>
                                  setSelectedBeds((current) => ({
                                    ...current,
                                    [key]: value,
                                  }))
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">Select bed</SelectItem>
                                  {activeBedOptions.map((bed) => (
                                    <SelectItem key={bed.id} value={bed.id}>
                                      {bed.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                onClick={() =>
                                  void assignGuest(
                                    guestNight.bookingGuestId,
                                    guestNight.stayDate,
                                  )
                                }
                                disabled={saving === `assign-${key}`}
                              >
                                Allocate
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </div>

              <div>
                <h2 className="mb-3 text-sm font-semibold text-slate-900">
                  Allocations
                </h2>
                {payload.allocations.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    No allocations in this range.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Guest</TableHead>
                        <TableHead>Bed</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Move</TableHead>
                        <TableHead className="w-24" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payload.allocations.map((allocation) => {
                        const moveKey = `move-${allocation.id}`;

                        return (
                          <TableRow key={allocation.id}>
                            <TableCell>{allocation.stayDate}</TableCell>
                            <TableCell>
                              <div className="font-medium">
                                {allocation.guestName}
                              </div>
                              <div className="font-mono text-xs text-muted-foreground">
                                {allocation.bookingId}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div>{allocation.roomName}</div>
                              <div className="text-xs text-muted-foreground">
                                {allocation.bedName}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                <Badge
                                  variant={
                                    allocation.source === "MANUAL"
                                      ? "warning"
                                      : "secondary"
                                  }
                                >
                                  {allocation.source}
                                </Badge>
                                <Badge
                                  variant={
                                    allocation.approvedAt ? "success" : "outline"
                                  }
                                >
                                  {allocation.approvedAt ? "Approved" : "Draft"}
                                </Badge>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Select
                                value={selectedBeds[moveKey] ?? "none"}
                                onValueChange={(value) =>
                                  setSelectedBeds((current) => ({
                                    ...current,
                                    [moveKey]: value,
                                  }))
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">Select bed</SelectItem>
                                  {activeBedOptions.map((bed) => (
                                    <SelectItem key={bed.id} value={bed.id}>
                                      {bed.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void moveAllocation(allocation)}
                                  disabled={saving === moveKey}
                                >
                                  Move
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label="Remove allocation"
                                  onClick={() =>
                                    void deleteAllocation(allocation.id)
                                  }
                                  disabled={saving === `delete-${allocation.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
