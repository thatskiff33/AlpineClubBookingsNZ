// @vitest-environment jsdom

// #1709: the admin book page must not offer the card (Stripe) PAYMENT_PENDING
// path for a retroactive (past-dated) booking with an outstanding balance — a
// finished stay has no arrival to gate a card hold on. It hides the Card option
// and forces Internet Banking with an explanation, while a normal future-dated
// booking still shows both Card and Internet Banking.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestData } from "@/components/guest-form";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  // The stubbed calendar reports whatever window the current test sets here.
  calendar: { checkIn: new Date(), checkOut: new Date() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, replace: vi.fn() }),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

vi.mock("@/components/lodge-select", () => ({
  LodgeSelect: () => null,
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

vi.mock("@/components/admin/member-picker", () => ({
  MemberPicker: ({
    onSelect,
  }: {
    onSelect: (member: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      ageTier: string;
    }) => void;
  }) => (
    <button
      onClick={() =>
        onSelect({
          id: "member-1",
          firstName: "Alice",
          lastName: "Anderson",
          email: "alice@example.com",
          ageTier: "ADULT",
        })
      }
    >
      pick test member
    </button>
  ),
}));

// The calendar and guest form have their own tests; stub them with buttons that
// drive the wizard. The calendar reports the window the test staged in h.calendar.
vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: ({
    onDateSelect,
  }: {
    onDateSelect: (ci: Date, co: Date) => void;
  }) => (
    <button onClick={() => onDateSelect(h.calendar.checkIn, h.calendar.checkOut)}>
      pick test dates
    </button>
  ),
}));

vi.mock("@/components/guest-form", () => ({
  GuestForm: ({
    onGuestsChange,
  }: {
    onGuestsChange: (guests: GuestData[]) => void;
  }) => (
    <button
      onClick={() =>
        onGuestsChange([
          {
            firstName: "Alice",
            lastName: "Anderson",
            ageTier: "ADULT",
            isMember: true,
            memberId: "member-1",
          },
        ])
      }
    >
      add test guest
    </button>
  ),
}));

vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => null,
}));

vi.mock("@/components/time-picker", () => ({
  TimePicker: () => null,
}));

import AdminBookPage from "@/app/(admin)/admin/book/page";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(opts: { internetBankingEnabled?: boolean } = {}) {
  const internetBankingEnabled = opts.internetBankingEnabled ?? true;
  const mock = vi.fn(
    async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes("/api/payments/options")) {
        return jsonResponse({
          methods: {
            stripe: { enabled: true, default: true },
            internetBanking: { enabled: internetBankingEnabled },
          },
          groupBookingsEnabled: false,
        });
      }
      if (u.includes("/api/admin/bookings/eligible-family")) {
        return jsonResponse({ familyMembers: [] });
      }
      if (u.includes("/api/availability/check")) {
        return jsonResponse({ minAvailable: 10, nightDetails: [] });
      }
      // Quote must be matched before the generic /api/bookings POST below.
      if (u.includes("/api/bookings/quote") && init?.method === "POST") {
        return jsonResponse({
          guests: [
            { ageTier: "ADULT", isMember: true, nights: 2, priceCents: 4000 },
          ],
          totalPriceCents: 4000,
        });
      }
      if (u.includes("/api/bookings") && init?.method === "POST") {
        return jsonResponse({ id: "booking-1", status: "PAYMENT_PENDING" });
      }
      return jsonResponse({});
    },
  );
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

// Find the create POST body (excluding the quote POST) the page sent.
function bookingPostBody(): Record<string, unknown> | undefined {
  const call = (
    fetchMock.mock.calls as Array<[string, { method?: string; body?: string }]>
  ).find(
    ([url, init]) =>
      String(url).includes("/api/bookings") &&
      !String(url).includes("/quote") &&
      init?.method === "POST",
  );
  return call?.[1]?.body
    ? (JSON.parse(call[1].body) as Record<string, unknown>)
    : undefined;
}

function daysFromToday(delta: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + delta);
  return d;
}

// Drive the wizard from the member picker to the review step. When retroactive,
// tick "Record a past stay" and stage a past window; otherwise a future window.
async function driveToReview(retroactive: boolean) {
  h.calendar = retroactive
    ? { checkIn: daysFromToday(-10), checkOut: daysFromToday(-8) }
    : { checkIn: daysFromToday(30), checkOut: daysFromToday(32) };

  render(<AdminBookPage />);
  fireEvent.click(screen.getByRole("button", { name: "pick test member" }));

  await screen.findByText("Select Dates", { exact: true });
  if (retroactive) {
    fireEvent.click(screen.getByRole("checkbox"));
  }
  fireEvent.click(screen.getByRole("button", { name: "pick test dates" }));

  fireEvent.click(await screen.findByRole("button", { name: "add test guest" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  await screen.findByText("Booking Summary");
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = stubFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin book page payment method for retroactive bookings (#1709)", () => {
  it("hides the card option and explains the restriction for a past stay with a balance", async () => {
    await driveToReview(true);

    // The card option's descriptive copy must be gone.
    expect(
      screen.queryByText(/The member pays by card to secure the booking/),
    ).toBeNull();
    // Internet Banking is offered as the settlement, with the explanation.
    expect(
      await screen.findByText(/Card payment isn't available for a past stay/),
    ).toBeTruthy();
    expect(screen.getByText(/Record it with internet banking/)).toBeTruthy();
    expect(screen.getByText("Internet Banking")).toBeTruthy();
  });

  it("shows both card and internet banking for a normal future-dated booking", async () => {
    await driveToReview(false);

    expect(
      await screen.findByText(/The member pays by card to secure the booking/),
    ).toBeTruthy();
    expect(screen.getByText("Internet Banking")).toBeTruthy();
    // No retroactive card-restriction copy on the normal path.
    expect(
      screen.queryByText(/Card payment isn't available for a past stay/),
    ).toBeNull();
  });

  it("forces internet_banking as the submitted payment method for a past-dated positive-balance stay", async () => {
    await driveToReview(true);

    // Confirm opens the per-create email-choice dialog; either choice creates.
    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Create and email member" }),
    );

    await waitFor(() => expect(h.push).toHaveBeenCalled());

    const body = bookingPostBody();
    expect(body).toBeDefined();
    expect(body?.paymentMethod).toBe("internet_banking");
    expect(body?.allowPastDates).toBe(true);
  });

  it("blocks Confirm with a no-settlement warning when Internet Banking is off for a past stay with a balance", async () => {
    // Re-stub before render so the mount-time /api/payments/options reports IB
    // off; with no card path and no IB there is no valid settlement.
    fetchMock = stubFetch({ internetBankingEnabled: false });
    await driveToReview(true);

    expect(
      await screen.findByText("Card payment isn't available for a past stay"),
    ).toBeTruthy();
    expect(screen.getByText(/can't be paid by card/)).toBeTruthy();

    const confirm = screen.getByRole("button", {
      name: /Confirm Booking/,
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
