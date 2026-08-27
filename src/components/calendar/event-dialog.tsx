"use client";

import { useEffect, useState } from "react";
import { Video, MapPin, Trash2, ExternalLink, Repeat } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClubTime } from "@/components/club-time-provider";
import type {
  CalendarEditScope,
  CalendarEventDTO,
} from "@/lib/calendar-events";
import {
  parseCalendarDate,
  parseInstant,
  type CalendarDate,
} from "@/lib/club-time";
import {
  formatEventDateLong,
  formatInstantTime,
  isoEndFromDateTimeInputs,
  isoFromDateTimeInputs,
  shouldIncludeRecurrence,
  toDateInputValue,
  toTimeInputValue,
} from "@/lib/calendar-client";
import {
  describeRecurrence,
  recurrenceOptionsForDate,
  recurrenceUnitLabel,
  type CalendarRecurrenceFrequency,
  type RecurrenceEndMode,
} from "@/lib/calendar-recurrence";

type RepeatValue = CalendarRecurrenceFrequency | "NONE";

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The event being edited/viewed, or null when creating. */
  event: CalendarEventDTO | null;
  /** Pre-selected calendar day when creating from a day cell. */
  initialDate: CalendarDate | null;
  /** Whether the current member may create NEW events. */
  canCreate: boolean;
  /**
   * Whether the current member may MANAGE the calendar (an active committee
   * member or a lodge admin). Gates the read-only "Join meeting" button:
   * ordinary members see event details but not the meeting link — only
   * committee members / admins can join. See src/lib/calendar-access.ts.
   */
  canManage: boolean;
  /**
   * Whether EXISTING events open editable (Save/Delete). When false, an existing
   * event shows the read-only detail view even for a manager — the member
   * calendar creates but does not edit; /admin/calendar keeps full editing.
   */
  canEditExisting: boolean;
  /** Called after a successful create/update/delete so the caller can refetch. */
  onSaved: () => void;
}

/** Fresh idempotency key for a create submit; empty string if unavailable. */
function freshIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "";
}

