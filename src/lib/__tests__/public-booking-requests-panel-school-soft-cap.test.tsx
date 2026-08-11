// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
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

// Radix Select needs jsdom polyfills the suite does not provide; stub it out —
// the pricing-mode picker is irrelevant to the soft-cap hint under test.
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

// A VERIFIED school request in a linking-editor status renders the "Adjust group
// numbers" editor and its soft-cap hint. Six CHILD guests + no teachers = a
// planned total of 6; the hint fires only when that exceeds the request's
// server-resolved per-lodge soft cap.
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
  cateringPreference: null,
  teachers: [],
  linkedGuestMembers: [],
  contactFirstName: "Ada",
  contactLastName: "Lovelace",
  contactEmail: "ada@example.com",
  contactPhone: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guests: Array.from({ length: 6 }, (_, index) => ({
    firstName: `Kid${index}`,
    lastName: "Guest",
    ageTier: "CHILD",
  })),
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

function mockFetch(request: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [request] }),
  }) as unknown as typeof fetch;
}

describe("PublicBookingRequestsPanel per-lodge school soft-cap hint (#1656)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the request's server-resolved per-lodge soft cap for the over-cap hint", async () => {
    // The request's lodge resolves to a soft cap of 5; six guests exceed it, so
    // the hint reads "Over 5" — the per-lodge value, not the code default of 25.
    mockFetch({ ...baseSchoolRequest, schoolGroupSoftCap: 5 });
    render(<PublicBookingRequestsPanel />);

    expect(
      await screen.findByText(/Over 5: confirm a club member is staying/i),
    ).toBeTruthy();
    // The default constant (25) must not leak into the copy.
    expect(screen.queryByText(/Over 25/i)).toBeNull();
  });

  it("suppresses the hint when the planned total is within the per-lodge soft cap", async () => {
    // Same six guests, but this lodge's soft cap is 10, so no hint renders.
    mockFetch({ ...baseSchoolRequest, schoolGroupSoftCap: 10 });
    render(<PublicBookingRequestsPanel />);

    // Wait for the request card to render (exact match hits the group-numbers
    // Label, not the longer helper paragraph), then confirm no over-cap hint.
    expect(await screen.findByText("Adjust group numbers")).toBeTruthy();
    expect(screen.queryByText(/confirm a club member is staying/i)).toBeNull();
  });
});
