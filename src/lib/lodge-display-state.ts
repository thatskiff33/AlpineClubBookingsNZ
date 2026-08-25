import type { AgeTier, DisplayNameGranularity } from "@prisma/client";
import { isValidArrivalTime } from "./arrival-time";
import {
  getActiveGuestsForNight,
  getGuestBedNightKeys,
  getGuestStayEnd,
  getGuestStayStart,
  getLodgeVisibleGuestsForDate,
  isGuestArrivingOnDay,
  isGuestDepartingOnDay,
} from "./booking-guest-stay-ranges";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "./booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
} from "./date-only";
import { clubTodayDateOnlyInstant } from "./club-time/server";
import { getCachedClubIdentity } from "./public-layout-config";
import {
  CLUB_THEME_ID,
  sanitiseLogoDataUrl,
  sanitiseLogoUrl,
} from "./club-theme-schema";
import { getSanitizedLodgeInstructions } from "./lodge-instructions";
import { DISPLAY_RELEVANT_MODULE_KEYS } from "./lodge-display/conditions";
import { lodgeNullTolerantScope } from "./lodges";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "./member-guest-consent";
import { loadEffectiveModuleFlags } from "./module-settings";
import { canServeMemberPhoneOnLodgeSurface, formatXeroPhone } from "./phone";
import type { ModuleKey } from "@/config/modules";
import { prisma } from "./prisma";

// The lobby display's data contract and privacy serialiser (fork issue #28,
// docs/lobby-display/design.md §5 and §10). THIS FILE IS THE SINGLE
// ENFORCEMENT POINT for what a public screen may show: names leave here
// already reduced to the configured granularity, minors are never
// individually named at any level, and no monetary or member-id field is ever
// selected. Every display module renders as a pure function of the DisplayState
// payload — templates cannot reach past it.
//
// The ONE contact exception (#125 / #37) is a member phone number, and it is
// released per-guest ONLY under the two-sided consent gate
// (`canServeMemberPhoneOnLodgeSurface`): the lodge has enabled phone display
// AND the member has opted in AND the guest is an adult AND the row already
// shows individual names. Both config flags default off, so by default no phone
// ever enters the payload.

export const DEFAULT_DISPLAY_NAME_GRANULARITY: DisplayNameGranularity =
  "FIRST_NAME_SURNAME_INITIAL";

export const DISPLAY_WINDOW_DEFAULT_DAYS = 3;
export const DISPLAY_WINDOW_MAX_DAYS = 7;

// A sole-occupancy booking only collapses to the whole-lodge blockout
// treatment when it is a genuine group take-over: an organisation booking, or
// at least this many guests. Keeps a lone mid-week guest off the blockout
// board. Documented in design.md §10; review-flagged on epic #25.
export const WHOLE_LODGE_MIN_GUESTS = 8;

const MINOR_AGE_TIERS: readonly AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

export interface DisplayStateGuest {
  label: string;
  stayStart: string;
  stayEnd: string;
  /**
   * Every lodge night this guest holds a bed for, sorted (#2735).
   *
   * `stayStart`/`stayEnd` is a half-open ENVELOPE and cannot express a gap: a
   * guest in on Friday, home on Saturday and back on Monday has the same
   * envelope as one who never left. This is the authoritative per-night
   * presence the bars are drawn from, so a stay with a gap draws as two bars
   * and the guest reads as leaving — and coming back — on the days they really
   * do. For a contiguous stay it is exactly `[stayStart, stayEnd)` expanded and
   * changes nothing.
   *
   * No new disclosure: the envelope already published the span, and the row
   * carrying this is already one the wall may name (`namesAllowed`).
   *
   * `readonly` because this is a SERIALISED payload: every consumer reads it
   * and none may sort or splice it in place. It also keeps an `as const` test
   * fixture assignable, which is what caught this — the payload's first array
   * field made every frozen fixture in the tree a type error.
   */
  nights: readonly string[];
  /** Adult member phone number — present ONLY when the two-sided consent gate
   * allows it (#125 / #37); omitted otherwise, so the default payload carries
   * no contact field. */
  phone?: string;
}

