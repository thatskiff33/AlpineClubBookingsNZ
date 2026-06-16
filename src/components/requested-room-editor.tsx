"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface RoomOption {
  id: string;
  name: string;
  bedCount: number;
}

interface RequestedRoom {
  id: string;
  name: string;
  active: boolean;
}

interface RequestedRoomEditorProps {
  bookingId: string;
  initialRoom: RequestedRoom | null;
  canEdit: boolean;
  /**
   * API base path for the save/clear calls. Defaults to the admin route so
   * existing admin usage is unchanged; members pass the member route
   * (`/api/bookings/[id]/requested-room`). Issue #776.
   */
  endpoint?: string;
  /**
   * Read-only explanation shown when editing is locked (e.g. the lodge has
   * confirmed the bed allocation). Only rendered when `canEdit` is false.
   */
  lockedNote?: string;
}

export function RequestedRoomEditor({
  bookingId,
  initialRoom,
  canEdit,
  endpoint,
  lockedNote,
}: RequestedRoomEditorProps) {
  const basePath =
    endpoint ?? `/api/admin/bookings/${bookingId}/requested-room`;
  const [room, setRoom] = useState(initialRoom);
  const [roomOptions, setRoomOptions] = useState<RoomOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!canEdit) return;
    fetch("/api/bookings/rooms")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setRoomOptions(data?.rooms ?? []))
      .catch(() => setRoomOptions([]));
  }, [canEdit]);

  async function handleChange(value: string) {
    const previous = room;
    setSaving(true);
    setSaved(false);

    try {
      if (value === "none") {
        await fetch(basePath, { method: "DELETE" });
        setRoom(null);
      } else {
        await fetch(basePath, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestedRoomId: value }),
        });
        const selected = roomOptions.find((option) => option.id === value);
        setRoom(selected ? { id: selected.id, name: selected.name, active: true } : null);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setRoom(previous);
    } finally {
      setSaving(false);
    }
  }

  const inactiveChip = room && !room.active ? (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">
      Room no longer active &mdash; treated as no preference
    </Badge>
  ) : null;

  if (!canEdit) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-sm text-gray-600">{room ? room.name : "No preference"}</p>
          {inactiveChip}
        </div>
        {lockedNote ? (
          <p className="text-sm text-gray-500">{lockedNote}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="w-64">
        <Select value={room?.id ?? "none"} onValueChange={handleChange} disabled={saving}>
          <SelectTrigger>
            <SelectValue placeholder="No preference" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No preference</SelectItem>
            {room && !room.active && (
              <SelectItem value={room.id}>{room.name} (inactive)</SelectItem>
            )}
            {roomOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name} ({option.bedCount} {option.bedCount === 1 ? "bed" : "beds"})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {inactiveChip}
      {saving && <span className="text-xs text-gray-400">Saving...</span>}
      {saved && <span className="text-xs text-green-600">Saved</span>}
    </div>
  );
}
