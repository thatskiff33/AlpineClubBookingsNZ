// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";
import {
  BOOKING_EXCEPTION_REQUEST_ID,
  BOOKING_WIZARD_ERROR_ID,
} from "@/components/book/booking-wizard-types";

// #4945. The review step is several screens long on a phone, and its buttons are
// the last thing on it. A refusal used to land in a static block at the very top
// of the page, so the member saw "Creating booking..." flick back to "Continue to
// Payment" and nothing else: the button looked dead, and a screen-reader user
// was left on it. Every review-step failure now takes focus in the wizard's one
// error box (or, for a 409 the member can waitlist, the "fully booked" card).
//
// These tests render the real page and the real wizard hook. The hook is wrapped
// only so the test can walk the wizard to the review step with the same calls
// the hook's own tests use; the button pressed is the one the member presses.

const wizard = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));

vi.mock("@/app/(authenticated)/book/_hooks/use-booking-wizard", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import(
    "@/app/(authenticated)/book/_hooks/use-booking-wizard"
  );
  return {
    ...actual,
    useBookingWizard: () => {
      const result = actual.useBookingWizard();
      wizard.current = result as unknown as Record<string, unknown>;
      return result;
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
    lodges: [{ id: "lodge-a", name: "Lodge A" }],
    loading: false,
  }),
  LodgeSelect: () => null,
}));

vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: () => <div data-testid="booking-calendar" />,
}));
vi.mock("@/components/guest-form", () => ({ GuestForm: () => null }));
vi.mock("@/components/promo-code-input", () => ({ PromoCodeInput: () => null }));
vi.mock("@/components/time-picker", () => ({ TimePicker: () => null }));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import BookPage from "@/app/(authenticated)/book/page";

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

/** A server refusal, or `"dropped"`: the connection fails before any reply. */
type Refusal = { status: number; body: Record<string, unknown> } | "dropped";

/** Stub every wizard fetch; `POST /api/bookings` answers with `refusal`. */
function stubFetch(refusal: Refusal) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/members/family")) {
        return jsonResponse({ familyMembers: [] });
      }
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
      if (u.includes("/api/bookings/rooms")) {
        return jsonResponse({ enabled: false, rooms: [] });
      }
      if (u.includes("/api/availability/check")) {
        return jsonResponse({ lodgeCapacity: 20, nightDetails: [] });
      }
      if (u.includes("/api/booking-policies/check")) {
        return jsonResponse({ valid: true });
      }
      if (u.includes("/api/bookings/quote")) {
        return jsonResponse({
          totalPriceCents: 20000,
          availableCreditCents: 0,
          guests: [],
        });
      }
      if (u.includes("/api/promo-codes/available")) return jsonResponse([]);
      if (u.includes("/api/work-parties/active")) return jsonResponse({ events: [] });
      if (u.endsWith("/api/bookings") && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        if (refusal === "dropped") throw new TypeError("Failed to fetch");
        return jsonResponse(refusal.body, false, refusal.status);
      }
      return jsonResponse({}, false);
    }),
  );
  return posts;
}

type Wizard = {
  handleLodgeChange: (id: string) => void;
  handleDateSelect: (checkIn: string, checkOut: string) => Promise<void>;
  handleGuestsChange: (guests: unknown[]) => void;
  handleGuestsDone: () => Promise<void>;
};

const ONE_ADULT = [
  { firstName: "Jo", lastName: "Member", ageTier: "ADULT", isMember: true },
];

/** Mount the page and walk it to the review step with `guests` as the party. */
async function renderOnReviewStep(
  refusal: Refusal,
  { guests = ONE_ADULT, primaryButton = "Continue to Payment" } = {},
) {
  const posts = stubFetch(refusal);
  render(<BookPage />);
  const current = () => wizard.current as unknown as Wizard;
  await act(async () => {
    current().handleLodgeChange("lodge-a");
  });
  await act(async () => {
    await current().handleDateSelect("2026-08-01", "2026-08-03");
  });
  act(() => {
    current().handleGuestsChange(guests);
  });
  await act(async () => {
    await current().handleGuestsDone();
  });
  await screen.findByRole("button", { name: primaryButton });
  return posts;
}

/** Mount the page and walk it to the guests step with `guests` as the party. */
async function renderOnGuestsStep(guests: unknown[]) {
  stubFetch({ status: 400, body: { error: "unused" } });
  render(<BookPage />);
  const current = () => wizard.current as unknown as Wizard;
  await act(async () => {
    current().handleLodgeChange("lodge-a");
  });
  await act(async () => {
    await current().handleDateSelect("2026-08-01", "2026-08-03");
  });
  act(() => {
    current().handleGuestsChange(guests);
  });
  await screen.findByRole("button", { name: "Continue" });
}

