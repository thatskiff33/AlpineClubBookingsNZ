"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useActionFocusReturn } from "@/hooks/use-scroll-to-feedback";
import { TimePicker } from "./time-picker";
import { formatArrivalTime, isValidArrivalTime } from "@/lib/arrival-time";

interface ArrivalTimeEditorProps {
  bookingId: string;
  initialTime: string | null;
  canEdit: boolean;
}

/**
 * #2621 — the expected arrival time, staged and saved explicitly.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERED. The previous version saved on every
 * change of the dropdown and then rendered "Saved" **without ever looking at the
 * response**. `fetch` only rejects on a network failure, so a 400 (a time on a
 * booking whose check-in date has passed) and a 403 (a member editing a booking
 * that is not theirs) both resolved normally and both printed "Saved" in green
 * next to a value the server had refused. The member closed the page believing
 * the lodge knew when they were coming. On reload the old value came back, with
 * no explanation of which of the two was true.
 *
 * The fix is the shape `BookingNotesEditor` already uses on this same page:
 * stage the value locally, save on an explicit press, check `res.ok`, and put
 * the server's own message on screen when it says no. Auto-save is what made
 * dishonesty invisible here — a save the member did not ask for has no obvious
 * place to report that it failed.
 *
 * "Saved" is now only ever rendered after a response the server called
 * successful, and `savedTime` (not the staged value) is what the read-only
 * summary shows, so the screen never claims a time is recorded that is not.
 */
export function ArrivalTimeEditor({
  bookingId,
  initialTime,
  canEdit,
}: ArrivalTimeEditorProps) {
  // `savedTime` is what the server last confirmed; `time` is what the member is
  // currently proposing. Keeping them apart is the whole point: a failed save
  // must leave the confirmed value untouched, and the Save button must know
  // whether there is anything to send.
  const [savedTime, setSavedTime] = useState(initialTime);
  const [time, setTime] = useState(initialTime);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const focusReturn = useActionFocusReturn();

  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const storedId = `${fieldId}-stored`;
  const hasChanged = time !== savedTime;

  // #2621 — a stored value the dropdown has no option for.
  //
  // The picker offers the canonical half-hour set only, so a booking holding a
  // legacy `"14:10"` (the old `[0-5]0` pattern accepted it, and so did hand-run
  // SQL) selects nothing: the member saw an EMPTY control on a booking that does
  // have a time recorded, with no way to tell "not set" from "set to something
  // this control cannot show". The value is named beside the control instead, in
  // the same 12-hour form every other surface uses, and the id joins the
  // control's description so it is announced rather than merely visible.
  //
  // Deliberately NOT offered as an extra option: the member's next save has to
  // land on a value the club's own rule accepts, and quietly re-saving a
  // non-canonical time would keep it alive for ever.
  const unselectableStoredLabel =
    savedTime !== null && !isValidArrivalTime(savedTime)
      ? formatArrivalTime(savedTime)
      : null;

  async function handleSave() {
    // A browser drops focus from a disabled control; hand it back when re-enabled (#5442).
    focusReturn.capture();
    setSaving(true);
    setError("");
    setSaved(false);
    // Snapshot the value being sent: the member can change the dropdown again
    // while the request is in flight, and confirming the wrong one is exactly
    // the class of lie this rewrite exists to remove.
    const submitted = time;
    try {
      const res = submitted
        ? await fetch(`/api/bookings/${bookingId}/arrival-time`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedArrivalTime: submitted }),
          })
        : await fetch(`/api/bookings/${bookingId}/arrival-time`, {
            method: "DELETE",
          });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to save arrival time");
      }
      setSavedTime(submitted);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      // The staged value stays on screen so the member can retry or correct it;
      // only `savedTime` is authoritative, and it has not moved.
      setError(err instanceof Error ? err.message : "Failed to save arrival time");
    } finally {
      setSaving(false);
      focusReturn.release();
    }
  }

  if (!canEdit) {
    return (
      <p className="text-sm text-muted-foreground">
        {savedTime ? formatArrivalTime(savedTime) : "Not set"}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* `sr-only` rather than a second visible heading: the card this
            editor sits in already shows "Expected Arrival Time" above it, and
            two identical visible labels is worse UI than one. What was missing
            was never the words — it was the programmatic association, so the
            control announces as more than a bare combo box. */}
        <label htmlFor={fieldId} className="sr-only">
          Expected arrival time
        </label>
        <div className="w-48">
          <TimePicker
            id={fieldId}
            describedBy={
              unselectableStoredLabel ? `${storedId} ${hintId}` : hintId
            }
            value={time}
            onChange={setTime}
            disabled={saving}
          />
        </div>
        {unselectableStoredLabel && (
          <span id={storedId} className="text-xs text-muted-foreground">
            Currently: {unselectableStoredLabel}
          </span>
        )}
        <Button size="sm" onClick={handleSave} disabled={saving || !hasChanged}>
          {saving ? "Saving..." : "Save arrival time"}
        </Button>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        Roughly when you expect to reach the lodge, so the hut leader knows when
        to expect you. It does not change your booking dates or your chores.
      </p>
      <div aria-live="polite" className="min-h-4">
        {error && <span className="text-xs text-danger-11">{error}</span>}
        {saved && <span className="text-xs text-success-11">Saved</span>}
      </div>
    </div>
  );
}
