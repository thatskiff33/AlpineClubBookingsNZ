"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useClubTime } from "@/components/club-time-provider";
import {
  addCalendarDays,
  calendarDateFromParts,
  calendarDateParts,
  calendarDayOfWeek,
  daysInCalendarMonth,
  formatClubLongWeekdayDate,
  formatClubMonthYear,
  requireCalendarDate,
} from "@/lib/club-time";
import { formatCalendarDayOnly } from "@/lib/date-only";

/**
 * A day button's accessible name, spelled out in full — long weekday, long month
 * — because a screen reader user hears it with no grid around it to give the
 * cell context (#2264). The kernel's medium and weekday shapes abbreviate, which
 * would make the announcement harder to follow.
 *
 * NO ZONE AT ALL, WHICH IS THE FIX (CT-4, #2870). What it renders is a CALENDAR
 * DAY, carried as a `yyyy-MM-dd` string, so it goes to a calendar-date shape,
 * which takes no zone and cannot be moved by one. This file used to hold a local
 * `Intl.DateTimeFormat` pinned to UTC over the UTC-midnight encoding, and before
 * that one pinned to `APP_TIME_ZONE` — the identity only for a club east of
 * Greenwich, and a day early for any club west of it.
 *
 * IT IS ONE CALL NOW because CT-4's `src/lib` group added the missing shape:
 * `HOUSE_SHAPES.longWeekdayDate` carries the long weekday, the long month AND
 * the year, declared as one shape rather than composed from
 * `longWeekdayDayMonth` plus the year — which is byte-identical for `en-NZ` and
 * not safe for a configurable `APP_LOCALE`, the exact hazard
 * `formatClubWeekdayDay`'s own docblock records.
 */

// #2474: the cells below are abstract calendar days (lodge nights), carried as
// NZ date-only strings end-to-end — never a local-midnight `Date`. CT-4 (#2870)
// removed the last step of that journey: they are now handed to the kernel's
// calendar-date shapes as strings, so no `Date` is constructed and no zone is
// consulted at any point.

interface SeasonInfo {
  name: string;
  type: string;
}

interface BookingCalendarProps {
  // A selected lodge night is a date-only `yyyy-MM-dd` string (#2474), not a
  // local-midnight `Date`.
  onDateSelect: (checkIn: string, checkOut: string) => void;
  selectedCheckIn?: string | null;
  selectedCheckOut?: string | null;
  // Lodge whose availability and seasons the calendar shows (multi-lodge
  // phase 8). Omitted/null = the club's default lodge.
  lodgeId?: string | null;
  // Admin retroactive booking (#1695): when true, days back to 365 days before
  // today become selectable (muted, warn-and-confirm on full nights). Default
  // false keeps the member flow byte-identical.
  allowPastDates?: boolean;
  // Admin over-capacity create (#1767): when true, a full future day is
  // presented as an OVER-CAPACITY selection — the admin book-on-behalf boundary
  // (#2930), which stays over-capacity warn-and-confirm rather than the member
  // waitlist. It no longer controls WHETHER a full day can be picked: since
  // #2930 a full future night is selectable for everyone, because a member has
  // to be able to reach the waitlist through it. What this flag still decides is
  // what the day is CALLED and what happens at submit.
  allowFullDates?: boolean;
}

/**
 * What a calendar cell means for the pick that is currently being made (#2930).
 *
 * Lodge occupancy is half-open — `[checkIn, checkOut)` (`INV-DATE-003`) — so the
 * SAME date is two different things depending on which end of the stay is being
 * chosen, and the old grid only ever modelled one of them. A date whose own
 * night is full was hard-disabled outright, which silently made it unusable as a
 * DEPARTURE MORNING: the member checks out on it and occupies no bed on it, so
 * its fullness has nothing to do with them. A member whose stay ended on a busy
 * Sunday simply could not express that stay.
 *
 * The role is derived on render and is the single input to disabled state,
 * click handling, styling and the accessible name — one decision, four
 * consumers, so they cannot drift apart the way they had.
 */
