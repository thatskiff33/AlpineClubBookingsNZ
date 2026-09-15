// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";

// next/navigation: the panel replaces the URL in an effect and reads search params.
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Radix Select needs jsdom polyfills this suite does not provide; the pricing
// mode stays at its Overall-total default, which is what these payloads use.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

vi.mock("@/components/admin/booking-requests/booking-request-contact-picker", () => ({
  BookingRequestContactPicker: () => <div data-testid="contact-picker" />,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
  ClubIdentityProvider: ({ children }: { children: ReactNode }) => children,
}));

// A VERIFIED school request: one teacher plus four youth, which is what the
// group-number boxes prefill from.
const baseSchoolRequest = {
  id: "req-school",
  type: "SCHOOL",
  status: "VERIFIED",
  schoolName: "Test School",
  lodgeId: "lodge-a",
  lodgeName: "Lodge A",
  otherLodgeId: null,
  otherLodgeName: null,
  suggestedGuestNightRates: {},
  cateringPreference: "NON_CATERED",
  schoolGroupSoftCap: 25,
  teachers: [{ firstName: "Tui", lastName: "Teacher", email: null }],
  linkedGuestMembers: [],
  contactFirstName: "Ada",
  contactLastName: "Lovelace",
  contactEmail: "ada@example.com",
  contactPhone: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guests: [
    { firstName: "Tui", lastName: "Teacher", ageTier: "ADULT" },
    ...Array.from({ length: 4 }, (_, index) => ({
      firstName: "School Child",
      lastName: String(index + 1),
      ageTier: "YOUTH",
    })),
  ],
  message: null,
  indicativePriceCents: null,
  priceCents: null,
  verifiedAt: "2026-07-01T00:00:00.000Z",
  pricedAt: null,
  pricedByMemberId: null,
  pricedByMemberName: null,
  reviewedAt: null,
  reviewedByMemberId: null,
  reviewedByMemberName: null,
  declineReason: null,
  convertedBookingId: null,
  attendeesConfirmedAt: null,
  convertedMemberId: null,
  heldBookingId: null,
  acceptedQuoteOptionId: null,
  acceptedPriceCents: null,
  acceptedAt: null,
  responseMessage: null,
  responseMessageAt: null,
  latestQuote: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

/** Serve the queue, and record every POST the panel makes. */
function mockFetch(request: unknown) {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes("/quote") ? {} : { data: [request] }),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function quoteBody(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.find(([url]) =>
    String(url).endsWith("/quote"),
  );
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
}

/** The single Non-catered option's total field (the request's catering preference). */
async function enterTotal(value: string) {
  const field = await screen.findByLabelText(/^Total \(/);
  fireEvent.change(field, { target: { value } });
}

async function editYouthCount(value: string) {
  const box = await screen.findByLabelText("Youth");
  fireEvent.change(box, { target: { value } });
}

describe("PublicBookingRequestsPanel school group numbers on Save quote (#3412)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the officer's adjusted counts with the quote", async () => {
    // The live defect: the panel read "= 20 total" and posted nothing about it,
    // so the quote was priced from the stored list.
    const fetchMock = mockFetch(baseSchoolRequest);
    render(<PublicBookingRequestsPanel />);

    await editYouthCount("2");
    await enterTotal("105.00");
    fireEvent.click(await screen.findByRole("button", { name: "Save quote" }));

    await waitFor(() => expect(quoteBody(fetchMock)).not.toBeNull());
    expect(quoteBody(fetchMock).childCounts).toEqual({
      INFANT: 0,
      CHILD: 0,
      YOUTH: 2,
    });
  });

  it("sends no counts when the officer did not touch the boxes", async () => {
    const fetchMock = mockFetch(baseSchoolRequest);
    render(<PublicBookingRequestsPanel />);

    await enterTotal("105.00");
    fireEvent.click(await screen.findByRole("button", { name: "Save quote" }));

    await waitFor(() => expect(quoteBody(fetchMock)).not.toBeNull());
    expect(quoteBody(fetchMock)).not.toHaveProperty("childCounts");
  });

  it("says why a count change cannot be saved while beds are held, and does not offer the click", async () => {
    const fetchMock = mockFetch({
      ...baseSchoolRequest,
      heldBookingId: "booking-held",
    });
    render(<PublicBookingRequestsPanel />);

    await editYouthCount("2");

    expect(
      await screen.findByText(/Beds are held for this request's current numbers/i),
    ).toBeTruthy();
    const saveQuote = await screen.findByRole("button", { name: "Save quote" });
    expect((saveQuote as HTMLButtonElement).disabled).toBe(true);
    expect(quoteBody(fetchMock)).toBeNull();
  });

  it("holds the beds only once the change is saved", async () => {
    mockFetch(baseSchoolRequest);
    render(<PublicBookingRequestsPanel />);

    const holdSlots = await screen.findByRole("button", { name: "Hold slots" });
    expect((holdSlots as HTMLButtonElement).disabled).toBe(false);

    // With an unsaved change, holding would reserve the count being replaced —
    // and beds held for it then refuse the save.
    await editYouthCount("2");
    expect((holdSlots as HTMLButtonElement).disabled).toBe(true);
    expect(
      await screen.findByText(/Hold slots is off until you save the quote/i),
    ).toBeTruthy();
  });
});
