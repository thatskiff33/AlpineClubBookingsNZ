// @vitest-environment jsdom

/**
 * #4942 — the wizard's four network calls must hand their button back however
 * the request ends.
 *
 * Each handler set a busy flag, awaited `fetch`, and cleared the flag inside
 * its `res.ok` branches. A rejected `fetch` (the connection dropped) or a body
 * that was not JSON (a gateway's 502 page) threw past those branches, so the
 * button kept its busy label forever and no message appeared.
 *
 * The create, waitlist and draft posts can all have committed before the reply
 * was lost — a create may already have used the member's account credit — so
 * their message must be the #2668 "could not verify" wording, never a claim
 * that nothing happened. The quote is a read, so "try again" is honest there.
 */
import { act, renderHook, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

const routerMocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "member-1", role: "MEMBER", accessRoles: [] } },
  }),
}));

vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: () => false,
  hasAccessRole: () => true,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [
      { id: "lodge-a", name: "Lodge A" },
      { id: "lodge-b", name: "Lodge B" },
    ],
    loading: false,
  }),
}));

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

const CHECK_MY_BOOKINGS = "Open My Bookings to check before trying again.";
const CREATE_UNVERIFIED = unverifiedWriteMessage("your booking was created", CHECK_MY_BOOKINGS);
const WAITLIST_UNVERIFIED = unverifiedWriteMessage(
  "you were added to the waitlist or booked",
  CHECK_MY_BOOKINGS,
);
const DRAFT_UNVERIFIED = unverifiedWriteMessage("your draft was saved", CHECK_MY_BOOKINGS);
const QUOTE_FAILED = "We could not calculate the price. Check your connection and try again.";

/** A JSON reply, as the routes send it. */
function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/**
 * A reply whose body is not JSON: a gateway error page, or a success whose body
 * was cut off. `json()` throws exactly as the browser's does.
 */
function htmlResponse(status: number) {
  return {
    ok: status < 400,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON");
    },
  } as unknown as Response;
}

/** How the endpoint under test answers. */
type Failure = "reject" | "gateway-502" | "unreadable-200";

function failWith(failure: Failure): Response {
  if (failure === "reject") throw new TypeError("Failed to fetch");
  return htmlResponse(failure === "gateway-502" ? 502 : 200);
}

/**
 * Every call the hook makes on the way to the review step answers normally;
 * `quote` and `create` decide the two endpoints these tests break. Each is a
 * queue so a retry can be answered differently from the first press.
 */
