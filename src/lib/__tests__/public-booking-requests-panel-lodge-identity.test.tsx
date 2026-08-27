// @vitest-environment jsdom

import { render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";

// next/navigation: the panel replaces the URL in an effect and reads params.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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
  lodgeName: "Lodge Two",
  heldBookingId: "held-1",
  acceptedQuoteOptionId: null,
  acceptedPriceCents: null,
  acceptedAt: null,
  responseMessage: null,
  responseMessageAt: null,
  latestQuote: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("PublicBookingRequestsPanel lodge identity (#2887)", () => {
  /*
    The badge follows `request.lodgeName` and nothing else, because ADR-002's
    single-lodge rule is applied SERVER-side now
    (`serializeBookingRequestForAdmin` nulls the name below two active lodges).

    That matters in both directions. This panel used to count
    `useLodgeOptions().lodges`, which is empty for a FAILED or FORBIDDEN list as
    well as for a real single-lodge club — and `/api/admin/lodges` needs
    `lodge:view`, which `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` do not have, so
    their 403 is permanent. A multi-lodge club's officer priced and approved
    with no lodge on screen. Counting client-side also went wrong the other way
    once this PR made the whole-lodge form always send the sole lodge id: new
    single-lodge rows carry a real name, so a single-lodge club would have shown
    a permanent badge.
  */
  function renderWith(lodgeName: string | null) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ ...heldRequest, lodgeName }] }),
    }) as unknown as typeof fetch;
    render(<PublicBookingRequestsPanel />);
  }

  beforeEach(() => vi.clearAllMocks());

  it("shows the lodge the server named, whatever the officer may read", async () => {
    renderWith("Lodge Two");
    expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
    expect(screen.getByText("Lodge Two")).toBeTruthy();
  });

  it("shows nothing when the server withheld the name (ADR-002 single lodge)", async () => {
    renderWith(null);
    expect(await screen.findByText(/ada@example\.com/)).toBeTruthy();
    expect(screen.queryByText("Lodge Two")).toBeNull();
  });
});
