// @vitest-environment jsdom

import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";

// Same stubs as the sibling link-conflict suite: the panel replaces the URL in
// an effect, Radix Select needs polyfills jsdom does not provide, and the
// contact picker and club identity fetch or throw outside their providers.
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

// A general request already carrying a priced figure, so the officer's box is
// pre-filled from it and CLEARING the box is distinguishable from never having
// typed in it. That distinction is the whole subject of this file.
function pricedRequest(): Record<string, unknown> {
  return {
    id: "req-1",
    type: "GENERAL",
    status: "PRICED",
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
    guests: [{ firstName: "Grace", lastName: "Hopper", ageTier: "ADULT" }],
    message: null,
    indicativePriceCents: null,
    priceCents: 12000,
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
    heldBookingId: null,
    acceptedQuoteOptionId: null,
    acceptedPriceCents: null,
    acceptedAt: null,
    responseMessage: null,
    responseMessageAt: null,
    latestQuote: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("PublicBookingRequestsPanel: an emptied total refuses rather than falling back", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #2801. `optionTotalInputValue` used to answer `if (key in priceInputs)`,
  // which proves an entry exists and says nothing about its type, so it handed
  // a `string | undefined` to the parser. The fix reads the VALUE and tests it
  // against `undefined` specifically - never for falsiness, because "" is a
  // real officer action with its own meaning: I have emptied this box.
  //
  // Under a falsy check the empty string falls through to the branch below it
  // and the panel quotes the request's STORED price - a figure the officer has
  // just deliberately erased - with no refusal and no sign anything happened.
  // That is invented money, so it gets a runtime test rather than a comment.
  it("refuses an emptied total and posts no quote, instead of quoting the stored price", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/link-conflicts")) {
        return { ok: true, json: async () => ({ conflicts: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ data: [pricedRequest()] }) } as Response;
    }) as unknown as typeof fetch;

    render(<PublicBookingRequestsPanel />);

    // The box is pre-filled from the stored $120.00, which is what makes the
    // fallback reachable at all.
    const total = (await screen.findByLabelText("Total (NZD)")) as HTMLInputElement;
    expect(total.value).toBe("120.00");

    fireEvent.change(total, { target: { value: "" } });
    expect(total.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save quote" }));

    expect(await screen.findByText(/Enter a valid .*total/i)).toBeTruthy();

    // And nothing was sent. The refusal has to happen before the request, not
    // be a message shown after one.
    const posted = (
      global.fetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([input]) => String(input).includes("/quote"));
    expect(posted).toEqual([]);
  });

  // The control case, so the test above cannot pass by the panel simply
  // refusing everything.
  it("still quotes a total the officer actually typed", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/link-conflicts")) {
        return { ok: true, json: async () => ({ conflicts: [] }) } as Response;
      }
      if (url.includes("/quote")) {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => ({ data: [pricedRequest()] }) } as Response;
    }) as unknown as typeof fetch;

    render(<PublicBookingRequestsPanel />);

    const total = (await screen.findByLabelText("Total (NZD)")) as HTMLInputElement;
    fireEvent.change(total, { target: { value: "155.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quote" }));

    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const quoteCall = await vi.waitFor(() => {
      const found = (
        global.fetch as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.find(([input]) => String(input).includes("/quote"));
      expect(found).toBeTruthy();
      return found;
    });
    expect(calls.length).toBeGreaterThan(0);

    // 155.50 dollars is 15550 cents, exactly - integer cents, no float drift.
    const body = JSON.parse(String((quoteCall?.[1] as RequestInit).body));
    expect(body.options).toEqual([
      { id: "STANDARD", cateringOption: null, totalCents: 15550 },
    ]);
  });
});