export interface DisplayStateBooking {
  /** Opaque per-row key — never the real booking id. */
  key: string;
  label: string;
  wholeLodge: boolean;
  roomId: string | null;
  /** Null when names are withheld (counts-only, family, org, whole-lodge). */
  guests: DisplayStateGuest[] | null;
  guestCount: number;
  stayStart: string;
  stayEnd: string;
  /**
   * The union of this row's guests' lodge nights, sorted (#2735) — see
   * {@link DisplayStateGuest.nights}.
   *
   * Present on EVERY row, including one whose names are withheld: a bar has to
   * be drawn for a family, an organisation and a whole-lodge blockout too, and
   * the row's `stayStart`/`stayEnd` already published the same span. It names
   * nobody — it is the same group-level occupancy fact the envelope was.
   *
   * This CHANGES NO COUNT. The occupancy buckets, the night counts and the
   * whole-lodge heuristic are all derived above, from the guest rows, before
   * any row is built.
   *
   * `readonly` for the same reason as {@link DisplayStateGuest.nights}.
   */
  nights: readonly string[];
  /**
   * The booking's expected arrival time as stored, `"HH:mm"` — display-only
   * information so the wall can say when tonight's arrivals are due (#2621,
   * owner decision 8 Aug). Null far more often than not, and null is the
   * ordinary case.
   *
   * IT RIDES THE NAME GATE, NOT ITS OWN. It is only ever non-null on a row that
   * is ALREADY naming individuals — the same `namesAllowed` decision that fills
   * `guests`. A row the wall may not name (a booking with a minor, an
   * organisation, a whole-lodge blockout, or COUNTS_ONLY granularity) gets no
   * time either, because "the group in room B arrives at 5:30" is a movement
   * fact about identifiable people on an unauthenticated public screen, and the
   * whole point of withholding the names was to not publish facts about who
   * those people are and what they are doing.
   *
   * It is also only non-null when the arrival falls INSIDE the board window: a
   * stay that began before the window shows no time, because a time-of-day with
   * no visible day beside it reads as "arriving at 5:30 today" for a guest who
   * arrived last Tuesday.
   *
   * This field CHANGES NO COUNT. It is not read by the occupancy buckets, the
   * night counts, the whole-lodge heuristic or anything else in this builder —
   * it is carried alongside them, unread.
   */
  arrivalTime: string | null;
}

/**
 * The kiosk's club-branding block (#2322).
 *
 * Sanitised HERE, not only on the write path: this surface reads the ClubTheme
 * columns directly rather than through `normaliseThemeValues`, so a hand-edited
 * row or an imported bundle could otherwise put an arbitrary string into an
 * `<img src>` on an unattended public screen. Exported as a test seam.
 */
// test seam
export function clubBrandingForDisplay(
  name: string,
  theme: { logoUrl?: string | null; logoDataUrl?: string | null } | null,
): DisplayState["club"] {
  return {
    name,
    logoUrl: sanitiseLogoUrl(theme?.logoUrl),
    logoDataUrl: sanitiseLogoDataUrl(theme?.logoDataUrl),
  };
}

export interface DisplayState {
  lodge: { name: string };
  /** Club branding for the header brand block (issue #56): the configured
   * club name and the club-theme logo — presentation-only fields already public
   * on every website page. `logoUrl` (#2322) is the served-image form and wins
   * over the legacy inlined `logoDataUrl`. Both are sanitised in
   * `buildDisplayState` before they reach this payload. */
  club: {
    name: string;
    logoUrl: string | null;
    logoDataUrl: string | null;
  };
  generatedAt: string;
  window: { start: string; days: number };
  rooms: Array<{ id: string; name: string }> | null;
  bookings: DisplayStateBooking[];
  occupancy: Array<{
    date: string;
    arriving: number;
    departing: number;
    staying: number;
  }>;
  chores: Array<{ date: string; title: string; assigneeLabels: string[] }>;
  rules: Array<{ title: string; html: string }> | null;
  /** Committee notice board content (#36): admin-authored free text,
   * rendered as text nodes only; {{config:<key>}} placeholders resolve
   * inside it at render. */
  notice: string | null;
  config: Record<string, string>;
  /** Display-relevant module flags only (ADR-003 §3): the capability
   * conditions read these instead of querying, so the evaluator stays a pure
   * function of the payload. Limited to DISPLAY_RELEVANT_MODULE_KEYS — the
   * whole club flag map is never shipped to a public wall. */
  capabilities: Record<string, boolean>;
  /**
   * The custodian(s) in residence today (#2286), or null when there is none.
   *
   * ONLY a bed-holding hut-leader assignment produces this slot: a role-only
   * assignment is not an occupancy and does not appear. The custodian is not a
   * BookingGuest, so their exclusion from the occupancy counts, the booking
   * rows and the chore roster is structural — there is nothing to filter.
   *
   * `count` is how many bed-holding custodians are in residence tonight. It is
   * a COUNT, not a flag, because a handover night legitimately has two people
   * on two different beds — the previous shape (one `findFirst`) silently named
   * one of them and hid the other, which is the one thing a "who is here" slot
   * must not do.
   *
   * `label` is the joined names, or null whenever ANY of them must not be
   * individually named: under COUNTS_ONLY granularity, and ALWAYS when a
   * minor-age custodian is among them regardless of granularity (the
   * file-level contract: minors are never individually named at any level).
   * All-or-nothing on purpose — naming the adult and omitting the minor next to
   * "Custodians" would identify the minor by elimination. The template then
   * renders the role word and the count.
   *
   * No phone, no dates, no member id — the slot carries names or a count.
   */
  custodian: { label: string | null; count: number } | null;
}

function isMinor(ageTier: AgeTier): boolean {
  return MINOR_AGE_TIERS.includes(ageTier);
}

/** Reduce an adult's name to the configured granularity. */
export function reduceName(
  firstName: string,
  lastName: string,
  granularity: DisplayNameGranularity
): string | null {
  const first = firstName.trim();
  const last = lastName.trim();
  switch (granularity) {
    case "FULL_NAME":
      return [first, last].filter(Boolean).join(" ");
    case "FIRST_NAME_SURNAME_INITIAL":
      return last ? `${first} ${last[0].toUpperCase()}` : first;
    case "FIRST_NAME_ONLY":
      return first;
    case "COUNTS_ONLY":
      return null;
  }
}

