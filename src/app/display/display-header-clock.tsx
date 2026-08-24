"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { APP_LOCALE } from "@/config/operational";
import {
  asClubTimeZone,
  bindClubTime,
  dateOnlyInstantOf,
  formatClubWeekdayDate,
  parseCalendarDate,
  requireClubTimeZone,
  type BoundClubTime,
} from "@/lib/club-time";
import { CLUB_TIME_ZONE_FALLBACK } from "@/lib/club-time-zone";

/**
 * The lobby display's header clock, and the club timezone it runs on.
 *
 * Split out of `display-screen.tsx` when CT-4 (#2870) moved it off the
 * environment: the clock, its two formatters, the preview-date reader and the
 * binding that supplies them are one subject, and that file is already well over
 * its size budget. Nothing else here changed in the move.
 */

/*
  THE CLUB'S CLOCK, CARRIED DOWN THIS TREE AS DATA (CT-4, #2870;
  INV-CONFIG-002).

  `/display` is outside both route-group chrome components on purpose, so the
  application's shared club-time provider is not above it. The zone is resolved
  on the SERVER in `page.tsx` and handed to `DisplayScreen` as a prop - see that
  file for why a prop rather than a mount.

  A CONTEXT RATHER THAN A PROP FROM HERE DOWN, and the reason is structural:
  `LodgeHeader` - the only consumer - is also registered in
  `PAGE_MODULE_COMPONENTS` and rendered generically as `<Module state={state} />`
  from a template-driven map, so there is no call site to add a prop to. The
  context is deliberately PRIVATE to this file and named apart from the shared
  hook, so the provider-mount census keeps reading this tree as one that reaches
  no shared-provider consumer. CT-6 (#2991) can collapse it into the shared
  provider in one edit if this surface ever joins the chrome.

  `null` means "no provider above me" and is NOT a usable zone: a default here
  would make a missing mount render a plausible wrong hour on a wall nobody is
  watching, which is the exact failure the throw exists to prevent.
*/
const DisplayClubTimeContext = createContext<BoundClubTime | null>(null);

export function useDisplayClubTime(): BoundClubTime {
  const bound = useContext(DisplayClubTimeContext);
  if (bound === null) {
    throw new Error(
      "useDisplayClubTime must be used within DisplayScreen, which binds the " +
        "club timezone resolved by src/app/display/page.tsx (CT-4, #2870; " +
        "INV-CONFIG-002). Rendering a display module bare in a test? Render it " +
        "through DisplayScreen with the zone the assertion is about.",
    );
  }
  return bound;
}

// #2264: the lobby clock used to render in the VIEWER's zone, so a TV browser or
// an operator previewing from outside New Zealand showed the wrong time on the
// wall. It now renders in the club's PERSISTED zone rather than the container's
// (CT-4, #2870) - the binding is the authority, and this only upper-cases it.
function formatClock(club: BoundClubTime, date: Date): string {
  return club.instantTime(date).toUpperCase();
}

