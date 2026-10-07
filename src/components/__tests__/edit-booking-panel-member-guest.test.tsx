// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import {
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/member-guest-refusal";

/**
 * MG4 (#2309): the edit panel's "+ Add Member Guest" surface, driven end to end.
 *
 * WHY THESE LIVE AT THE PANEL AND NOT ON THE FINDER COMPONENT. Every one of them
 * is about a SEQUENCE the panel owns — what the prediction says for this viewer,
 * what happens to the finder between an add and the quote that answers it, what
 * a failed family fetch leaves behind — and each was wrong in the first cut in a
 * way a props-level test of the finder could not have seen, because the finder
 * was not on screen at the moment that mattered.
 */

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2309";

const SAM = {
  memberId: "m-sam",
  firstName: "Sam",
  lastName: "Whittaker",
  ageTier: "ADULT",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchOptions = {
  /** What `/api/members/family` (or `eligible-family`) answers. */
  familyResponse?: () => Response;
  /** What the debounced modify-quote answers. */
  quoteResponse?: () => Response;
};

let fetchCalls: { url: string; method: string }[];

function installFetch(options: FetchOptions = {}) {
  fetchCalls = [];
  const {
    familyResponse = () =>
      jsonResponse({ familyMembers: [], partnerSharingCandidates: [] }),
    quoteResponse = () => jsonResponse(OK_QUOTE),
  } = options;

  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("family")) return familyResponse();
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("member-guest-candidates") || url.includes("guest-candidates")) {
      return jsonResponse({ candidates: [SAM] });
    }
    if (url.includes("/modify-quote")) return quoteResponse();
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
}

const OK_QUOTE = {
  newTotalPriceCents: 5000,
  newDiscountCents: 0,
  newPromoAdjustmentCents: 0,
  newFinalPriceCents: 5000,
  priceDiffCents: 0,
  changeFeeCents: 0,
  netChargeCents: 0,
  settlementOptions: null,
  capacityAvailable: true,
  promoStillValid: true,
  promoValidation: null,
  itemizedChanges: [],
};

const COLLAPSED_REFUSAL = {
  code: MEMBER_GUEST_NOT_ADDABLE_CODE,
  error: MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
};

type GuestSeed = {
  id: string;
  firstName: string;
  lastName: string;
  memberId?: string | null;
  consent?: { tone: "pending" | "ok" | "blocked"; label: string; subState?: string };
};

function makeBooking(overrides: Record<string, unknown> = {}, guests?: GuestSeed[]) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: (
      guests ?? [
        { id: "g1", firstName: "Bea", lastName: "Booker", memberId: "m-booker" },
        { id: "g2", firstName: "Ari", lastName: "Booker", memberId: "m-ari" },
      ]
    ).map((guest) => ({
      id: guest.id,
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: "ADULT",
      isMember: true,
      memberId: guest.memberId ?? null,
      stayStart: null,
      stayEnd: null,
      nights: null,
      priceCents: 5000,
      ...(guest.consent ? { consent: guest.consent } : {}),
    })),
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
    memberGuest: {
      enabled: true,
      openSearchEnabled: false,
      // The shipped default (D-3): the club asks first. It is the setting that
      // made the admin-preview bug visible, because an officer's add ignores it.
      approvalRequired: true,
    },
    ...overrides,
  };
}

/** Open the finder, resolve Sam by email, and press "Add to booking". */
async function addSamThroughTheFinder() {
  fireEvent.click(screen.getByRole("button", { name: "+ Add Member Guest" }));
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "sam@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  // One candidate at the address auto-resolves to the chip.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add to booking" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add to booking" }));
}

beforeEach(() => {
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what an ADMIN is told adding will do (MG4-D-a)", () => {
  it("predicts the admin-assigned outcome, not the club's ask-first setting", async () => {
    // THE BUG. The panel's own inline prediction read only `approvalRequired`,
    // so on a default club an officer saw "This member will be added
    // immediately and told by email" in the finder AND "Waiting for Sam to
    // approve … their bed is held until they answer" on the guest row directly
    // beneath it. The server never writes PENDING for an ADMIN actor — the
    // admin branch of `buildMemberGuestConsentWrite` runs before
    // `approvalRequired` is consulted at all — so the row was the false one.
    installFetch();
    render(
      <EditBookingPanel
        booking={makeBooking({ viewerRole: "ADMIN" })}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchCalls.some((c) => c.url.includes("family"))).toBe(true));

    await addSamThroughTheFinder();

    // The badge is the shared one's ADMIN_ASSIGNED wording…
    await waitFor(() =>
      expect(screen.getByText("Added by the club")).toBeInTheDocument(),
    );
    // …and the helper states MG4-D-a's second half, which is the one an officer
    // is most likely to assume away.
    expect(
      screen.getByText(/Added by the club and told by email\. Sam will not be asked first\./),
    ).toBeInTheDocument();
    // Nothing anywhere claims a hold or an unanswered question.
    expect(screen.queryByText(/Waiting for Sam/)).toBeNull();
    expect(screen.queryByText(/held until they answer/)).toBeNull();
  });

  it("still predicts the ask-first outcome for a MEMBER on the same club", async () => {
    // The other half of the property: the admin branch must not have swallowed
    // the ordinary one.
    installFetch();
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await waitFor(() => expect(fetchCalls.some((c) => c.url.includes("family"))).toBe(true));

    await addSamThroughTheFinder();

    await waitFor(() =>
      expect(screen.getByText("Waiting for Sam to approve")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Added by the club/)).toBeNull();
  });
});

