// @vitest-environment jsdom

/**
 * The admin queue's "saved details need attention" marker and the affordances
 * it turns off (#2342).
 *
 * #2342 made admin reads tolerant so one row with an unreadable stored blob
 * stopped 500ing the whole Booking Requests page. That made such a row
 * REACHABLE by every button on the card — and each of those buttons now fails
 * server-side, because quoting, pricing, holding and approving all strict-read
 * the stored blobs. These tests pin the panel half of that: the marker states
 * only what actually failed, the acting affordances are off, and Decline — the
 * one action that works end to end on a flagged row — stays on.
 */
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

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
const baseRequest = {
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

function mockFetch(request: Record<string, unknown> | Record<string, unknown>[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: Array.isArray(request) ? request : [request] }),
  }) as unknown as typeof fetch;
}

async function renderWith(request: Record<string, unknown> | Record<string, unknown>[]) {
  mockFetch(request);
  render(<PublicBookingRequestsPanel />);
  // Wait for the first fetch to land before asserting on the card. (The school
  // name renders as the card title and the contact line, hence findAll.)
  await screen.findAllByText(/Demo High School|Ada Lovelace/i);
}

function button(name: RegExp) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

const MARKER = /Saved details need attention/i;
const GUEST_REASON = /saved guest list could not be read back/i;
const LINK_REASON = /saved member links could not be read back/i;
const QUOTE_REASON = /saved quote could not be read back/i;

