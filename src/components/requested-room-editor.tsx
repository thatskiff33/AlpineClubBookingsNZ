"use client";

import { useEffect, useId, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useActionFocusReturn } from "@/hooks/use-scroll-to-feedback";
import { Button } from "@/components/ui/button";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

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

/** What the requested-room routes return on a successful write. */
interface RequestedRoomWriteResult {
  requestedRoom: RequestedRoom | null;
}

function selectionValue(room: RequestedRoom | null): string {
  return room?.id ?? "none";
}

/**
 * Turn a picked option value into the room the member is proposing. The picker
 * offers active rooms plus, when the booking already holds an inactive room,
 * the inactive room it holds — which is not in `roomOptions`, so fall back to
 * what is already known about it.
 */
function stagedRoom(
  value: string,
  roomOptions: RoomOption[],
  saved: RequestedRoom | null,
): RequestedRoom | null {
  if (value === "none") return null;
  const selected = roomOptions.find((option) => option.id === value);
  if (selected) return { id: selected.id, name: selected.name, active: true };
  return saved?.id === value ? saved : null;
}

/**
 * #2654 — the requested room, staged and saved explicitly.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERED. The previous version wrote on every
 * change of the picker and then rendered "Saved" **without ever looking at the
 * response**. `fetch` only rejects on a network failure, so the 400 from the
 * room validator, the 403 from the ownership check, and the 409 the writer
 * raises once the lodge has allocated the beds all resolved normally and all
 * printed "Saved" in green beside a room the server had refused. The member
 * closed the page believing the lodge knew which room they wanted. On reload
 * the old value came back, with no explanation of which of the two was true.
 *
 * The fix is the shape its sibling on this same page already uses
 * (`arrival-time-editor.tsx`, #2621/#2657): stage the choice locally, save on
 * an explicit press, check `response.ok`, and put the server's own message on
 * screen when it says no. Auto-save is what made the dishonesty invisible here
 * — a save the member did not ask for has no obvious place to report that it
 * failed. Two editors sit on this one booking page, and a member now meets the
 * same interaction model in both.
 *
 * "Saved" is now only ever rendered after a response the server called
 * successful, and `savedRoom` (not the staged pick) is what the read-only
 * summary and the inactive-room chip show, so the screen never claims a room
 * is recorded that is not.
 */
