// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
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
// the pricing-mode picker is irrelevant to the link-conflict advisory here.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

// The contact picker fetches its own data; stub it — it is irrelevant here.
vi.mock("@/components/admin/booking-requests/booking-request-contact-picker", () => ({
  BookingRequestContactPicker: () => <div data-testid="contact-picker" />,
}));

// The panel reads the configurable hut-leader label via useClubIdentity, which
// throws outside a ClubIdentityProvider; stub it with the default label.
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
  ClubIdentityProvider: ({ children }: { children: ReactNode }) => children,
}));

// A general request in an editable status (so the linking editor + advisory
// banner render), with no held booking so the contact picker path is inert.
function baseRequest(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
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
    ...overrides,
  };
}

function conflict(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    memberId: "member-42",
    memberName: "Grace Hopper",
    bookingOwnerName: "Other Owner",
    bookingCheckIn: "2026-08-01",
    bookingCheckOut: "2026-08-03",
    conflictingNights: ["2026-08-01", "2026-08-02"],
    ...overrides,
  };
}

describe("PublicBookingRequestsPanel link-conflict advisory (#1226 follow-up)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the advisory on load for an already-linked conflict (no re-link needed)", async () => {
    // The request arrives with a persisted member link. Nothing is clicked; the
    // banner must appear from the on-load pre-check alone.
    const prelinked = baseRequest({
      linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
    });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/link-conflicts")) {
        return {
          ok: true,
          json: async () => ({ conflicts: [conflict()] }),
        } as Response;
      }
      return { ok: true, json: async () => ({ data: [prelinked] }) } as Response;
    }) as unknown as typeof fetch;

    render(<PublicBookingRequestsPanel />);

    expect(await screen.findByText(/member-night overlap/i)).toBeTruthy();
    expect(
      screen.getByText(/Grace Hopper is already on Other Owner's booking/i),
    ).toBeTruthy();

    // It fired the advisory pre-check for the persisted link on load.
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      calls.some(([input]) => String(input).includes("/link-conflicts")),
    ).toBe(true);
  });

  it("stays advisory-only: a load-time conflict never disables the actions", async () => {
    const prelinked = baseRequest({
      linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
    });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/link-conflicts")) {
        return {
          ok: true,
          json: async () => ({ conflicts: [conflict()] }),
        } as Response;
      }
      return { ok: true, json: async () => ({ data: [prelinked] }) } as Response;
    }) as unknown as typeof fetch;

    render(<PublicBookingRequestsPanel />);

    // Banner is shown...
    await screen.findByText(/member-night overlap/i);
    expect(screen.getByText(/This is advisory only/i)).toBeTruthy();

    // ...yet Save quote, Approve, and Decline all remain enabled — the advisory
    // never blocks; the hard block stays at approve/hold time server-side.
    expect(
      (screen.getByRole("button", { name: "Save quote" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Approve & send payment link",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Decline" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("ignores a stale out-of-order response so only the latest link applies", async () => {
    // No pre-links, so the on-load effect fires nothing — the only link-conflict
    // requests come from the two clicks below.
    const request = baseRequest({ linkedGuestMembers: [] });
    const memberA = {
      id: "member-A",
      firstName: "Alice",
      lastName: "Alpha",
      email: "alice@example.com",
    };
    const memberB = {
      id: "member-B",
      firstName: "Bob",
      lastName: "Beta",
      email: "bob@example.com",
    };

    // Hold each /link-conflicts response open so we can resolve them out of order.
    const pending: Array<{ memberId: string; resolve: (value: Response) => void }> =
      [];
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/link-conflicts")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const memberId = body.links?.[0]?.memberId as string;
        return new Promise<Response>((resolve) => {
          pending.push({ memberId, resolve });
        });
      }
      if (url.includes("/api/admin/members")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ members: [memberA, memberB] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [request] }),
      } as Response);
    }) as unknown as typeof fetch;

    render(<PublicBookingRequestsPanel />);

    // Search for members against the single guest, then link Alice.
    const searchInput = await screen.findByPlaceholderText("Search member");
    fireEvent.change(searchInput, { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Alice Alpha" }));

    // Re-open the results and re-link to Bob (supersedes Alice).
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bob Beta" }));

    // Both requests are in flight. Resolve the LATEST (Bob) first, then let the
    // STALE earlier (Alice) resolve last carrying a different conflict.
    const bob = pending.find((p) => p.memberId === "member-B");
    const alice = pending.find((p) => p.memberId === "member-A");
    expect(bob).toBeTruthy();
    expect(alice).toBeTruthy();

    await act(async () => {
      bob!.resolve({
        ok: true,
        json: async () => ({
          conflicts: [conflict({ memberId: "member-B", memberName: "Bob Beta" })],
        }),
      } as Response);
    });
    await act(async () => {
      alice!.resolve({
        ok: true,
        json: async () => ({
          conflicts: [
            conflict({ memberId: "member-A", memberName: "Alice Alpha" }),
          ],
        }),
      } as Response);
    });

    // The latest (Bob) applies; the stale earlier (Alice) response is discarded.
    expect(await screen.findByText(/Bob Beta is already on/i)).toBeTruthy();
    expect(screen.queryByText(/Alice Alpha is already on/i)).toBeNull();
  });
});
