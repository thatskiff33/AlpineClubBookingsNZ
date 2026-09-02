// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LodgePinSessionProvider } from "@/components/lodge-pin-session";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  HUT_LEADER_PIN_IDLE_CHECK_INTERVAL_MS,
  HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS,
  HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
} from "@/lib/lodge-pin-session-timing";

import RosterSetupWizard from "../page";

/**
 * #3228 — A HUT LEADER WORKING THE CHORE ROSTER IS NOT DROPPED MID-TASK.
 *
 * ## The defect this file exists to hold shut
 *
 * The idle window's renewal originally lived in the kiosk page. The kiosk links
 * to this wizard with a plain `<a href>` — a FULL NAVIGATION — so the kiosk
 * unmounted and took its interaction listeners with it. From that moment nothing
 * could move the deadline: the leader had at most ten minutes, and often less,
 * because the renewal throttle means the last accepted renewal can already be a
 * minute old.
 *
 * Nothing looked wrong while it happened. Every read this page makes is served
 * to the ordinary lodge tier, so the wizard rendered normally the whole way
 * through. The failure arrived at the very end, on the one call that matters:
 * `POST .../confirm` answered `{"error":"Forbidden"}`, which the page printed
 * verbatim over a full lodge's chore allocation held only in component state.
 * There was no PIN box, no retry, and no save — the only way on was back to the
 * kiosk, re-entering the PIN, and doing all of it again. Allocating chores for a
 * full lodge plausibly takes longer than ten minutes every single time.
 *
 * That is the outcome the owner rejected the hard-timeout option to avoid
 * ("that ends with the PIN on a sticky note beside the tablet"), it contradicts
 * the acceptance criterion "a hut leader working a roster is never interrupted",
 * and it contradicted the operator guide shipping in the same change. Neither of
 * the two test files written with the fix rendered this page, which is why none
 * of them saw it.
 *
 * So: the first case below is the regression test. It works this wizard for
 * three times the idle window and requires **Confirm** to still be authorised.
 * The second and third are the safety net for when the window does close — the
 * work survives and the PIN box appears here rather than a bare "Forbidden".
 */

vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ date: "2026-07-01" }),
  useRouter: () => ({ push: routerPush }),
}));

const DATE = "2026-07-01";
const PIN_SESSION_URL = "/api/lodge/pin-session";
const PIN_LOGIN_URL = "/api/lodge/pin-login";
const IDLE_MS = HUT_LEADER_PIN_SESSION_IDLE_SECONDS * 1000;

interface WizardServer {
  calls: string[];
  renewals: number;
  pinLogins: number;
  confirms: number;
  generates: number;
  /** Every status the confirm endpoint answered, in order. */
  confirmStatuses: number[];
  /** What the server measures its idle window from, as it moves. */
  deadlineBasis: number;
  unlocked: () => boolean;
}

/**
 * The wizard's four endpoints, served by a mock server that keeps its own
 * ten-minute idle window measured from the last accepted RENEWAL — exactly as
 * the signed cookie's `exp` is. A page that stops renewing is refused here, so
 * the first case cannot pass by accident.
 */