interface OrganiserShape {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

/**
 * Whether a booking's guests may be individually named anywhere on the wall
 * (design.md §10 settled rules; issue #174): sole occupancy of the lodge, any
 * minor in the booking, an organisation organiser, or counts-only
 * granularity all suppress individual names in favour of the booking's
 * reduced group label. This is the SINGLE definition of that condition —
 * every board that might name an individual (booking rows, chore assignees)
 * calls this instead of re-deriving the condition list.
 *
 * `soleOccupancy`, not `wholeLodge` (#2735). It was renamed because the two
 * came apart: `row.wholeLodge` says the wall may draw a BLOCKOUT (the group
 * holds a night inside the window), while this asks whether the group had the
 * building to itself on any night that put it on the wall — which includes the
 * night before the window, whose occupants are still here on the first morning.
 * The privacy rule follows the second, so it is the second that belongs here.
 */
export function namesAllowedForBooking(options: {
  soleOccupancy: boolean;
  containsMinors: boolean;
  organiserAgeTier: AgeTier;
  granularity: DisplayNameGranularity;
}): boolean {
  return (
    !options.soleOccupancy &&
    !options.containsMinors &&
    options.organiserAgeTier !== "NOT_APPLICABLE" &&
    options.granularity !== "COUNTS_ONLY"
  );
}

/**
 * The booking-level label (design.md §10 settled rules):
 * - organisation organiser (schools, clubs): the organisation's full name at
 *   EVERY granularity — organisations are not people;
 * - booking containing minors: a family/group label, never individual names;
 * - otherwise: the organiser's name at the configured granularity.
 */
export function bookingLabel(
  organiser: OrganiserShape,
  options: {
    granularity: DisplayNameGranularity;
    containsMinors: boolean;
    guestCount: number;
  }
): string {
  const { granularity, containsMinors, guestCount } = options;

  if (organiser.ageTier === "NOT_APPLICABLE") {
    return [organiser.firstName.trim(), organiser.lastName.trim()]
      .filter(Boolean)
      .join(" ");
  }

  if (containsMinors) {
    const last = organiser.lastName.trim();
    if (
      last &&
      (granularity === "FULL_NAME" ||
        granularity === "FIRST_NAME_SURNAME_INITIAL")
    ) {
      return `${last} family`;
    }
    return `Family of ${guestCount}`;
  }

  return (
    reduceName(organiser.firstName, organiser.lastName, granularity) ??
    `Guests · ${guestCount}`
  );
}

/** Sanitise the per-lodge config glob to a flat string map with caps. */
export function sanitiseDisplayConfig(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) continue;
    if (typeof value !== "string") continue;
    // Strip control characters; values are additionally HTML-escaped at
    // render time by the config-token resolver (LTV-006).
    out[key] = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500);
  }
  return out;
}

export function clampDisplayWindowDays(requested: number | null): number {
  if (requested === null || !Number.isFinite(requested)) {
    return DISPLAY_WINDOW_DEFAULT_DAYS;
  }
  return Math.min(DISPLAY_WINDOW_MAX_DAYS, Math.max(1, Math.floor(requested)));
}

/**
 * Build the DisplayState payload for one lodge. `lodgeId` comes from the
 * display device's FK (checkDisplayAuth) — every query below is scoped to it
 * and nothing from any other lodge can appear (issue #28 AC5).
 */
