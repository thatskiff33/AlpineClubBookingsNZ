// @vitest-environment jsdom

/**
 * The admin queue's "saved details need attention" marker and the affordances
 * it turns off (#2342).
 *
 * #2342 made admin reads tolerant so one row with an unreadable stored blob
 * stopped 500ing the whole Booking Requests page. That made such a row
 * REACHABLE by every button on the card. Some server writers refuse unreadable
 * blobs, while teacher-only corruption does not block direct pricing or holds.
 * These tests pin the panel half of that: the marker states
 * only what actually failed, the acting affordances are off, and Decline — the
 * one action that works end to end on a flagged row — stays on.
 */
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";
import { toast } from "sonner";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Radix Select needs jsdom polyfills this suite does not provide; the pricing
// mode picker is not what is under test here.
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

// A VERIFIED SCHOOL request in a linking-editor status: it renders every acting
// affordance at once — Save quote, Send quote, Hold slots and Approve — so one
// fixture covers the whole gate. It carries a saved quote so "Send quote" is
// enabled on the healthy control rather than trivially disabled.
const schoolRequest = {
  id: "req-1",
  type: "SCHOOL",
  status: "VERIFIED",
  schoolName: "Demo High School",
  lodgeId: null,
  lodgeName: null,
  otherLodgeId: null,
  otherLodgeName: null,
  suggestedGuestNightRates: {},
  exclusivityRequested: false,
  requestedByMemberId: null,
  requestedByMemberName: null,
  cateringPreference: null,
  teachers: [{ firstName: "Mr", lastName: "Teacher", email: "t@example.com" }],
  linkedGuestMembers: [],
  contactFirstName: "Ada",
  contactLastName: "Lovelace",
  contactEmail: "ada@example.com",
  contactPhone: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-03",
  guests: [
    { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
    { firstName: "School Child 1", lastName: "", ageTier: "YOUTH" },
  ],
  schoolGroupSoftCap: 25,
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
  latestQuote: {
    id: "quote-1",
    version: 1,
    status: "DRAFT",
    pricingMode: "OVERALL_TOTAL",
    sentAt: null,
    responseTokenExpiresAt: null,
    options: [
      { id: "CATERED", label: "Catered", totalCents: 12_000, cateringOption: "CATERED" },
    ],
  },
  createdAt: "2026-07-01T00:00:00.000Z",
};

const request = {
  ...schoolRequest, type: "GENERAL", schoolName: null, requestedByMemberId: "member-1",
  requestedByMemberName: "Ada Lovelace", exclusivityRequested: true, applyAccountCredit: true,
  teachers: [], guests: [{ firstName: "Guest 1", lastName: "", ageTier: "ADULT" }],
  wholeLodgeFlatTotalCents: null, latestQuote: null,
};

function mockFetch(memberChoosesPayment: boolean, invoiceMode = "member") {
  global.fetch = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => url.endsWith("/approve")
      ? { type: "MEMBER_WHOLE_LODGE", invoiceMode, exclusiveHoldConflicts: [] }
      : { data: [request], memberWholeLodgeChoosesPaymentMethod: memberChoosesPayment },
  })) as unknown as typeof fetch;
}

describe("#4019 officer whole-lodge payment messages", () => {
  beforeEach(() => vi.clearAllMocks());
  it("shows the stored credit election without promising application after modules were disabled", async () => {
    mockFetch(false);
    render(<PublicBookingRequestsPanel />);
    expect(await screen.findByText(/Account credit will not be applied with the current payment modules/)).toBeTruthy();
    expect(screen.queryByText(/as much of their credit as the total allows is applied/)).toBeNull();
  });
  it("describes credit application when the current modules admit it", async () => {
    mockFetch(true);
    render(<PublicBookingRequestsPanel />);
    expect(await screen.findByText(/as much of their credit as the total allows is applied/)).toBeTruthy();
  });
  it("a zero-price paid approval does not attribute payment to credit", async () => {
    mockFetch(true, "paid");
    render(<PublicBookingRequestsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve & hold the whole lodge" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("The booking is paid and nothing is owing.")));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining("credit covered"));
  });
});