describe("D-8's refusal actually reaches the screen", () => {
  it("re-opens the finder with the neutral sentence beside the person it was about", async () => {
    // The add CLOSES the finder and the server's answer arrives on the quote
    // that follows — so without the re-open, `addError` and `refusedCandidate`
    // render nowhere and MG3's F9 shape never appears on this surface at all.
    installFetch({ quoteResponse: () => jsonResponse(COLLAPSED_REFUSAL, 403) });
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await waitFor(() => expect(fetchCalls.some((c) => c.url.includes("family"))).toBe(true));

    await addSamThroughTheFinder();
    // The add really did close it — the premise of the finding.
    expect(screen.queryByTestId("member-guest-find-panel")).toBeNull();

    // The debounced quote comes back refused, and the finder comes back with it.
    await waitFor(
      () =>
        expect(screen.getByTestId("member-guest-find-panel")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    // …carrying the neutral sentence beside a chip naming the candidate (F9),
    // which is the whole point: the refusal has to be attached to the person.
    const finder = within(screen.getByTestId("member-guest-find-panel"));
    expect(
      finder.getByText(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE),
    ).toBeInTheDocument();
    expect(finder.getByText("Sam Whittaker")).toBeInTheDocument();
  });
});

describe("a failed family fetch is 'unknown', never 'no family'", () => {
  it("predicts nothing at all when the family list could not be loaded", async () => {
    // An empty list for a reason that has nothing to do with the booker's
    // family makes EVERY candidate look beyond-family — including their own
    // child, whose quick-add button is missing from the same failed response.
    // Predicting nothing under-informs; predicting PENDING would promise a
    // consent email that is never sent and a bed that is never held.
    installFetch({ familyResponse: () => jsonResponse({ error: "boom" }, 500) });
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    await waitFor(() => expect(fetchCalls.some((c) => c.url.includes("family"))).toBe(true));

    await addSamThroughTheFinder();

    // The guest is added — the refusal, if any, is the server's to make…
    await waitFor(() => expect(screen.getByText("NEW")).toBeInTheDocument());
    // …but no consent promise is drawn over them.
    expect(screen.queryByText(/Waiting for Sam/)).toBeNull();
    expect(screen.queryByText(/Added by the club/)).toBeNull();
    expect(screen.queryByText(/held until they answer/)).toBeNull();
  });
});

describe("the helper sentences on an existing member-guest row", () => {
  it("says what cancelling a still-unanswered request will do", async () => {
    installFetch();
    render(
      <EditBookingPanel
        booking={makeBooking({}, [
          { id: "g1", firstName: "Bea", lastName: "Booker", memberId: "m-booker" },
          {
            id: "g2",
            firstName: "Sam",
            lastName: "Whittaker",
            memberId: "m-sam",
            consent: { tone: "pending", label: "Waiting for consent" },
          },
        ])}
        onDone={vi.fn()}
      />,
    );

    // The control is named for the act, and the sentence explains it.
    expect(
      screen.getByRole("button", { name: "Cancel request" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Cancelling withdraws the request\. Sam is told, and their held bed is released\./,
      ),
    ).toBeInTheDocument();
  });

  it("states both halves of MG4-D-a on a row the club placed", async () => {
    // Tone alone cannot carry this: "ok" covers an ordinary consent and a
    // notify-only auto-confirm too, which is why the sub-state is threaded.
    installFetch();
    render(
      <EditBookingPanel
        booking={makeBooking({}, [
          { id: "g1", firstName: "Bea", lastName: "Booker", memberId: "m-booker" },
          {
            id: "g2",
            firstName: "Sam",
            lastName: "Whittaker",
            memberId: "m-sam",
            consent: {
              tone: "ok",
              label: "Added by the club",
              subState: "ADMIN_ASSIGNED",
            },
          },
        ])}
        onDone={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        /Added by the club and told by email\. Sam was not asked first\./,
      ),
    ).toBeInTheDocument();
  });

  it("leaves an ordinary consented row exactly as it was", async () => {
    installFetch();
    render(
      <EditBookingPanel
        booking={makeBooking({}, [
          { id: "g1", firstName: "Bea", lastName: "Booker", memberId: "m-booker" },
          {
            id: "g2",
            firstName: "Sam",
            lastName: "Whittaker",
            memberId: "m-sam",
            consent: { tone: "ok", label: "Consented", subState: "TARGET_APPROVED" },
          },
        ])}
        onDone={vi.fn()}
      />,
    );

    expect(screen.queryByText(/was not asked first/)).toBeNull();
    expect(screen.queryByText(/Cancelling withdraws/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Remove" }).length).toBe(2);
  });
});
