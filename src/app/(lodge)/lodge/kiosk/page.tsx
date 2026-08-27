"use client";

import { useState, useEffect, useCallback } from "react";
import { CalendarDays, RefreshCw } from "lucide-react";
import { KioskLodgeInstructions } from "@/components/kiosk-lodge-instructions";
import { useClubIdentity } from "@/components/club-identity-provider";
import type { KioskTier } from "@/lib/kiosk-access";
import { useClubTime } from "@/components/club-time-provider";
import { formatClubLongWeekdayDate, parseCalendarDate } from "@/lib/club-time";
// #2621: one 12-hour rendering of the expected arrival time, shared with the
// booking page editor and the lobby wall. Three private copies of the same six
// lines is how three surfaces end up disagreeing about midnight.
import { formatArrivalTime } from "@/lib/arrival-time";
import {
  addDaysToDateKey,
  getWeekStartDateKey,
  KioskWeekView,
  type KioskWeekDaySummary,
  weekHasAccessibleDay,
} from "./_components/kiosk-week-view";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  phone: string | null;
  isMember: boolean;
  isArriving: boolean;
  isDeparting: boolean;
  // #2631: the DEPARTING BADGE (`isDeparting`) is the operational day — "leaves
  // today" — and a sparse stay has one on every segment. The CHECK-OUT BUTTON
  // rides on `canMarkDeparted`, which the server derives from the depart
  // endpoint's OWN predicate, so the button is offered exactly where the server
  // will accept it. Gate it on anything else and the kiosk dead-ends: staff tap
  // "Mark Departed", the server refuses, and there is nothing they can do about
  // it. (#2628 renamed this from `isFinalDeparture`, which was `stayEnd`
  // equality and withheld the button on a sparse stay's earlier departure —
  // that check-out was simply unrecordable.)
  canMarkDeparted: boolean;
  // #2628: the CHECK-IN button's flag, and the mirror of the one above. It was
  // computed here as `isArriving && !departedAt`, which cannot see the night
  // set — so on a sparse stay's second arrival (departed on the 12th, back on
  // the 14th) the page hid this button AND the depart button, and the hut
  // leader had no control at all on a night the guest was in the building. The
  // server derives it where the nights are loaded; it is false for the same
  // days as before on every contiguous stay.
  canMarkArrived: boolean;
  arrivedAt: string | null;
  departedAt: string | null;
}

interface BookingGroup {
  bookingId: string;
  memberName: string;
  expectedArrivalTime: string | null;
  // #1422: a booking held by a pending admin review is shown but blocked from
  // check-in — arrival is disabled here and the server rejects it too.
  blockedFromCheckin?: boolean;
  guests: Guest[];
}

interface Assignment {
  id: string;
  choreTemplateId: string;
  choreTemplateName: string;
  choreDescription: string | null;
  choreSortOrder: number;
  choreTimeOfDay: string;
  bookingGuestId: string | null;
  guestName: string | null;
  guestAgeTier: string | null;
  bookingId: string;
  status: string;
  completedAt: string | null;
  completedVia: string | null;
}

interface AccessInfo {
  tier: KioskTier;
  dateRange: { minDate: string; maxDate: string } | null;
  canManageRoster: boolean;
  canMarkAttendance: boolean;
  canCompleteChores: boolean;
  // Lodge this kiosk session operates; null for single-lodge clubs
  // (ADR-002 presentation rule) and older responses.
  lodgeName?: string | null;
  // Set when this kiosk account is assigned to more than one lodge (M5): the
  // data routes 403, so render a fix-the-assignment message instead.
  misconfigured?: boolean;
  error?: string;
  // Set when a full admin is previewing this kiosk as a specific account
  // (issue #23): the client shows a PREVIEW banner and forces read-only.
  preview?: boolean;
  previewAccountEmail?: string;
}

type KioskView = "week" | "day";

/*
  #2474 — a lodge night on this page is a date-only KEY ("2026-04-15"), never a
  `Date`. Every "today" comes from the club's own day — `clubTime.today()` since
  CT-4 (#2870), the persisted setting rather than the container's environment —
  and every step comes from `addDaysToDateKey` (UTC date-only arithmetic), so
  the kiosk agrees with the server guards it calls and with the week strip it
  renders.

  What this replaced was two different things, and only one of them was a bug.

  THE BUG: `formatDate(new Date())` read the DISPLAY DEVICE's calendar day. A
  kiosk tablet left on a foreign zone — or simply set wrong, which is the common
  case on a lodge device nobody administers — opened on the wrong night, while
  every server route the page calls resolves the night in New Zealand.

  THE SEAM ALIGNMENT: the day-stepping helpers used to round-trip through
  `new Date(key + "T00:00:00")` + `setDate` + local getters. That was NOT
  broken. Writing and reading with the same local getters is a closed round
  trip: swept over every IANA zone and every day from 2008 to 2030, it agrees
  with `addDaysToDateKey` on every DST transition, month end and year end (the
  only divergence in the whole space is the 2011 Samoa dateline skip, where a
  calendar day was deleted outright). It moved onto `addDaysToDateKey` so the
  page speaks ONE date-only encoding end to end — the same UTC-midnight seam the
  week strip and `src/lib/date-only.ts` use — and so no later edit can
  reintroduce a device-local `Date` here by copying the pattern the file used to
  set. Do not cite this file as prior art for a DST defect: there wasn't one.
*/

