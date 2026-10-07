// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
// The shared helper mounts the club-format provider the panel now reads (#3565).
import { act, cleanup, render, screen, fireEvent } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import { formatCents } from "@/lib/utils";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

/*
  #2690 — four behaviours the refactor moved across a file boundary that nothing
  in the repository was checking.

  An adversarial review mutated nine behaviours and ran 1,047 tests across 109
  component files against each. Seven survived. Four of the survivors are here:
  the two optimistic-concurrency refs, which are the panel's entire defence
  against a stale answer and a double submission, and the two admin-override
  fences on the guest rows.

  All four were correct by reading and unguarded by tests. That is the weakest
  place to leave a single-flight save, and this refactor is exactly the kind of
  change that could have broken one of them silently.
*/

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2690-guards";

/** A promise plus the handle that settles it, so response ORDER is ours. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quotePayload(newFinalPriceCents: number) {
  return {
    newTotalPriceCents: newFinalPriceCents,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents,
    priceDiffCents: 0,
    changeFeeCents: 0,
    netChargeCents: 0,
    settlementOptions: null,
    capacityAvailable: true,
    promoStillValid: true,
    promoCoverage: null,
    promoValidation: null,
    itemizedChanges: [],
  };
}

/** Every queued modify-quote response, in the order the panel asked for them. */
let pendingQuotes: Array<{ resolve: (r: Response) => void }> = [];
let savePuts: string[] = [];
let pendingSave: { resolve: (r: Response) => void } | null = null;
let holdQuotes = false;
let holdSave = false;

function installFetch() {
  pendingQuotes = [];
  savePuts = [];
  pendingSave = null;
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/modify-quote")) {
      if (!holdQuotes) return jsonResponse(quotePayload(10000));
      const d = deferred<Response>();
      pendingQuotes.push({ resolve: d.resolve });
      return d.promise;
    }
    if (url.endsWith("/modify")) {
      savePuts.push(String(init?.body ?? ""));
      if (!holdSave) return jsonResponse({});
      const d = deferred<Response>();
      pendingSave = { resolve: d.resolve };
      return d.promise;
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
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
      {
        id: "g2",
        firstName: "Bo",
        lastName: "Reid",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
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
    ...overrides,
  };
}

function setCheckOut(value: string) {
  fireEvent.change(screen.getByLabelText(/Check-out/i), { target: { value } });
}

/*
  TIME IS FAKE HERE, for the reason recorded in
  edit-booking-panel-quote-debounce.test.tsx.

  Measured, not guessed: driven by the real clock these cases waited out a 500ms
  debounce plus a 700ms drain inside `waitFor`, which put them within a few
  hundred milliseconds of vitest's 5s default test timeout. Under load — a
  `test:related` run with 23 files in flight — they tipped over it, and every
  case in the file failed at almost exactly 5,000ms. That is a property of the
  machine, not of the code under test, and it is the wrong thing for a guard to
  be sensitive to.
*/
const FROZEN_NOW = new Date("2026-07-01T00:00:00.000Z");
const DEBOUNCE_MS = 500;

/** Fire everything due within `ms`, flushing promises between timers. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Flush pending promise callbacks without moving the clock. */
const flush = () => advance(0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(FROZEN_NOW);
  holdQuotes = false;
  holdSave = false;
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a superseded quote can never overwrite the current one (#2690)", () => {
  it("keeps the LATEST edit's price when an older request answers last", async () => {
    holdQuotes = true;
    const { unmount } = render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    // First edit — its request goes out and is held unanswered.
    setCheckOut("2026-09-08");
    await advance(DEBOUNCE_MS);
    expect(pendingQuotes).toHaveLength(1);

    // Second edit — a second request goes out, also held.
    setCheckOut("2026-09-10");
    await advance(DEBOUNCE_MS);
    expect(pendingQuotes).toHaveLength(2);

    // Answer the NEWER request first, then let the stale one land on top.
    pendingQuotes[1].resolve(jsonResponse(quotePayload(22200)));
    await flush();
    pendingQuotes[0].resolve(jsonResponse(quotePayload(11100)));
    await flush();

    // `quoteRequestSeqRef` is the only thing standing between the member and a
    // price from an edit they have already moved on from. Delete it and the
    // panel quotes 111.00 for a stay it is no longer proposing.
    expect(
      screen.queryByText(formatCents(11100, CLUB_FORMAT_TEST)),
      "a superseded quote overwrote the current one; the monotonic request-id " +
        "guard in fetchQuote is gone",
    ).not.toBeInTheDocument();
    expect(screen.getByText(formatCents(22200, CLUB_FORMAT_TEST))).toBeInTheDocument();
    unmount();
  });
});

describe("the save is single-flighted (#2690)", () => {
  it("sends ONE PUT when two clicks land before React re-renders", async () => {
    holdSave = true;
    const { unmount } = render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    setCheckOut("2026-09-08");
    await advance(DEBOUNCE_MS);
    const save = screen.getByRole("button", { name: "Save Changes" });
    expect(save).not.toBeDisabled();

    /*
      Both clicks inside ONE act batch, which is the case the ref exists for.
      The button's `disabled` attribute stops an ordinary double-click, but it
      is computed from the PREVIOUS render — two events delivered before React
      commits `saving = true` both reach the handler, and only the synchronously
      updated `saveInFlightRef` can turn the second one around. A test that
      clicks twice with an await between them proves nothing, because the
      attribute alone would pass it.
    */
    await act(async () => {
      save.click();
      save.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      savePuts,
      "two clicks in one batch produced two PUTs; the single-flight guard is " +
        "gone and the booking is modified twice",
    ).toHaveLength(1);

    pendingSave?.resolve(jsonResponse({}));
    await flush();
    unmount();
  });
});

describe("an admin override edit is date-only on screen as well as in the payload (#2690)", () => {
  const adminBooking = () =>
    makeBooking({
      viewerRole: "ADMIN",
      editPolicy: {
        mode: "future" as const,
        today: "2026-08-01",
        editableFrom: null,
        checkInEditable: true,
        adminOverrideAvailable: true,
      },
    });

  it("withdraws the guest Remove control and the name fields while the override is on", async () => {
    const { unmount } = render(
      <EditBookingPanel
        booking={adminBooking()}
        canAdminOverride
        onDone={() => {}}
      />,
    );

    // Both fences are open to begin with: two guests, one of them a non-member
    // whose free-text name may be corrected.
    expect(screen.getAllByRole("button", { name: "Remove" }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("First Name")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Move locked\/past dates \(admin override\)/i,
      }),
    );

    // An override edit sends dates and nothing else, so offering either control
    // would invite a change the payload silently drops.
    expect(
      screen.queryAllByRole("button", { name: "Remove" }),
      "the guest Remove control survived the admin override; its " +
        "!overrideEnabled fence is gone",
    ).toEqual([]);
    expect(
      screen.queryByLabelText("First Name"),
      "the non-member name field survived the admin override; its " +
        "!overrideEnabled fence is gone",
    ).not.toBeInTheDocument();

    await advance(DEBOUNCE_MS * 2);
    unmount();
  });
});