export async function buildDisplayState(
  lodgeId: string,
  options: { days?: number | null; windowStart?: Date | null } = {}
): Promise<DisplayState | null> {
  const days = clampDisplayWindowDays(options.days ?? null);
  // `windowStart` is the admin-preview simulated date (issue #60); it only
  // reaches here from the preview branch of the state route — device fetches
  // never pass it, so a real screen always starts today.
  //
  // WHOSE "TODAY", AND A DECLARED `src/lib` FIX INSIDE CT-4 GROUP E (#2870).
  // `src/lib/**` is group F by the epic's published partition, so group E does
  // not normally touch it. It has to here: group E migrated the wall's HEADER to
  // read the live day through `club.calendarDateOf(now)` — the club's persisted
  // zone — while this line, which keys the whole board (occupancy, arrivals,
  // roster, chores, custodian in residence), still took the CONTAINER's day from
  // `getTodayDateOnly()`. For a club in `Pacific/Auckland` on a `TZ=UTC` host
  // that is a twelve-hour window every day in which the header reads
  // "Fri, 17 Apr" above a board still showing 16 April's guests and arrivals.
  // One unattended screen, contradicting itself, with nobody to reload it.
  //
  // The club's today is a CALENDAR DATE; `clubTodayDateOnlyInstant` re-encodes it
  // as the UTC-midnight `Date` every query below and every `@db.Date` bound wants,
  // which is exactly the shape `getTodayDateOnly()` returned. CT-6 (#2991) still
  // owns carrying `CalendarDate` through this function rather than re-encoding here.
  const startDate = options.windowStart ?? (await clubTodayDateOnlyInstant());
  const endExclusive = addDaysDateOnly(startDate, days);
  const endInclusive = addDaysDateOnly(endExclusive, -1);
  const windowDates = eachDateOnlyInRange(startDate, endExclusive).slice(0, days);
  // The nights whose occupants can appear anywhere in this window. Night
  // `startDate - 1` counts: its occupant is still in the lodge on the window's
  // first morning (INV-DATE-002).
  const priorNight = addDaysDateOnly(startDate, -1);
  const windowFirstNightKey = formatDateOnly(priorNight);
  const windowLastNightKey = formatDateOnly(endInclusive);

  const [lodge, flags] = await Promise.all([
    prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: {
        id: true,
        name: true,
        active: true,
        displayConfig: true,
        displayNameGranularity: true,
        displayNotice: true,
        showGuestPhonesOnScreens: true,
      },
    }),
    loadEffectiveModuleFlags(),
  ]);
  if (!lodge || !lodge.active) return null;

  const granularity =
    lodge.displayNameGranularity ?? DEFAULT_DISPLAY_NAME_GRANULARITY;

  const [bookings, rooms, choreRows, instructionDocs] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        checkIn: { lte: endInclusive },
        checkOut: { gte: startDate },
        ...lodgeNullTolerantScope(lodgeId),
        guests: {
          some: {
            stayStart: { lte: endInclusive },
            stayEnd: { gte: startDate },
            ...OPERATIONALLY_PRESENT_GUEST_WHERE,
          },
        },
      },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        // #2621: display-only information for the wall's arrival rows. Selected
        // here, gated by `namesAllowed` and the window in the row builder below,
        // and read by NOTHING in the occupancy, night-count, whole-lodge or
        // chore logic in this file.
        expectedArrivalTime: true,
        // Authoritative whole-lodge treatment (#122 / epic #116, ADR-001
        // decision 4): an explicit exclusive hold drives the blockout board,
        // with the sole-occupancy heuristic as the fallback for un-flagged
        // bookings.
        wholeLodgeHold: true,
        member: {
          select: { firstName: true, lastName: true, ageTier: true },
        },
        guests: {
          // Owner decision D-12 (#2307): the wall describes who is actually at
          // the lodge, so an unconsented member guest is not in this set.
          //
          // THIS CHANGES HOW A LODGE IS LABELLED, deliberately. The guest set
          // feeds the sole-occupancy whole-lodge heuristic (guestCount >=
          // WHOLE_LODGE_MIN_GUESTS) and the containsMinors decision, both of
          // which gate whether individual names may be shown at all. A booking
          // that reaches the group threshold only by counting a PENDING guest is
          // not a group on the wall, and a booking whose only minor is a PENDING
          // guest has no minor present. That is the consistent reading of D-12:
          // the board describes the lodge as it will be, not as the capacity
          // ledger holds it. A dedicated test makes the threshold flip visible
          // rather than incidental.
          where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            ageTier: true,
            stayStart: true,
            stayEnd: true,
            // #125 / #37: the member's opt-in + phone, released per-guest only
            // under `canServeMemberPhoneOnLodgeSurface` in the row builder.
            member: {
              select: {
                ageTier: true,
                lodgeScreenPhoneOptIn: true,
                phoneCountryCode: true,
                phoneAreaCode: true,
                phoneNumber: true,
              },
            },
            nights: { select: { stayDate: true } },
            bedAllocations: {
              where: {
                stayDate: { gte: startDate, lte: endInclusive },
              },
              orderBy: { stayDate: "asc" },
              select: { roomId: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
    }),
    flags.bedAllocation
      ? prisma.lodgeRoom.findMany({
          where: { active: true, lodgeId },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    flags.chores
      ? prisma.choreAssignment.findMany({
          where: {
            date: { gte: startDate, lt: endExclusive },
            booking: {
              status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
              ...lodgeNullTolerantScope(lodgeId),
            },
          },
          orderBy: [{ date: "asc" }],
          select: {
            date: true,
            choreTemplate: { select: { name: true } },
            bookingGuest: {
              select: { firstName: true, lastName: true, ageTier: true },
            },
            booking: {
              select: {
                // `id` looks the booking up in `wholeLodgeBookingIds` below —
                // the same whole-lodge decision the booking rows use (#174).
                id: true,
                member: {
                  select: { firstName: true, lastName: true, ageTier: true },
                },
                // D-12 (#2307): the chore panel re-derives containsMinors and
                // the group headcount for its own assignee label, so it has to
                // read the SAME guest set as the booking rows above or the two
                // panels would label one booking two different ways on one wall.
                guests: {
                  where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
                  select: { ageTier: true },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    getSanitizedLodgeInstructions(lodgeId),
  ]);

  // --- occupancy + per-booking visibility per window day -------------------
  const perBookingDayCounts = new Map<string, Map<string, number>>();
  // NIGHT counts (departure day excluded) drive whole-lodge detection: a
  // group leaving Monday morning still had the lodge to itself even when
  // someone arrives Monday evening (issue #58 — the departure-day overlap
  // used to break the blockout for every back-to-back handover).
  const perBookingNightCounts = new Map<string, Map<string, number>>();
  const nightTotals = new Map<string, number>();
  const occupancy = windowDates.map((date) => {
    const dateKey = formatDateOnly(date);
    let arriving = 0;
    let departing = 0;
    let staying = 0;

    for (const booking of bookings) {
      const visible = getLodgeVisibleGuestsForDate(
        booking.guests,
        date,
        booking,
        { includeDepartureDate: true }
      );
      if (visible.length > 0) {
        let dayMap = perBookingDayCounts.get(booking.id);
        if (!dayMap) {
          dayMap = new Map();
          perBookingDayCounts.set(booking.id, dayMap);
        }
        dayMap.set(dateKey, visible.length);
      }
      // NIGHTS, asked as a night question of the WHOLE guest list (#2628,
      // finished in #2735). This started life as "everyone visible except
      // whoever's `stayEnd` is today"; #2628 made it a real night question but
      // still asked it of `visible`, which left the count bounded above by the
      // visibility rule. #2735 makes the visibility rule per-segment, so the
      // count is now taken from `booking.guests` and shares nothing with it at
      // all: no change to who is SHOWN on the wall can add or remove a night
      // here, in either direction. It is the phantom night that matters — a
      // sole-occupancy count is what decides whether an unauthenticated screen
      // prints guests' names and phone numbers (INV-DATE-006, INV-DATE-023,
      // issue #58). THAT SEPARATION IS WHAT MADE THE #2735 WIDENING SAFE:
      // couple this back to `visible` and the visibility rule has to narrow
      // again first.
      //
      // The value is unchanged by both steps: `visible` has always been a
      // superset of the guests active on `date` (a departure morning is added,
      // never a night removed), so filtering it by the night model and filtering
      // the whole list by the night model give the same guests.
      const nightGuests = getActiveGuestsForNight(booking.guests, date, booking);
      if (nightGuests.length > 0) {
        let nightMap = perBookingNightCounts.get(booking.id);
        if (!nightMap) {
          nightMap = new Map();
          perBookingNightCounts.set(booking.id, nightMap);
        }
        nightMap.set(dateKey, nightGuests.length);
        nightTotals.set(dateKey, (nightTotals.get(dateKey) ?? 0) + nightGuests.length);
      }
      // ARRIVING / DEPARTING, per SEGMENT (#2735). These used to compare the
      // guest's overall envelope ends against the date, so a guest who goes
      // home mid-stay and comes back arrived once and left once no matter how
      // many times they really did either. `isGuestArrivingOnDay` /
      // `isGuestDepartingOnDay` are the named operational-day labels — which
      // half of the day the guest occupies — so nights {10, 12} arrives on the
      // 10th AND the 12th and leaves on the 11th AND the 13th.
      //
      // Unchanged for every contiguous stay: "occupies the evening half only"
      // is `stayStart` and nothing else, and "occupies the morning half only"
      // is `stayEnd` and nothing else. Counted over `visible`, which is exactly
      // the guests occupying either half, so neither label can fall outside it.
      //
      // NEITHER OF THESE IS A NIGHT COUNT. `nightTotals` above is the only
      // input to sole-occupancy detection and is derived independently.
      staying += visible.length;
      arriving += visible.filter((guest) =>
        isGuestArrivingOnDay(guest, date, booking)
      ).length;
      departing += visible.filter((guest) =>
        isGuestDepartingOnDay(guest, date, booking)
      ).length;
    }

    return { date: dateKey, arriving, departing, staying };
  });

  // --- whole-lodge detection: an explicit exclusive hold is AUTHORITATIVE
  // (#122 / epic #116, ADR-001 decision 4) — a flagged booking always gets the
  // blockout treatment regardless of headcount. The sole-occupancy heuristic
  // (design.md §10: sole occupancy on every NIGHT the booking covers AND a
  // genuine group — organisation or >= threshold) is the fallback for
  // un-flagged bookings.
  //
  // TWO SETS, NOT ONE (#2735), because the two things "whole lodge" used to
  // mean pull apart on a departure morning:
  //
  // - `wholeLodgeBookingIds` is the BLOCKOUT VIEW. The group holds the lodge on
  //   a night INSIDE the window, so `row.wholeLodge` is true and the wall may
  //   say the lodge is booked out — the blockout panel, the week strip, the
  //   rotating `occupancy:whole-lodge-*` conditions. A group that checked out on
  //   the window's FIRST MORNING holds nothing tonight and must not turn the
  //   wall into a "fully booked" statement over an empty lodge.
  // - `soleOccupancyBookingIds` is the PRIVACY GATE, and it is a SUPERSET. It
  //   also covers the group whose only presence in this window is that departure
  //   morning: they had the lodge to themselves on night `startDate - 1`, and
  //   naming fourteen people who were alone in the building is exactly the
  //   disclosure issue #58 and design.md §10 refuse. The morning they leave is
  //   not an exception to that (INV-DATE-006).
  //
  // Being a superset is the safety property: this can only ever WITHHOLD more
  // names, never publish one the old rule withheld.
  const wholeLodgeBookingIds = new Set<string>();
  const soleOccupancyBookingIds = new Set<string>();
  // Night `startDate - 1`, counted the same way the window's own nights are.
  // Needed because `perBookingNightCounts`/`nightTotals` are scanned over the
  // window only, and the booking this closes over holds no night in it. NOT
  // folded into that scan: a group sole on nights 13 and 14 but SHARING night
  // 12 would then lose its blockout and start naming its members, which is the
  // same disclosure in the opposite direction.
  const priorNightCounts = new Map<string, number>();
  let priorNightTotal = 0;
  for (const booking of bookings) {
    const count = getActiveGuestsForNight(booking.guests, priorNight, booking)
      .length;
    if (count > 0) {
      priorNightCounts.set(booking.id, count);
      priorNightTotal += count;
    }
  }
  for (const booking of bookings) {
    if (booking.wholeLodgeHold) {
      wholeLodgeBookingIds.add(booking.id);
      soleOccupancyBookingIds.add(booking.id);
      continue;
    }
    const guestCount = booking.guests.length;
    const isOrganisation = booking.member.ageTier === "NOT_APPLICABLE";
    const isGroup = isOrganisation || guestCount >= WHOLE_LODGE_MIN_GUESTS;
    if (!isGroup) continue;
    const nightMap = perBookingNightCounts.get(booking.id);
    if (nightMap && nightMap.size > 0) {
      const isSoleOnAllNights = [...nightMap.entries()].every(
        ([dateKey, count]) => nightTotals.get(dateKey) === count
      );
      if (isSoleOnAllNights) {
        wholeLodgeBookingIds.add(booking.id);
        soleOccupancyBookingIds.add(booking.id);
      }
      continue;
    }
    // No night inside the window at all, yet the booking can still hold a row:
    // its only presence here is the morning after night `startDate - 1`. Judge
    // sole occupancy on that night alone — the only night it has here.
    const priorCount = priorNightCounts.get(booking.id) ?? 0;
    if (priorCount > 0 && priorCount === priorNightTotal) {
      soleOccupancyBookingIds.add(booking.id);
    }
  }

  // --- booking rows: split per (booking, room); privacy-reduce labels ------
  const rows: DisplayStateBooking[] = [];
  for (const booking of bookings) {
    if (!perBookingDayCounts.has(booking.id)) continue; // nothing visible in window

    const containsMinors = booking.guests.some((guest) => isMinor(guest.ageTier));
    const wholeLodge = wholeLodgeBookingIds.has(booking.id);
    const label = bookingLabel(booking.member, {
      granularity,
      containsMinors,
      guestCount: booking.guests.length,
    });
    // Individual names appear only when every privacy condition allows it.
    //
    // The sole-occupancy set, NOT `wholeLodge` (#2735). They are the same on
    // every row that holds a night in the window; they differ only for the group
    // whose one appearance here is the morning they leave, where the wall must
    // still not name them but must also not claim the lodge is booked out. See
    // the two sets above.
    const namesAllowed = namesAllowedForBooking({
      soleOccupancy: soleOccupancyBookingIds.has(booking.id),
      containsMinors,
      organiserAgeTier: booking.member.ageTier,
      granularity,
    });

    // The nights each guest actually holds a bed for (INV-DATE-020): the
    // explicit `BookingGuestNight` set when they carry one, the half-open
    // envelope when they do not. Derived once per guest and reused for the
    // in-window test, the row's own night set and the per-guest payload, so
    // those three can never disagree about which nights a guest is here.
    const nightKeysByGuest = new Map<string, string[]>(
      booking.guests.map((guest) => [
        guest.id,
        getGuestBedNightKeys(guest, booking),
      ])
    );

    const byRoom = new Map<string | null, typeof booking.guests>();
    for (const guest of booking.guests) {
      // In the window if the guest is in the lodge on any of its days. A guest
      // occupies day D when night D or night D-1 is theirs (INV-DATE-004), so
      // that is exactly one booked night in `[startDate - 1, endInclusive]`.
      //
      // Identical to the envelope-overlap test it replaces for every contiguous
      // stay — `[stayStart, stayEnd)` meets `[startDate - 1, endInclusive]`
      // exactly when `[stayStart, stayEnd]` meets `[startDate, endInclusive]`.
      // It differs only for a SPARSE stay whose nights all fall outside the
      // window while its envelope spans it, which the envelope test listed on
      // the wall as present (#2735).
      const nightKeys = nightKeysByGuest.get(guest.id) ?? [];
      const inWindow = nightKeys.some(
        (key) => key >= windowFirstNightKey && key <= windowLastNightKey
      );
      if (!inWindow) continue;
      const roomId =
        rooms === null ? null : guest.bedAllocations[0]?.roomId ?? null;
      const group = byRoom.get(roomId) ?? [];
      group.push(guest);
      byRoom.set(roomId, group);
    }

    let rowIndex = 0;
    for (const [roomId, guests] of byRoom) {
      const stayStarts = guests.map((g) => getGuestStayStart(g, booking).getTime());
      const stayEnds = guests.map((g) => getGuestStayEnd(g, booking).getTime());
      const rowStayStart = Math.min(...stayStarts);
      // The row's own night set: the union of its guests' nights, sorted. For
      // every contiguous stay this is exactly `[stayStart, stayEnd)` expanded,
      // so the bars it draws are the bars drawn today. It exists so a stay with
      // a GAP in it draws as two bars rather than one unbroken one (#2735) —
      // `stayStart`/`stayEnd` alone cannot express a gap, and a guest booked in
      // on Friday, home on Saturday and back on Monday was shown to the lobby
      // as though they never left.
      const rowNights = [
        ...new Set(
          guests.flatMap((g) => nightKeysByGuest.get(g.id) ?? [])
        ),
      ].sort();
      // #2621 — the expected arrival time, and the four things that must all be
      // true before an unauthenticated wall may print it.
      //
      // 1. `namesAllowed`. Identical gate to `guests` below, deliberately
      //    re-used rather than re-derived: a row the wall may not name may not
      //    carry a movement time for the people on it either. A minor in the
      //    booking, an organisation organiser, a whole-lodge blockout or
      //    COUNTS_ONLY granularity each suppress it, exactly as they suppress
      //    the names.
      // 2. The row's own start is inside the window. A time-of-day printed
      //    against a bar that begins before the board's first day reads as
      //    tonight, and would be wrong every day after the first.
      // 3. THE ROW STARTS AT THE BOOKING'S CHECK-IN. The stored value describes
      //    when the BOOKING arrives, and nothing else — there is one time per
      //    booking, no per-guest and no per-room time. A row's start can be
      //    later than the booking's check-in in two ordinary ways: a guest with
      //    their own later `stayStart` (a partial stay, #713), and a per-room
      //    split where one room fills up later in the stay. In both cases
      //    condition 2 is satisfied while the booking itself checked in days
      //    earlier, and the bar would print `arr 5:30 PM` beside a mid-window
      //    start as though that party were arriving tonight. So the time rides
      //    only the row that really is the booking's arrival; every other row of
      //    the same booking shows none. (`rowStayStart` is a date-only
      //    millisecond value on both sides — `getGuestStayStart` falls back to
      //    `booking.checkIn` itself — so the equality is exact, not a
      //    same-day-ish comparison.)
      // 4. The stored value matches the canonical shape. The wall is stricter
      //    than the kiosk here — this file is the single enforcement point for
      //    what a public screen may show, so it renders only values of the
      //    known form, and a malformed pre-#2621 row degrades to no time rather
      //    than to arbitrary text on a lobby TV.
      //
      // Nothing above touches a count. `stayStarts`/`stayEnds` are the existing
      // arrays; `rowStayStart` only replaces the `Math.min` that was already
      // inlined into `stayStart` below, and produces the identical value.
      const arrivalTime =
        namesAllowed &&
        booking.expectedArrivalTime !== null &&
        rowStayStart >= startDate.getTime() &&
        rowStayStart === booking.checkIn.getTime() &&
        isValidArrivalTime(booking.expectedArrivalTime)
          ? booking.expectedArrivalTime
          : null;
      rows.push({
        key: `row-${rows.length + 1}-${rowIndex++}`,
        label,
        wholeLodge,
        roomId,
        guests: namesAllowed
          ? guests.map((guest) => {
              // Phone rides the same row that already shows an individual name.
              // The member's own age tier decides adulthood (falls back to the
              // guest tier for a non-member guest, who has no opt-in and so is
              // filtered out anyway).
              const phone =
                guest.member &&
                canServeMemberPhoneOnLodgeSurface({
                  lodgeShowGuestPhonesOnScreens: lodge.showGuestPhonesOnScreens,
                  memberOptedIn: guest.member.lodgeScreenPhoneOptIn,
                  ageTier: guest.member.ageTier ?? guest.ageTier,
                })
                  ? formatXeroPhone(guest.member)
                  : null;
              return {
                label:
                  reduceName(guest.firstName, guest.lastName, granularity) ?? "",
                stayStart: formatDateOnly(getGuestStayStart(guest, booking)),
                stayEnd: formatDateOnly(getGuestStayEnd(guest, booking)),
                nights: nightKeysByGuest.get(guest.id) ?? [],
                ...(phone ? { phone } : {}),
              };
            })
          : null,
        guestCount: guests.length,
        stayStart: formatDateOnly(new Date(rowStayStart)),
        stayEnd: formatDateOnly(new Date(Math.max(...stayEnds))),
        nights: rowNights,
        arrivalTime,
      });
    }
  }

  // --- chores: assignee labels obey the SAME namesAllowed decision as the
  // booking rows (#174) — a chore assignee is never named more precisely
  // than that booking's own row on the wall.
  const chores = choreRows.map((assignment) => {
    const assignee = assignment.bookingGuest;
    let assigneeLabels: string[] = [];
    if (assignee) {
      const bookingContainsMinors = assignment.booking.guests.some((guest) =>
        isMinor(guest.ageTier)
      );
      // The SAME sole-occupancy set the booking's own row used (#2735), not the
      // narrower blockout set: a chore assignee is never named more precisely
      // than that booking's row, and the row withholds names on the group's
      // departure morning too.
      const namesAllowed = namesAllowedForBooking({
        soleOccupancy: soleOccupancyBookingIds.has(assignment.booking.id),
        containsMinors: bookingContainsMinors,
        organiserAgeTier: assignment.booking.member.ageTier,
        granularity,
      });
      if (namesAllowed) {
        const label = reduceName(
          assignee.firstName,
          assignee.lastName,
          granularity
        );
        assigneeLabels = label ? [label] : [];
      } else {
        // Names are withheld for this booking (minor present, whole-lodge,
        // organisation organiser, or counts-only): fall back to the
        // booking's reduced group label rather than the assignee's name.
        assigneeLabels = [
          bookingLabel(assignment.booking.member, {
            granularity,
            containsMinors: bookingContainsMinors,
            guestCount: assignment.booking.guests.length,
          }),
        ];
      }
    }
    return {
      date: formatDateOnly(assignment.date),
      title: assignment.choreTemplate.name,
      assigneeLabels,
    };
  });

  // Only the display-relevant module flags reach the public payload — never
  // the whole club flag map (ADR-003 §3). The capability conditions read these.
  const capabilities: Record<string, boolean> = Object.fromEntries(
    (Object.keys(DISPLAY_RELEVANT_MODULE_KEYS) as ModuleKey[]).map((key) => [
      key,
      Boolean(flags[key]),
    ])
  );

  // Club branding is best-effort: a missing theme row must never take the
  // board down, so failures degrade to a text-only brand block.
  const theme = await prisma.clubTheme
    .findUnique({
      where: { id: CLUB_THEME_ID },
      select: { logoUrl: true, logoDataUrl: true },
    })
    .catch(() => null);

  // DB-first club name (E3 #1929, leak fixed C5 #1984): resolve through
  // ClubIdentitySettings so an admin rename reaches the lobby display, instead of
  // reading the raw config/club.json name. Uses the tagged 15s cache (invalidated
  // by the admin identity PUT via invalidatePublicClubIdentity) rather than an
  // uncached read, because /api/display/state is polled. Never throws — falls
  // back to config.
  const clubIdentity = await getCachedClubIdentity();

  // Custodian in residence (#2286). Scoped to this lodge and to the window's
  // CURRENT day — the wall answers "who is here now", not "who will be here on
  // Thursday". `bedId: not null` is the whole gate: a role-only assignment is
  // not an occupancy and never renders a slot.
  //
  // Gated on the hutLeaders module like every other module-owned read in this
  // builder (`flags.bedAllocation` for rooms, `flags.chores` for the roster): a
  // club with the module off has no hut-leader surface at all, so the wall must
  // not grow one. The query is skipped entirely rather than filtered later.
  //
  // findMany, NOT findFirst (#2286 review B11): a handover night has TWO
  // custodians on two different beds, and a findFirst named one and silently
  // dropped the other. `take` is a sanity bound — the assignment overlap rule
  // permits a one-day handover, so more than a handful on one night means bad
  // data, not a case to render.
  const custodianAssignments = flags.hutLeaders
    ? await prisma.hutLeaderAssignment.findMany({
        where: {
          bedId: { not: null },
          startDate: { lte: startDate },
          endDate: { gte: startDate },
          ...lodgeNullTolerantScope(lodgeId),
        },
        select: {
          member: { select: { firstName: true, lastName: true, ageTier: true } },
        },
        orderBy: [{ startDate: "asc" }, { id: "asc" }],
        take: 8,
      })
    : [];
  // A minor is never individually named at ANY granularity (the contract at the
  // top of this file). Nothing structurally stops a minor-age member being made
  // custodian, so the guard lives here rather than relying on the admin
  // surface. All-or-nothing across the whole set: naming one of two custodians
  // and withholding the other would identify the withheld person by
  // elimination, so one un-nameable custodian withholds every name and the wall
  // falls back to the role word plus the count.
  const custodianNames = custodianAssignments.map((assignment) =>
    isMinor(assignment.member.ageTier)
      ? null
      : reduceName(
          assignment.member.firstName,
          assignment.member.lastName,
          granularity,
        ),
  );
  const custodian =
    custodianAssignments.length > 0
      ? {
          label: custodianNames.every((name) => name)
            ? custodianNames.join(" · ")
            : null,
          count: custodianAssignments.length,
        }
      : null;

  return {
    lodge: { name: lodge.name },
    club: clubBrandingForDisplay(clubIdentity.name, theme),
    generatedAt: new Date().toISOString(),
    window: { start: formatDateOnly(startDate), days },
    rooms,
    bookings: rows,
    occupancy,
    chores,
    rules:
      instructionDocs.length > 0
        ? instructionDocs.map((doc) => ({
            title: doc.title,
            html: doc.contentHtml,
          }))
        : null,
    notice:
      lodge.displayNotice && lodge.displayNotice.trim().length > 0
        ? lodge.displayNotice.trim().slice(0, 2000)
        : null,
    config: sanitiseDisplayConfig(lodge.displayConfig),
    capabilities,
    custodian,
  };
}