// How often the page asks the club's calendar whether the day has turned over.
// A minute is the coarsest interval a hut leader would not notice at midnight,
// and the check itself is one `Intl` format — far cheaper than the two-minute
// data refresh it sits alongside. Deliberately NOT exported — this is an App
// Router page file, and a named export here is an invalid page export; the
// suite advances its fake clock by this many ms with a comment pointing back.
const CLUB_DAY_TICK_MS = 60000;

// The kiosk header names the DAY OF THE WEEK in full ("Wednesday, 15 April
// 2026") because that is what a hut leader scans for. A CALENDAR DAY, SO NO
// TIMEZONE AT ALL (CT-4, #2870): the kernel's `longWeekdayDate` shape is that
// exact bag, pinned to `UTC` over the UTC-midnight encoding, which is provably
// the identity for every club. The local formatter this replaces was the fourth
// copy of the same options in the same locale.

function displayDate(dateStr: string): string {
  // `parseCalendarDate`, not `requireCalendarDate`: this is the night the whole
  // page is keyed on, and a throw here would blank an unattended wall tablet.
  // The fallback is NEW rather than preserved — `parseDateOnly` returned
  // `new Date(NaN)` for a malformed key and `Intl` then threw `Invalid time
  // value` out of the render, which on a lodge wall screen nobody is watching is
  // the worst available outcome.
  const night = parseCalendarDate(dateStr);
  return night === null ? dateStr : formatClubLongWeekdayDate(night);
}

