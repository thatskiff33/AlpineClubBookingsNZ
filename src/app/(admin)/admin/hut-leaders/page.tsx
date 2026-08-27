"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BedDouble,
  Trash2,
  UserCheck,
  CalendarDays,
  KeyRound,
  Undo2,
} from "lucide-react";
import { useClubTime } from "@/components/club-time-provider";
import { calendarMonthOf } from "@/lib/club-time";
// ZONE-FREE UTC date-only arithmetic, kept on the adapter deliberately. Every
// value below is a `yyyy-MM-dd` lodge night with no timezone in it, and these
// three helpers only add days and re-encode — they read no clock and no zone,
// so CT-4 (#2870) has nothing to correct in them. They stay because
// `calculateOverlapDays` (in `src/lib`, a different lane's file) takes `Date`
// arguments; converting this screen to `CalendarDate` end to end means changing
// that signature, which is reported on #2870 rather than half-done here. The
// CLOCK reads are what CT-4 moved: they now come from the club's persisted zone.
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { calculateOverlapDays } from "@/lib/hut-leader-overlap";
import { LodgeSelect, useLodgeOptions } from "@/components/lodge-select";
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status";
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import type {
  CalendarOverlayValue,
  CalendarTone,
} from "@/components/admin/occupancy-calendar";
import type { PickedMember } from "@/components/admin/member-picker";
import {
  AssignmentForm,
  type AssignmentSummary,
  type AssignmentTarget,
  type EligibleMember,
} from "./_components/assignment-form";
import { CustodianBedPicker } from "./_components/custodian-bed-picker";

interface HutLeaderAssignment {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  lodgeId: string | null;
  lodgeName: string | null;
  // #2286: the bed this assignment holds, or null for a role-only assignment.
  bedId: string | null;
  bedName: string | null;
  bedRoomName: string | null;
}

interface UnassignedDate {
  date: string;
  // One row per uncovered lodge-night since #2917; here always the selected
  // lodge, so these are for keying, not display. Optional: an older cached
  // response must not break the panel.
  lodgeId?: string | null;
  lodgeName?: string | null;
  bookingCount: number;
  guestCount: number;
}

// Compute the last inclusive day of a "YYYY-MM" month.
function monthBounds(monthKey: string) {
  const start = parseDateOnly(`${monthKey}-01`);
  const [year, month] = monthKey.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endExclusive = parseDateOnly(
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
  );
  return { start, end: addDaysDateOnly(endExclusive, -1) };
}

// Short calendar-badge label for a covered night: the surname, or initials when
// the surname is long, so a custodian's multi-month block reads as a band.
function shortLeaderLabel(memberName: string) {
  const parts = memberName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return memberName;
  const surname = parts[parts.length - 1];
  if (surname.length > 10) {
    return parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
  }
  return surname;
}

