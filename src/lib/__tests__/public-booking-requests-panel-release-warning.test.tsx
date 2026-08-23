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

// Radix Select needs jsdom polyfills the suite does not provide; stub it out —
// the pricing-mode picker is irrelevant to the release-hold warning under test.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

// The contact picker is not rendered while a hold exists; stub it defensively.
vi.mock("@/components/admin/booking-requests/booking-request-contact-picker", () => ({
  BookingRequestContactPicker: () => <div data-testid="contact-picker" />,
}));

// The panel reads the configurable hut-leader label via useClubIdentity, which
// throws outside a ClubIdentityProvider; stub it with the default label.
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
  ClubIdentityProvider: ({ children }: { children: ReactNode }) => children,
}));

// A general request that HAS a held booking and is in a whitelisted status, so
// the read-only note + "Release hold" action render.
const heldRequest = {
  id: "req-1",
  type: "GENERAL",
  status: "QUOTE_SENT",
  schoolName: null,
  cateringPreference: null,
  teachers: [],
  linkedGuestMembers: [],
  contactFirstName: "Ada",
  contactLastName: "Lovelace",
  contactEmail: "ada@example.com",
  contactPhone: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guests: [],
  message: null,
  indicativePriceCents: null,
  priceCents: null,
  verifiedAt: null,
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
  heldBookingId: "held-1",
  acceptedQuoteOptionId: null,
  acceptedPriceCents: null,
  acceptedAt: null,
  responseMessage: null,
  responseMessageAt: null,
  latestQuote: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("PublicBookingRequestsPanel release-hold warning (#1255 RR-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [heldRequest] }),
    }) as unknown as typeof fetch;
  });

  it("surfaces the quote-link warning in the Release-hold confirm before confirming", async () => {
    render(<PublicBookingRequestsPanel />);

    // Wait for the fetched request to render its Release-hold action.
    const releaseButton = await screen.findByRole("button", { name: "Release hold" });

    // The warning is only shown once the admin opens the confirm step.
    expect(screen.queryByText(/existing quote link/i)).toBeNull();

    fireEvent.click(releaseButton);

    await waitFor(() => {
      expect(
        screen.getByText(/the requester's existing quote link\s+stays active/i),
      ).toBeTruthy();
    });
    // And it advises the mitigation (re-send a fresh quote after re-mapping).
    expect(screen.getByText(/re-send a fresh quote after/i)).toBeTruthy();
    // The confirm action is present alongside the warning.
    expect(screen.getByRole("button", { name: "Confirm release" })).toBeTruthy();
  });

  it("hides request mutation controls for bookings view-only access", async () => {
    render(<PublicBookingRequestsPanel canEdit={false} />);

    /*
      Wait on the request CARD, not on the view-only explanation.

      This assertion used to await the per-request `AdminViewOnlyNotice`
      ("can view this request but cannot price…"), which #2160 removed in favour
      of one section banner. That notice rendered INSIDE the fetched request
      card, so awaiting it did double duty: it checked the explanation AND
      synchronised on the fetch. The banner does not — it renders at the top of
      the panel, synchronously, whether or not any request has loaded. Swapping
      the await straight over to the banner would therefore make the two
      assertions below vacuous: with no card rendered yet, "Release hold" and
      the contact picker are absent for every `canEdit`, and the test would keep
      passing even if the gate broke completely.

      So the await is anchored to the contact email, which every request card
      renders regardless of `canEdit`. Only once the card is on screen do the
      absence checks mean anything.
    */
    expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();

    // The explanation now lives once, in the section banner.
    expect(screen.getByTestId("admin-view-only-banner").textContent).toMatch(
      /can view booking requests but cannot price/i,
    );

    // …and the mutation controls themselves are still gone, which is the point
    // of this test. Only the explanation moved.
    expect(screen.queryByRole("button", { name: "Release hold" })).toBeNull();
    expect(screen.queryByTestId("contact-picker")).toBeNull();
  });
});

// The manual "Hold slots" entry is SCHOOL-only as of #1385: the generic quote
// flow auto-holds the beds on quote send (#1280), so the manual hold is redundant
// there and hidden. SCHOOL requests keep it (school approval reuses the held
// booking, #1352). An actionable request in a LINKING_EDITOR status with no hold
// yet renders the full action-button row, so this is where the gate is visible.
describe("PublicBookingRequestsPanel manual Hold slots visibility (#1385)", () => {
  const actionableBase = {
    ...heldRequest,
    status: "VERIFIED",
    heldBookingId: null,
  };

  function mockFetch(request: unknown) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [request] }),
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render the manual Hold slots button on a generic request", async () => {
    mockFetch({
      ...actionableBase,
      id: "req-general",
      type: "GENERAL",
      schoolName: null,
    });

    render(<PublicBookingRequestsPanel />);

    // The action row still renders (e.g. Send quote), so the absence of the hold
    // button is the gate, not an unrendered block.
    await screen.findByRole("button", { name: "Send quote" });
    expect(screen.queryByRole("button", { name: "Hold slots" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Slots held" })).toBeNull();
  });

  it("renders the manual Hold slots button on a SCHOOL request", async () => {
    mockFetch({
      ...actionableBase,
      id: "req-school",
      type: "SCHOOL",
      schoolName: "Test School",
    });

    render(<PublicBookingRequestsPanel />);

    const holdButton = await screen.findByRole("button", { name: "Hold slots" });
    expect(holdButton).toBeTruthy();
    // Still wired: enabled while no hold exists (onClick -> handleHoldSlots).
    expect((holdButton as HTMLButtonElement).disabled).toBe(false);
  });
});
