// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KioskPage from "../page";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS,
  HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
} from "@/lib/lodge-pin-session-timing";
import {
  buildWeekDateKeys,
  getWeekStartDateKey,
  type KioskWeekDaySummary,
} from "../_components/kiosk-week-view";

/**
 * #3228 — THE KIOSK'S HALF OF THE TEN-MINUTE IDLE WINDOW.
 *
 * The server decides when a hut leader's PIN session is over
 * (`src/lib/__tests__/lodge-pin-session-idle-window.test.ts`). This file is
 * about the one thing the browser decides: WHEN TO SAY SOMEBODY IS STILL HERE.
 *
 * That is the whole trap in the issue. This page refreshes itself every two
 * minutes to keep the roster current, so if renewal rode on the page's own
 * traffic a wall tablet sitting alone on a bench would keep itself privileged
 * for as long as it had power — exactly the situation being closed. The first
 * case below is therefore the load-bearing one: half an hour of background
 * refreshes, three times the window, and not one renewal.
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

const CLUB_ZONE = "Pacific/Auckland";
const PIN_SESSION_URL = "/api/lodge/pin-session";

/**
 * A value only a hut leader's response carries. There is no such field in the
 * guest payload TODAY — the tier difference is the roster-management link — so
 * this stands in for the privileged lines #3040 adds, and pins the rule those
 * will need: what a device holds is dropped on a lock, not merely hidden.
 */
const HUT_LEADER_ONLY_VALUE = "PRIVILEGED-ORGANISER-Priya";

function renderKiosk() {
  return render(
    <ClubTimeProvider zone={CLUB_ZONE}>
      <KioskPage />
    </ClubTimeProvider>,
  );
}

function weekDays(start: string): KioskWeekDaySummary[] {
  return buildWeekDateKeys(start).map((date) => ({
    date,
    accessible: true,
    guestCount: 1,
    arrivingCount: 1,
    departingCount: 0,
    rosterStatus: "needs-roster" as const,
  }));
}

interface KioskFetchLog {
  calls: string[];
  renewals: number;
  locks: number;
}

/**
 * The kiosk's endpoints, served as a PIN-unlocked device until `lockNow()` is
 * called — at which point the server answers as the ordinary lodge account
 * would, which is what a real lock does.
 */