type DayRole =
  /** Before the earliest selectable day. Not pickable at either end. */
  | "unreachable"
  /**
   * A candidate arrival/stay night: this date's own occupancy is the member's
   * occupancy. Full still means full — it just no longer means blocked.
   */
  | "arrival"
  /**
   * A candidate departure morning. `[checkIn, thisDate)` excludes this night
   * entirely, so however full it is, it does not bear on the stay.
   */
  | "departure";

// Retroactive bookings may reach at most this many days into the past. Kept in
// sync with RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS on the server (#1695).
const RETROACTIVE_LOOKBACK_DAYS = 365;

/**
 * Everything one lodge's calendar knows about occupancy, accumulated across
 * every month that has been loaded (#2930).
 *
 * TWO DEFECTS LIVED IN THE SHAPE THIS REPLACES, a bare `Record<string, number>`
 * reset on every month change.
 *
 * 1. **Months did not accumulate.** Paging forward replaced the map wholesale,
 *    so paging back showed an empty month until its refetch landed — and a stay
 *    that spans a month boundary was being judged with one of its two months
 *    missing.
 * 2. **Missing was read as zero.** `availability[date] ?? 0` cannot tell "this
 *    night has nobody in it" from "this night has not been loaded", and it
 *    answered BOTH with an empty lodge. A failed or in-flight fetch therefore
 *    painted a full lodge as completely free and invited the member to pick it.
 *    Unknown is now its own state and renders as unknown.
 *
 * Keyed by lodge because the numbers are only meaningful against the lodge they
 * were counted for: switching lodges DISCARDS the accumulation rather than
 * merging two lodges' nights into one map. `capacity` is that lodge's own
 * effective capacity as the route resolved it (`INV-CAP-003`), never the
 * club-identity figure, which is one lodge's bed count and was previously used
 * as the denominator for all of them.
 */
interface LodgeAvailabilityState {
  /** The lodge these nights and this capacity belong to; null = default lodge. */
  lodgeId: string | null;
  /** Occupied beds per `yyyy-MM-dd`. An ABSENT key means "not loaded". */
  nights: Record<string, number>;
  /** The lodge's effective capacity, or null until a response has resolved it. */
  capacity: number | null;
}

/**
 * One cell's derived state (#2930). Computed once per render per day and then
 * read by the class, the disabled attribute, the accessible name and the
 * sub-label — the four places that previously each re-derived "is this day
 * full?" from `lodgeCapacity - (availability[date] ?? 0)` and could therefore
 * disagree.
 */
interface DayView {
  dateStr: string;
  role: DayRole;
  /** A past date inside the admin retroactive window (#1695). */
  isRetroPast: boolean;
  /**
   * Free beds at THIS lodge on this night, or null when either the night's
   * occupancy or the lodge's capacity has not been resolved. Null is not zero
   * and is not capacity — it is "we do not know", and it renders as that.
   */
  free: number | null;
  /** Neither the occupancy nor the capacity half of the subtraction is known. */
  availabilityUnknown: boolean;
  /** Known to have no free beds. False while availability is unknown. */
  isFull: boolean;
}

const EMPTY_AVAILABILITY: LodgeAvailabilityState = {
  lodgeId: null,
  nights: {},
  capacity: null,
};

