// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  HUT_LEADER_PIN_IDLE_CHECK_INTERVAL_MS,
  HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS,
  HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
  KIOSK_DATA_REFRESH_MS,
} from "@/lib/lodge-pin-session-timing";
import { renderKiosk, settleKiosk, weekDays } from "./helpers/kiosk-harness";
import {
  buildWeekDateKeys,
  getWeekStartDateKey,
} from "../_components/kiosk-week-view";

/**
 * #3228 — THE BROWSER'S HALF OF THE TEN-MINUTE IDLE WINDOW.
 *
 * The server decides when a hut leader's PIN session is over
 * (`src/lib/__tests__/lodge-pin-session-idle-window.test.ts`). This file is
 * about the two things the browser decides: WHEN TO SAY SOMEBODY IS STILL HERE,
 * and WHEN TO STOP PAINTING A VIEW IT BELIEVES HAS LAPSED.
 *
 * The renewal itself lives in `src/components/lodge-pin-session.tsx`, mounted
 * for the whole lodge area rather than on this page, because a hut leader's
 * authority also covers the roster wizard a full navigation away
 * (`src/app/(lodge)/lodge/roster/[date]/setup/__tests__/`). The kiosk is still
 * where it is DRIVEN from, which is why the cases below render this page.
 *
 * ## The two traps, and which case pins each
 *
 * 1. **Renewal must not ride on the page's own traffic.** This page refreshes
 *    itself every two minutes, so a wall tablet sitting alone on a bench would
 *    keep itself privileged for as long as it had power — exactly the situation
 *    being closed. "sends no renewal across half an hour" is that case.
 *
 * 2. **The browser must not give up BEFORE the server does.** The first cut
 *    counted interval ticks anchored at mount and always dropped strictly early,
 *    which is worse than useless: the refetch that follows gets the privileged
 *    payload back and restarts the clock from a background event, so the real
 *    expiry then passes unnoticed. "drops only after the server has already
 *    expired it" is that case, and the interaction there lands MID-interval
 *    on purpose — the degenerate alignment (no interaction at all, or one
 *    exactly on a tick boundary) is what let the old arithmetic look correct.
 *
 * ## A jsdom limit, stated rather than worked around
 *
 * The page ignores any input event a script dispatched (`event.isTrusted`), and
 * `isTrusted` is an unforgeable own property in jsdom as in a browser — a
 * dispatched event is always untrusted and cannot be made otherwise. So the
 * REFUSAL of a scripted event is driven end to end here with `fireEvent`, and
 * the accepted path is covered in two parts instead: the exact listener
 * registration (which events, on which target, with which options) and the
 * registered handler itself, driven with a trusted event. What no unit test can
 * cover is whether a real finger on real glass produces one of those four
 * events; that is a browser property, and the four were chosen for it.
 */

vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