function installFetchMock(
  options: { expireAfterIdleWindow?: boolean; failAfterLock?: boolean } = {},
): KioskFetchLog {
  const log: KioskFetchLog = { calls: [], renewals: 0, locks: 0 };
  let locked = false;
  /*
    `expireAfterIdleWindow` stands in for the SERVER's own deadline, and it is
    measured from the last RENEWAL exactly as the signed cookie's `exp` is: a
    device that keeps renewing never expires, and one that stops does, ten
    minutes later. Without that, a test asserting "steady use keeps the session"
    would be asserting nothing about renewal at all.
  */
  let deadlineBasis = Date.now();
  const unlockedNow = () =>
    !locked &&
    !(
      options.expireAfterIdleWindow === true &&
      Date.now() - deadlineBasis >= HUT_LEADER_PIN_SESSION_IDLE_SECONDS * 1000
    );

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    log.calls.push(`${method} ${url}`);

    if (url.startsWith(PIN_SESSION_URL)) {
      if (method === "POST") {
        log.renewals += 1;
        if (!unlockedNow()) {
          // The server cannot resurrect an expired session, and a mock that
          // let it would hide a page that renews too late.
          return Response.json({ error: "No PIN session to renew" }, { status: 403 });
        }
        deadlineBasis = Date.now();
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
      return Response.json(
        unlockedNow()
          ? {
              tier: "hut-leader",
              pinSessionActive: true,
              dateRange: { minDate: "2026-06-01", maxDate: "2026-08-01" },
              canManageRoster: true,
              canMarkAttendance: true,
              canCompleteChores: true,
              lodgeName: null,
            }
          : {
              tier: "lodge",
              dateRange: null,
              canManageRoster: false,
              canMarkAttendance: true,
              canCompleteChores: true,
              lodgeName: null,
            },
      );
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

/**
 * Drains the page's chained fetches without `waitFor`: `setInterval` is faked
 * in this file, and `waitFor` polls on a real interval, so under a faked one it
 * can only be woken by a DOM mutation — the near-miss shape that reports green.
 * `setTimeout` stays real, so awaiting a macrotask inside `act` flushes both the
 * microtask queue and React's effects.
 */
async function settleKiosk(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * One renewal interval of wall clock, with the page's timers running. Two
 * settle rounds rather than six: these loops run dozens of intervals and the
 * only chain to drain per tick is one fetch and its state update.
 */
async function advanceOneInterval(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS);
  });
  await settleKiosk(2);
}

/**
 * The page's own data-refresh cadence (`page.tsx`, "Auto-refresh"). Not
 * imported — a page module may export nothing but the component — so a change
 * there wants a change here; the assertion that uses it says why.
 */
const KIOSK_REFRESH_MS = 120_000;

const IDLE_INTERVALS = Math.ceil(
  (HUT_LEADER_PIN_SESSION_IDLE_SECONDS * 1000) /
    HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS,
);

beforeEach(() => {
  vi.useRealTimers();
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(frozenTestNow());
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

    expect(
      screen.getByRole("heading", { name: /Hut Leader controls are unlocked/i }),
    ).toBeVisible();

    // Thirty minutes — three idle windows — with nobody touching the tablet.
    // The two-minute data refresh runs, the club-day tick runs, the idle timer
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
  });

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
    expect(
      screen.getByRole("heading", { name: /Hut Leader controls are unlocked/i }),
    ).toBeVisible();

    for (let tick = 0; tick < IDLE_INTERVALS; tick += 1) {
      await advanceOneInterval();
    }
    await settleKiosk();

    expect(log.renewals).toBe(0);
    expect(
      screen.queryByRole("heading", {
        name: /Hut Leader controls are unlocked/i,
      }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Enter PIN" })).toBeVisible();

    /*
      AND IT ASKED ON ITS OWN, rather than happening to be told by the next
      scheduled refresh. Without this the case passes even if the idle counter
      is reset by the page's own polling — the two-minute refresh would report
      the drop eventually, and up to two minutes of a hut leader's view would
      stay on a shared screen after the session had ended. Measured against the
      refresh schedule rather than against a hard number, so it survives a
      change to either interval.
    */
    const accessCalls = log.calls.filter((call) =>
      call.startsWith("GET /api/lodge/access"),
    ).length;
    const elapsedMs = IDLE_INTERVALS * HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS;
    const scheduledRefreshes = Math.floor(elapsedMs / KIOSK_REFRESH_MS) + 1;
    expect(accessCalls).toBeGreaterThan(scheduledRefreshes);
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

    const tap = () => {
      for (const { handler } of captured) {
        handler({ isTrusted: true } as Event);
      }
    };

    tap();
    await settleKiosk();
    expect(log.renewals).toBe(1);

    // A hut leader marking off a full lodge taps many times a minute. That must
    // cost one request, not one per tap.
    for (let burst = 0; burst < 20; burst += 1) tap();
    await settleKiosk();
    expect(log.renewals).toBe(1);

    // A minute later the trigger is re-armed and the next tap renews again, so
    // somebody working the roster is never dropped.
    await advanceOneInterval();
    tap();
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
      for (const { handler } of captured) {
        handler({ isTrusted: true } as Event);
      }
      await advanceOneInterval();
    }

    expect(log.renewals).toBe(IDLE_INTERVALS * 2);
    expect(
      screen.getByRole("heading", { name: /Hut Leader controls are unlocked/i }),
    ).toBeVisible();
  }, 20000);
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
    // matters is that the page has taken its listeners off the window.
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

  it("says so when the lock request fails, rather than looking locked", async () => {
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

    expect(
      screen.getByText("Could not lock the screen. Try again."),
    ).toBeVisible();
    // The server still holds the session, so the honest thing is to show the
    // unlocked view again rather than a locked-looking screen that is not.
    expect(
      screen.getByRole("heading", { name: /Hut Leader controls are unlocked/i }),
    ).toBeVisible();
  });
});

const INTERACTION_TYPES = ["pointerdown", "keydown", "touchstart", "wheel"];

/**
 * Which interaction listeners the page currently has on the window: every
 * `addEventListener` for one of the four types, minus every
 * `removeEventListener` for it.
 */
function trackInteractionListeners() {
  // Keyed on TYPE, holding the handlers registered for it: the page registers
  // one handler for all four types, so keying on the handler would collapse
  // them into a single entry and the assertion would stop discriminating.
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