describe("PublicBookingRequestsPanel saved-data marker (#2342)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing on a healthy row, and leaves every action enabled", async () => {
    await renderWith(baseRequest);

    expect(screen.queryByText(MARKER)).toBeNull();
    expect(screen.queryByText(GUEST_REASON)).toBeNull();
    expect(button(/Save quote/i).disabled).toBe(false);
    expect(button(/Send quote/i).disabled).toBe(false);
    expect(button(/Hold slots/i).disabled).toBe(false);
    expect(button(/Approve & invoice school/i).disabled).toBe(false);
    expect(button(/^Decline$/i).disabled).toBe(false);
  });

  it("keeps a permanent alert and focuses an approve failure", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    await renderWith(baseRequest);

    const alert = document.getElementById("public-booking-requests-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe("");
    expect(alert?.classList.contains("sr-only")).toBe(true);

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "Reload the request and try again." }),
    }) as unknown as typeof fetch;
    fireEvent.click(button(/Approve & invoice school/i));

    await waitFor(() =>
      expect(alert?.textContent).toContain("Reload the request and try again."),
    );
    await expectRecoveryAlertToHoldFocus(alert);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("retains ordinary declined-request recovery, suppresses stale decline, and links to the held booking", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    await renderWith([
      { ...baseRequest, heldBookingId: "booking/held" },
      { ...baseRequest, id: "req-2", schoolName: "Second School" },
    ]);

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/booking-requests/req-1/decline" && init?.method === "POST") {
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: "private database detail",
            requestDeclined: true,
            holdReleaseStatusUnconfirmed: true,
          }),
        } as Response;
      }
      if (url === "/api/admin/booking-requests/req-2/approve" && init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "The second request changed; reload it." }),
        } as Response;
      }
      if (url.startsWith("/api/admin/booking-requests?")) {
        return {
          ok: false,
          json: async () => ({ error: "refresh unavailable" }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    fireEvent.click(screen.getAllByRole("button", { name: /^Decline$/i })[0]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Decline and email requester" }),
    );

    const recoveryAlert = document.getElementById("public-booking-requests-recovery");
    const actionAlert = document.getElementById("public-booking-requests-error");
    await waitFor(() =>
      expect(recoveryAlert?.textContent).toMatch(/request was declined/i),
    );
    expect(recoveryAlert?.textContent).toMatch(/capacity hold status could not be confirmed/i);
    expect(recoveryAlert?.textContent).toMatch(/could not be refreshed/i);
    expect(recoveryAlert?.textContent).not.toContain("private database detail");
    await expectRecoveryAlertToHoldFocus(recoveryAlert);
    expect(screen.queryAllByText("Demo High School")).toHaveLength(0);
    expect(
      screen.getByRole("link", { name: "Open affected booking" }).getAttribute("href"),
    ).toBe(
      "/bookings/booking%2Fheld?returnTo=%2Fadmin%2Fbooking-requests",
    );

    fireEvent.click(button(/Approve & invoice school/i));
    await waitFor(() =>
      expect(actionAlert?.textContent).toContain("The second request changed; reload it."),
    );
    await expectRecoveryAlertToHoldFocus(actionAlert);
    expect(recoveryAlert?.textContent).toMatch(/request was declined/i);
  });

  it("states ONLY the guest failure when only the guest list is unreadable", async () => {
    await renderWith({ ...baseRequest, guestDataNeedsAttention: true });

    expect(screen.getByText(MARKER)).toBeTruthy();
    expect(screen.getByText(GUEST_REASON)).toBeTruthy();
    // The pre-fix copy asserted both failures on every flagged row: it told the
    // officer their member links were hidden when the links had parsed fine.
    expect(screen.queryByText(LINK_REASON)).toBeNull();
    expect(screen.queryByText(QUOTE_REASON)).toBeNull();
  });

  it("states ONLY the link failure when only the links are unreadable", async () => {
    await renderWith({ ...baseRequest, linkedMemberDataNeedsAttention: true });

    expect(screen.getByText(MARKER)).toBeTruthy();
    expect(screen.getByText(LINK_REASON)).toBeTruthy();
    // And never tells the officer to distrust names that validated.
    expect(screen.queryByText(GUEST_REASON)).toBeNull();
  });

  it("states ONLY the quote failure when only the stored quote is unreadable", async () => {
    await renderWith({ ...baseRequest, quoteDataNeedsAttention: true });

    expect(screen.getByText(MARKER)).toBeTruthy();
    expect(screen.getByText(QUOTE_REASON)).toBeTruthy();
    expect(screen.queryByText(GUEST_REASON)).toBeNull();
    expect(screen.queryByText(LINK_REASON)).toBeNull();
  });

  it("lists every failure when more than one blob is unreadable", async () => {
    await renderWith({
      ...baseRequest,
      guestDataNeedsAttention: true,
      linkedMemberDataNeedsAttention: true,
      quoteDataNeedsAttention: true,
    });

    expect(screen.getByText(GUEST_REASON)).toBeTruthy();
    expect(screen.getByText(LINK_REASON)).toBeTruthy();
    expect(screen.getByText(QUOTE_REASON)).toBeTruthy();
  });

  it("steers toward the requester and Decline, never toward approving", async () => {
    await renderWith({ ...baseRequest, guestDataNeedsAttention: true });

    const marker = screen.getByText(MARKER).closest("div")!;
    expect(marker.textContent).toMatch(/Check what the group actually wants with the requester/i);
    expect(marker.textContent).toMatch(/Decline/);
    // The old copy ended "Check the details with the requester before you
    // approve it" — steering at the one action that is guaranteed to fail.
    expect(marker.textContent).not.toMatch(/before you approve/i);
    expect(marker.textContent).toMatch(/turned off/i);
    // A bordered warning box with a live region, the idiom this panel already
    // uses for actionable data warnings — not a bare status paragraph.
    expect(marker.getAttribute("role")).toBe("status");
    expect(marker.className).toContain("border-warning-6");
    expect(marker.className).toContain("bg-warning-3");
  });

  it("disables quoting, holding and approving on a flagged row but leaves Decline", async () => {
    await renderWith({ ...baseRequest, guestDataNeedsAttention: true });

    expect(button(/Save quote/i).disabled).toBe(true);
    expect(button(/Send quote/i).disabled).toBe(true);
    expect(button(/Hold slots/i).disabled).toBe(true);
    expect(button(/Approve & invoice school/i).disabled).toBe(true);
    // Decline genuinely works end to end on a flagged row: it never reads the
    // stored guests, and it is the remedy the marker points at.
    expect(button(/^Decline$/i).disabled).toBe(false);
    // Stated beside the buttons too — the marker is several blocks up the card,
    // and a disabled button's title never fires (disabled:pointer-events-none).
    expect(
      screen.getByText(/Quoting, holding and approving are turned off/i),
    ).toBeTruthy();
  });

  it("disables the school group-number boxes, which prefill from the salvaged list", async () => {
    // deriveChildCounts counts an unreadable age tier as ZERO, so these boxes
    // would offer to approve a 30-child group as a handful of people.
    await renderWith({ ...baseRequest, guestDataNeedsAttention: true });

    const youth = screen.getByLabelText(/Youth/i) as HTMLInputElement;
    expect(youth.disabled).toBe(true);
  });

  it("leaves the group-number boxes editable on a healthy row", async () => {
    await renderWith(baseRequest);

    const youth = screen.getByLabelText(/Youth/i) as HTMLInputElement;
    expect(youth.disabled).toBe(false);
  });

  it("does not tell an officer to Decline a request that is already converted", async () => {
    // The row that found this bug was CONVERTED. Its card offers no editor and
    // no Decline, so the open-request remedy would be wrong on both counts.
    await renderWith({
      ...baseRequest,
      status: "CONVERTED",
      convertedBookingId: "bk-1",
      guestDataNeedsAttention: true,
    });

    const marker = screen.getByText(MARKER).closest("div")!;
    expect(marker.textContent).toMatch(/No decision is open on this request/i);
    expect(marker.textContent).not.toMatch(/Decline/);
    expect(marker.textContent).not.toMatch(/turned off/i);
    expect(screen.queryByRole("button", { name: /^Decline$/i })).toBeNull();
    // The reason itself is still stated — the flag is not status-dependent.
    expect(screen.getByText(GUEST_REASON)).toBeTruthy();
  });

  it("keeps the flag off a row flagged only by a sibling row", async () => {
    // Regression guard for the whole point of #2342: one bad row must cost one
    // row, so the marker is per-card and never leaks onto the page.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { ...baseRequest, id: "req-bad", guestDataNeedsAttention: true },
          { ...baseRequest, id: "req-good", schoolName: "Healthy School" },
        ],
      }),
    }) as unknown as typeof fetch;
    render(<PublicBookingRequestsPanel />);
    await screen.findByText(/Healthy School/i);

    expect(screen.getAllByText(MARKER)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Decline$/i })).toHaveLength(2);
  });
});
