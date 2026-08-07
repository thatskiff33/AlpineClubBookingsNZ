"use client";

import { useId, useState } from "react";
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
  // `saved` tracks the value the SERVER holds, so a failed save can put the
  // control back to it rather than leaving a time on screen that was rejected.
  const [savedTime, setSavedTime] = useState(initialTime);
  const [time, setTime] = useState(initialTime);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const statusId = useId();

  async function handleChange(newTime: string | null) {
    setTime(newTime);
    setSaving(true);
    setSaved(false);
    setError(null);

    try {
      /*
        #2621. This used to `await fetch(...)` and then set "Saved"
        unconditionally. `fetch` rejects only on a network failure, so a 400 from
        the validator or a 403 from the booking-officer check resolved normally and
        the member was told their arrival time was saved when the server had
        refused it — and the refused value stayed on screen, so a reload was the
        only way to find out. Check the response, and say what happened.
      */
      const response = await (newTime
        ? fetch(`/api/bookings/${bookingId}/arrival-time`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedArrivalTime: newTime }),
          })
        : fetch(`/api/bookings/${bookingId}/arrival-time`, {
            method: "DELETE",
          }));

      if (!response.ok) {
        // Prefer the server's own words — it is the one that knows whether this
        // was a bad time, a booking already checked in, or a missing permission.
        let message = "Could not save your arrival time. Please try again.";
        try {
          const body: unknown = await response.json();
          if (
            body &&
            typeof body === "object" &&
            "error" in body &&
            typeof (body as { error?: unknown }).error === "string"
          ) {
            message = (body as { error: string }).error;
          }
        } catch {
          // A non-JSON error body is not worth surfacing raw; keep the default.
        }
        setTime(savedTime);
        setError(message);
        return;
      }

      setSavedTime(newTime);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Network failure: nothing reached the server, so the stored value stands.
      setTime(savedTime);
      setError("Could not reach the server. Your arrival time was not saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) {
    return (
      <p className="text-sm text-muted-foreground">
        {time ? formatArrivalTime(time) : "Not set"}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        {/*
          Visually hidden rather than absent: this control sits in a labelled row
          on the booking page, so a visible second label would be redundant on
          screen — but the `select` still needs a name of its own.
        */}
        <label htmlFor={labelId} className="sr-only">
          Expected arrival time
        </label>
        <div className="w-48">
          <TimePicker
            id={labelId}
            value={time}
            onChange={handleChange}
            disabled={saving}
            describedById={error ? statusId : undefined}
          />
        </div>
        {saving && (
          <span className="text-xs text-muted-foreground">Saving...</span>
        )}
        {saved && <span className="text-xs text-success-11">Saved</span>}
      </div>
      {/*
        `role="status"` rather than `role="alert"`: this is the outcome of the
        member's own action on the control they just used, so it should be
        announced without stealing focus from it.
      */}
      {error && (
        <p id={statusId} role="status" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
