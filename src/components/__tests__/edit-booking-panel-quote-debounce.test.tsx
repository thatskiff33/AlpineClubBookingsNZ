// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, fireEvent } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

/*
  #2690 — the debounced modify-quote arm, pinned by COUNTING REQUESTS rather than
  by reading the screen.

  WHY THIS SUITE EXISTS. The panel's other twelve suites assert rendered output,
  and rendered output is nearly blind to the failure this one is about: a
  dependency array that gains or loses an entry. `fetchQuote` is memoised on
  `[bookingId, …stable setters]` and the debounce effect is keyed on
  `[fetchQuote, modificationPayloadJson, …stable setters]`. Put a value in either
  array that is rebuilt on every render — a payload object instead of its
  serialised form, an inline callback, a `useMemo` with the wrong inputs — and the
  effect re-arms its own timer on the render its own response causes. The panel
  then refetches every 500ms, for ever, and every screen assertion in the repo
  still passes, because the numbers on screen are correct. That regression is
  recorded in the effect's own comment; this is the guard for it.

  The other two arms of the same effect are pinned here for the same reason: the
  debounce must COALESCE a burst into one request carrying the LAST payload (a
  broken key would send one per keystroke, each priced on a party the member has
  already moved on from), and an edit reverted to nothing must clear the quote
  WITHOUT asking the server to price "no change".
*/

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2690";

/**
 * Every modify-quote request body ONE test has sent, oldest first.
 *
 * Deliberately created per test and captured by the fetch mock closure, rather
 * than living in a module-level slot the mock resolves at call time. With a
 * shared slot, a request issued by an EARLIER test — a 500ms timer or an
 * in-flight promise that outlived it — pushes into whichever array is current,
 * so a later test can be handed a body it never asked for. Each test now owns an
 * array nothing else can reach, and unmounts its panel before finishing.
 */
type QuoteRecorder = { bodies: string[] };

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quotePayload() {
  return {
    newTotalPriceCents: 12000,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents: 12000,
    priceDiffCents: 2000,
    changeFeeCents: 0,
    netChargeCents: 2000,
    settlementOptions: null,
    capacityAvailable: true,
    promoStillValid: true,
    promoCoverage: null,
    promoValidation: null,
    itemizedChanges: [],
  };
}

function installFetch(): QuoteRecorder {
  const recorder: QuoteRecorder = { bodies: [] };
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/promo-codes/available")) {
      return jsonResponse([]);
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      recorder.bodies.push(String(init?.body ?? ""));
      return jsonResponse(quotePayload());
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return recorder;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
    // Fixed against the frozen clock (2026-07-01): permanently a future stay, so
    // the panel is always in "future" edit mode.
    checkIn: "2026-09-04",
    checkOut: "2026-09-06",
    guests: [
      {
        id: "g1",
        firstName: "Ann",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-ann",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 10000,
    totalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: true,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
  };
}

function setCheckOut(value: string) {
  fireEvent.change(screen.getByLabelText(/Check-out/i), { target: { value } });
}

/*
  TIME IS FAKE IN THIS SUITE, AND THAT IS THE POINT.

  The debounce is a 500ms `setTimeout`. Driven by the real clock, every case here
  depended on wall-clock behaviour it does not actually care about: whether the
  machine got round to firing a timer, whether three `fireEvent`s landed inside
  one window, whether a straggler from the previous case was still running. This
  suite flaked twice on exactly that — once for a reviewer, once in a
  `test:related` run under load — and a guard that goes red for reasons nobody
  can reproduce gets re-run rather than believed, which is the worst possible
  property for the ONE guard covering this PR's only behavioural change.

  With the timer faked, nothing fires unless a case says so. That makes the
  central observation STRONGER rather than weaker: instead of waiting 1.7s of
  real time and hoping, a case advances twenty debounce windows instantly and
  asserts that no further request appeared. A re-arming effect cannot hide in
  that, and neither can a slow machine.

  `Date` is faked alongside the timers and re-pinned to the repository's frozen
  instant. `docs/TESTING.md` documents the contract: the root re-freeze leaves a
  suite that deliberately pins its own instant completely alone, so this must pin
  the SAME one rather than drifting to the default.
*/
const FROZEN_NOW = new Date("2026-07-01T00:00:00.000Z");
const DEBOUNCE_MS = 500;
/** Twenty windows. A loop re-arms every 500ms, so it cannot survive this. */
const TWENTY_DEBOUNCE_WINDOWS_MS = DEBOUNCE_MS * 20;

/** Fire everything due within `ms`, flushing promises between timers. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Let the debounce fire and its response land. */
const settleQuote = () => advance(DEBOUNCE_MS);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(FROZEN_NOW);
  routerRefresh.mockClear();
});