function installWizardServer(
  options: { startExpired?: boolean } = {},
): WizardServer {
  const server: WizardServer = {
    calls: [],
    renewals: 0,
    pinLogins: 0,
    confirms: 0,
    generates: 0,
    confirmStatuses: [],
    deadlineBasis: options.startExpired === true ? -IDLE_MS : Date.now(),
    unlocked: () => Date.now() - server.deadlineBasis < IDLE_MS,
  };

  const guests = [
    {
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Sam",
      lastName: "Hall",
      ageTier: "ADULT",
      isArriving: true,
      isDeparting: false,
    },
  ];

  const template = {
    id: "chore-1",
    name: "Sweep the bunkroom",
    description: null,
    timeOfDay: "MORNING",
    sortOrder: 1,
    isEssential: true,
    frequencyMode: "EVERY_DAY",
    frequencyDays: null,
    frequencyDaysOfWeek: [],
    recommendedPeopleMin: 1,
    recommendedPeopleMax: 2,
    ageRestriction: "NONE",
    minAge: 0,
    active: true,
  };

  const allocation = {
    choreTemplateId: template.id,
    choreTemplateName: template.name,
    choreTimeOfDay: template.timeOfDay,
    choreSortOrder: template.sortOrder,
    bookingGuestId: "guest-1",
    guestName: "Sam Hall",
    guestAgeTier: "ADULT",
    bookingId: "booking-1",
  };

  const forbidden = () =>
    Response.json({ error: "Forbidden" }, { status: 403 });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    server.calls.push(`${method} ${url}`);

    if (url === PIN_SESSION_URL && method === "POST") {
      server.renewals += 1;
      if (!server.unlocked()) return forbidden();
      server.deadlineBasis = Date.now();
      return Response.json({ renewed: true });
    }

    if (url === PIN_LOGIN_URL && method === "POST") {
      server.pinLogins += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { pin?: string };
      if (body.pin !== "123456") {
        return Response.json({ error: "Invalid PIN" }, { status: 401 });
      }
      server.deadlineBasis = Date.now();
      return Response.json({ success: true, tier: "hut-leader" });
    }

    // Guest list and existing roster: the ordinary lodge tier sees both, which
    // is why the whole page looked healthy while the session was gone.
    if (url === `/api/lodge/guests/${DATE}`) {
      return Response.json({
        bookings: [
          { bookingId: "booking-1", memberName: "R. Hall", guests },
        ],
      });
    }
    if (url === `/api/lodge/roster/${DATE}`) {
      return Response.json({ assignments: [] });
    }

    // Chore templates and the frequency preview are hut-leader gated.
    if (url === `/api/lodge/roster/${DATE}/chores`) {
      if (!server.unlocked()) return forbidden();
      return Response.json({ templates: [template] });
    }
    if (url === `/api/lodge/roster/${DATE}/frequency-info`) {
      if (!server.unlocked()) return forbidden();
      return Response.json({ lastRosteredDates: {} });
    }

    if (url === `/api/lodge/roster/${DATE}/generate` && method === "POST") {
      server.generates += 1;
      if (!server.unlocked()) return forbidden();
      return Response.json({ allocations: [allocation], guests });
    }

    if (url === `/api/lodge/roster/${DATE}/confirm` && method === "POST") {
      server.confirms += 1;
      const status = server.unlocked() ? 200 : 403;
      server.confirmStatuses.push(status);
      if (status === 403) return forbidden();
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return server;
}

function renderWizard(options: { initialPinSessionActive?: boolean } = {}) {
  return render(
    <LodgePinSessionProvider
      initialActive={options.initialPinSessionActive !== false}
    >
      <RosterSetupWizard />
    </LodgePinSessionProvider>,
  );
}

async function settle(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle(2);
}

/**
 * A trusted interaction, delivered the way the provider listens for one.
 *
 * `fireEvent` cannot be used for the ACCEPTED path: it dispatches, so its events
 * carry `isTrusted: false` and the provider refuses them by design (that refusal
 * is driven end to end in the kiosk suite). The listener is captured instead and
 * handed a trusted-looking event, which is the same split that suite documents.
 */
function captureInteractionListeners() {
  const captured: EventListener[] = [];
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
      captured.push(handler);
    }
    return real(
      type as keyof WindowEventMap,
      handler as EventListener,
      options,
    );
  });
  return {
    tap: () => {
      for (const handler of captured) handler({ isTrusted: true } as Event);
    },
    count: () => captured.length,
  };
}

beforeEach(() => {
  routerPush.mockReset();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
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

/** Step 1 -> step 2 -> generate -> step 3 -> step 4. */
async function walkToConfirmStep(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Next: Select Chores/ }));
  await settle(2);
  fireEvent.click(screen.getByRole("button", { name: /Next: Generate Roster/ }));
  await settle(4);
  fireEvent.click(screen.getByRole("button", { name: /Next: Confirm/ }));
  await settle(2);
}