export default function HutLeadersPage() {
  const { hutLeaderLabel } = useClubIdentity();
  // Hut-leader assignments are lodge config; the write routes enforce
  // lodge:edit, so a lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const [assignments, setAssignments] = useState<HutLeaderAssignment[]>([]);
  const [eligibleMembers, setEligibleMembers] = useState<EligibleMember[]>([]);
  const [unassignedDates, setUnassignedDates] = useState<UnassignedDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [resettingPinId, setResettingPinId] = useState<string | null>(null);
  const [pinMessage, setPinMessage] = useState<{
    memberName: string;
    pin: string;
    emailSent: boolean;
  } | null>(null);

  const [selection, setSelection] = useState({ startDate: "", endDate: "" });
  const [target, setTarget] = useState<AssignmentTarget | null>(null);
  // #2286: the optional custodian bed hold. null = "No bed — role only", the
  // default and the pre-#2286 behaviour.
  const [selectedBedId, setSelectedBedId] = useState<string | null>(null);
  // Set when the server answered CUSTODIAN_OVER_CAPACITY_CONFIRM_REQUIRED: the
  // hold is legitimate but tips the lodge past its ceiling on these nights, so
  // the admin re-confirms rather than discovering it later (#1668 precedent).
  //
  // `confirm` is the action to re-run with the override — a NEW assignment from
  // the form, or a bed CHANGE on an existing row (both PUT and POST can answer
  // this), so the card asks the question once for either.
  //
  // `bookings` (#2286 review M5) are live bookings over those nights that the
  // per-night figures do NOT count (the #177 override-settle blind spot):
  // informational, but the admin is accepting an over-capacity night, so they
  // must know the true total could be higher.
  const [overCapacity, setOverCapacity] = useState<{
    nights: Array<{ date: string; occupiedBeds: number; capacity: number }>;
    bookings: Array<{
      id: string;
      memberName: string;
      checkIn: string;
      checkOut: string;
      guestCount: number;
      status: string;
    }>;
    confirm: () => void;
  } | null>(null);
  // Which assignment's bed is being changed inline in the table (#2286 review
  // M7). One at a time: the picker re-reads availability for that row's dates.
  const [bedEditAssignmentId, setBedEditAssignmentId] = useState<string | null>(
    null,
  );
  const [savingBedForId, setSavingBedForId] = useState<string | null>(null);
  // Server-side privacy note: a minor custodian is never named on the lodge TV.
  const [minorCustodianNote, setMinorCustodianNote] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<{ message: string; memberId: string | null } | null>(null);
  // Lodge context for new assignments; LodgeSelect renders nothing (and
  // reports the sole lodge) while fewer than two lodges exist (ADR-002).
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    reload: reloadLodgeOptions,
  } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(null);
  const showLodgeColumn = lodges.length > 1;
  /*
    #2701: a FAILED lodge list is not "a club with no lodges", but until now the
    two were the same empty array here. LodgeSelect renders nothing below two
    options (ADR-002) and normalises the selection to null, and an omitted
    lodgeId is resolved server-side to the club's DEFAULT lodge.

    On this page that lands in two places, and both are writes: the POST files
    the assignment (and the club's kiosk PIN with it) against the default lodge,
    and the bed picker offers the DEFAULT lodge's beds — so "hold a bed" would
    take a real bed out of the bookable pool at a property nobody chose. Neither
    is offered while the list has failed.

    The assignments table and coverage calendar are club-wide reads, but they
    stay stopped too: no downstream state is trustworthy until the selector's
    lodge universe has settled.
  */
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: lodgeId,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
  });
  const scopedLodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null;
  const lodgeScopeReady = scopedLodgeId !== null;
  const activeLodgeIdRef = useRef<string | null>(scopedLodgeId);
  useEffect(() => {
    activeLodgeIdRef.current = scopedLodgeId;
  }, [scopedLodgeId]);

  // The over-capacity question appears below the form after a declined save, so
  // it takes focus when it arrives (#2286 review M6) — otherwise a keyboard or
  // screen-reader admin has no idea a second step is waiting further down.
  const overCapacityCardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (overCapacity) overCapacityCardRef.current?.focus();
  }, [overCapacity]);

  const clubTime = useClubTime();
  const [visibleMonthKey, setVisibleMonthKey] = useState(() =>
    calendarMonthOf(clubTime.today()),
  );
  // Windowed "needs a leader" dates and occupied nights, keyed by visible month.
  const [redDatesByMonth, setRedDatesByMonth] = useState<Record<string, string[]>>({});
  const [guestNightsByMonth, setGuestNightsByMonth] = useState<
    Record<string, Set<string>>
  >({});

  const fetchAssignments = useCallback(async () => {
    if (!lodgeScopeReady) {
      setAssignments([]);
      setLoading(false);
      return;
    }
    const requestedLodgeId = scopedLodgeId;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/hut-leaders?lodgeId=${encodeURIComponent(requestedLodgeId)}`);
      if (res.ok) {
        const data = await res.json();
        if (activeLodgeIdRef.current === requestedLodgeId) {
          setAssignments(Array.isArray(data?.assignments) ? data.assignments : []);
        }
      }
    } finally {
      if (activeLodgeIdRef.current === requestedLodgeId) setLoading(false);
    }
  }, [lodgeScopeReady, scopedLodgeId]);

  // Default lookahead window — feeds the amber "Upcoming Dates Without…" card.
  // Intentionally the un-windowed variant so that card is byte-for-byte unchanged.
  const fetchUnassignedDates = useCallback(async () => {
    if (!lodgeScopeReady) {
      setUnassignedDates([]);
      return;
    }
    const requestedLodgeId = scopedLodgeId;
    try {
      const res = await fetch(`/api/admin/hut-leaders/unassigned-dates?lodgeId=${encodeURIComponent(requestedLodgeId)}`);
      if (res.ok) {
        const data = await res.json();
        if (activeLodgeIdRef.current === requestedLodgeId) {
          setUnassignedDates(
            Array.isArray(data?.unassignedDates) ? data.unassignedDates : [],
          );
        }
      }
    } catch {
      // ignore
    }
  }, [lodgeScopeReady, scopedLodgeId]);

  // Per-month overlay data: red (needs-leader) nights via the windowed variant,
  // and occupied nights (for violet fill-vs-ring emphasis) via the occupancy API.
  const refreshOverlay = useCallback(async (monthKey: string) => {
    if (!lodgeScopeReady) return;
    const requestedLodgeId = scopedLodgeId;
    try {
      const res = await fetch(
        `/api/admin/hut-leaders/unassigned-dates?month=${monthKey}&lodgeId=${encodeURIComponent(requestedLodgeId)}`,
      );
      if (res.ok) {
        const data: { unassignedDates?: UnassignedDate[] } = await res.json();
        // Map EAGERLY, here, inside the try — never inside the state updater.
        // React invokes an updater closure later, during render, where this
        // function's own `catch` can no longer see it: an unexpected body then
        // escaped as an unhandled error and took the page down instead of
        // degrading a "non-essential overlay". Tolerate the shape as well, for
        // the same reason the picker does (#2286 review).
        const dates = Array.isArray(data?.unassignedDates)
          ? data.unassignedDates.map((d) => d.date)
          : [];
        if (activeLodgeIdRef.current === requestedLodgeId) {
          setRedDatesByMonth((prev) => ({ ...prev, [monthKey]: dates }));
        }
      }
    } catch {
      // non-essential overlay
    }
    try {
      const res = await fetch(`/api/admin/occupancy?month=${monthKey}&lodgeId=${encodeURIComponent(requestedLodgeId)}`);
      if (res.ok) {
        const data: { nights?: Array<{ date: string; guestCount: number }> } =
          await res.json();
        const guestNights = new Set(
          (data.nights ?? [])
            .filter((n) => n.guestCount > 0)
            .map((n) => n.date),
        );
        if (activeLodgeIdRef.current === requestedLodgeId) {
          setGuestNightsByMonth((prev) => ({ ...prev, [monthKey]: guestNights }));
        }
      }
    } catch {
      // non-essential overlay
    }
  }, [lodgeScopeReady, scopedLodgeId]);

  const handleVisibleMonthChange = useCallback(
    (monthKey: string) => {
      setVisibleMonthKey(monthKey);
      fetchAssignments();
      refreshOverlay(monthKey);
    },
    [fetchAssignments, refreshOverlay],
  );

  useEffect(() => {
    // State is labelled by the selected lodge but keyed only by month/member in
    // memory. Clear it synchronously with a scope change; response fences below
    // prevent a late Lodge A request from repopulating the Lodge B workspace.
    setAssignments([]);
    setUnassignedDates([]);
    setEligibleMembers([]);
    setRedDatesByMonth({});
    setGuestNightsByMonth({});
    setSelection({ startDate: "", endDate: "" });
    setTarget(null);
    setSelectedBedId(null);
    setOverCapacity(null);
    setError(null);
    setMinorCustodianNote(null);
    setPinMessage(null);
    setCreating(false);
    setSavingBedForId(null);
    setResettingPinId(null);
  }, [scopedLodgeId]);

  useEffect(() => {
    fetchAssignments();
    fetchUnassignedDates();
  }, [fetchAssignments, fetchUnassignedDates]);

  // Fetch eligible members whenever the picked range changes.
  useEffect(() => {
    if (
      !lodgeScopeReady ||
      !selection.startDate ||
      !selection.endDate ||
      selection.startDate > selection.endDate
    ) {
      setEligibleMembers([]);
      return;
    }

    let cancelled = false;
    setLoadingMembers(true);

    fetch(
      `/api/admin/hut-leaders/eligible-members?startDate=${selection.startDate}&endDate=${selection.endDate}&lodgeId=${encodeURIComponent(scopedLodgeId)}`,
    )
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (!cancelled) {
          setEligibleMembers(Array.isArray(data?.members) ? data.members : []);
        }
      })
      .catch(() => {
        if (!cancelled) setEligibleMembers([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selection.startDate, selection.endDate, lodgeScopeReady, scopedLodgeId]);

  // Step 1 — picking new nights always drops any selected target.
  function handlePickNights(next: { startDate: string; endDate: string }) {
    if (!lodgeScopeReady) return;
    setSelection(next);
    setTarget(null);
  }

  // Step 2a — a suggestion adopts the member's conflict-free suggested range.
  function handleSelectEligible(member: EligibleMember) {
    if (!lodgeScopeReady) return;
    setSelection({
      startDate: member.suggestedStartDate,
      endDate: member.suggestedEndDate,
    });
    setTarget({
      memberId: member.id,
      memberName: `${member.firstName} ${member.lastName}`,
    });
    setError(null);
  }

  // Step 2b — any member (including a no-booking custodian) keeps the picked range.
  function handleSelectAnyMember(member: PickedMember) {
    if (!lodgeScopeReady) return;
    setTarget({
      memberId: member.id,
      memberName: `${member.firstName} ${member.lastName}`,
    });
    setError(null);
  }

  async function handleConfirm(confirmOverCapacity = false) {
    if (!target || !selection.startDate || !selection.endDate) return;
    // #2701: the Confirm button is already disabled in this state; this is the
    // defence behind it, because a pending over-capacity card re-invokes this
    // through a captured closure rather than through the button.
    if (!scopedLodgeId) return;
    const requestedLodgeId = scopedLodgeId;
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/hut-leaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: target.memberId,
          startDate: selection.startDate,
          endDate: selection.endDate,
          lodgeId: requestedLodgeId,
          // #2286: omitted entirely for a role-only assignment, so the request
          // is byte-for-byte what it was before this feature.
          ...(selectedBedId ? { bedId: selectedBedId } : {}),
          ...(confirmOverCapacity ? { confirmOverCapacity: true } : {}),
        }),
      });
      if (activeLodgeIdRef.current !== requestedLodgeId) return;
      if (!res.ok) {
        if (res.status === 403) {
          setError({
            message: ADMIN_FORBIDDEN_SAVE_REASON,
            memberId: target.memberId,
          });
          return;
        }
        const data = await res.json();
        // #2286 warn-and-confirm: not a failure, a question. Keep the form
        // exactly as it is and show the nights so the admin decides.
        if (data.code === "CUSTODIAN_OVER_CAPACITY_CONFIRM_REQUIRED") {
          setOverCapacity({
            nights: data.nightDetails ?? [],
            bookings: Array.isArray(data.nonHoldingBookings)
              ? data.nonHoldingBookings
              : [],
            confirm: () => void handleConfirm(true),
          });
          return;
        }
        setError({
          message: data.error || "Failed to create",
          memberId: target.memberId,
        });
        return;
      }
      // The minor-custodian privacy note is advisory: a body that cannot be
      // parsed must not turn a successful assignment into an error.
      const created = await res.json().catch(() => null);
      if (activeLodgeIdRef.current !== requestedLodgeId) return;
      setMinorCustodianNote(created?.minorCustodianWarning ?? null);
      setSelection({ startDate: "", endDate: "" });
      setTarget(null);
      setSelectedBedId(null);
      setOverCapacity(null);
      fetchAssignments();
      fetchUnassignedDates();
      refreshOverlay(visibleMonthKey);
    } finally {
      if (activeLodgeIdRef.current === requestedLodgeId) setCreating(false);
    }
  }

  /**
   * Set, change or RELEASE the bed an existing assignment holds (#2286 review
   * M7) — `PUT /api/admin/hut-leaders/[id]` with the route's three-state
   * `bedId`: a string sets it, explicit `null` clears it.
   *
   * This is what makes every "clear the bed first" refusal elsewhere in the app
   * actionable: before it, a hold could only be removed by DELETING the whole
   * assignment, which also destroyed the coverage record and the kiosk PIN — and
   * a hold on a cron-created assignment had no admin control at all.
   */
  async function handleSetBed(
    assignment: HutLeaderAssignment,
    bedId: string | null,
    confirmOverCapacity = false,
  ) {
    if (!scopedLodgeId) return;
    const requestedLodgeId = scopedLodgeId;
    setError(null);
    setSavingBedForId(assignment.id);
    try {
      const res = await fetch(`/api/admin/hut-leaders/${assignment.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // `bedId` is sent EXPLICITLY, including as null: omitting it means
        // "leave the bed alone" to the route, which is the one thing a release
        // must not do.
        body: JSON.stringify({
          bedId,
          ...(confirmOverCapacity ? { confirmOverCapacity: true } : {}),
        }),
      });
      if (activeLodgeIdRef.current !== requestedLodgeId) return;
      if (!res.ok) {
        if (res.status === 403) {
          setError({ message: ADMIN_FORBIDDEN_SAVE_REASON, memberId: null });
          return;
        }
        const data = await res.json().catch(() => null);
        if (data?.code === "CUSTODIAN_OVER_CAPACITY_CONFIRM_REQUIRED") {
          setOverCapacity({
            nights: data.nightDetails ?? [],
            bookings: Array.isArray(data.nonHoldingBookings)
              ? data.nonHoldingBookings
              : [],
            confirm: () => void handleSetBed(assignment, bedId, true),
          });
          return;
        }
        setError({
          message: data?.error || "Failed to update the bed",
          memberId: null,
        });
        return;
      }
      setBedEditAssignmentId(null);
      setOverCapacity(null);
      fetchAssignments();
      refreshOverlay(visibleMonthKey);
    } finally {
      if (activeLodgeIdRef.current === requestedLodgeId) {
        setSavingBedForId(null);
      }
    }
  }

  async function handleDelete(id: string) {
    if (!scopedLodgeId) return;
    const requestedLodgeId = scopedLodgeId;
    if (!confirm(`Delete this ${hutLeaderLabel.toLowerCase()} assignment?`)) return;
    const res = await fetch(`/api/admin/hut-leaders/${id}`, { method: "DELETE" });
    if (activeLodgeIdRef.current !== requestedLodgeId) return;
    if (res.ok) {
      fetchAssignments();
      fetchUnassignedDates();
      refreshOverlay(visibleMonthKey);
    } else if (res.status === 403) {
      setError({ message: ADMIN_FORBIDDEN_SAVE_REASON, memberId: null });
    }
  }

  async function handleResetPin(assignment: HutLeaderAssignment) {
    if (!scopedLodgeId) return;
    const requestedLodgeId = scopedLodgeId;
    if (
      !confirm(
        `Generate a new kiosk PIN for ${assignment.memberName}? Their existing PIN will stop working.`,
      )
    ) {
      return;
    }

    setError(null);
    setPinMessage(null);
    setResettingPinId(assignment.id);
    try {
      const res = await fetch(`/api/admin/hut-leaders/${assignment.id}/pin`, {
        method: "POST",
      });
      if (activeLodgeIdRef.current !== requestedLodgeId) return;
      if (!res.ok && res.status === 403) {
        setError({ message: ADMIN_FORBIDDEN_SAVE_REASON, memberId: null });
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error || "Failed to reset PIN", memberId: null });
        return;
      }

      setPinMessage({
        memberName: assignment.memberName,
        pin: data.pin,
        emailSent: Boolean(data.emailSent),
      });
      fetchAssignments();
    } finally {
      if (activeLodgeIdRef.current === requestedLodgeId) {
        setResettingPinId(null);
      }
    }
  }

  function handleAssignForDate(date: string) {
    if (!lodgeScopeReady) return;
    setSelection({ startDate: date, endDate: date });
    setTarget(null);
  }

  // ---- Calendar overlay (three layers: red needs-leader, violet covered) ----
  const overlayByDate = useMemo<Record<string, CalendarOverlayValue>>(() => {
    const overlay: Record<string, CalendarOverlayValue> = {};
    const { start: monthStart, end: monthEnd } = monthBounds(visibleMonthKey);
    const guestNights = guestNightsByMonth[visibleMonthKey];

    // Red first (violet overwrites on any collision so "covered" always wins).
    for (const date of redDatesByMonth[visibleMonthKey] ?? []) {
      overlay[date] = { tone: "red", label: "Needs leader" };
    }

    // Violet — covered nights, combining surnames on a shared handover day.
    const surnamesByDate = new Map<string, Set<string>>();
    for (const a of assignments) {
      const aStart = parseDateOnly(a.startDate);
      const aEnd = parseDateOnly(a.endDate);
      const from = aStart.getTime() > monthStart.getTime() ? aStart : monthStart;
      const to = aEnd.getTime() < monthEnd.getTime() ? aEnd : monthEnd;
      const surname = shortLeaderLabel(a.memberName);
      for (
        let day = from;
        day.getTime() <= to.getTime();
        day = addDaysDateOnly(day, 1)
      ) {
        const ds = formatDateOnly(day);
        const set = surnamesByDate.get(ds) ?? new Set<string>();
        set.add(surname);
        surnamesByDate.set(ds, set);
      }
    }
    for (const [ds, surnames] of surnamesByDate) {
      overlay[ds] = {
        tone: "violet",
        label: [...surnames].join(" / "),
        emphasis: guestNights?.has(ds) ? "fill" : "ring",
      };
    }

    return overlay;
  }, [assignments, redDatesByMonth, guestNightsByMonth, visibleMonthKey]);

  const overlayLegend = useMemo<Array<{ tone: CalendarTone; label: string }>>(
    () => [
      { tone: "violet", label: `Has a ${hutLeaderLabel}` },
      { tone: "red", label: `Needs a ${hutLeaderLabel}` },
    ],
    [hutLeaderLabel],
  );

  // ---- Step-3 summary + client-side conflict preview -----------------------
  const summary = useMemo<AssignmentSummary | null>(() => {
    if (!target || !selection.startDate || !selection.endDate) return null;
    if (selection.startDate > selection.endDate) return null;

    const start = parseDateOnly(selection.startDate);
    const end = parseDateOnly(selection.endDate);
    const nights =
      Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

    // Fills: how many currently-red nights this range would cover. Uses every
    // month of red data we have loaded so a cross-month range still counts.
    const redSet = new Set(Object.values(redDatesByMonth).flat());
    let fills = 0;
    for (
      let day = start;
      day.getTime() <= end.getTime();
      day = addDaysDateOnly(day, 1)
    ) {
      if (redSet.has(formatDateOnly(day))) fills++;
    }

    // Conflicts: same calculateOverlapDays the POST route uses (no logic drift).
    // >1 day overlap with any existing assignment blocks the assignment.
    const conflicts = assignments
      .map((a) => ({
        name: a.memberName,
        startDate: a.startDate,
        endDate: a.endDate,
        days: calculateOverlapDays(
          start,
          end,
          parseDateOnly(a.startDate),
          parseDateOnly(a.endDate),
        ),
      }))
      .filter((c) => c.days > 1);

    return {
      name: target.memberName,
      startDate: selection.startDate,
      endDate: selection.endDate,
      nights,
      fills,
      conflicts,
    };
  }, [target, selection.startDate, selection.endDate, assignments, redDatesByMonth]);

  // The club's day decides whether a coverage block reads as active or past —
  // not the build's `NEXT_PUBLIC_TZ`, which is fixed at compile time rather than
  // read from the club's persisted setting, and which falls back to
  // `Pacific/Auckland` for every viewer on a deployment that sets only `TZ`.
  // Either way a block could read finished a day early (CT-4, #2870;
  // INV-CONFIG-002).
  const today: string = clubTime.today();

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
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view {hutLeaderLabel.toLowerCase()} assignments but
      cannot change them. Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <AdminPageHeader
        title={`${hutLeaderLabel} Assignments`}
        description={`Paint the calendar: assign a member as ${hutLeaderLabel.toLowerCase()} for the nights that need cover.`}
      />

      <div className="max-w-xs">
        <LodgeSelect
          lodges={lodges}
          value={lodgeId}
          onChange={setLodgeId}
          loading={lodgesLoading}
          deferDefaultSelection={lodgeOptionsFailed || lodgeOptionsForbidden}
        />
      </div>

      {/* #2701: say the lodge list failed, above the form whose lodge picker it
          silently removed. */}
      <LodgeScopeStatusNotice
        scope={lodgeScope}
        onRetry={reloadLodgeOptions}
        what={`${hutLeaderLabel.toLowerCase()} assignments for a particular lodge`}
      />

      {lodgeScopeReady ? (
        <>
      {/*
        Page-level (more prominent than a form-scoped banner): reset-PIN errors
        originate in the assignments table, so a form banner would never show
        them. This guarantees every error — create, reset-PIN — is visible
        without scrolling.
      */}
      {lodgeScopeReady && error && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-danger/20 bg-danger-muted px-4 py-3 text-sm text-danger"
        >
          {error.message}
        </div>
      )}

      {lodgeScopeReady && unassignedDates.length > 0 && (
        <Card className="border-warning/20 bg-warning-muted">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-warning">
              <CalendarDays className="h-5 w-5" />
              Upcoming Dates Without {hutLeaderLabel} ({unassignedDates.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {unassignedDates.map((d) => (
                <div
                  key={`${d.date}|${d.lodgeId ?? ""}`}
                  className="flex items-center justify-between rounded-lg border border-warning/20 bg-card px-3 py-2 text-card-foreground"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">{d.date}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.bookingCount} booking{d.bookingCount !== 1 ? "s" : ""},{" "}
                      {d.guestCount} guest{d.guestCount !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleAssignForDate(d.date)}
                    className="text-xs"
                  >
                    Assign
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {lodgeScopeReady ? <AssignmentForm
        hutLeaderLabel={hutLeaderLabel}
        lodgeId={scopedLodgeId}
        selectedStartDate={selection.startDate}
        selectedEndDate={selection.endDate}
        onPickNights={handlePickNights}
        onVisibleMonthChange={handleVisibleMonthChange}
        overlayByDate={overlayByDate}
        overlayLegend={overlayLegend}
        eligibleMembers={eligibleMembers}
        loadingMembers={loadingMembers}
        target={target}
        onSelectEligible={handleSelectEligible}
        onSelectAnyMember={handleSelectAnyMember}
        onClearTarget={() => setTarget(null)}
        summary={summary}
        creating={creating}
        error={error}
        onConfirm={() => void handleConfirm()}
        /*
          #2701: this prop is the form's "may the Confirm write proceed" gate
          (its only other use, the form's own banner, is suppressed just below),
          so an unresolved lodge closes it exactly as a lodge:view role does.
          The table's own row controls below keep the plain `canEdit` — deleting
          an assignment or resetting a kiosk PIN needs no lodge.
        */
        canEdit={canEdit}
        // #2160: the page banner above already states view-only access for this
        // whole surface, including the assignments table below, so the form must
        // not repeat it — both are unconditional, so every view-only lodge admin
        // would otherwise meet the same sentence twice in two live regions.
        renderViewOnlyBanner={false}
        lodgeSelector={null}
        /*
          #2701: not rendered at all while the lodge is unresolved, because the
          picker's `available-beds` lookup is the lodge-keyed fetch on this page
          — with no lodgeId the route answers with the DEFAULT lodge's beds, and
          a picker offering another property's beds is worse than none.
        */
        bedPicker={
          (
            <CustodianBedPicker
              lodgeId={scopedLodgeId}
              startDate={selection.startDate}
              endDate={selection.endDate}
              value={selectedBedId}
              onChange={(bedId) => {
                setSelectedBedId(bedId);
                // A changed bed invalidates any pending over-capacity answer.
                setOverCapacity(null);
              }}
              canEdit={canEdit}
            />
          )
        }
      /> : null}

      {overCapacity && overCapacity.nights.length > 0 && (
        /*
          #2160/#1549 convention on this page: anything the admin MUST read
          before acting is announced, not merely rendered. This card is a
          question — it appears after a save the server declined to complete —
          so it is a `role="alert"` live region AND takes focus, otherwise a
          screen-reader or keyboard admin presses Confirm, hears nothing, and
          has no idea a second step appeared further down the page.
        */
        <Card
          className="border-warning/20 bg-warning-muted"
          role="alert"
          aria-live="assertive"
          tabIndex={-1}
          ref={overCapacityCardRef}
          data-testid="custodian-over-capacity-confirm"
        >
          <CardContent className="space-y-3 p-4">
            <p className="text-sm font-medium text-warning">
              Holding that bed puts the lodge over capacity
            </p>
            <ul className="space-y-1 text-sm text-foreground">
              {overCapacity.nights.map((night) => (
                <li key={night.date}>
                  {night.date}: {night.occupiedBeds} people for {night.capacity}{" "}
                  bed{night.capacity === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
            {overCapacity.bookings.length > 0 && (
              /*
                #2286 review M5 (the #177 blind spot). The figures above count
                only capacity-HOLDING bookings, so an overridden booking that
                will settle onto these very nights adds nothing to them. Naming
                it here is the difference between an honest confirmation and one
                that understates what the admin is accepting.
              */
              <div className="space-y-1" data-testid="custodian-over-capacity-bookings">
                <p className="text-sm font-medium text-warning">
                  Not counted above — these live bookings can still take those
                  nights:
                </p>
                <ul className="space-y-1 text-sm text-foreground">
                  {overCapacity.bookings.map((booking) => (
                    <li key={booking.id}>
                      {booking.memberName} · {booking.checkIn} → {booking.checkOut}{" "}
                      · {booking.guestCount} guest
                      {booking.guestCount === 1 ? "" : "s"} · {booking.status}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              The {hutLeaderLabel.toLowerCase()} genuinely sleeps in the lodge,
              so this can be correct — confirm only if you know those nights
              work.
            </p>
            <div className="flex flex-wrap gap-2">
              {/*
                Defence in depth: the write route enforces lodge:edit, and this
                card is only reachable from a save a view-only admin cannot
                start — but every write control on this page goes through
                ViewOnlyActionButton, and an exception is the thing a later
                refactor copies.
              */}
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                type="button"
                onClick={overCapacity.confirm}
                disabled={creating || savingBedForId !== null}
              >
                {creating || savingBedForId ? "Saving..." : "Confirm anyway"}
              </ViewOnlyActionButton>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOverCapacity(null)}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {minorCustodianNote && (
        <Card className="border-info/20 bg-info-muted">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <p className="text-sm text-info">{minorCustodianNote}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMinorCustodianNote(null)}
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {pinMessage && (
        <Card className="border-info/20 bg-info-muted">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-info">
                New kiosk PIN for {pinMessage.memberName}
              </p>
              <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.25em] text-foreground">
                {pinMessage.pin}
              </p>
              <p className="mt-1 text-xs text-info">
                This PIN is shown once.{" "}
                {pinMessage.emailSent
                  ? `It has also been emailed to the ${hutLeaderLabel.toLowerCase()}.`
                  : "Email delivery failed, so provide it directly."}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => setPinMessage(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground">
          Loading...
        </div>
      ) : assignments.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground">
          No {hutLeaderLabel.toLowerCase()} assignments yet.
        </div>
      ) : (
        <AdminDataTable>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              {showLodgeColumn && <TableHead>Lodge</TableHead>}
              <TableHead>Start</TableHead>
              <TableHead>End</TableHead>
              {/* #2286: which bed (if any) this assignment holds. */}
              <TableHead>Bed held</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignments.map((a) => {
              const isActive = a.startDate <= today && a.endDate >= today;
              const isPast = a.endDate < today;
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <UserCheck className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{a.memberName}</div>
                        <div className="text-xs text-muted-foreground">{a.memberEmail}</div>
                      </div>
                    </div>
                  </TableCell>
                  {showLodgeColumn && <TableCell>{a.lodgeName ?? "—"}</TableCell>}
                  <TableCell>{a.startDate}</TableCell>
                  <TableCell>{a.endDate}</TableCell>
                  <TableCell>
                    {a.bedName ? (
                      <span className="text-sm">
                        {a.bedRoomName ? `${a.bedRoomName} · ` : ""}
                        {a.bedName}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Role only
                      </span>
                    )}
                    {/*
                      #2286 review M7: the bed is editable in place, including on
                      an assignment the auto-assign cron created — which
                      previously had no bed control at all. Selecting a bed PUTs
                      straight away; "No bed — role only" releases it.
                    */}
                    {bedEditAssignmentId === a.id ? (
                      <div className="mt-2" data-testid={`bed-picker-${a.id}`}>
                        <CustodianBedPicker
                          lodgeId={a.lodgeId}
                          startDate={a.startDate}
                          endDate={a.endDate}
                          assignmentId={a.id}
                          value={a.bedId}
                          onChange={(bedId) => void handleSetBed(a, bedId)}
                          canEdit={canEdit && savingBedForId !== a.id}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-1 text-xs"
                          onClick={() => setBedEditAssignmentId(null)}
                        >
                          Done
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {isActive ? (
                      <Badge className="border-success/20 bg-success-muted text-success">Active</Badge>
                    ) : isPast ? (
                      <Badge variant="secondary">Past</Badge>
                    ) : (
                      <Badge className="border-info/20 bg-info-muted text-info">Upcoming</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {/*
                        #2286 review M7. Two separate controls on purpose:
                        RELEASE is the one every "clear the bed first" message
                        elsewhere in the app tells the admin to use, so it is one
                        click and is never buried inside a picker. It stays
                        available even with the bedAllocation module off — a
                        hold created while it was on still occupies a real bed,
                        and the route's clear branch is deliberately
                        module-check-free so it can always be undone.
                      */}
                      {a.bedId ? (
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleSetBed(a, null)}
                          disabled={savingBedForId === a.id}
                          className="text-muted-foreground hover:bg-muted hover:text-foreground"
                          title="Release the bed (keep the assignment)"
                        >
                          <Undo2 className="h-4 w-4" />
                          <span className="sr-only">Release bed</span>
                        </ViewOnlyActionButton>
                      ) : null}
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={false}
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setBedEditAssignmentId((current) =>
                            current === a.id ? null : a.id,
                          )
                        }
                        disabled={savingBedForId === a.id}
                        className="text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={a.bedId ? "Change the bed held" : "Hold a bed"}
                      >
                        <BedDouble className="h-4 w-4" />
                        <span className="sr-only">
                          {a.bedId ? "Change bed" : "Hold a bed"}
                        </span>
                      </ViewOnlyActionButton>
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={false}
                        variant="ghost"
                        size="sm"
                        onClick={() => handleResetPin(a)}
                        disabled={resettingPinId === a.id}
                        className="text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Reset kiosk PIN"
                      >
                        <KeyRound className="h-4 w-4" />
                        <span className="sr-only">Reset kiosk PIN</span>
                      </ViewOnlyActionButton>
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={false}
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(a.id)}
                        className="text-danger hover:bg-danger-muted hover:text-danger"
                        title="Delete assignment"
                      >
                        <Trash2 className="h-4 w-4" />
                        <span className="sr-only">Delete assignment</span>
                      </ViewOnlyActionButton>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </AdminDataTable>
      )}
        </>
      ) : null}
      </div>
    </div>
  );
}
