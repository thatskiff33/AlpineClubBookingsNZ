"use client";

import { useState } from "react";
import { TimePicker } from "./time-picker";

interface ArrivalTimeEditorProps {
  bookingId: string;
  initialTime: string | null;
  canEdit: boolean;
}

function formatArrivalTime(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export function ArrivalTimeEditor({
  bookingId,
  initialTime,
  canEdit,
}: ArrivalTimeEditorProps) {
  const [time, setTime] = useState(initialTime);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleChange(newTime: string | null) {
    setTime(newTime);
    setSaving(true);
    setSaved(false);

    try {
      if (newTime) {
        await fetch(`/api/bookings/${bookingId}/arrival-time`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedArrivalTime: newTime }),
        });
      } else {
        await fetch(`/api/bookings/${bookingId}/arrival-time`, {
          method: "DELETE",
        });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Revert on error
      setTime(initialTime);
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) {
    return (
      <p className="text-sm text-gray-600">
        {time ? formatArrivalTime(time) : "Not set"}
      </p>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="w-48">
        <TimePicker value={time} onChange={handleChange} disabled={saving} />
      </div>
      {saving && <span className="text-xs text-gray-400">Saving...</span>}
      {saved && <span className="text-xs text-green-600">Saved</span>}
    </div>
  );
}