vi.mock("@/components/kiosk-lodge-instructions", () => ({
  KioskLodgeInstructions: ({ date }: { date: string }) => (
    <div data-testid="kiosk-instructions">{date}</div>
  ),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

const PIN_SESSION_URL = "/api/lodge/pin-session";
const IDLE_MS = HUT_LEADER_PIN_SESSION_IDLE_SECONDS * 1000;

/**
 * A value only a hut leader's response carries. There is no such field in the
 * guest payload TODAY — the tier difference is the roster-management link — so
 * this stands in for the privileged lines #3040 adds, and pins the rule those
 * will need: what a device holds is dropped on a lock, not merely hidden.
 */
const HUT_LEADER_ONLY_VALUE = "PRIVILEGED-ORGANISER-Priya";

interface KioskFetchLog {
  calls: string[];
  renewals: number;
  locks: number;
  /** The instant the mock SERVER measures its idle window from, as it moves. */
  deadlineBasis: number;
  /** Access responses that answered `hut-leader`, and that answered `lodge`. */
  unlockedAnswers: number;
  lockedAnswers: number;
  /**
   * When each `/api/lodge/access` call arrived.
   *
   * THE ONLY RELIABLE WITNESS TO A DROP, and the heading is not one: a drop that
   * fires while the server session is still live gets the privileged payload
   * straight back, so the view REAPPEARS and a test watching the heading sees
   * nothing at all. That is the flap this whole arithmetic exists to prevent, so
   * a test that cannot see it is not testing for it. Every drop causes exactly
   * one extra access call, and the page's own schedule is known, so the times are
   * what discriminate.
   */
  accessTimes: number[];
}

/**
 * The kiosk's endpoints, served as a PIN-unlocked device until `lockNow()` is
 * called — at which point the server answers as the ordinary lodge account
 * would, which is what a real lock does.
 */
function installFetchMock(
  options: {
    expireAfterIdleWindow?: boolean;
    /**
     * Shorten the SERVER's window below the real one, so the server can expire
     * a session while the browser still believes it is live. That is the only
     * way to drive the "told by a 403" path: with both clocks agreeing, the
     * browser's own check always notices first.
     */
    serverIdleMs?: number;
    failAfterLock?: boolean;
    /** Every renewal answers 429, which is NOT "the session is over". */
    refuseRenewalWith?: number;
  } = {},
): KioskFetchLog {
  const log: KioskFetchLog = {
    calls: [],
    renewals: 0,
    locks: 0,
    deadlineBasis: Date.now(),
    unlockedAnswers: 0,
    lockedAnswers: 0,
    accessTimes: [],
  };
  let locked = false;
  /*
    `expireAfterIdleWindow` stands in for the SERVER's own deadline, and it is
    measured from the last RENEWAL exactly as the signed cookie's `exp` is: a
    device that keeps renewing never expires, and one that stops does, ten
    minutes later. Without that, a test asserting "steady use keeps the session"
    would be asserting nothing about renewal at all.
  */
  const serverIdleMs = options.serverIdleMs ?? IDLE_MS;
  const unlockedNow = () =>
    !locked &&
    !(
      options.expireAfterIdleWindow === true &&
      Date.now() - log.deadlineBasis >= serverIdleMs
    );

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    log.calls.push(`${method} ${url}`);

    if (url.startsWith(PIN_SESSION_URL)) {
      if (method === "POST") {
        log.renewals += 1;
        if (options.refuseRenewalWith !== undefined) {
          return Response.json(
            { error: "Too many requests" },
            { status: options.refuseRenewalWith },
          );
        }
        if (!unlockedNow()) {
          // The server cannot resurrect an expired session, and a mock that
          // let it would hide a page that renews too late.
          return Response.json({ error: "No PIN session to renew" }, { status: 403 });
        }
        log.deadlineBasis = Date.now();
        return Response.json({ renewed: true });
      }
      log.locks += 1;
      locked = true;
      return Response.json({ locked: true });
    }

    if (options.failAfterLock === true && locked) {
      // The network drops the moment the screen is locked. What the device is
      // still HOLDING then is the whole question: nothing arrives to overwrite
      // it, so anything not explicitly dropped stays on screen.
      throw new Error("network down");
    }

    if (url.startsWith("/api/lodge/access")) {
      log.accessTimes.push(Date.now());
      if (unlockedNow()) {
        log.unlockedAnswers += 1;
        return Response.json({
          tier: "hut-leader",
          pinSessionActive: true,
          dateRange: { minDate: "2026-06-01", maxDate: "2026-08-01" },
          canManageRoster: true,
          canMarkAttendance: true,
          canCompleteChores: true,
          lodgeName: null,
        });
      }
      log.lockedAnswers += 1;
      return Response.json({
        tier: "lodge",
        dateRange: null,
        canManageRoster: false,
        canMarkAttendance: true,
        canCompleteChores: true,
        lodgeName: null,
      });
    }

    if (url.startsWith("/api/lodge/week?start=")) {
      const start =
        new URL(url, "http://localhost").searchParams.get("start") ?? "";
      return Response.json({ start, days: weekDays(start) });
    }

    if (/^\/api\/lodge\/guests\/\d{4}-\d{2}-\d{2}$/.test(url)) {
      return Response.json({
        bookings: [
          {
            bookingId: "booking-1",
            memberName: unlockedNow() ? HUT_LEADER_ONLY_VALUE : "R. Hall",
            expectedArrivalTime: null,
            guests: [
              {
                id: "guest-1",
                firstName: "Sam",
                lastName: "Hall",
                ageTier: "ADULT",
                phone: null,
                isMember: true,
                isArriving: true,
                isDeparting: false,
                canMarkDeparted: false,
                canMarkArrived: true,
                arrivedAt: null,
                departedAt: null,
              },
            ],
          },
        ],
        totalGuests: 1,
      });
    }

    if (/^\/api\/lodge\/roster\/\d{4}-\d{2}-\d{2}$/.test(url)) {
      return Response.json({ assignments: [] });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return log;
}

/** `ms` of wall clock, with the page's timers running. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settleKiosk(2);
}

/** One renewal interval of wall clock. */
async function advanceOneInterval(): Promise<void> {
  await advance(HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS);
}

const IDLE_INTERVALS = Math.ceil(
  IDLE_MS / HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS,
);

const unlockedHeading = () =>
  screen.queryByRole("heading", { name: /Hut Leader controls are unlocked/i });

/**
 * Every `setTimeout` this file's renders schedule, with its delay.
 *
 * `setTimeout` is deliberately left REAL here (see `settleKiosk`), so a
 * self-removing toast cannot be caught by advancing a clock. Recording the
 * scheduling call is how the lock-failure case tells a banner that stays from
 * one that removes itself.
 */
let timeoutCalls: Array<[unknown, unknown]> = [];

beforeEach(() => {
  vi.useRealTimers();
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(frozenTestNow());
  timeoutCalls = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...rest: unknown[]
  ) => {
    timeoutCalls.push([handler, delay]);
    return (realSetTimeout as (...args: unknown[]) => unknown)(
      handler,
      delay,
      ...rest,
    );
  }) as typeof globalThis.setTimeout);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(frozenTestNow());
});

describe("kiosk PIN session: background traffic never extends it (#3228)", () => {
  it("sends no renewal across half an hour of the page's own refreshes", async () => {
    const log = installFetchMock();
    renderKiosk();
    await settleKiosk();

    expect(unlockedHeading()).toBeVisible();

    // Thirty minutes — three idle windows — with nobody touching the tablet.
    // The two-minute data refresh runs, the club-day tick runs, the idle check
    // runs.
    const intervals =
      (30 * 60_000) / HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS;
    for (let tick = 0; tick < intervals; tick += 1) {
      await advanceOneInterval();
    }

    // The assertion the whole fix rests on.
    expect(log.renewals).toBe(0);
    expect(log.calls.filter((call) => call.includes(PIN_SESSION_URL))).toEqual([]);
    // ...and it really did poll in that time, so this is not a green from a
    // page that did nothing at all.
    expect(
      log.calls.filter((call) => call.startsWith("GET /api/lodge/access")).length,
    ).toBeGreaterThan(3);
  }, 20000);

  it("ignores an input event a script dispatched, so no other code on the page can hold the screen open", async () => {
    const log = installFetchMock();
    renderKiosk();
    await settleKiosk();

    // `fireEvent` dispatches, so these arrive with `isTrusted: false` — exactly
    // what a synthetic event from another script looks like.
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.touchStart(document.body);
    fireEvent.wheel(document.body);
    await settleKiosk();

    expect(log.renewals).toBe(0);
  });

  it("returns to the ordinary lodge view when the window closes, without waiting for the next refresh", async () => {
    // The server expires the session on its own clock; the page's job is to
    // stop showing a hut leader's view promptly rather than up to two minutes
    // later, when the next data refresh would have noticed.
    const log = installFetchMock({ expireAfterIdleWindow: true });
    renderKiosk();
    await settleKiosk();
    expect(unlockedHeading()).toBeVisible();

    for (let tick = 0; tick < IDLE_INTERVALS + 1; tick += 1) {
      await advanceOneInterval();
    }
    await settleKiosk();

    expect(log.renewals).toBe(0);
    expect(unlockedHeading()).toBeNull();
    expect(screen.getByRole("button", { name: "Enter PIN" })).toBeVisible();
    // The server really did stop serving a hut leader, so this is the ordinary
    // lodge view rather than a blank one.
    expect(log.lockedAnswers).toBeGreaterThan(0);

    /*
      WHAT THIS CASE DELIBERATELY DOES NOT CLAIM. "Noticed without waiting for
      the next scheduled refresh" is not demonstrable with NO interaction at all,
      and the reason is pure arithmetic: with nothing renewing, the server's
      deadline sits at exactly ten minutes from mount, which is a whole number of
      two-minute refreshes (600s = 5 x 120s). The refresh and the deadline land on
      the same instant, so which of the two notices first says nothing about
      either. Moving the deadline off that grid takes an interaction, and the
      "drops only after the server has already expired it" case below does
      exactly that and carries the unscheduled-refetch assertion.
    */
  }, 20000);
});

describe("kiosk PIN session: a person keeps it alive (#3228)", () => {
  /** Registers the page's interaction listeners and hands them back. */
  function captureInteractionListeners() {
    const captured: Array<{
      type: string;
      handler: EventListener;
      options: unknown;
    }> = [];
    const real = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((
      type: string,
      handler: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (
        typeof handler === "function" &&
        ["pointerdown", "keydown", "touchstart", "wheel"].includes(type)
      ) {
        captured.push({ type, handler, options });
      }
      return real(
        type as keyof WindowEventMap,
        handler as EventListener,
        options,
      );
    });
    return captured;
  }

  /** One trusted interaction, through every registered handler. */
  function tapThrough(
    captured: Array<{ handler: EventListener }>,
  ): void {
    for (const { handler } of captured) {
      handler({ isTrusted: true } as Event);
    }
  }

  it("listens for taps, keys, touches and wheels on the window, and nothing else", async () => {
    const captured = captureInteractionListeners();
    installFetchMock();
    renderKiosk();
    await settleKiosk();

    expect(captured.map(({ type }) => type).sort()).toEqual([
      "keydown",
      "pointerdown",
      "touchstart",
      "wheel",
    ]);
    for (const { type, options } of captured) {
      expect(options, type).toEqual({ capture: true, passive: true });
    }
    // `scroll` is deliberately not among them: a programmatic scroll is trusted,
    // so it would let any future auto-scroll on this page read as a person.
    expect(captured.map(({ type }) => type)).not.toContain("scroll");
  });

  it("renews once on the first interaction and collapses a burst into that one call", async () => {
    const captured = captureInteractionListeners();
    const log = installFetchMock();
    renderKiosk();
    await settleKiosk();

    tapThrough(captured);
    await settleKiosk();
    expect(log.renewals).toBe(1);

    // A hut leader marking off a full lodge taps many times a minute. That must
    // cost one request, not one per tap.
    for (let burst = 0; burst < 20; burst += 1) tapThrough(captured);
    await settleKiosk();
    expect(log.renewals).toBe(1);

    // A minute later the throttle has elapsed and the next tap renews again, so
    // somebody working the roster is never dropped.
    await advanceOneInterval();
    tapThrough(captured);
    await settleKiosk();
    expect(log.renewals).toBe(2);
  });

  it("keeps the view for as long as somebody keeps using it", async () => {
    const captured = captureInteractionListeners();
    // The server expires an unrenewed session at the window, so a page that
    // stopped renewing would be dropped here rather than merely un-renewed.
    const log = installFetchMock({ expireAfterIdleWindow: true });
    renderKiosk();
    await settleKiosk();

    // Steady use for twice the idle window: one interaction per interval.
    // Nobody is interrupted mid-roster.
    for (let tick = 0; tick < IDLE_INTERVALS * 2; tick += 1) {
      tapThrough(captured);
      await advanceOneInterval();
    }

    expect(log.renewals).toBe(IDLE_INTERVALS * 2);
    expect(unlockedHeading()).toBeVisible();
  }, 20000);

  /*
    THE CASE THE FIRST IMPLEMENTATION COULD NOT PASS, and the reason it was
    invisible: the only drop case performed ZERO interactions, so the interval
    anchor and the deadline basis coincided exactly, and the sibling "keeps the
    view" case interacted precisely ON a tick boundary — the same degenerate
    alignment. Interact halfway through an interval and then stop, and
    tick-counting drops the view up to a full interval before the server's
    deadline; the refetch then returns the privileged payload, restarts the
    clock, and the real expiry goes unnoticed for up to two minutes.
  */
  it("drops only after the server has already expired it, and the view does not come back", async () => {
    const captured = captureInteractionListeners();
    const log = installFetchMock({ expireAfterIdleWindow: true });
    renderKiosk();
    await settleKiosk();
    expect(unlockedHeading()).toBeVisible();

    const start = frozenTestNow().getTime();

    // Halfway through an interval, somebody taps once — and then stops. That
    // offset is the whole point: it moves the server's deadline off both the
    // interval grid and the two-minute refresh grid, which is the alignment the
    // first implementation's arithmetic was accidentally correct on.
    await advance(HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS / 2);
    tapThrough(captured);
    await settleKiosk();
    expect(log.renewals).toBe(1);

    const serverDeadline = log.deadlineBasis + IDLE_MS;
    expect(serverDeadline).toBeGreaterThan(start + IDLE_MS);

    // Run well past the deadline, in idle-check steps.
    const windowMs = IDLE_MS + 4 * KIOSK_DATA_REFRESH_MS;
    for (
      let elapsed = HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS / 2;
      elapsed < windowMs;
      elapsed += HUT_LEADER_PIN_IDLE_CHECK_INTERVAL_MS
    ) {
      await advance(HUT_LEADER_PIN_IDLE_CHECK_INTERVAL_MS);
    }

    /*
      ASSERTION ONE — IT DID NOT GIVE UP EARLY.

      Every access call before the server's deadline must be one the page's own
      two-minute schedule explains. A drop fires a refetch, so an extra call in
      that stretch IS the browser having given up while the session was still
      good — and because the refetch then returns the privileged payload, the
      screen would look perfectly fine while the browser's clock restarted from a
      background event.
    */
    const beforeDeadline = log.accessTimes.filter(
      (at) => at < serverDeadline,
    ).length;
    const scheduledBeforeDeadline =
      Math.floor((serverDeadline - 1 - start) / KIOSK_DATA_REFRESH_MS) + 1;
    expect(beforeDeadline).toBe(scheduledBeforeDeadline);

    /*
      ASSERTION TWO — IT DID GIVE UP, ON ITS OWN.

      Over the whole window there is at least one access call the schedule cannot
      explain: the drop's refetch. Without this the case passes for a browser that
      never notices at all and waits to be told by its next poll, leaving up to
      two minutes of a hut leader's view on a shared screen.
    */
    const scheduledOverall = Math.floor(windowMs / KIOSK_DATA_REFRESH_MS) + 1;
    expect(log.accessTimes.length).toBeGreaterThan(scheduledOverall);

    // ASSERTION THREE — and it stayed gone.
    expect(log.renewals).toBe(1);
    expect(unlockedHeading()).toBeNull();
    expect(screen.getByRole("button", { name: "Enter PIN" })).toBeVisible();
  }, 30000);

  it("stops at once when the server says there is no session, rather than waiting for its own count", async () => {
    /*
      A 403 from the renewal endpoint is the server stating the window has
      closed, and being told beats any estimate. Driven with a SERVER window
      shorter than the real one, because that is the only arrangement in which
      the server can be ahead of the browser — with both clocks agreeing, the
      browser's own check always notices first.
    */
    const captured = captureInteractionListeners();
    const log = installFetchMock({
      expireAfterIdleWindow: true,
      serverIdleMs: 60_000,
    });
    renderKiosk();
    await settleKiosk();
    expect(unlockedHeading()).toBeVisible();

    // Ninety seconds: past the server's window, nowhere near the browser's.
    await advance(90_000);
    expect(unlockedHeading()).toBeVisible();

    tapThrough(captured);
    await settleKiosk();

    expect(log.renewals).toBe(1);
    expect(unlockedHeading()).toBeNull();
    expect(screen.getByRole("button", { name: "Enter PIN" })).toBeVisible();
  });

  it("says so when a renewal is refused for any other reason, and does not treat it as the end", async () => {
    /*
      A 429 is not "the session is over" — it is somebody else on the lodge's
      connection, or a blip. The deadline did not move, so the screen may lock
      itself mid-task; the browser must neither drop the view (the server never
      said to) nor swallow the refusal.
    */
    const captured = captureInteractionListeners();
    const log = installFetchMock({ refuseRenewalWith: 429 });
    renderKiosk();
    await settleKiosk();

    tapThrough(captured);
    await settleKiosk();

    expect(log.renewals).toBe(1);
    expect(unlockedHeading()).toBeVisible();
    expect(screen.getByText(/Trouble keeping this kiosk unlocked/i)).toBeVisible();

    // The throttle still holds, so a refusal cannot be turned into a flood by
    // somebody tapping.
    for (let burst = 0; burst < 20; burst += 1) tapThrough(captured);
    await settleKiosk();
    expect(log.renewals).toBe(1);
  });
});

describe("kiosk PIN session: the Lock control (#3228)", () => {
  it("ends the session and leaves nothing privileged on the device", async () => {
    const log = installFetchMock();
    const { container } = renderKiosk();
    await settleKiosk();

    // Into the day list, where the hut-leader-only affordance and the
    // hut-leader-only payload value are both on screen.
    const dayKey = buildWeekDateKeys(getWeekStartDateKey("2026-07-01"))[0];
    expect(dayKey).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Open Wednesday, 1 July/ }),
    );
    await settleKiosk();

    expect(screen.getByText(/Set Up Today's Roster/)).toBeVisible();
    expect(container.innerHTML).toContain(HUT_LEADER_ONLY_VALUE);

    // Lock.
    fireEvent.click(
      screen.getByRole("button", { name: /Lock hut leader controls/i }),
    );
    await settleKiosk();

    expect(log.locks).toBe(1);
    expect(log.calls).toContain(`DELETE ${PIN_SESSION_URL}`);

    // The privileged affordance is gone, the Lock control is gone, and the
    // PIN prompt is back — this device reads as the ordinary lodge account.
    expect(screen.queryByText(/Set Up Today's Roster/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Lock hut leader controls/i }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Enter PIN" })).toBeVisible();

    // And the whole serialized page — not only its visible text, so a value
    // parked in a `title`, an `aria-label` or a `data-*` attribute would fail
    // too — no longer holds the hut-leader-only value.
    expect(container.innerHTML).not.toContain(HUT_LEADER_ONLY_VALUE);
  });

  it("drops what it holds rather than waiting to be given something else", async () => {
    /*
      THE CASE THAT MAKES THE EXPLICIT CLEARS NECESSARY, and it is easy to miss:
      on a normal lock the refetch immediately overwrites the guest list, so a
      version that only re-asked would look correct. Take the network away at the
      moment of the lock and nothing arrives to overwrite anything — and
      `fetchData`'s own catch does not touch `bookings` or `assignments`. So
      whatever the device was holding stays on the shared screen until somebody
      reloads the page, which on a wall tablet is nobody.
    */
    const log = installFetchMock({ failAfterLock: true });
    const { container } = renderKiosk();
    await settleKiosk();

    fireEvent.click(
      screen.getByRole("button", { name: /Open Wednesday, 1 July/ }),
    );
    await settleKiosk();
    expect(container.innerHTML).toContain(HUT_LEADER_ONLY_VALUE);

    fireEvent.click(
      screen.getByRole("button", { name: /Lock hut leader controls/i }),
    );
    await settleKiosk();

    expect(log.locks).toBe(1);
    expect(container.innerHTML).not.toContain(HUT_LEADER_ONLY_VALUE);
    expect(screen.getByText("Failed to load data")).toBeVisible();
  });

  it("stops listening for interaction once locked, so a locked screen cannot renew anything", async () => {
    // Asserted on the listeners rather than by firing events: the handler
    // captured from a previous mount is still a callable function, so invoking
    // one after the lock would measure the harness rather than the page. What
    // matters is that the listeners have come off the window.
    const listeners = trackInteractionListeners();
    const log = installFetchMock();
    renderKiosk();
    await settleKiosk();

    expect(listeners.live()).toEqual([
      "keydown",
      "pointerdown",
      "touchstart",
      "wheel",
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: /Lock hut leader controls/i }),
    );
    await settleKiosk();

    expect(listeners.live()).toEqual([]);
    // Nothing renewed on the way through, either.
    expect(log.renewals).toBe(0);
  });

  it("keeps saying the screen is still unlocked when the lock request fails", async () => {
    /*
      THE FAILURE MODE THIS REPLACED. The first version raised a three-second
      toast BEFORE the round trip, and the drop that follows puts the page on its
      full-screen loading state, where that toast is not rendered at all — so on
      a slow link the three seconds elapsed behind the loading screen and the one
      message somebody must not miss could be shown for zero milliseconds. It is
      now a banner raised AFTER the refetch, and it stays.
    */
    installFetchMock();
    const realFetch = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input).startsWith(PIN_SESSION_URL) &&
          (init?.method ?? "GET").toUpperCase() === "DELETE"
        ) {
          return new Response("nope", { status: 500 });
        }
        return realFetch(input, init);
      }),
    );

    renderKiosk();
    await settleKiosk();

    fireEvent.click(
      screen.getByRole("button", { name: /Lock hut leader controls/i }),
    );
    await settleKiosk();

    const stillUnlocked = () =>
      screen.queryByText(/Could not lock the screen/i);

    expect(stillUnlocked()).toBeVisible();
    // The server still holds the session, so the honest thing is to show the
    // unlocked view again rather than a locked-looking screen that is not.
    const heading = unlockedHeading();
    expect(heading).toBeVisible();

    /*
      NO EXPIRY TIMER WAS SCHEDULED, which is the half of this a rendering
      assertion cannot reach. `setTimeout` is deliberately NOT faked in this file
      — `settleKiosk` needs a real macrotask to flush React's effects — so a
      three-second toast would still be on screen here and a test that only
      looked would pass. What separates the two is that the toast SCHEDULES its
      own removal.
    */
    expect(
      timeoutCalls.filter(([, delay]) => typeof delay === "number" && delay > 0),
    ).toEqual([]);

    /*
      AND IT IS IN THE UNLOCKED PANEL, not the page-top toast slot. That slot is
      not rendered at all while the page is on its full-screen loading state,
      which is exactly where the drop's refetch puts it — so on a slow link the
      old toast's three seconds elapsed behind the loading screen and the message
      could be shown for zero milliseconds.
    */
    const panel = (heading as HTMLElement).closest("section");
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement).getByText(/Could not lock the screen/i),
    ).toBeVisible();

    // Past a scheduled data refresh, too: a warning that disappears while
    // somebody walks away is no warning at all.
    await advance(KIOSK_DATA_REFRESH_MS);
    expect(stillUnlocked()).toBeVisible();
    expect(unlockedHeading()).toBeVisible();
  });
});