export function EventDialog({
  open,
  onOpenChange,
  event,
  initialDate,
  canCreate,
  canManage,
  canEditExisting,
  onSaved,
}: EventDialogProps) {
  /*
    CT-4 (#2870). Every date and time this dialog reads or WRITES is club civil
    time, from `ClubTimeProvider`. The write half is the one that mattered: the
    date and time inputs were composed with `new Date("2026-04-16T19:00")`, which
    JavaScript resolves in the HOST's zone — so an officer editing from overseas
    saved 7pm THEIR time onto a club event, and the "today" default for a new
    event was their day rather than the club's.
  */
  const club = useClubTime();
  const isEdit = event !== null;
  const isSeriesEvent = Boolean(event?.seriesId);

  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [location, setLocation] = useState("");
  const [details, setDetails] = useState("");
  const [isMeeting, setIsMeeting] = useState(false);
  /*
    #2264: the title and location examples used to be placeholders — grey text
    inside the box that reads as an event already named, and that disappears the
    moment you type. They are helper text under each field now.

    The title example is deliberately NOT "Committee meeting": converting turns
    the example into real, queryable page text, and the calendar dialog's own
    tests render a FIXTURE event titled "Committee meeting" and select it by
    text. A hint carrying the same words would make that query ambiguous, so the
    example names a different, equally ordinary club event.
  */
  const titleHint = useFieldHint();
  const locationHint = useFieldHint();

  // Recurrence
  const [repeat, setRepeat] = useState<RepeatValue>("NONE");
  const [interval, setIntervalValue] = useState(1);
  const [endMode, setEndMode] = useState<RecurrenceEndMode>("never");
  const [until, setUntil] = useState("");
  const [count, setCount] = useState(10);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Joining a meeting mints a fresh host token per click via the join endpoint;
  // no token is ever read off the event. `joining` disables the button during
  // the fetch; `joinError` surfaces failures inline.
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // A create request carries a fresh idempotency key so a double-submit / retry
  // cannot create duplicate events. Regenerated each time the create dialog
  // (re)opens; never sent on PATCH.
  const [idempotencyKey, setIdempotencyKey] = useState("");
  // When editing/deleting an occurrence of a series, ask which occurrences the
  // action applies to before committing.
  const [scopePrompt, setScopePrompt] = useState<"save" | "delete" | null>(null);
  // Second step of the series-delete chooser: once "All events" is picked, ask
  // whether individually-edited (detached) occurrences are kept or deleted too.
  const [deleteAllStep, setDeleteAllStep] = useState(false);
  // Confirm dialogs (replacing native window.confirm): deleting a single event,
  // and discarding unsaved edits when closing the form.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  // Serialised baseline of the form as last (re)opened, to detect dirty edits.
  const [baseline, setBaseline] = useState<string>("");

  // Reset the form whenever the dialog opens for a different event/day.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setJoining(false);
    setJoinError(null);
    setScopePrompt(null);
    setDeleteAllStep(false);
    setConfirmDelete(false);
    setDiscardPrompt(false);
    // A brand-new idempotency key per create-dialog opening; existing events
    // (PATCH) never send one.
    setIdempotencyKey(event ? "" : freshIdempotencyKey());

    const next = event
      ? {
          title: event.title,
          allDay: event.allDay,
          date: toDateInputValue(event.startsAt, club.zone),
          startTime: event.allDay
            ? ""
            : toTimeInputValue(event.startsAt, club.zone),
          endTime: event.endsAt
            ? toTimeInputValue(event.endsAt, club.zone)
            : "",
          location: event.location ?? "",
          details: event.details ?? "",
          isMeeting: event.isMeeting,
          repeat: (event.recurrence?.frequency ?? "NONE") as RepeatValue,
          interval: event.recurrence?.interval ?? 1,
          endMode: (event.recurrence?.endMode ?? "never") as RecurrenceEndMode,
          until: event.recurrence?.until
            ? toDateInputValue(event.recurrence.until, club.zone)
            : "",
          count: event.recurrence?.count ?? 10,
        }
      : {
          title: "",
          allDay: false,
          date: initialDate ?? club.today(),
          startTime: "09:00",
          endTime: "",
          location: "",
          details: "",
          isMeeting: false,
          repeat: "NONE" as RepeatValue,
          interval: 1,
          endMode: "never" as RecurrenceEndMode,
          until: "",
          count: 10,
        };

    setTitle(next.title);
    setAllDay(next.allDay);
    setDate(next.date);
    setStartTime(next.startTime);
    setEndTime(next.endTime);
    setLocation(next.location);
    setDetails(next.details);
    setIsMeeting(next.isMeeting);
    setRepeat(next.repeat);
    setIntervalValue(next.interval);
    setEndMode(next.endMode);
    setUntil(next.until);
    setCount(next.count);
    // Record the just-loaded values as the clean baseline for dirty detection.
    setBaseline(JSON.stringify(next));
    // `club` joins the dependencies because this effect now decodes the event's
    // date and time THROUGH the club's zone (CT-4, #2870): if an operator changes
    // the club timezone the form has to reload in the new one rather than keep
    // showing the old reading. `useClubTime` returns a `useMemo`d binding keyed on
    // the zone, so the identity is stable and this does not re-run per render.
  }, [open, event, initialDate, club]);

  // Join a meeting by minting a fresh host token on the server (never reading a
  // link off the event). A blank tab is opened SYNCHRONOUSLY on the click so the
  // browser attributes it to the user gesture — opening it after the await would
  // trip pop-up blockers. Its `opener` is severed for `noopener` semantics while
  // keeping the handle so we can point it at the join URL once minted.
  async function joinMeeting(eventId: string) {
    if (joining) return;
    setJoinError(null);
    const popup = window.open("", "_blank");
    if (popup) {
      try {
        // noopener semantics without losing the reference (passing "noopener"
        // to window.open would return null and defeat the pre-open).
        popup.opener = null;
      } catch {
        // Some engines make `opener` read-only; the join URL is same-origin
        // to a trusted meeting host, so this is best-effort hardening.
      }
    }
    setJoining(true);
    try {
      const res = await fetch(`/api/calendar/events/${eventId}/join`, {
        method: "POST",
      });
      if (!res.ok) {
        popup?.close();
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setJoinError(
          body?.error ?? "Could not open the meeting. Please try again.",
        );
        setJoining(false);
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        joinUrl?: string;
      } | null;
      if (!data?.joinUrl) {
        popup?.close();
        setJoinError("Could not open the meeting. Please try again.");
        setJoining(false);
        return;
      }
      if (popup) {
        popup.location.href = data.joinUrl;
      } else {
        // The pre-opened tab was blocked; we do NOT hijack the current tab for a
        // new-tab intent — ask the member to allow pop-ups instead.
        setJoinError(
          "Your browser blocked the meeting tab. Please allow pop-ups for this site and try again.",
        );
      }
      setJoining(false);
    } catch {
      popup?.close();
      setJoinError("Could not open the meeting. Please try again.");
      setJoining(false);
    }
  }

  // Read-only detail view: shown to ordinary members, and to managers on the
  // member calendar (where existing events are not editable). A meeting shows a
  // "Join meeting" button only to managers (committee members / admins) — an
  // ordinary member sees the event details but cannot join the meeting.
  if (event && !canEditExisting) {
    // The series summary describes a pattern anchored at a real instant, so it
    // is rendered only when that instant parses. There is nothing honest to say
    // about the shape of a series whose anchor is unreadable, and a placeholder
    // date would be a confident lie.
    const anchorInstant = parseInstant(event.startsAt);
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {event.isMeeting && (
                <Video aria-hidden className="h-4 w-4 text-primary" />
              )}
              {event.title}
            </DialogTitle>
            <DialogDescription>
              {formatEventDateLong(event, club.zone)}
              {!event.allDay && (
                <>
                  {" · "}
                  {formatInstantTime(event.startsAt, club.zone)}
                  {event.endsAt
                    ? ` – ${formatInstantTime(event.endsAt, club.zone)}`
                    : ""}
                </>
              )}
              {event.allDay && " · All day"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {event.recurrence && anchorInstant && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Repeat aria-hidden className="h-4 w-4" />
                {describeRecurrence(
                  {
                    frequency: event.recurrence.frequency,
                    interval: event.recurrence.interval,
                    endMode: event.recurrence.endMode,
                    until: event.recurrence.until,
                    count: event.recurrence.count,
                  },
                  anchorInstant,
                  club.zone,
                )}
              </p>
            )}
            {event.location && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <MapPin aria-hidden className="h-4 w-4" />
                {event.location}
              </p>
            )}
            {event.details && (
              <p className="whitespace-pre-wrap text-foreground">
                {event.details}
              </p>
            )}
            {!event.location && !event.details && !event.recurrence && (
              <p className="text-muted-foreground">No further details.</p>
            )}
            {joinError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {joinError}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {canManage && event.isMeeting ? (
              <Button
                type="button"
                onClick={() => joinMeeting(event.id)}
                disabled={joining}
              >
                <Video aria-hidden className="mr-2 h-4 w-4" />
                {joining ? "Opening…" : "Join meeting"}
              </Button>
            ) : (
              <span />
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Creating requires create permission. The New-event affordances are hidden
  // without it, so this is a defensive guard against an unreachable state.
  if (!event && !canCreate) return null;

  // Dirty detection: compare the live form to the baseline captured on open, so
  // closing a form with unsaved edits can prompt before discarding.
  const currentSnapshot = JSON.stringify({
    title,
    allDay,
    date,
    startTime,
    endTime,
    location,
    details,
    isMeeting,
    repeat,
    interval,
    endMode,
    until,
    count,
  });
  const isDirty = currentSnapshot !== baseline;

  // Guarded close: prompt before discarding unsaved edits; a clean form (or an
  // in-flight save) closes straight away.
  function requestClose() {
    if (saving) return;
    if (isDirty) {
      setDiscardPrompt(true);
      return;
    }
    onOpenChange(false);
  }

  /*
    Labels for the Repeat picker follow the currently-selected date, which is a
    CALENDAR DAY straight out of `<input type="date">` and needs no zone at all.
    It used to be re-parsed as a browser-local midnight instant and then read
    back through a club-pinned formatter, so an overseas admin could be offered
    "Weekly on Monday" for a Tuesday.
  */
  const anchorDate = parseCalendarDate(date) ?? club.today();
  const repeatOptions = recurrenceOptionsForDate(anchorDate);

  async function submit(scope: CalendarEditScope) {
    setError(null);

    if (!title.trim()) {
      setError("Please enter a title.");
      setScopePrompt(null);
      return;
    }
    if (!date) {
      setError("Please choose a date.");
      setScopePrompt(null);
      return;
    }

    const startsAt = isoFromDateTimeInputs(
      date,
      club.zone,
      allDay ? undefined : startTime || "00:00",
    );
    if (!startsAt) {
      setError("The date or start time is invalid.");
      setScopePrompt(null);
      return;
    }
    /*
      The END goes through its own resolver rather than a second
      `isoFromDateTimeInputs` call, because both ends of a time inside a
      spring-forward gap resolve to the same instant and the event would be
      stored zero-length. `isoEndFromDateTimeInputs` keeps the exact wall time
      wherever it survives the transition and falls back to the typed duration
      only in that degenerate case; its docblock carries the measurement and why
      duration-first would be worse.
    */
    const endsAt =
      !allDay && endTime
        ? isoEndFromDateTimeInputs(date, club.zone, startTime || "00:00", endTime)
        : null;

    // Send the recurrence rule EXCEPT when editing a single occurrence of an
    // existing series — that path changes only this occurrence, never the
    // pattern. On create, and when converting a standalone event to recurring,
    // and on a whole-series edit, the rule is included (see
    // shouldIncludeRecurrence).
    const recurrence =
      repeat === "NONE" ||
      !shouldIncludeRecurrence({ repeat, isEdit, isSeriesEvent, scope })
        ? null
        : {
            frequency: repeat,
            interval: Math.max(1, interval || 1),
            endMode,
            until:
              endMode === "until"
                ? isoFromDateTimeInputs(until, club.zone, "12:00")
                : null,
            count: endMode === "count" ? Math.max(1, count || 1) : null,
          };

    if (recurrence && endMode === "until" && !until) {
      setError("Please choose an end date for the recurrence.");
      setScopePrompt(null);
      return;
    }

    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        location: location.trim() || null,
        details: details.trim() || null,
        allDay,
        startsAt,
        endsAt,
        isMeeting,
        recurrence,
        scope,
        // Dedup key for create only — a retry/double-submit reuses it so the
        // server collapses duplicates. Never sent on PATCH.
        ...(isEdit || !idempotencyKey ? {} : { idempotencyKey }),
      };
      const res = await fetch(
        isEdit ? `/api/calendar/events/${event.id}` : "/api/calendar/events",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "Could not save the event. Please try again.");
        setSaving(false);
        setScopePrompt(null);
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch {
      setError("Could not save the event. Please try again.");
      setSaving(false);
      setScopePrompt(null);
    }
  }

  function handleSaveClick() {
    if (isSeriesEvent) {
      setScopePrompt("save");
      return;
    }
    submit("single");
  }

  async function performDelete(
    scope: CalendarEditScope,
    exceptions?: "keep" | "delete",
  ) {
    if (!event) return;
    setSaving(true);
    try {
      const params = new URLSearchParams({ scope });
      // `exceptions` is only meaningful for a whole-series delete; it decides
      // whether individually-edited (detached) occurrences survive as
      // standalone events ("keep") or are removed too ("delete").
      if (scope === "series") {
        params.set("exceptions", exceptions ?? "keep");
      }
      const res = await fetch(
        `/api/calendar/events/${event.id}?${params.toString()}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError("Could not delete the event. Please try again.");
        setSaving(false);
        setScopePrompt(null);
        setDeleteAllStep(false);
        setConfirmDelete(false);
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch {
      setError("Could not delete the event. Please try again.");
      setSaving(false);
      setScopePrompt(null);
      setDeleteAllStep(false);
      setConfirmDelete(false);
    }
  }

  function handleDeleteClick() {
    if (!event) return;
    if (isSeriesEvent) {
      setScopePrompt("delete");
      return;
    }
    // In-app confirm dialog (not native window.confirm), matching the series
    // scope chooser.
    setConfirmDelete(true);
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit event" : "New event"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Update the details for this club event."
                : "Add an event to the club calendar."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="event-title">Title</Label>
              <Input
                id="event-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                {...titleHint.fieldProps}
              />
              <FieldHint {...titleHint.hintProps}>
                Example: Winter working bee
              </FieldHint>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="event-all-day"
                checked={allDay}
                onCheckedChange={(checked) => setAllDay(checked)}
              />
              <Label htmlFor="event-all-day" className="cursor-pointer">
                All-day event
              </Label>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-1">
                <Label htmlFor="event-date">Date</Label>
                <Input
                  id="event-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              {!allDay && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="event-start">Start time</Label>
                    <Input
                      id="event-start"
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="event-end">End time</Label>
                    <Input
                      id="event-end"
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Recurrence */}
            <div className="space-y-1.5">
              <Label htmlFor="event-repeat" className="flex items-center gap-1.5">
                <Repeat aria-hidden className="h-4 w-4 text-muted-foreground" />
                Repeat
              </Label>
              <Select
                value={repeat}
                onValueChange={(v) => setRepeat(v as RepeatValue)}
              >
                <SelectTrigger id="event-repeat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repeatOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isEdit && isSeriesEvent && (
                <p className="text-xs text-muted-foreground">
                  Changing how this repeats applies when you choose “All events”
                  on save.
                </p>
              )}
            </div>

            {repeat !== "NONE" && (
              <div className="grid grid-cols-1 gap-4 rounded-md border border-border bg-muted p-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="event-interval">Repeat every</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="event-interval"
                      type="number"
                      min={1}
                      max={52}
                      value={interval}
                      onChange={(e) =>
                        setIntervalValue(Number(e.target.value) || 1)
                      }
                      className="w-20"
                    />
                    <span className="text-sm text-muted-foreground">
                      {recurrenceUnitLabel(repeat)}
                      {interval === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="event-end-mode">Ends</Label>
                  <Select
                    value={endMode}
                    onValueChange={(v) =>
                      setEndMode(v as RecurrenceEndMode)
                    }
                  >
                    <SelectTrigger id="event-end-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="never">Never</SelectItem>
                      <SelectItem value="until">On date</SelectItem>
                      <SelectItem value="count">After N times</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {endMode === "until" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="event-until">End date</Label>
                    <Input
                      id="event-until"
                      type="date"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                    />
                  </div>
                )}
                {endMode === "count" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="event-count">Occurrences</Label>
                    <Input
                      id="event-count"
                      type="number"
                      min={1}
                      max={366}
                      value={count}
                      onChange={(e) => setCount(Number(e.target.value) || 1)}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="event-location">Location (optional)</Label>
              <Input
                id="event-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                maxLength={200}
                {...locationHint.fieldProps}
              />
              <FieldHint {...locationHint.hintProps}>
                Example: Clubrooms / online
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="event-details">Details (optional)</Label>
              <Textarea
                id="event-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Agenda, notes, links…"
                rows={3}
                maxLength={5000}
              />
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border bg-muted p-3">
              <Checkbox
                id="event-meeting"
                checked={isMeeting}
                onCheckedChange={(checked) => setIsMeeting(checked)}
              />
              <Label htmlFor="event-meeting" className="cursor-pointer">
                <span className="flex items-center gap-1.5 font-medium">
                  <Video aria-hidden className="h-4 w-4 text-primary" />
                  Video meeting (MiroTalk)
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  Creates a meeting link committee members can join.
                </span>
              </Label>
            </div>

            {isEdit && event?.isMeeting && (
              <button
                type="button"
                onClick={() => joinMeeting(event.id)}
                disabled={joining}
                className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ExternalLink aria-hidden className="h-4 w-4" />
                {joining ? "Opening…" : "Open meeting link"}
              </button>
            )}

            {joinError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {joinError}
              </p>
            )}
            {error && (
              <p className="text-sm font-medium text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {isEdit ? (
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={handleDeleteClick}
                disabled={saving}
              >
                <Trash2 aria-hidden className="mr-2 h-4 w-4" />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={requestClose}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="button" onClick={handleSaveClick} disabled={saving}>
                {saving ? "Saving…" : isEdit ? "Save changes" : "Create event"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Scope chooser for recurring-event edits/deletes. A whole-series DELETE
          adds a second step for the fate of individually-edited occurrences. */}
      <Dialog
        open={scopePrompt !== null}
        onOpenChange={(v) => {
          if (!v) {
            setScopePrompt(null);
            setDeleteAllStep(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          {scopePrompt === "delete" && deleteAllStep ? (
            <>
              <DialogHeader>
                <DialogTitle>Delete the whole series</DialogTitle>
                <DialogDescription>
                  Some occurrences may have been edited on their own. Keep those
                  as standalone events, or delete everything in the series?
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => performDelete("series", "keep")}
                >
                  Keep individually-edited events
                </Button>
                <Button
                  variant="destructive"
                  disabled={saving}
                  onClick={() => performDelete("series", "delete")}
                >
                  Delete everything
                </Button>
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setDeleteAllStep(false)}
                >
                  Back
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {scopePrompt === "delete"
                    ? "Delete recurring event"
                    : "Edit recurring event"}
                </DialogTitle>
                <DialogDescription>
                  This event is part of a series. Apply to just this occurrence,
                  or the whole series?
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() =>
                    scopePrompt === "delete"
                      ? performDelete("single")
                      : submit("single")
                  }
                >
                  This event only
                </Button>
                <Button
                  variant={scopePrompt === "delete" ? "destructive" : "default"}
                  disabled={saving}
                  onClick={() =>
                    scopePrompt === "delete"
                      ? setDeleteAllStep(true)
                      : submit("series")
                  }
                >
                  All events in the series
                </Button>
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setScopePrompt(null);
                    setDeleteAllStep(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Single-event delete confirmation (in-app, replacing window.confirm). */}
      <Dialog
        open={confirmDelete}
        onOpenChange={(v) => {
          if (!v) setConfirmDelete(false);
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete event</DialogTitle>
            <DialogDescription>
              Delete “{event?.title}”? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={() => performDelete("single")}
            >
              {saving ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved-changes guard when closing the form. */}
      <Dialog
        open={discardPrompt}
        onOpenChange={(v) => {
          if (!v) setDiscardPrompt(false);
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              You have unsaved changes to this event. Discard them?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDiscardPrompt(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDiscardPrompt(false);
                onOpenChange(false);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