export default function KioskPage() {
  const { hutLeaderLabel } = useClubIdentity();
  // Position-appropriate casings of the configurable label so the default
  // "Hut Leader" reproduces the previous copy byte-for-byte: mid-sentence prose
  // uses the lowercase form, sentence-start prose capitalizes the first letter.
  const hutLeaderLower = hutLeaderLabel.toLowerCase();
  const hutLeaderSentence =
    hutLeaderLower.charAt(0).toUpperCase() + hutLeaderLower.slice(1);
  // Per-account preview (issue #23): a full admin opens this page with
  // ?previewAccount=<memberId> to see the kiosk exactly as that account would.
  // Read once from the URL and thread it through every kiosk fetch so the
  // server resolves tier/lodge as the target account. Read-only end to end.
  const [previewAccount] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const value = new URLSearchParams(window.location.search).get(
      "previewAccount"
    );
    return value && value.trim().length > 0 ? value : null;
  });
  const withPreview = useCallback(
    (url: string) => {
      if (!previewAccount) return url;
      const sep = url.includes("?") ? "&" : "?";
      return `${url}${sep}previewAccount=${encodeURIComponent(previewAccount)}`;
    },
    [previewAccount]
  );
  // #2474 — the club's day is HELD, not re-read in the render, and the night
  // shown is seeded from that one snapshot. Reading it inline where the week
  // strip is rendered would let the "Today" chip roll at NZ midnight while
  // `date` — the night every fetch, every roster write and every check-in is
  // keyed on — stayed on yesterday. That divergence would open at 00:00 NZ, the
  // exact hour a late arrival is being checked in.
  /*
    THE CLUB'S DAY, FROM THE CLUB'S PERSISTED TIMEZONE (CT-4, #2870; epic #2988;
    INV-CONFIG-002) — delivered to this browser as data by `ClubTimeProvider`,
    where it used to come from the container's environment zone. It has never
    been the tablet's own clock, and that is the whole point of #2474 above: a
    lodge device set to the wrong zone must not open on the wrong night. Same
    shape, same answer on every deployment today; only the authority moved.
  */
  const clubTime = useClubTime();
  const [clubToday, setClubToday] = useState<string>(() => clubTime.today());
  const [date, setDate] = useState(clubToday);
  const [view, setView] = useState<KioskView>("week");
  const [weekStart, setWeekStart] = useState(() => getWeekStartDateKey(clubToday));
  const [weekDays, setWeekDays] = useState<KioskWeekDaySummary[]>([]);
  const [bookings, setBookings] = useState<BookingGroup[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [viewAs, setViewAs] = useState<KioskTier | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);
  const [showPinForm, setShowPinForm] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinLoading, setPinLoading] = useState(false);

  // Effective tier (admin can preview other tiers)
  const effectiveTier = viewAs ?? access?.tier ?? "none";
  // A per-account preview (issue #23) is read-only: the server rejects every
  // kiosk write for a preview session, so mirror that in the UI by never
  // offering write controls, whatever tier is being previewed.
  const isPreview = access?.preview === true;
  const canMarkAttendance =
    !isPreview &&
    (effectiveTier === "admin" || effectiveTier === "hut-leader" || effectiveTier === "lodge");
  const canCompleteChores = canMarkAttendance;
  const canManageRoster =
    !isPreview && (effectiveTier === "admin" || effectiveTier === "hut-leader");

  const fetchData = useCallback(async () => {
    try {
      const accessRes = await fetch(withPreview(`/api/lodge/access?date=${date}`));
      if (!accessRes.ok) {
        setAccess(null);
        setWeekDays([]);
        setBookings([]);
        setAssignments([]);
        setAuthRequired(accessRes.status === 401);
        setError(
          accessRes.status === 401
            ? "Sign in to view the lodge kiosk."
            : "You do not have lodge kiosk access for this date."
        );
        setFailCount(0);
        return;
      }

      const accessData = await accessRes.json();
      setAccess(accessData);
      setAuthRequired(false);

      // A kiosk account bound to more than one lodge is denied everywhere data
      // is served (M5). Stop before the week/guest/roster fetches (which 403)
      // and render the fix-the-assignment notice instead of a generic failure.
      if (accessData.misconfigured) {
        setWeekDays([]);
        setBookings([]);
        setAssignments([]);
        setError(null);
        setFailCount(0);
        return;
      }

      if (view === "week") {
        const weekRes = await fetch(withPreview(`/api/lodge/week?start=${weekStart}`));

        if (!weekRes.ok) {
          setWeekDays([]);
          setBookings([]);
          setAssignments([]);
          setError("Failed to load lodge kiosk week data.");
          setFailCount(0);
          return;
        }

        const weekData = await weekRes.json();
        setWeekDays(weekData.days ?? []);
        setBookings([]);
        setAssignments([]);
        setError(null);
        setFailCount(0);
        return;
      }

      const [guestsRes, rosterRes] = await Promise.all([
        // #2631: no scope query parameter any more. The guests route answers
        // one question — the operational day — so this screen, the roster setup
        // wizard and chore generation cannot drift apart. "Departing Today" keeps
        // exactly the meaning it always had here: this guest's last night was
        // last night, so they leave before midday.
        fetch(withPreview(`/api/lodge/guests/${date}`)),
        fetch(withPreview(`/api/lodge/roster/${date}`)),
      ]);

      if (!guestsRes.ok || !rosterRes.ok) {
        setBookings([]);
        setAssignments([]);
        setError("Failed to load lodge kiosk data for this date.");
        setFailCount(0);
        return;
      }

      const guestsData = await guestsRes.json();
      const rosterData = await rosterRes.json();
      setBookings(guestsData.bookings);
      setAssignments(rosterData.assignments);

      setError(null);
      setFailCount(0);
    } catch {
      setAuthRequired(false);
      setWeekDays([]);
      setError("Failed to load data");
      setFailCount((c) => c + 1);
    } finally {
      setLoading(false);
    }
  }, [date, view, weekStart, withPreview]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Auto-refresh: backs off to 5 min after 3 consecutive failures
  useEffect(() => {
    const interval = failCount >= 3 ? 300000 : 120000;
    const timer = setInterval(fetchData, interval);
    return () => clearInterval(timer);
  }, [failCount, fetchData]);

  // #2474 — a kiosk is a wall tablet nobody reloads, so the club's new day has
  // to arrive on its own. Watch for the rollover and carry the strip across WITH
  // it, so the "Today" chip and the night being served never disagree.
  //
  // Two things it deliberately will NOT do, because 00:00 NZ is the check-in
  // hour and not a quiet moment:
  //
  //  - it never moves a view somebody chose. Only a strip still parked on what
  //    was today follows the club over; a night or a week a hut leader browsed
  //    to stays exactly where they left it.
  //  - it never touches the DAY view. Reaching a day list takes a deliberate
  //    tap, and it is where arrivals are marked off — a list that re-pointed
  //    itself at the new night mid-check-in would send the next tap to the
  //    wrong lodge night. It waits for **Today**, or for a tap back to the
  //    strip.
  //
  // `clubToday` itself always advances, so the chip is right the moment the
  // strip is shown again. The effect re-arms on `clubToday` (once a day) and on
  // `view`, so a tick restarts while somebody is actively moving around — which
  // is the behaviour we want anyway.
  useEffect(() => {
    const timer = setInterval(() => {
      const nextClubDay: string = clubTime.today();
      if (nextClubDay === clubToday) return;

      setClubToday(nextClubDay);
      if (view !== "week") return;

      setDate((current) => (current === clubToday ? nextClubDay : current));
      setWeekStart((current) =>
        current === getWeekStartDateKey(clubToday)
          ? getWeekStartDateKey(nextClubDay)
          : current
      );
    }, CLUB_DAY_TICK_MS);
    return () => clearInterval(timer);
  }, [clubTime, clubToday, view]);

  const refreshNow = async () => {
    setRefreshing(true);
    try {
      await fetchData();
    } finally {
      setRefreshing(false);
    }
  };

  const canNavigateBack = () => {
    if (!access?.dateRange) return true;
    return addDaysToDateKey(date, -1) >= access.dateRange.minDate;
  };

  const canNavigateForward = () => {
    if (!access?.dateRange) return true;
    return addDaysToDateKey(date, 1) <= access.dateRange.maxDate;
  };

  const changeDate = (delta: number) => {
    const newDate = addDaysToDateKey(date, delta);

    // Enforce date range for restricted tiers
    if (access?.dateRange) {
      if (newDate < access.dateRange.minDate || newDate > access.dateRange.maxDate) {
        return;
      }
    }

    setDate(newDate);
    setWeekStart(getWeekStartDateKey(newDate));
  };

  const canNavigateWeek = (deltaWeeks: number) => {
    const nextWeekStart = addDaysToDateKey(weekStart, deltaWeeks * 7);
    return weekHasAccessibleDay(nextWeekStart, access?.dateRange ?? null);
  };

  const changeWeek = (deltaWeeks: number) => {
    const nextWeekStart = addDaysToDateKey(weekStart, deltaWeeks * 7);
    if (!weekHasAccessibleDay(nextWeekStart, access?.dateRange ?? null)) {
      return;
    }
    setWeekStart(nextWeekStart);
  };

  const openDayView = (dateKey: string) => {
    setDate(dateKey);
    setWeekStart(getWeekStartDateKey(dateKey));
    setView("day");
  };

  const showWeekForDate = () => {
    setWeekStart(getWeekStartDateKey(date));
    setView("week");
  };

  const showToday = () => {
    // Re-read rather than trusting `clubToday`: the rollover tick can be up to
    // a minute behind the club at midnight, and **Today** must never send a hut
    // leader to yesterday. Setting all three together keeps the chip, the
    // served night and the week on the same day.
    const today: string = clubTime.today();
    setClubToday(today);
    setDate(today);
    setWeekStart(getWeekStartDateKey(today));
    setView("week");
  };

  const showActionError = (message: string) => {
    setActionError(message);
    setTimeout(() => setActionError(null), 3000);
  };

  const submitPin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPinError(null);
    setPinLoading(true);

    try {
      const res = await fetch("/api/lodge/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setPinError(data?.error || "PIN login failed");
        return;
      }

      setPin("");
      setShowPinForm(false);
      setLoading(true);
      await fetchData();
    } catch {
      setPinError("PIN login failed");
    } finally {
      setPinLoading(false);
    }
  };

  const toggleChore = async (assignmentId: string, currentStatus: string) => {
    if (!canCompleteChores) return;
    const action = currentStatus === "COMPLETED" ? "uncomplete" : "complete";
    try {
      const res = await fetch(`/api/lodge/roster/${date}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, assignmentId }),
      });
      if (!res.ok) {
        showActionError("Failed to update chore");
        return;
      }
      setAssignments((prev) =>
        prev.map((a) =>
          a.id === assignmentId
            ? {
                ...a,
                status: action === "complete" ? "COMPLETED" : "CONFIRMED",
                completedAt: action === "complete" ? new Date().toISOString() : null,
                completedVia: action === "complete" ? "KIOSK" : null,
              }
            : a
        )
      );
    } catch {
      showActionError("Failed to update chore");
    }
  };

  const toggleArrival = async (guestId: string) => {
    if (!canMarkAttendance) return;
    try {
      const res = await fetch(`/api/lodge/guests/${date}/arrive`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingGuestId: guestId }),
      });
      if (!res.ok) {
        // #2737: one refusal here is actionable and the rest are not. A 409
        // `GUEST_NOT_BOOKED_THIS_NIGHT` means this page is stale — the guest is
        // not staying tonight — so pass the server's own sentence through
        // instead of "Failed to update arrival", which sends the hut leader
        // looking for a fault that is not there. Only that one code is
        // whitelisted: every other status keeps the generic line rather than
        // rendering arbitrary server text on the kiosk screen.
        const refusal = await res
          .json()
          .catch(() => null as { code?: string; error?: string } | null);
        showActionError(
          res.status === 409 &&
            refusal?.code === "GUEST_NOT_BOOKED_THIS_NIGHT" &&
            typeof refusal.error === "string"
            ? refusal.error
            : "Failed to update arrival"
        );
        return;
      }
      const data = await res.json();
      setBookings((prev) =>
        prev.map((b) => ({
          ...b,
          guests: b.guests.map((g) =>
            g.id === guestId
              ? {
                  ...g,
                  arrivedAt: data.arrivedAt,
                  // A RETURN clears the departure recorded on the guest's
                  // earlier segment (#2628); take the server's answer rather
                  // than assuming this row did not move.
                  departedAt:
                    data.departedAt === undefined
                      ? g.departedAt
                      : data.departedAt,
                }
              : g
          ),
        }))
      );
    } catch {
      showActionError("Failed to update arrival");
    }
  };

  const toggleDeparture = async (guestId: string) => {
    if (!canMarkAttendance) return;
    try {
      const res = await fetch(`/api/lodge/guests/${date}/depart`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingGuestId: guestId }),
      });
      if (!res.ok) {
        showActionError("Failed to update departure");
        return;
      }
      const data = await res.json();
      setBookings((prev) =>
        prev.map((b) => ({
          ...b,
          guests: b.guests.map((g) =>
            g.id === guestId ? { ...g, departedAt: data.departedAt } : g
          ),
        }))
      );
    } catch {
      showActionError("Failed to update departure");
    }
  };

  const totalGuests = bookings.reduce((sum, b) => sum + b.guests.length, 0);
  const filterBookingsByGuest = (predicate: (guest: Guest) => boolean) =>
    bookings
      .map((booking) => ({
        ...booking,
        guests: booking.guests.filter(predicate),
      }))
      .filter((booking) => booking.guests.length > 0);

  const lodgeListSections = [
    {
      title: "Guests Arriving Today",
      emptyText: "No guests arriving today",
      bookings: filterBookingsByGuest((guest) => guest.isArriving),
    },
    {
      title: "Guests Staying",
      emptyText: "No continuing guests staying today",
      bookings: filterBookingsByGuest(
        (guest) => !guest.isArriving && !guest.isDeparting
      ),
    },
    {
      title: "Guests Departing Today",
      emptyText: "No guests departing today",
      bookings: filterBookingsByGuest((guest) => guest.isDeparting),
    },
  ];

  // Group assignments by time of day
  const timeGroups = ["MORNING", "EVENING", "ANYTIME"] as const;
  const groupedAssignments = timeGroups.map((tod) => ({
    label: tod === "MORNING" ? "Morning" : tod === "EVENING" ? "Evening" : "Anytime",
    assignments: assignments.filter((a) => a.choreTimeOfDay === tod),
  }));

  const hasAssignments = assignments.length > 0;

  if (loading) {
    return (
      <div className="theme-aware-kiosk min-h-screen bg-kiosk-page text-kiosk-fg flex items-center justify-center">
        <div className="text-2xl">Loading...</div>
      </div>
    );
  }

  // This kiosk account is assigned to more than one lodge, so it cannot serve
  // a single property's guest list or roster (M5). Show a clear, dead-end
  // notice rather than empty panels an admin would have to guess at.
  if (access?.misconfigured) {
    return (
      <div className="theme-aware-kiosk min-h-screen bg-kiosk-page text-kiosk-fg flex items-center justify-center p-6">
        <div className="max-w-lg rounded-2xl border border-kiosk-danger-border bg-kiosk-danger-bg p-6 text-center text-kiosk-danger-fg">
          <h1 className="text-2xl font-bold text-kiosk-danger-fg">Kiosk needs attention</h1>
          <p className="mt-3 text-lg">
            {access.error ??
              "This kiosk account is assigned to more than one lodge, so it cannot show a lodge list."}
          </p>
          <p className="mt-2 text-sm text-kiosk-danger-fg/80">
            An administrator can fix this under Admin &rarr; Lodge Kiosk by
            setting this account to operate a single lodge.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="theme-aware-kiosk min-h-screen bg-kiosk-page text-kiosk-fg p-4 select-none">
      {isPreview && (
        <div className="mb-4 rounded-xl border border-kiosk-warning-border bg-kiosk-warning-solid px-4 py-2 text-center text-sm font-semibold text-kiosk-warning-solid-fg">
          PREVIEW — {access?.lodgeName ?? "Default lodge"} kiosk
          {access?.previewAccountEmail ? ` (account ${access.previewAccountEmail})` : ""}
          {" · read-only, no changes are saved"}
        </div>
      )}
      {actionError && (
        <div className="bg-kiosk-danger-solid text-kiosk-danger-solid-fg text-center py-2 text-sm font-medium">
          {actionError}
        </div>
      )}

      {/* Admin tier preview dropdown */}
      {access?.tier === "admin" && (
        <div className="flex items-center justify-end mb-3 gap-2">
          <span className="text-sm text-kiosk-muted-fg">
            Viewing as:
          </span>
          <select
            value={viewAs ?? "admin"}
            onChange={(e) => {
              const val = e.target.value as KioskTier;
              setViewAs(val === access.tier ? null : val);
            }}
            className="bg-kiosk-inset text-kiosk-fg text-sm rounded px-3 py-1.5 border border-kiosk-border"
          >
            <option value="admin">Admin</option>
            <option value="hut-leader">{hutLeaderLabel}</option>
            <option value="lodge">Lodge</option>
            <option value="staying-guest">Staying Guest</option>
          </select>
        </div>
      )}

      {view === "day" && (
        <header className="mb-6 flex items-center justify-between">
          <button
            onClick={() => changeDate(-1)}
            disabled={!canNavigateBack()}
            className={`min-h-[56px] min-w-[64px] rounded-xl px-6 py-4 text-2xl font-bold text-kiosk-fg ${
              canNavigateBack()
                ? "bg-kiosk-inset hover:bg-kiosk-hover active:bg-kiosk-hover"
                : "cursor-not-allowed bg-kiosk-card text-kiosk-faint-fg"
            }`}
            aria-label="Previous day"
          >
            &lsaquo;
          </button>
          <div className="text-center">
            {access?.lodgeName && (
              <p className="text-sm font-medium uppercase text-kiosk-fg">
                {access.lodgeName}
              </p>
            )}
            <button
              type="button"
              onClick={showWeekForDate}
              className="mb-3 inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-kiosk-card px-3 py-2 text-sm font-semibold text-kiosk-fg transition-colors hover:bg-kiosk-hover active:bg-kiosk-hover"
            >
              <CalendarDays className="h-4 w-4" />
              &lsaquo; Week
            </button>
            <h1 className="text-2xl font-bold">{displayDate(date)}</h1>
            <p className="text-lg text-kiosk-muted-fg">
              {totalGuests} guest{totalGuests !== 1 ? "s" : ""} on lodge list
            </p>
            {(effectiveTier === "staying-guest" || effectiveTier === "none") && (
              <p className="mt-1 text-sm text-kiosk-accent">Read-only view</p>
            )}
            <button
              onClick={refreshNow}
              disabled={refreshing}
              className="mt-3 inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-kiosk-card px-3 py-2 text-sm font-semibold text-kiosk-fg transition-colors hover:bg-kiosk-hover active:bg-kiosk-hover disabled:cursor-wait disabled:text-kiosk-muted-fg"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          <button
            onClick={() => changeDate(1)}
            disabled={!canNavigateForward()}
            className={`min-h-[56px] min-w-[64px] rounded-xl px-6 py-4 text-2xl font-bold text-kiosk-fg ${
              canNavigateForward()
                ? "bg-kiosk-inset hover:bg-kiosk-hover active:bg-kiosk-hover"
                : "cursor-not-allowed bg-kiosk-card text-kiosk-faint-fg"
            }`}
            aria-label="Next day"
          >
            &rsaquo;
          </button>
        </header>
      )}

      {error && (
        <div className="bg-kiosk-danger-bg text-kiosk-danger-fg rounded-xl p-4 mb-4 text-lg">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            {authRequired && (
              <a
                href={`/login?callbackUrl=${encodeURIComponent("/lodge/kiosk")}`}
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-kiosk-accent px-4 py-2 text-sm font-semibold text-kiosk-accent-fg transition-colors hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active"
              >
                Sign in
              </a>
            )}
          </div>
        </div>
      )}

      {effectiveTier === "lodge" && (
        <section className="bg-kiosk-card rounded-2xl p-4 mb-4 border border-kiosk-border">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-kiosk-fg">
                {hutLeaderSentence} controls
              </h2>
              <p className="text-sm text-kiosk-fg mt-1">
                Enter the 6-digit {hutLeaderLower} PIN to unlock {hutLeaderLower}{" "}
                controls on this kiosk, including roster management.
              </p>
            </div>
            {!showPinForm && (
              <button
                onClick={() => {
                  setShowPinForm(true);
                  setPinError(null);
                }}
                className="inline-flex items-center justify-center rounded-xl bg-kiosk-accent px-4 py-3 text-sm font-semibold text-kiosk-accent-fg transition-colors hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active"
              >
                Enter PIN
              </button>
            )}
          </div>

          {showPinForm && (
            <form
              onSubmit={submitPin}
              className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1">
                <label
                  htmlFor="hut-leader-pin"
                  className="block text-sm font-medium text-kiosk-fg mb-2"
                >
                  {hutLeaderSentence} PIN
                </label>
                <input
                  id="hut-leader-pin"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={pin}
                  onChange={(event) =>
                    setPin(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  className="w-full rounded-xl border border-kiosk-border bg-kiosk-page px-4 py-3 text-lg tracking-[0.35em] text-kiosk-fg outline-none transition-colors focus:border-kiosk-accent"
                  placeholder="123456"
                  autoComplete="one-time-code"
                  required
                />
                {pinError && (
                  <p className="mt-2 text-sm text-kiosk-danger-fg">{pinError}</p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={pinLoading || pin.length !== 6}
                  className="rounded-xl bg-kiosk-accent px-4 py-3 text-sm font-semibold text-kiosk-accent-fg transition-colors hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active disabled:cursor-not-allowed disabled:bg-kiosk-chip disabled:text-kiosk-faint-fg"
                >
                  {pinLoading ? "Checking..." : "Unlock"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowPinForm(false);
                    setPin("");
                    setPinError(null);
                  }}
                  className="rounded-xl bg-kiosk-inset px-4 py-3 text-sm font-semibold text-kiosk-fg transition-colors hover:bg-kiosk-hover active:bg-kiosk-hover"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {!error && view === "week" && (
        <KioskWeekView
          days={weekDays}
          weekStart={weekStart}
          todayDate={clubToday}
          selectedDate={date}
          lodgeName={access?.lodgeName}
          readOnly={effectiveTier === "staying-guest" || effectiveTier === "none"}
          refreshing={refreshing}
          canGoToPreviousWeek={canNavigateWeek(-1)}
          canGoToNextWeek={canNavigateWeek(1)}
          onSelectDate={openDayView}
          onChangeWeek={changeWeek}
          onToday={showToday}
          onRefresh={refreshNow}
        />
      )}

      {/* Lodge instructions for the signed-in hut leader (API re-checks access) */}
      {view === "day" && (effectiveTier === "admin" || effectiveTier === "hut-leader") && (
        <KioskLodgeInstructions date={date} />
      )}

      {view === "day" && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Lodge List Panel */}
        <section>
          <div className="flex min-h-[44px] items-center justify-between gap-3 mb-3">
            <h2 className="text-xl font-semibold text-kiosk-fg">
              Lodge List
            </h2>
          </div>
          {bookings.length === 0 ? (
            <div className="bg-kiosk-card rounded-xl p-6 text-center text-kiosk-muted-fg text-lg">
              No guests on the lodge list for this date
            </div>
          ) : (
            <div className="space-y-6">
              {lodgeListSections.map((section) => (
                <div key={section.title}>
                  <h3 className="mb-2 text-base font-medium text-kiosk-muted-fg">
                    {section.title} ({section.bookings.reduce((sum, booking) => sum + booking.guests.length, 0)})
                  </h3>
                  {section.bookings.length === 0 ? (
                    <div className="rounded-xl bg-kiosk-card p-4 text-center text-sm text-kiosk-muted-fg">
                      {section.emptyText}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {section.bookings.map((booking) => (
                        <div
                          key={`${section.title}-${booking.bookingId}`}
                          className="bg-kiosk-card rounded-xl p-4"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-sm text-kiosk-muted-fg">
                              Booked by {booking.memberName}
                            </p>
                            {booking.expectedArrivalTime && booking.guests.some((g) => g.isArriving) && (
                              <span className="text-sm text-kiosk-accent font-medium">
                                Arriving {formatArrivalTime(booking.expectedArrivalTime)}
                              </span>
                            )}
                            {!booking.expectedArrivalTime && booking.guests.some((g) => g.isArriving) && (
                              <span className="text-sm text-kiosk-muted-fg">
                                Arrival time: Not specified
                              </span>
                            )}
                          </div>
                          {booking.blockedFromCheckin && (
                            <p className="mb-2 inline-block rounded-lg border border-kiosk-danger-border bg-kiosk-danger-bg px-3 py-1 text-sm font-semibold text-kiosk-danger-fg">
                              Blocked from Check-In — see Booking Officer
                            </p>
                          )}
                          <div className="space-y-2">
                            {booking.guests.map((guest) => (
                              <div
                                key={guest.id}
                                className={`flex items-center justify-between rounded-lg px-4 py-3 min-h-[56px] ${
                                  // Faded = "gone". A guest who is checking back
                                  // in tonight is not gone, even though the
                                  // stay's single `departedAt` still holds the
                                  // check-out from their previous segment
                                  // (#2628) — fading them there would show
                                  // somebody standing at the desk as departed.
                                  guest.departedAt && !guest.canMarkArrived
                                    ? "bg-kiosk-inset opacity-60"
                                    : guest.arrivedAt && !guest.departedAt
                                      ? "bg-kiosk-success-bg border border-kiosk-success-border"
                                      : "bg-kiosk-inset"
                                }`}
                              >
                                <div>
                                  <div className="flex items-center gap-3 flex-wrap">
                                    <span className="text-lg font-medium">
                                      {guest.firstName} {guest.lastName}
                                    </span>
                                    <span className="text-sm text-kiosk-muted-fg">
                                      {guest.ageTier}
                                    </span>
                                  </div>
                                  {guest.ageTier === "ADULT" && (
                                    <p className="text-sm text-kiosk-muted-fg mt-1">
                                      {guest.phone
                                        ? `Phone ${guest.phone}`
                                        : "Phone not available"}
                                    </p>
                                  )}
                                </div>
                                <div className="flex gap-2 items-center">
                                  {guest.isArriving && (
                                    <span className="bg-kiosk-success-solid text-kiosk-success-solid-fg text-sm font-medium px-3 py-1 rounded-full">
                                      Arriving
                                    </span>
                                  )}
                                  {guest.isDeparting && (
                                    <span className="bg-kiosk-warning-solid text-kiosk-warning-solid-fg text-sm font-medium px-3 py-1 rounded-full">
                                      Departing
                                    </span>
                                  )}
                                  {!guest.isMember && (
                                    <span className="bg-kiosk-chip text-kiosk-fg text-sm px-3 py-1 rounded-full">
                                      Non-member
                                    </span>
                                  )}
                                  {canMarkAttendance && guest.canMarkArrived && !booking.blockedFromCheckin && (
                                    <button
                                      onClick={() => toggleArrival(guest.id)}
                                      className={`text-sm font-medium px-4 py-2 rounded-lg min-h-[44px] transition-colors ${
                                        // "Arrived" means HERE NOW, so a stale
                                        // `arrivedAt` left over from an earlier
                                        // segment of a stay with a gap in it
                                        // does not count until the return is
                                        // recorded (#2628).
                                        guest.arrivedAt && !guest.departedAt
                                          ? "bg-kiosk-success-solid text-kiosk-success-solid-fg"
                                          : "bg-kiosk-accent text-kiosk-accent-fg hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active"
                                      }`}
                                    >
                                      {guest.arrivedAt && !guest.departedAt ? "Arrived" : "Mark Arrived"}
                                    </button>
                                  )}
                                  {canMarkAttendance && guest.canMarkDeparted && !booking.blockedFromCheckin && (
                                    <button
                                      onClick={() => toggleDeparture(guest.id)}
                                      className={`text-sm font-medium px-4 py-2 rounded-lg min-h-[44px] transition-colors ${
                                        guest.departedAt
                                          ? "bg-kiosk-warning-solid text-kiosk-warning-solid-fg"
                                          : "bg-kiosk-accent text-kiosk-accent-fg hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active"
                                      }`}
                                    >
                                      {guest.departedAt ? "Departed" : "Mark Departed"}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Chore Roster Panel */}
        <section>
          <div className="flex min-h-[44px] items-center justify-between gap-3 mb-3">
            <h2 className="text-xl font-semibold text-kiosk-fg">
              Chore Roster
            </h2>
            {canManageRoster && (
              <a
                href={`/lodge/roster/${date}/setup`}
                className="inline-block bg-kiosk-accent hover:bg-kiosk-accent-hover active:bg-kiosk-accent-active text-kiosk-accent-fg text-sm font-semibold px-4 py-2 rounded-xl min-h-[44px] transition-colors whitespace-nowrap"
              >
                {hasAssignments ? "Manage Today's Roster" : "Set Up Today's Roster"}
              </a>
            )}
          </div>
          {!hasAssignments ? (
            <div className="bg-kiosk-card rounded-xl p-6 text-center">
              <p className="text-kiosk-muted-fg text-lg mb-4">
                No roster set up for this date
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {groupedAssignments
                .filter((g) => g.assignments.length > 0)
                .map((group) => (
                  <div key={group.label}>
                    <h3 className="text-base font-medium text-kiosk-muted-fg mb-2">
                      {group.label}
                    </h3>
                    <div className="space-y-2">
                      {/* Group by chore template */}
                      {Object.values(
                        group.assignments.reduce(
                          (acc, a) => {
                            if (!acc[a.choreTemplateId]) {
                              acc[a.choreTemplateId] = {
                                name: a.choreTemplateName,
                                assignments: [],
                              };
                            }
                            acc[a.choreTemplateId].assignments.push(a);
                            return acc;
                          },
                          {} as Record<
                            string,
                            { name: string; assignments: Assignment[] }
                          >
                        )
                      ).map((chore) => (
                        <div
                          key={chore.name}
                          className="bg-kiosk-card rounded-xl p-4"
                        >
                          <h4 className="font-semibold text-lg mb-2">
                            {chore.name}
                          </h4>
                          <div className="space-y-1">
                            {chore.assignments.map((a) =>
                              canCompleteChores ? (
                                <button
                                  key={a.id}
                                  onClick={() => toggleChore(a.id, a.status)}
                                  className={`w-full flex items-center gap-3 rounded-lg px-4 py-3 min-h-[56px] text-left transition-colors ${
                                    a.status === "COMPLETED"
                                      ? "bg-kiosk-success-bg text-kiosk-success-fg"
                                      : "bg-kiosk-inset hover:bg-kiosk-hover active:bg-kiosk-hover"
                                  }`}
                                >
                                  <div
                                    className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center flex-shrink-0 ${
                                      a.status === "COMPLETED"
                                        ? "border-kiosk-success-solid bg-kiosk-success-solid"
                                        : "border-kiosk-border"
                                    }`}
                                  >
                                    {a.status === "COMPLETED" && (
                                      <svg
                                        className="w-5 h-5 text-kiosk-success-solid-fg"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={3}
                                      >
                                        <path
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          d="M5 13l4 4L19 7"
                                        />
                                      </svg>
                                    )}
                                  </div>
                                  <span className="text-lg">
                                    {a.guestName ?? "Unassigned"}
                                  </span>
                                </button>
                              ) : (
                                <div
                                  key={a.id}
                                  className={`w-full flex items-center gap-3 rounded-lg px-4 py-3 min-h-[56px] ${
                                    a.status === "COMPLETED"
                                      ? "bg-kiosk-success-bg text-kiosk-success-fg"
                                      : "bg-kiosk-inset"
                                  }`}
                                >
                                  <div
                                    className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center flex-shrink-0 ${
                                      a.status === "COMPLETED"
                                        ? "border-kiosk-success-solid bg-kiosk-success-solid"
                                        : "border-kiosk-border"
                                    }`}
                                  >
                                    {a.status === "COMPLETED" && (
                                      <svg
                                        className="w-5 h-5 text-kiosk-success-solid-fg"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={3}
                                      >
                                        <path
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          d="M5 13l4 4L19 7"
                                        />
                                      </svg>
                                    )}
                                  </div>
                                  <span className="text-lg">
                                    {a.guestName ?? "Unassigned"}
                                  </span>
                                </div>
                              )
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </section>
      </div>
      )}

      {/* Last refresh indicator */}
      <footer className="mt-6 text-center text-sm text-kiosk-muted-fg">
        Auto-refreshes every {failCount >= 3 ? "5m" : "60s"}
      </footer>
    </div>
  );
}