// A refusal the server marks as one a Booking Officer may allow (#2562): it
// carries the frozen violation the request card renders.
const MIN_STAY_VIOLATION = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-weekend",
  policyVersion: 3,
  policyName: "Weekend minimum",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-a" },
  affectedNights: ["2026-08-01"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Friday nights need a two-night booking.",
};
const REVIEWABLE_REFUSAL = {
  error: "Booking does not meet minimum stay requirement",
  code: "MINIMUM_STAY_VIOLATION",
  violations: [MIN_STAY_VIOLATION],
  exceptionReview: { violations: [MIN_STAY_VIOLATION], capacityMode: "HOLD" },
};

function errorBox() {
  return document.getElementById(BOOKING_WIZARD_ERROR_ID);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  wizard.current = null;
});

describe("review-step failures land where the member is looking (#4945)", () => {
  it("focuses the error box when the create is refused", async () => {
    await renderOnReviewStep({
      status: 400,
      body: { error: "Bookings for these dates are not open yet." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));

    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("Bookings for these dates are not open yet."),
    );
    await expectRecoveryAlertToHoldFocus(errorBox());
    // One assertive region for the wizard: the box is it.
    expect(screen.getAllByRole("alert")).toEqual([errorBox()]);
  });

  it("focuses the error box when the connection drops before the reply", async () => {
    // #4942 made a lost reply an unknown outcome the member is told about; it is
    // still a failure their press raised, so it must reach them like a refusal.
    await renderOnReviewStep("dropped");

    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));

    await waitFor(() => expect(errorBox()).toHaveTextContent("could not verify"));
    await expectRecoveryAlertToHoldFocus(errorBox());

    // A second press that drops the same way brings the member back to the same
    // sentence. (The press clears the box first, so this does not lean on the
    // attention key; the client-side review-reason case below does.)
    const again = screen.getByRole("button", { name: "Continue to Payment" });
    again.focus();
    expect(document.activeElement).toBe(again);
    fireEvent.click(again);

    await expectRecoveryAlertToHoldFocus(errorBox());
  });

  it("keeps a guest-profile refusal's action inside the focused box", async () => {
    await renderOnReviewStep({
      status: 400,
      body: {
        code: "GUEST_PROFILE_REQUIRED",
        error: "Some member guests need their details completed.",
        members: [
          {
            memberId: "member-2",
            name: "Sam Member",
            missingFields: ["Date of birth"],
            action: "complete_details",
            canCurrentUserResolve: true,
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));

    await waitFor(() => expect(errorBox()).toHaveTextContent("Sam Member"));
    await expectRecoveryAlertToHoldFocus(errorBox());
    expect(errorBox()).toHaveTextContent("Missing: Date of birth");
    const link = Array.from(errorBox()!.querySelectorAll("a")).find((anchor) =>
      anchor.getAttribute("href")?.includes("family-group"),
    );
    expect(link).toBeTruthy();
  });

  it("announces and focuses the fully-booked card on a waitlistable 409", async () => {
    await renderOnReviewStep({
      status: 409,
      body: {
        code: "CAPACITY_EXCEEDED",
        canWaitlist: true,
        error: "Not enough beds",
        fullNights: ["2026-08-01"],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));

    const heading = await screen.findByRole("heading", {
      name: "Lodge is fully booked",
    });
    const card = heading.closest("[tabindex='-1']");
    await expectRecoveryAlertToHoldFocus(card);
    // A named group: `aria-labelledby` is ignored on a role-less div, so without
    // the role the focused card would be announced with no name at all.
    expect(screen.getByRole("group", { name: "Lodge is fully booked" })).toBe(card);
    // A status region is atomic by default, which would re-read the whole card
    // when Join Waitlist changes its label.
    const region = card?.closest("[role='status']");
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-atomic", "false");
    // The 409 clears the error box, so nothing is announced twice.
    expect(errorBox()).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("focuses the error box when Save as Draft is refused", async () => {
    await renderOnReviewStep({
      status: 400,
      body: { error: "Drafts are not available for these dates." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save as Draft" }));

    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("Drafts are not available for these dates."),
    );
    await expectRecoveryAlertToHoldFocus(errorBox());
  });

  it("brings the member back to a repeated refusal", async () => {
    // Not a test of the attention key: a create press clears the box before it
    // posts, so the sentence goes '' -> message and the box refocuses on `error`
    // alone. The client-side checks below are what pin the key.
    await renderOnReviewStep({
      status: 400,
      body: { error: "Bookings for these dates are not open yet." },
    });
    const button = screen.getByRole("button", { name: "Continue to Payment" });

    fireEvent.click(button);
    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("Bookings for these dates are not open yet."),
    );
    await expectRecoveryAlertToHoldFocus(errorBox());

    // The member goes back to the button and presses it again.
    const again = screen.getByRole("button", { name: "Continue to Payment" });
    again.focus();
    expect(document.activeElement).toBe(again);
    fireEvent.click(again);

    await expectRecoveryAlertToHoldFocus(errorBox());
    expect(errorBox()).toHaveTextContent("Bookings for these dates are not open yet.");
  });

  it("does not take focus back for a passive re-render while an error shows", async () => {
    await renderOnReviewStep({
      status: 400,
      body: { error: "Bookings for these dates are not open yet." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));
    await expectRecoveryAlertToHoldFocus(errorBox());

    // Typing in the notes re-renders the whole wizard; the error is unchanged.
    const notes = screen.getByLabelText("Notes (optional)");
    notes.focus();
    fireEvent.change(notes, { target: { value: "Arriving late" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(notes);
  });

  it("moves focus each time a missing review reason stops the press", async () => {
    // A child with no adult needs a reason for the booking officer. The check
    // is client-side, so the identical sentence is set twice with nothing in
    // between: only the attention key can make the second press move focus.
    const posts = await renderOnReviewStep(
      { status: 400, body: { error: "unused" } },
      {
        guests: [
          { firstName: "Kid", lastName: "Member", ageTier: "CHILD", isMember: true },
        ],
        primaryButton: "Submit for Review",
      },
    );
    const reason = screen.getByLabelText(/Reason for booking without an adult guest/);
    // Nothing has been refused yet, so the field is not tied to the box.
    expect(reason).not.toHaveAttribute("aria-describedby");
    expect(reason).not.toHaveAttribute("aria-invalid");

    fireEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("Please add a reason for booking"),
    );
    await expectRecoveryAlertToHoldFocus(errorBox());
    // The box is about this field now, so the field points at it.
    expect(reason).toHaveAttribute("aria-describedby", BOOKING_WIZARD_ERROR_ID);
    expect(reason).toHaveAttribute("aria-invalid", "true");

    const again = screen.getByRole("button", { name: "Submit for Review" });
    again.focus();
    fireEvent.click(again);
    await expectRecoveryAlertToHoldFocus(errorBox());
    expect(posts).toEqual([]);
  });

  it("stops pointing the reason field at the box once the box is about something else", async () => {
    await renderOnReviewStep(
      { status: 400, body: { error: "Bookings for these dates are not open yet." } },
      {
        guests: [
          { firstName: "Kid", lastName: "Member", ageTier: "CHILD", isMember: true },
        ],
        primaryButton: "Submit for Review",
      },
    );
    const reason = screen.getByLabelText(/Reason for booking without an adult guest/);

    fireEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("Please add a reason for booking"),
    );
    expect(reason).toHaveAttribute("aria-describedby", BOOKING_WIZARD_ERROR_ID);

    // Filling the field in answers the refusal, so the field stops claiming it.
    fireEvent.change(reason, { target: { value: "My adult is travelling separately" } });
    expect(reason).not.toHaveAttribute("aria-describedby");
    expect(reason).not.toHaveAttribute("aria-invalid");

    // The next refusal is about something else, and the field never claims it.
    fireEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("Bookings for these dates are not open yet."),
    );
    expect(reason).not.toHaveAttribute("aria-describedby");
    expect(reason).not.toHaveAttribute("aria-invalid");
  });

  it("points a reviewable refusal at the Booking Officer request further down", async () => {
    // The box takes the member to the reason; the request form, their remedy, is
    // screens lower on the review step. The box has to say so.
    await renderOnReviewStep({ status: 400, body: REVIEWABLE_REFUSAL });

    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));

    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("Booking does not meet minimum stay requirement"),
    );
    await expectRecoveryAlertToHoldFocus(errorBox());
    const link = Array.from(errorBox()!.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Go to the request",
    );
    expect(link).toHaveAttribute("href", `#${BOOKING_EXCEPTION_REQUEST_ID}`);
    // The link lands on the card itself, which is on the review step and not in
    // the box.
    const target = document.getElementById(BOOKING_EXCEPTION_REQUEST_ID);
    expect(target).toHaveAttribute("data-testid", "request-officer-approval");
    expect(errorBox()!.contains(target)).toBe(false);
  });

  it("offers no request link for a refusal a Booking Officer cannot allow", async () => {
    await renderOnReviewStep({
      status: 400,
      body: { error: "Bookings for these dates are not open yet." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue to Payment" }));

    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("Bookings for these dates are not open yet."),
    );
    expect(errorBox()!.querySelector("a")).toBeNull();
    expect(document.getElementById(BOOKING_EXCEPTION_REQUEST_ID)).toBeNull();
  });
});

describe("a stopped Continue on the guests step also lands where the member is looking (#4945)", () => {
  it("moves focus each time, even for the identical sentence", async () => {
    // A guest with no name stops the press in the browser. Nothing between the
    // two presses clears the box, so only the attention key can move focus the
    // second time.
    await renderOnGuestsStep([
      { firstName: "", lastName: "", ageTier: "ADULT", isMember: false },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(errorBox()).toHaveTextContent("All guests must have first and last names"),
    );
    await expectRecoveryAlertToHoldFocus(errorBox());

    const again = screen.getByRole("button", { name: "Continue" });
    again.focus();
    expect(document.activeElement).toBe(again);
    fireEvent.click(again);

    await expectRecoveryAlertToHoldFocus(errorBox());
  });
});