export function BookingCalendar({ onDateSelect, selectedCheckIn, selectedCheckOut, lodgeId, allowPastDates = false, allowFullDates = false }: BookingCalendarProps) {
  /**
   * The month the calendar opens on, and the day it treats as "today", both come
   * from the CLUB's calendar (CT-4, #2870; INV-CONFIG-002).
   *
   * WHAT THIS REPLACES READ THE BROWSER'S CLOCK, and it was a live defect rather
   * than a theoretical one: a member booking from London at 10am New Zealand time
   * saw yesterday as "today", so the current lodge night was greyed out and
   * unselectable and the calendar opened on the wrong month either side of a
   * month boundary. The club's day is the same day for every viewer.
   */
  const clubTime = useClubTime();
  const clubToday = clubTime.today();
  const [currentMonth, setCurrentMonth] = useState(() => {
    const parts = calendarDateParts(clubToday);
    return { year: parts.year, month: parts.month - 1 };
  });
  const [availability, setAvailability] = useState<LodgeAvailabilityState>({
    ...EMPTY_AVAILABILITY,
    lodgeId: lodgeId ?? null,
  });
  const [seasons, setSeasons] = useState<Record<string, SeasonInfo>>({});
  const [selecting, setSelecting] = useState<"checkIn" | "checkOut">("checkIn");
  const [checkIn, setCheckIn] = useState<string | null>(selectedCheckIn ?? null);
  const [checkOut, setCheckOut] = useState<string | null>(selectedCheckOut ?? null);

  useEffect(() => {
    let cancelled = false;

    const requestedLodgeId = lodgeId ?? null;

    async function loadAvailability() {
      const res = await fetch(
        `/api/availability?year=${currentMonth.year}&month=${currentMonth.month}${
          lodgeId ? `&lodgeId=${encodeURIComponent(lodgeId)}` : ""
        }`
      );
      if (!res.ok || cancelled) {
        // A refused or abandoned month leaves its nights UNLOADED, which is now
        // a state the grid renders honestly. Before #2930 it left them absent
        // from a map whose reader defaulted absent to zero occupancy, so a
        // failed fetch drew an empty lodge.
        return;
      }

      const data = await res.json();
      if (cancelled) return;

      const loadedNights: Record<string, number> =
        data.availability && typeof data.availability === "object"
          ? data.availability
          : {};
      // The lodge's own effective capacity (#2930). Never fall back to the
      // club-identity figure when it is missing: a wrong denominator produces
      // confident, wrong bed counts, where an absent one produces a visible
      // "not loaded" the member can act on.
      const loadedCapacity =
        typeof data.lodgeCapacity === "number" ? data.lodgeCapacity : null;

      setAvailability((current) =>
        current.lodgeId === requestedLodgeId
          ? {
              lodgeId: requestedLodgeId,
              // MERGE, so every month paged through stays loaded and a stay
              // spanning a month boundary is judged against both of its months.
              nights: { ...current.nights, ...loadedNights },
              capacity: loadedCapacity ?? current.capacity,
            }
          : {
              // A different lodge: the accumulated nights counted somebody
              // else's beds, so they are discarded rather than merged.
              lodgeId: requestedLodgeId,
              nights: loadedNights,
              capacity: loadedCapacity,
            },
      );
      // Seasons accumulate across months like the nights do, but they are SPARSE
      // — only a day inside a season gets a key — so a blanket merge could never
      // remove one. A season that was deactivated or re-dated kept its label on
      // the grid until the lodge changed (#2930 fix round). This month's keys are
      // dropped before the fresh answer is merged, which makes the refetch
      // authoritative for the month it asked about and leaves every other month
      // standing.
      const monthPrefix = formatCalendarDayOnly(
        currentMonth.year,
        currentMonth.month,
        1,
      ).slice(0, "yyyy-MM-".length);
      const loadedSeasons: Record<string, SeasonInfo> =
        data.seasons && typeof data.seasons === "object" ? data.seasons : {};
      setSeasons((current) => {
        const kept: Record<string, SeasonInfo> = {};
        for (const [date, season] of Object.entries(current)) {
          if (!date.startsWith(monthPrefix)) kept[date] = season;
        }
        return { ...kept, ...loadedSeasons };
      });
    }

    void loadAvailability();

    return () => {
      cancelled = true;
    };
  }, [currentMonth.month, currentMonth.year, lodgeId]);

  /**
   * Everything accumulated belongs to the lodge it was counted for, so changing
   * lodge discards it SYNCHRONOUSLY (#2930 fix round).
   *
   * The load effect above discards on a lodge mismatch too, but only on the
   * branch where a response arrives. A member who is not eligible to book a
   * lodge gets a refused fetch on every month, so that branch never ran and the
   * grid went on rendering the PREVIOUS lodge's free-bed counts, heat colours
   * and full/not-full decisions against the new lodge's dates — including
   * drawing a held night at the new lodge as free. That is exactly the
   * confidently-wrong denominator this file's own comments forbid, and unknown
   * already has an honest rendering.
   *
   * Seasons are per lodge for the same reason (`lodgeNullTolerantScope`).
   */
  useEffect(() => {
    setSeasons({});
    setAvailability({ ...EMPTY_AVAILABILITY, lodgeId: lodgeId ?? null });
  }, [lodgeId]);

  // The grid's two facts are calendar-day facts, so the kernel answers both and
  // no `Date` is built (CT-4, #2870). The spelling this replaces was
  // host-local-midnight in and host-local out, which is self-consistent and
  // therefore correct — but it is the shape from which the next author reaches
  // for a UTC-midnight value and keeps `.getDay()`, shifting the whole grid by a
  // column for every viewer west of Greenwich. `currentMonth.month` stays
  // 0-based, matching `Date.getMonth()`; the kernel counts months 1-12.
  const daysInMonth = daysInCalendarMonth(
    currentMonth.year,
    currentMonth.month + 1,
  );
  const firstDay = calendarDayOfWeek(
    calendarDateFromParts(currentMonth.year, currentMonth.month + 1, 1),
  );
  // Adjust for Monday start (0=Mon, 6=Sun)
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;

  /**
   * The SELECTED lodge's effective capacity, or null until a response for this
   * lodge has resolved it (#2930).
   *
   * This used to be `useClubIdentity().lodgeCapacity`, which is a single
   * club-wide number: at any lodge whose capacity differs from it — a capped
   * lodge, a second lodge, a lodge whose beds were reconfigured — every free-bed
   * count, every heat colour and the full/not-full decision itself were computed
   * from the wrong denominator, against occupancy the server had counted for the
   * right one. `INV-CAP-001`: no path may treat one lodge's beds as another's.
   *
   * Null rather than a fallback, deliberately. A fallback denominator is a
   * confidently wrong number; null is an honestly unknown one, and the grid has
   * a rendering for that.
   */
  const lodgeCapacity = availability.capacity;

  // The CLUB's calendar day, as a date-only string, so every selectability
  // comparison stays a lexicographic (== chronological) compare of `yyyy-MM-dd`
  // values rather than instant arithmetic.
  const todayStr = clubToday;
  // Earliest clickable day. Under the retroactive flag this drops 365 days back
  // (calendar-day arithmetic, DST-immune); otherwise it is today.
  const minSelectableStr = allowPastDates
    ? addCalendarDays(todayStr, -RETROACTIVE_LOOKBACK_DAYS)
    : todayStr;

  /**
   * The cell's role for the pick currently in progress (#2930). Derived here
   * and nowhere else, so the disabled state, the click handler, the styling and
   * the accessible name are all answering the same question.
   */
  function dayRole(dateStr: string): DayRole {
    if (dateStr < minSelectableStr) return "unreachable";
    // Choosing the far end of the stay, and this date is after the arrival:
    // `[checkIn, dateStr)` leaves this night out of the stay entirely
    // (`INV-DATE-003`), so it is a departure morning and its own occupancy is
    // none of this booking's business. A date at or before the arrival restarts
    // the selection, which makes it an arrival candidate again.
    if (selecting === "checkOut" && checkIn && dateStr > checkIn) return "departure";
    return "arrival";
  }

  function handleDayClick(day: number) {
    const dateStr = formatCalendarDayOnly(currentMonth.year, currentMonth.month, day);

    if (dayRole(dateStr) === "unreachable") return;

    if (selecting === "checkIn") {
      setCheckIn(dateStr);
      setCheckOut(null);
      setSelecting("checkOut");
    } else {
      if (checkIn && dateStr > checkIn) {
        setCheckOut(dateStr);
        setSelecting("checkIn");
        onDateSelect(checkIn, dateStr);
      } else {
        // If selected date is before checkIn, treat as new checkIn
        setCheckIn(dateStr);
        setCheckOut(null);
        setSelecting("checkOut");
      }
    }
  }

  function getDayClass(view: DayView) {
    const { dateStr, role, isRetroPast, availabilityUnknown, isFull, free } = view;
    const season = seasons[dateStr];

    let classes = "relative flex h-12 w-10 flex-col items-center justify-center rounded-md text-sm font-medium transition-colors ";

    // Season top-border indicator
    if (season?.type === "WINTER") {
      classes += "border-t-2 border-info-7 ";
    } else if (season?.type === "SUMMER") {
      classes += "border-t-2 border-warning-7 ";
    }

    // Availability heat, token-driven so it dark-adapts (epic #1800). The
    // per-night free-bed count text below carries the same information, so colour
    // is never the only signal. The thresholds and branch order are byte-identical
    // to the previous green/amber/red/grey treatment — only the classes change.
    if (role === "unreachable") {
      classes += "text-muted-foreground cursor-not-allowed ";
    } else if (isRetroPast) {
      // Muted-but-clickable tint for a past date open to retroactive booking:
      // distinct from the availability heat and the full tint.
      classes += "bg-muted text-muted-foreground italic hover:shadow-sm cursor-pointer ";
    } else if (availabilityUnknown) {
      // This month has not loaded (or failed). Neutral and clickable: the server
      // is authoritative about capacity, so an unknown night is offered rather
      // than guessed at — and never painted as an empty lodge, which is what
      // defaulting missing occupancy to zero used to do (#2930).
      classes += "bg-muted text-muted-foreground hover:brightness-95 cursor-pointer ";
    } else if (isFull) {
      // Full night (0 beds) -> danger token, and CLICKABLE for everyone since
      // #2930. For a member that is how the waitlist is reached; for an admin it
      // is the #1767 over-capacity warn-and-confirm; as a departure morning the
      // night is not part of the stay at all. The "Waitlist"/"Full" label
      // rendered below states which without relying on colour.
      classes += "bg-danger-muted text-danger italic hover:brightness-95 cursor-pointer ";
    } else if (free !== null && free <= 5) {
      // Nearly full (1-5 beds) -> the information pair keeps this tier distinct
      // from the warning "filling" tier while remaining an explicit AA-gated
      // semantic endpoint in light and dark mode.
      classes += "bg-info-muted text-info hover:brightness-95 cursor-pointer ";
    } else if (free !== null && free <= 15) {
      // Filling (6-15 beds) -> warning token.
      classes += "bg-warning-muted text-warning hover:brightness-95 cursor-pointer ";
    } else {
      // Plenty (>15 beds) -> success token.
      classes += "bg-success-muted text-success hover:brightness-95 cursor-pointer ";
    }

    // Selected range uses the brand-gold accent, deliberately distinct from the
    // availability heat so the two never read as the same signal.
    if (checkIn && dateStr === checkIn) {
      classes += "!border-4 !border-double !border-brand-gold !bg-brand-gold !text-brand-charcoal ";
    } else if (checkOut && dateStr === checkOut) {
      classes += "!border-4 !border-double !border-brand-gold !bg-brand-gold !text-brand-charcoal ";
    } else if (checkIn && checkOut && dateStr > checkIn && dateStr < checkOut) {
      classes += "!border-2 !border-dashed !border-brand-gold !bg-muted !text-foreground ";
    }

    return classes;
  }

  function prevMonth() {
    setCurrentMonth((prev) => {
      if (prev.month === 0) return { year: prev.year - 1, month: 11 };
      return { ...prev, month: prev.month - 1 };
    });
  }

  function nextMonth() {
    setCurrentMonth((prev) => {
      if (prev.month === 11) return { year: prev.year + 1, month: 0 };
      return { ...prev, month: prev.month + 1 };
    });
  }

  const monthName = formatClubMonthYear(
    requireCalendarDate(
      formatCalendarDayOnly(currentMonth.year, currentMonth.month, 1),
    ),
  );

  // Unique seasons visible in the current month for the legend
  const uniqueSeasons = [...new Map(Object.values(seasons).map((s) => [s.name, s])).values()];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={prevMonth}>
          &lsaquo; Prev
        </Button>
        <h3 className="text-lg font-semibold">{monthName}</h3>
        <Button variant="outline" size="sm" onClick={nextMonth}>
          Next &rsaquo;
        </Button>
      </div>

      <div aria-live="polite" className="text-sm text-muted-foreground">
        {selecting === "checkIn" ? "Select check-in date" : "Select check-out date"}
      </div>

      <div className="grid grid-cols-7 justify-items-center gap-1 text-center">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="w-10 py-2 text-xs font-medium text-muted-foreground">
            {d}
          </div>
        ))}

        {Array.from({ length: startOffset }).map((_, i) => (
          <div key={`empty-${i}`} />
        ))}

        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
          const dateStr = formatCalendarDayOnly(currentMonth.year, currentMonth.month, day);
          // ABSENT IS NOT ZERO (#2930). `occupied` is null when this night has
          // not been loaded, and a null propagates through the subtraction to a
          // null `free` rather than resolving to an empty lodge.
          const occupied = availability.nights[dateStr] ?? null;
          const free =
            occupied === null || lodgeCapacity === null
              ? null
              : lodgeCapacity - occupied;
          const availabilityUnknown = free === null;
          const isFull = free !== null && free <= 0;
          const season = seasons[dateStr];
          // A day before the earliest selectable day stays disabled; a past day
          // still inside the retroactive window is clickable but muted (#1695).
          const role = dayRole(dateStr);
          const isRetroPast =
            allowPastDates && role !== "unreachable" && dateStr < todayStr;
          const view: DayView = {
            dateStr,
            role,
            isRetroPast,
            free,
            availabilityUnknown,
            isFull,
          };
          const dateLabel = formatClubLongWeekdayDate(requireCalendarDate(dateStr));
          const isCheckIn = Boolean(checkIn && dateStr === checkIn);
          const isCheckOut = Boolean(checkOut && dateStr === checkOut);
          const inRange = Boolean(
            checkIn && checkOut && dateStr > checkIn && dateStr < checkOut,
          );
          // Convey the visual selection highlight to screen readers, which
          // otherwise only hear the availability label and can't tell which day
          // is chosen.
          const selectionSuffix = isCheckIn
            ? ", selected as check-in"
            : isCheckOut
              ? ", selected as check-out"
              : inRange
                ? ", within your selected stay"
                : "";
          const retroSuffix = isRetroPast
            ? ", past date — retroactive booking"
            : "";
          const seasonSuffix = season?.name ? `, ${season.name} season` : "";
          // One accessible name per role (#2930). A departure morning says so
          // explicitly, because a cell that reads "full" and is still clickable
          // is otherwise inexplicable to somebody who cannot see the highlighted
          // arrival date it is being measured from.
          //
          // NOTHING HERE NAMES A WHOLE-LODGE HOLD, and nothing can: the route
          // reports a held night as a full lodge with zero free beds
          // (`INV-CAP-021`, `INV-CAP-038`, ADR-001 decision 6), so this code
          // cannot tell the two apart even in principle and every held night
          // takes the ordinary "full" wording below.
          const occupancyPhrase = availabilityUnknown
            ? "availability not loaded"
            : isFull
              ? "full"
              : `${free} of ${lodgeCapacity} beds free`;
          const rolePhrase =
            role === "departure"
              ? " — selectable as your check-out morning"
              : isFull
                ? allowFullDates
                  ? " — selectable for over-capacity booking"
                  : " — waitlist only"
                : "";
          const dayLabel =
            (role === "unreachable"
              ? `${dateLabel}, unavailable`
              : `${dateLabel}, ${occupancyPhrase}${rolePhrase}`) +
            retroSuffix +
            seasonSuffix +
            selectionSuffix;

          return (
            <button
              key={day}
              onClick={() => handleDayClick(day)}
              className={getDayClass(view)}
              // THE ROLE IS THE WHOLE TEST NOW (#2930). Only a day before the
              // earliest selectable day is disabled. A full future night is not:
              // for a member it is how the server-backed waitlist is reached,
              // for an admin it is the #1767 over-capacity warn-and-confirm, and
              // as a departure morning it is not part of the stay at all. Each
              // of those was previously a dead end, and the checkout one was a
              // dead end with no way round it.
              disabled={role === "unreachable"}
              aria-label={dayLabel}
              aria-pressed={isCheckIn || isCheckOut || inRange}
            >
              <span aria-hidden="true" className="leading-none">{day}</span>
              {season ? (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-0.5 text-[0.5rem] font-bold uppercase leading-none"
                  title={`${season.name} season`}
                >
                  {season.type === "WINTER" ? "W" : "S"}
                </span>
              ) : null}
              {role !== "unreachable" &&
                (isCheckIn || isCheckOut || inRange ? (
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-[0.625rem] font-semibold uppercase leading-none tracking-wide"
                  >
                    {isCheckIn ? "In" : isCheckOut ? "Out" : "Stay"}
                  </span>
                ) : availabilityUnknown ? (
                  // Not loaded. Deliberately not a number and deliberately not
                  // blank, so an unloaded month cannot be mistaken for an empty
                  // lodge (#2930). The accessible name says it in words.
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-[0.625rem] font-semibold uppercase leading-none tracking-wide"
                  >
                    ?
                  </span>
                ) : isFull ? (
                  // States availability without relying on colour; the
                  // aria-label already announces it for screen readers. A member
                  // looking at an arrival night gets the ACTION ("Waitlist")
                  // rather than only the state, because the state alone is what
                  // used to read as a dead end.
                  <span
                    aria-hidden="true"
                    className="mt-0.5 text-[0.625rem] font-semibold uppercase leading-none tracking-wide"
                  >
                    {role === "arrival" && !allowFullDates ? "Waitlist" : "Full"}
                  </span>
                ) : (
                  <span aria-hidden="true" className="text-xs leading-none mt-0.5">
                    {free}
                  </span>
                ))}
            </button>
          );
        })}
      </div>

      {/* Availability legend — swatches mirror the token-driven heat above */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-success-muted" /> Available (&gt;15 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-warning-muted" /> Filling (6-15 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-info-muted" /> Nearly full (1-5 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-danger-muted" />{" "}
          {allowFullDates ? "Full" : "Full — waitlist only"}
        </span>
      </div>

      {/*
        A full future night is still selectable (#2930), which is not what a
        calendar normally means by a red day, so the grid says what picking one
        actually does instead of leaving the member to guess from a colour. Not
        shown on the admin over-capacity grid, whose full days are the #1767
        warn-and-confirm overbook and not a waitlist at all.
      */}
      {!allowFullDates ? (
        <p className="text-xs text-muted-foreground">
          Full nights can still be selected &mdash; you will be offered the
          waitlist, and we will email you if a place opens up. A full night is
          also fine as your check-out morning, because you do not use a bed on
          the day you leave.
        </p>
      ) : null}

      {/* Season legend — only shown when season data is available */}
      {uniqueSeasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {uniqueSeasons.map((s) => (
            <span key={s.name} className="flex items-center gap-1">
              <span
                className={`h-3 w-3 rounded border-t-2 ${
                  s.type === "WINTER" ? "border-info-7" : "border-warning-7"
                }`}
              />
              <span aria-hidden className="font-semibold">
                {s.type === "WINTER" ? "W" : "S"}
              </span>
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