afterEach(() => {
  // Unmount first: the debounce effect's cleanup clears any armed timer, so
  // nothing can be pending when the fake clock is discarded. cleanup() is called
  // explicitly because vitest.config.mts pins sequence.hooks to "stack", which
  // runs after-hooks in REVERSE registration order — Testing Library's automatic
  // unmount would otherwise run after this, not before.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EditBookingPanel — the debounced modify-quote arm (#2690)", () => {
  it("prices a settled edit exactly once and does not re-arm on its own response", async () => {
    const quoteRequestBodies = installFetch().bodies;
    render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    setCheckOut("2026-09-08");
    await settleQuote();
    expect(quoteRequestBodies).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save Changes" })).not.toBeDisabled();

    // The whole point. A dependency that is rebuilt every render makes the
    // effect re-arm on the render its own response causes, so the count climbs
    // by one per 500ms while the screen stays perfectly correct.
    await advance(TWENTY_DEBOUNCE_WINDOWS_MS);
    expect(
      quoteRequestBodies,
      "the quote effect re-armed itself: it is keyed on something rebuilt every " +
        "render, which refetches every 500ms for as long as the panel is open",
    ).toHaveLength(1);
  });

  it("coalesces a burst of edits into one request carrying the last payload", async () => {
    const quoteRequestBodies = installFetch().bodies;
    render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    // Three edits inside one window. With a real clock this depended on the
    // machine getting through all three in under 500ms; now the window simply
    // does not advance until the test says so.
    setCheckOut("2026-09-07");
    setCheckOut("2026-09-08");
    setCheckOut("2026-09-09");

    await settleQuote();
    await advance(TWENTY_DEBOUNCE_WINDOWS_MS);

    expect(quoteRequestBodies).toHaveLength(1);
    expect(JSON.parse(quoteRequestBodies[0])).toMatchObject({
      checkOut: "2026-09-09",
    });
  });

  it("clears the quote without asking the server to price an edit that no longer exists", async () => {
    const quoteRequestBodies = installFetch().bodies;
    render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    setCheckOut("2026-09-08");
    await settleQuote();
    expect(quoteRequestBodies).toHaveLength(1);

    // Back to the stored dates: `hasChanges` goes false, the payload goes null,
    // and that arm of the effect returns WITHOUT arming a timer.
    setCheckOut("2026-09-06");
    await advance(TWENTY_DEBOUNCE_WINDOWS_MS);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();

    expect(quoteRequestBodies).toHaveLength(1);
    // The Price Summary is gated on `hasChanges`, so a cleared edit takes the
    // whole card away rather than leaving last quote's figures on screen.
    expect(screen.queryByText("Price Summary")).not.toBeInTheDocument();
  });

  it("disarms an armed debounce when the panel closes", async () => {
    /*
      The effect's CLEANUP, which nothing else in this PR reaches.

      The effect clears the previous timer at the top of its own body, so on a
      re-run the cleanup is redundant — which is exactly why deleting it left
      every other case here green. The one moment it is the only thing standing
      is UNMOUNT: an officer edits a date and closes the panel inside the 500ms
      window. Without the cleanup that timer still fires into a dead tree, so a
      modify-quote request goes out for a panel nobody is looking at, and its
      response writes through setters belonging to an unmounted component.

      Measured: deleting the `return () => clearTimeout(...)` passes all four of
      the other cases in this file and both refactor-guard suites; it fails only
      here.
    */
    const quoteRequestBodies = installFetch().bodies;
    const { unmount } = render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    // Arms the timer, then closes the panel before the window elapses.
    setCheckOut("2026-09-08");
    unmount();

    await advance(TWENTY_DEBOUNCE_WINDOWS_MS);
    expect(
      quoteRequestBodies,
      "the debounce effect's cleanup no longer disarms its timer, so a quote " +
        "fires for a panel that has already closed",
    ).toHaveLength(0);
  });

  it("asks the family route once per mount, not once per edit", async () => {
    // This case counts family calls off the mock itself, so it needs the fetch
    // installed but not the quote recorder.
    installFetch();
    render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    setCheckOut("2026-09-08");
    await settleQuote();
    await advance(TWENTY_DEBOUNCE_WINDOWS_MS);

    // The loader is keyed on [bookingId, viewerRole]. Widening that array to
    // anything the panel recomputes turns a one-shot mount fetch into a fetch
    // per edit — the same class of defect as the quote loop above, on the arm
    // whose answer decides whether the consent prediction is shown at all.
    const familyCalls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((call) => String(call[0]).includes("/api/members/family"));
    expect(familyCalls).toHaveLength(1);
  });
});