describe("roster wizard: the PIN session survives the work (#3228)", () => {
  it("registers the interaction listeners on this page too, not only on the kiosk", async () => {
    const listeners = captureInteractionListeners();
    installWizardServer();
    renderWizard();
    await settle();

    // Four listeners, from the provider the lodge layout mounts. Before the fix
    // this page had none, and the count here was zero.
    expect(listeners.count()).toBe(4);
  });

  it("lets a hut leader confirm a roster after three times the idle window of steady work", async () => {
    const listeners = captureInteractionListeners();
    const server = installWizardServer();
    renderWizard();
    await settle();

    expect(screen.getByText(/Guests in the lodge/)).toBeVisible();

    /*
      HALF AN HOUR OF WORK, which is not an unreasonable figure for allocating
      chores across a full lodge — it is three times the idle window. One
      interaction per renewal interval, which is what the throttle collapses a
      burst of taps down to.
    */
    const intervals = (3 * IDLE_MS) / HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS;
    for (let tick = 0; tick < intervals; tick += 1) {
      listeners.tap();
      await advance(HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS);
    }
    expect(server.renewals).toBe(intervals);

    await walkToConfirmStep();
    expect(screen.getByRole("heading", { name: "Confirm Roster" })).toBeVisible();

    listeners.tap();
    fireEvent.click(screen.getByRole("button", { name: /^Confirm Roster$/ }));
    await settle(4);

    // THE ASSERTION. Thirty minutes in, the save is still authorised — and the
    // page went to the kiosk rather than printing "Forbidden" over the work.
    expect(server.confirmStatuses).toEqual([200]);
    expect(screen.queryByText(/Forbidden/)).toBeNull();
    expect(screen.queryByText(/This screen locked itself/)).toBeNull();
    expect(routerPush).toHaveBeenCalledWith("/lodge/kiosk");
  }, 30000);

  it("does not renew on this page's own traffic, only on a person", async () => {
    const server = installWizardServer();
    renderWizard();
    await settle();

    // The page's load is four requests, and none of them may be read as somebody
    // being here — otherwise a tablet left open on this wizard would hold itself
    // privileged, which is the same trap the kiosk's refresh sets.
    expect(server.calls.length).toBeGreaterThanOrEqual(4);
    expect(server.renewals).toBe(0);

    // Half an hour of nothing but the clock. Still nothing.
    for (let tick = 0; tick < 30; tick += 1) {
      await advance(HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS);
    }
    expect(server.renewals).toBe(0);
    expect(server.calls.filter((call) => call.includes(PIN_SESSION_URL))).toEqual(
      [],
    );
  }, 20000);
});

describe("roster wizard: when the window closes anyway (#3228)", () => {
  it("offers the PIN and re-saves, instead of printing Forbidden over the work", async () => {
    const listeners = captureInteractionListeners();
    const server = installWizardServer();
    renderWizard();
    await settle();

    await walkToConfirmStep();
    expect(screen.getByRole("heading", { name: "Confirm Roster" })).toBeVisible();
    // The allocation exists, and only in this component's state.
    expect(screen.getByText("Sam Hall")).toBeVisible();

    /*
      Now the session goes. Driven by taking the listeners' renewals away —
      `listeners.tap()` is simply not called — and letting the clock run past the
      window, which is what walking off mid-wizard looks like.
    */
    for (let check = 0; check < 60; check += 1) {
      await advance(HUT_LEADER_PIN_IDLE_CHECK_INTERVAL_MS);
      if (screen.queryByText(/This screen locked itself/)) break;
    }

    // The notice is here and the work is untouched — this page neither reloaded
    // nor navigated away.
    expect(screen.getByText(/This screen locked itself/)).toBeVisible();
    expect(screen.getByText(/Nothing you have set up has been lost/)).toBeVisible();
    expect(screen.getByText("Sam Hall")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Confirm Roster" })).toBeVisible();

    // Confirm now would be refused, and the page says so with the PIN box
    // rather than the server's bare word.
    fireEvent.click(screen.getByRole("button", { name: /^Confirm Roster$/ }));
    await settle(4);
    expect(server.confirmStatuses).toEqual([403]);
    expect(screen.queryByText(/Forbidden/)).toBeNull();
    expect(screen.getByText("Sam Hall")).toBeVisible();

    // The PIN goes in, and the interrupted save runs itself.
    fireEvent.change(screen.getByLabelText(/6-digit PIN/), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Unlock and save the roster/ }));
    await settle(6);

    expect(server.pinLogins).toBe(1);
    expect(server.confirmStatuses).toEqual([403, 200]);
    expect(routerPush).toHaveBeenCalledWith("/lodge/kiosk");
    expect(listeners.count()).toBeGreaterThanOrEqual(4);
  }, 30000);

  it("offers the PIN when the page itself cannot load, rather than a dead error", async () => {
    // Arriving here with the session already gone: the chore-template list is
    // hut-leader gated, so the load 403s. That is a re-unlock, not a fault.
    installWizardServer({ startExpired: true });
    renderWizard();
    await settle();

    expect(screen.getByText(/This screen locked itself/)).toBeVisible();
    expect(screen.queryByText("Failed to load data")).toBeNull();

    fireEvent.change(screen.getByLabelText(/6-digit PIN/), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Unlock and load this page/ }));
    await settle(6);

    expect(screen.queryByText(/This screen locked itself/)).toBeNull();
    expect(screen.getByText(/Guests in the lodge/)).toBeVisible();
  });

  it("says so when the PIN is wrong, and keeps the work and the box", async () => {
    installWizardServer({ startExpired: true });
    renderWizard();
    await settle();

    fireEvent.change(screen.getByLabelText(/6-digit PIN/), {
      target: { value: "999999" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Unlock and load this page/ }));
    await settle(4);

    expect(screen.getByText("Invalid PIN")).toBeVisible();
    expect(screen.getByText(/This screen locked itself/)).toBeVisible();
  });
});