function stubFetch(answers: {
  quote?: Array<() => Response>;
  create?: Array<() => Response>;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/members/family")) return jsonResponse({ familyMembers: [] });
    if (u.includes("/api/payments/options")) {
      return jsonResponse({
        methods: {
          stripe: { enabled: true, default: true },
          internetBanking: { enabled: false },
        },
        groupBookingsEnabled: false,
      });
    }
    if (u.includes("/api/member/subscription-status")) {
      return jsonResponse({
        status: "PAID",
        seasonDisplay: "2026",
        invoiceUrl: null,
        invoiceNumber: null,
      });
    }
    if (u.includes("/api/booking-messages")) return jsonResponse({ messages: {} });
    if (u.includes("/api/bookings/rooms")) return jsonResponse({ enabled: false, rooms: [] });
    if (u.includes("/api/availability/check")) {
      return jsonResponse({ lodgeCapacity: 20, nightDetails: [] });
    }
    if (u.includes("/api/booking-policies/check")) return jsonResponse({ valid: true });
    if (u.includes("/api/bookings/quote")) {
      const next = answers.quote?.shift();
      if (next) return next();
      return jsonResponse({ totalPriceCents: 20000, availableCreditCents: 0, guests: [] });
    }
    if (u.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (u.includes("/api/work-parties/active")) return jsonResponse({ events: [] });
    if (u.endsWith("/api/bookings") && init?.method === "POST") {
      const next = answers.create?.shift();
      if (next) return next();
      // A hold owes nothing yet, so every handler navigates rather than taking
      // the card step.
      return jsonResponse({ id: "booking-1", status: "PENDING" });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const CHECK_IN = "2026-08-01";
const CHECK_OUT = "2026-08-03";

async function renderAtGuestsStep() {
  const hook = renderHook(() => useBookingWizard());
  await act(async () => {
    hook.result.current.handleLodgeChange("lodge-a");
  });
  await act(async () => {
    await hook.result.current.handleDateSelect(CHECK_IN, CHECK_OUT);
  });
  act(() => {
    hook.result.current.handleGuestsChange([
      { firstName: "Jo", lastName: "Member", ageTier: "ADULT", isMember: true },
    ]);
  });
  return hook;
}

async function renderAtReviewStep() {
  const hook = await renderAtGuestsStep();
  await act(async () => {
    await hook.result.current.handleGuestsDone();
  });
  await waitFor(() => expect(hook.result.current.step).toBe("review"));
  return hook;
}

beforeEach(() => {
  routerMocks.push.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the price quote cannot freeze Continue (#4942)", () => {
  it.each<[Failure, string]>([
    ["reject", QUOTE_FAILED],
    // A gateway page on the error branch has no `error` field to show, so the
    // existing generic refusal copy applies — the quote is a read.
    ["gateway-502", "Failed to calculate price"],
    ["unreadable-200", QUOTE_FAILED],
  ])("clears priceLoading and says so when the quote %s", async (failure, message) => {
    stubFetch({ quote: [() => failWith(failure)] });
    const { result } = await renderAtGuestsStep();

    await act(async () => {
      await result.current.handleGuestsDone();
    });

    expect(result.current.priceLoading).toBe(false);
    expect(result.current.error).toBe(message);
    expect(result.current.step).toBe("guests");
  });

  it("lets the member press Continue again and reach the review step", async () => {
    stubFetch({ quote: [() => failWith("reject")] });
    const { result } = await renderAtGuestsStep();

    await act(async () => {
      await result.current.handleGuestsDone();
    });
    await act(async () => {
      await result.current.handleGuestsDone();
    });

    expect(result.current.step).toBe("review");
    expect(result.current.error).toBe("");
  });

  it("keeps a readable refusal's own words", async () => {
    stubFetch({ quote: [() => jsonResponse({ error: "Those dates are closed." }, 400)] });
    const { result } = await renderAtGuestsStep();

    await act(async () => {
      await result.current.handleGuestsDone();
    });

    expect(result.current.priceLoading).toBe(false);
    expect(result.current.error).toBe("Those dates are closed.");
  });
});

describe.each([
  {
    handler: "handleSubmit" as const,
    flag: "submitting" as const,
    unverified: CREATE_UNVERIFIED,
    refusalFallback: "Failed to create booking",
  },
  {
    handler: "handleJoinWaitlist" as const,
    flag: "joiningWaitlist" as const,
    unverified: WAITLIST_UNVERIFIED,
    refusalFallback: "Failed to join waitlist",
  },
  {
    handler: "handleSaveAsDraft" as const,
    flag: "savingDraft" as const,
    unverified: DRAFT_UNVERIFIED,
    refusalFallback: "Failed to save draft",
  },
])("$handler cannot freeze its button (#4942)", ({ handler, flag, unverified, refusalFallback }) => {
  it.each<Failure>(["reject", "gateway-502", "unreadable-200"])(
    "after %s, clears the busy flag and says the outcome is unknown",
    async (failure) => {
      stubFetch({ create: [() => failWith(failure)] });
      const { result } = await renderAtReviewStep();

      await act(async () => {
        await result.current[handler]();
      });

      expect(result.current[flag]).toBe(false);
      // The write may have landed: the member is sent to check, never told
      // that nothing was made.
      expect(result.current.error).toBe(unverified);
      // No receipt, no id — so no `/bookings/undefined`.
      expect(routerMocks.push).not.toHaveBeenCalled();
    },
  );

  it("lets the member press again without reloading", async () => {
    stubFetch({ create: [() => failWith("reject")] });
    const { result } = await renderAtReviewStep();

    await act(async () => {
      await result.current[handler]();
    });
    await act(async () => {
      await result.current[handler]();
    });

    expect(routerMocks.push).toHaveBeenCalledWith(
      expect.stringMatching(/^\/bookings\/booking-1(#payment)?$/),
    );
    // Held through navigation, so a second press cannot post again.
    expect(result.current[flag]).toBe(true);
  });

  it("keeps a readable server refusal exactly as before", async () => {
    stubFetch({ create: [() => jsonResponse({ error: "Not this weekend." }, 403)] });
    const { result } = await renderAtReviewStep();

    await act(async () => {
      await result.current[handler]();
    });

    expect(result.current[flag]).toBe(false);
    expect(result.current.error).toBe("Not this weekend.");
  });

  it("falls back to the refusal copy for a readable body with no message", async () => {
    stubFetch({ create: [() => jsonResponse({}, 400)] });
    const { result } = await renderAtReviewStep();

    await act(async () => {
      await result.current[handler]();
    });

    expect(result.current[flag]).toBe(false);
    expect(result.current.error).toBe(refusalFallback);
  });
});

describe("handleSubmit's card path is unchanged (#4942)", () => {
  it("moves to the pay step and hands the button back after a failed first press", async () => {
    stubFetch({
      create: [
        () => failWith("reject"),
        () => jsonResponse({ id: "booking-1", status: "PAYMENT_PENDING" }),
      ],
    });
    vi.stubGlobal("scrollTo", vi.fn());
    const { result } = await renderAtReviewStep();

    await act(async () => {
      await result.current.handleSubmit();
    });
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.step).toBe("pay");
    expect(result.current.createdBooking?.id).toBe("booking-1");
    expect(result.current.submitting).toBe(false);
    expect(routerMocks.push).not.toHaveBeenCalled();
  });
});

describe("handleSubmit's readable capacity refusal still offers the waitlist (#4942)", () => {
  it("raises the waitlist prompt and hands the button back", async () => {
    stubFetch({
      create: [
        () =>
          jsonResponse(
            { code: "CAPACITY_EXCEEDED", canWaitlist: true, fullNights: [CHECK_IN] },
            409,
          ),
      ],
    });
    const { result } = await renderAtReviewStep();

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.submitting).toBe(false);
    expect(result.current.showWaitlistPrompt).toBe(true);
    expect(result.current.error).toBe("");
  });
});