/*
  Not one of the shared helpers: the header date line deliberately drops the
  year to fit the fixed-width clock block without shifting the layout, and the
  kernel has no `HOUSE_SHAPES` entry for that bag.

  PINNED TO `UTC`, AND ONLY EVER HANDED A CALENDAR DAY (CT-4, #2870). It used to
  be pinned to `APP_TIME_ZONE` and handed EITHER a real instant (today's clock)
  or a UTC-midnight window start (a simulated preview date) - one concept wearing
  another's clothes, and a day early for any club west of Greenwich in the second
  case. Both branches now resolve to a `CalendarDate` first: the live one through
  `club.calendarDateOf`, which is the one operation allowed to say which club day
  a moment falls on (INV-DATE-019), and the simulated one straight off the
  window's own date-only key.
*/
const SHORT_WEEKDAY_DAY = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Preview-mode state for the header (issue #60): whether the URL marks this
 * as an admin preview, and any active simulated date. Computed after mount so
 * the server render and first client render match (the page is force-dynamic
 * and client-hydrated). */
export function readPreviewState(): {
  isPreview: boolean;
  previewDate: string | null;
} {
  if (typeof window === "undefined") return { isPreview: false, previewDate: null };
  const params = new URLSearchParams(window.location.search);
  // A sandboxed authoring-page embed carries ?previewGrant (LTV-036) instead of
  // ?preview/?previewDevice, but it is still a preview: the clock's simulate
  // affordance and the "previewing against" line belong there too.
  const isPreview =
    params.has("preview") ||
    params.has("previewDevice") ||
    params.has("previewGrant");
  const raw = params.get("previewDate");
  const previewDate = raw && DATE_ONLY_REGEX.test(raw) ? raw : null;
  return { isPreview, previewDate };
}

/** Human-readable label for the accessible simulating hint; falls back to the
 * raw value if it is not a real calendar date. */
function formatSimulatedDate(dateStr: string): string {
  // A simulated preview date is a CALENDAR DAY and takes no zone at all: the
  // kernel's formatter pins `UTC` over the UTC-midnight encoding, so no
  // operator's clock and no club's setting can roll it back a day.
  // `parseCalendarDate` keeps the existing raw-value fallback, which matters
  // here because the value comes off the query string.
  const parsed = parseCalendarDate(dateStr);
  if (parsed === null) return dateStr;
  return formatClubWeekdayDate(parsed);
}

/** Live clock + payload freshness for the header (issue #56). Ticks on the
 * client only; the server render shows a blank slot for one frame. In an admin
 * preview (issue #60) the date line becomes a date picker that rewrites
 * ?previewDate and reloads — a testing tool, so a full reload is fine. While a
 * previewDate is active the clock recolours amber (data-simulated) and its date
 * line shows the simulated window start instead of today; the layout never
 * shifts. The rendered lodge is identified on the admin preview host page
 * around the frame (LTV-036), so no in-frame "previewing against" line is
 * needed — a preview always renders the lodge the device or template is bound
 * to. */
export function HeaderClock({
  generatedAt,
  windowStart,
}: {
  generatedAt: string;
  windowStart: string;
}) {
  const club = useDisplayClubTime();
  const [now, setNow] = useState<Date | null>(null);
  const [preview, setPreview] = useState(() => ({
    isPreview: false,
    previewDate: null as string | null,
  }));
  const dateInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setNow(new Date());
    setPreview(readPreviewState());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!now) return <div className="display-header-clock" />;
  const updated = new Date(generatedAt);
  const simulated = preview.isPreview && preview.previewDate !== null;

  const applyPreviewDate = (value: string) => {
    if (!DATE_ONLY_REGEX.test(value)) return;
    const params = new URLSearchParams(window.location.search);
    params.set("previewDate", value);
    // A testing tool: a full reload keeps the fetch/render path identical to a
    // fresh preview open.
    window.location.search = params.toString();
  };

  const openPicker = () => {
    const input = dateInputRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
      input.click();
    }
  };

  // The date line shows real "today" normally; when a previewDate override is
  // active it shows the simulated window start (the board's window.start),
  // keeping the header and the board in agreement without shifting layout.
  //
  // BOTH BRANCHES RESOLVE TO A CALENDAR DAY BEFORE ANYTHING IS FORMATTED
  // (CT-4, #2870). `windowStart` is a date-only key and needs no zone; `now` is
  // a moment, and the club day it falls on is the club's answer to give, not the
  // container's. A `windowStart` the parser refuses falls back to the live day
  // rather than throwing on an unattended wall.
  const simulatedDay = simulated ? parseCalendarDate(windowStart) : null;
  const dateSource = simulatedDay ?? club.calendarDateOf(now);
  const dateLine = (
    <>
      {SHORT_WEEKDAY_DAY.format(dateOnlyInstantOf(dateSource))}
      {" · "}
      <b>updated {formatClock(club, updated).toLowerCase()}</b>
    </>
  );

  return (
    <div
      className="display-header-clock"
      data-simulated={simulated ? "" : undefined}
    >
      <span className="display-clock-time">{formatClock(club, now)}</span>
      {preview.isPreview ? (
        // #65 fix: the date <input> is a SIBLING of the button, not its child.
        // A native date input nested inside a <button> is invalid HTML and its
        // selection does not reliably fire `change`, so picking a date never
        // applied; as siblings the picker fires normally and the button just
        // opens it via showPicker() on the shared ref (focus/click fallback).
        <>
          <button
            type="button"
            className="display-clock-date display-clock-date-picker"
            onClick={openPicker}
          >
            {dateLine}
          </button>
          <input
            ref={dateInputRef}
            type="date"
            className="display-simulate-input"
            defaultValue={preview.previewDate ?? ""}
            onChange={(event) => applyPreviewDate(event.target.value)}
            aria-label="Simulate a date"
          />
        </>
      ) : (
        <span className="display-clock-date">{dateLine}</span>
      )}
      {simulated && (
        <span className="display-visually-hidden">
          Simulating {formatSimulatedDate(preview.previewDate as string)}
        </span>
      )}
    </div>
  );
}

/**
 * Bind the club's timezone for everything under the lobby screen.
 *
 * `zone` is a raw `string` rather than the branded `ClubTimeZone` because that
 * is what survives the server-to-client prop boundary; it is re-validated here,
 * exactly as `club-time/server.ts` re-validates the same value for the same
 * reason. The only way a persisted, already-validated identifier fails is a
 * runtime whose ICU has forgotten a zone the club chose years ago, and on an
 * unattended wall screen falling back to the documented default keeps the board
 * answering where a throw would black it out.
 */
export function DisplayClubTimeProvider({
  zone,
  children,
}: {
  zone: string;
  children: React.ReactNode;
}) {
  const bound = useMemo(
    () =>
      bindClubTime(
        asClubTimeZone(zone) ?? requireClubTimeZone(CLUB_TIME_ZONE_FALLBACK),
      ),
    [zone],
  );
  return (
    <DisplayClubTimeContext.Provider value={bound}>
      {children}
    </DisplayClubTimeContext.Provider>
  );
}