export function RequestedRoomEditor({
  bookingId,
  initialRoom,
  canEdit,
  endpoint,
  lockedNote,
}: RequestedRoomEditorProps) {
  const basePath =
    endpoint ?? `/api/admin/bookings/${bookingId}/requested-room`;
  // `savedRoom` is what the server last confirmed; `room` is what the member is
  // currently proposing. Keeping them apart is the whole point: a failed save
  // must leave the confirmed value untouched, and the Save button must know
  // whether there is anything to send.
  const [savedRoom, setSavedRoom] = useState(initialRoom);
  const [room, setRoom] = useState(initialRoom);
  const [roomOptions, setRoomOptions] = useState<RoomOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusReturn = useActionFocusReturn();
  const statusId = useId();

  const hasChanged = selectionValue(room) !== selectionValue(savedRoom);

  /*
    #2664. This used to load its choices from `/api/bookings/rooms` with no
    scope at all. That endpoint's no-`lodgeId` mode lists active rooms across
    EVERY lodge the caller is personally eligible to book, which broke the
    picker in two directions on a multi-lodge club: it offered lodge B's rooms
    while editing a lodge A booking (a choice `writeRequestedRoom()` then
    correctly refused under its lock, so the control simply did not work), and
    it filtered a Booking Officer's choices by that officer's OWN member booking
    eligibility even though their write is authorised through the booking/admin
    path.

    The booking-scoped read fixes both at once, and it does so without the
    client ever naming a lodge: the server resolves this booking, takes its
    `lodgeId` from the row, and answers with that lodge's active rooms — under
    the booking's own authority (owner, Full Admin, or `bookings:edit`
    officer). So this component asks a question it is entitled to ask ("what may
    THIS booking request?") rather than one it cannot scope ("what rooms exist?").
  */
  useEffect(() => {
    if (!canEdit) return;
    // The booking id is now part of the request, so a re-render onto a
    // different booking must not be able to keep the previous booking's list.
    let cancelled = false;
    fetch(
      `/api/bookings/${encodeURIComponent(bookingId)}/requested-room/options`,
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setRoomOptions(data?.rooms ?? []);
      })
      .catch(() => {
        if (!cancelled) setRoomOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canEdit, bookingId]);

  function handleSelect(value: string) {
    // Picking only STAGES. Nothing is written until the member presses Save.
    setRoom(stagedRoom(value, roomOptions, savedRoom));
    // A green "Saved" belongs to the room it was said about, so it is dropped
    // the moment the member moves the picker somewhere else. The refusal
    // message is deliberately NOT cleared here: the member is most likely
    // picking a different room *because* of it, and it should stay readable
    // until the next attempt actually replaces it.
    setSaved(false);
  }

  async function handleSave() {
    // A browser drops focus from a disabled control; hand it back when re-enabled (#5442).
    focusReturn.capture();
    setSaving(true);
    setSaved(false);
    setError(null);
    // Snapshot what is being sent: the member can move the picker again while
    // the request is in flight, and confirming the wrong room is exactly the
    // class of lie this rewrite exists to remove.
    const submitted = room;

    try {
      /*
        #2654. This used to `await fetch(...)` and then show "Saved"
        unconditionally. `fetch` rejects only on a network failure, so a 400
        from the room validator, a 403 from the ownership check or the 409 the
        writer raises when the lodge has already allocated the beds all
        resolved normally — and the member was told their room request was
        stored when the server had refused it. Check the response, and say what
        actually happened.
      */
      const response = submitted
        ? await fetch(basePath, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestedRoomId: submitted.id }),
          })
        : // "No preference" means CLEAR the stored request, which is the
          // routes' DELETE. In the staged model that can only ever be reached
          // when there IS something to clear: with nothing saved yet, staging
          // "No preference" is not a change, `hasChanged` is false, the Save
          // button stays disabled, and no empty DELETE is sent. So DELETE keeps
          // its plain meaning — remove the room this booking is holding —
          // rather than doubling as a no-op write on a booking that never had
          // a preference.
          await fetch(basePath, { method: "DELETE" });

      if (!response.ok) {
        // Prefer the server's own words. It is the one that knows whether this
        // was an unknown room, a room in another lodge, a cancelled booking, a
        // booking whose beds are already allocated, or a missing permission.
        let message = "Could not save your room request. Please try again.";
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
        // The staged pick stays on screen so the member can retry or correct
        // it; only `savedRoom` is authoritative, and it has not moved.
        setError(message);
        return;
      }

      // Take the stored room from the response rather than from the option we
      // sent, so an inactive room the server kept is shown as inactive.
      let confirmed = submitted;
      try {
        const body = (await response.json()) as RequestedRoomWriteResult | null;
        if (body && typeof body === "object" && "requestedRoom" in body) {
          confirmed = body.requestedRoom ?? null;
        }
      } catch {
        // Keep what was submitted; the write itself succeeded.
      }
      setRoom(confirmed);
      setSavedRoom(confirmed);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      /*
        #2668. This used to say "Your room request was not saved." `fetch`
        rejects both when the request never reached the server AND when the
        server processed it and the connection dropped before the response came
        back, and this side of the wire cannot tell which happened. Claiming the
        second one did not happen is the same lie as #2654's "Saved", with the
        sign flipped: the member is sent back to redo something that may already
        be stored. The staged pick stays put (a re-press sends the same PUT,
        which is idempotent), and `savedRoom` is left alone rather than being
        asserted as current — the message points at the page reload, which is
        the only value here that comes from the server.
      */
      setError(
        unverifiedWriteMessage(
          "your room request was saved",
          "Reload the page to see what the club's records hold before trying again.",
        ),
      );
    } finally {
      setSaving(false);
      focusReturn.release();
    }
  }

  // The chip is a statement about what the club's records HOLD, so it follows
  // `savedRoom` and never the staged pick: a member part-way through choosing a
  // replacement is still on a booking whose stored room has been retired.
  const inactiveChip =
    savedRoom && !savedRoom.active ? (
      <Badge
        variant="outline"
        className="border-warning-6 bg-warning-3 text-warning-11"
      >
        Room no longer active &mdash; treated as no preference
      </Badge>
    ) : null;

  if (!canEdit) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">
            {savedRoom ? savedRoom.name : "No preference"}
          </p>
          {inactiveChip}
        </div>
        {lockedNote ? (
          <p className="text-sm text-muted-foreground">{lockedNote}</p>
        ) : null}
      </div>
    );
  }

  // A stored inactive room is not in the active options list, so the picker
  // would otherwise have nothing to bind its own value to and would render
  // empty on a booking that does hold a room.
  const storedInactiveOption =
    savedRoom &&
    !savedRoom.active &&
    !roomOptions.some((option) => option.id === savedRoom.id)
      ? savedRoom
      : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-64">
          <Select
            value={selectionValue(room)}
            onValueChange={handleSelect}
            disabled={saving}
          >
            <SelectTrigger
              aria-label="Preferred room"
              aria-describedby={error ? statusId : undefined}
            >
              <SelectValue placeholder="No preference" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No preference</SelectItem>
              {storedInactiveOption && (
                <SelectItem value={storedInactiveOption.id}>
                  {storedInactiveOption.name} (inactive)
                </SelectItem>
              )}
              {roomOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name} ({option.bedCount}{" "}
                  {option.bedCount === 1 ? "bed" : "beds"})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/*
          #2143 dirty gate, in the same place the sibling puts it: on the Save
          button. Every one of these calls is an audited booking mutation, so a
          pristine editor — or one re-picking the room already stored — must not
          be able to fire one.
        */}
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || !hasChanged}
        >
          {saving ? "Saving..." : "Save preferred room"}
        </Button>
        {inactiveChip}
      </div>
      {/*
        Permanently mounted rather than rendered only when there is something to
        say: a polite live region injected already-populated is silently dropped
        by some screen-reader/browser pairings. `role="status"` rather than
        `role="alert"`: this is the outcome of the member's own press on the
        button beside it, so it is announced without stealing focus from the
        control. Matches the arrival-time editor's live region.
      */}
      <div id={statusId} role="status" className="min-h-4">
        {error && <span className="text-xs text-destructive">{error}</span>}
        {saved && <span className="text-xs text-success-11">Saved</span>}
      </div>
    </div>
  );
}