const INTERACTION_TYPES = ["pointerdown", "keydown", "touchstart", "wheel"];

/**
 * Which interaction listeners the page currently has on the window: every
 * `addEventListener` for one of the four types, minus every
 * `removeEventListener` for it.
 */
function trackInteractionListeners() {
  // Keyed on TYPE, holding the handlers registered for it: one handler is
  // registered for all four types, so keying on the handler would collapse them
  // into a single entry and the assertion would stop discriminating.
  const live = new Map<string, Set<EventListener>>();
  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);

  vi.spyOn(window, "addEventListener").mockImplementation((
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (typeof handler === "function" && INTERACTION_TYPES.includes(type)) {
      const set = live.get(type) ?? new Set<EventListener>();
      set.add(handler);
      live.set(type, set);
    }
    return realAdd(
      type as keyof WindowEventMap,
      handler as EventListener,
      options,
    );
  });

  vi.spyOn(window, "removeEventListener").mockImplementation((
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    if (typeof handler === "function" && INTERACTION_TYPES.includes(type)) {
      const set = live.get(type);
      set?.delete(handler);
      if (set && set.size === 0) live.delete(type);
    }
    return realRemove(
      type as keyof WindowEventMap,
      handler as EventListener,
      options,
    );
  });

  return { live: () => [...live.keys()].sort() };
}
