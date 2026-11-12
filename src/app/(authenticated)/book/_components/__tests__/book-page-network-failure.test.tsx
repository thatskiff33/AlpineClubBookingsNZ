// @vitest-environment jsdom

/**
 * #4942 — what the member SEES when the connection drops on the review step.
 *
 * The hook tests pin the busy flags; this pins the screen they drive. Before
 * the fix a rejected create left "Creating booking..." on a disabled button,
 * Save as Draft greyed out beside it, and nothing in the alert region. The
 * member's only way out was to reload and lose everything they had typed.
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestData } from "@/components/guest-form";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

const routerMocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "member-1", role: "MEMBER", accessRoles: [] } },
  }),
}));

vi.mock("@/lib/access-roles", () => ({ hasAdminAccess: () => false }));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

// The calendar and guest form have their own tests; these buttons drive the
// wizard the way a member would.
vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: ({ onDateSelect }: { onDateSelect: (ci: string, co: string) => void }) => (
    <button onClick={() => onDateSelect("2026-07-10", "2026-07-12")}>pick test dates</button>
  ),
}));

vi.mock("@/components/guest-form", () => ({
  GuestForm: ({ onGuestsChange }: { onGuestsChange: (guests: GuestData[]) => void }) => (
    <button
      onClick={() =>
        onGuestsChange([
          {
            firstName: "Jo",
            lastName: "Member",
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

vi.mock("@/components/promo-code-input", () => ({ PromoCodeInput: () => null }));
vi.mock("@/components/time-picker", () => ({ TimePicker: () => null }));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import BookPage from "@/app/(authenticated)/book/page";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

/** `createRejects` counts how many create posts lose their reply. */
function stubFetch(opts: { quoteRejects?: number; createRejects?: number }) {
  let quoteRejects = opts.quoteRejects ?? 0;
  let createRejects = opts.createRejects ?? 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (u.includes("/api/lodges")) {
        return jsonResponse({ lodges: [{ id: "lodge-1", name: "Alpine Lodge", active: true }] });
      }
      if (u.includes("/api/bookings/quote")) {
        if (quoteRejects > 0) {
          quoteRejects -= 1;
          throw new TypeError("Failed to fetch");
        }
        return jsonResponse({
          guests: [{ ageTier: "ADULT", isMember: true, nights: 2, priceCents: 4000 }],
          totalPriceCents: 4000,
        });
      }
      if (u.endsWith("/api/bookings") && init?.method === "POST") {
        if (createRejects > 0) {
          createRejects -= 1;
          throw new TypeError("Failed to fetch");
        }
        return jsonResponse({ id: "booking-1", status: "PAYMENT_PENDING" });
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
      if (u.includes("/api/availability/check")) {
        return jsonResponse({ minAvailable: 10, nightDetails: [] });
      }
      if (u.includes("/api/booking-policies/check")) return jsonResponse({ valid: true });
      if (u.includes("/api/member/subscription-status")) {
        return jsonResponse({
          status: "PAID",
          seasonDisplay: "2026",
          invoiceUrl: null,
          invoiceNumber: null,
        });
      }
      if (u.includes("/api/members/family")) return jsonResponse({ familyMembers: [] });
      if (u.includes("/api/booking-messages")) return jsonResponse({ messages: {} });
      if (u.includes("/api/bookings/rooms")) return jsonResponse({ enabled: false, rooms: [] });
      if (u.includes("/api/work-parties/active")) return jsonResponse({ events: [] });
      if (u.includes("/api/promo-codes/available")) return jsonResponse([]);
      return jsonResponse({}, false);
    }),
  );
}

async function advanceToGuestsStep() {
  render(<BookPage />);
  fireEvent.click(await screen.findByText("pick test dates"));
  fireEvent.click(await screen.findByText("add test guest"));
}

beforeEach(() => {
  routerMocks.push.mockReset();
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the booking wizard after a dropped connection (#4942)", () => {
  it("re-enables the review step's buttons and announces the unknown outcome", async () => {
    stubFetch({ createRejects: 1 });
    await advanceToGuestsStep();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Payment" }));

    // The message reaches the alert region, so a screen reader announces it.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      unverifiedWriteMessage(
        "your booking was created",
        "Open My Bookings to check before trying again.",
      ),
    );
    const create = screen.getByRole("button", { name: "Continue to Payment" });
    expect(create).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save as Draft" })).toBeEnabled();

    // And the same press works once the connection is back.
    fireEvent.click(create);
    expect(await screen.findByText("Complete Payment")).toBeInTheDocument();
  });

  it("re-enables the guests step's Continue after the quote fails", async () => {
    stubFetch({ quoteRejects: 1 });
    await advanceToGuestsStep();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not calculate the price. Check your connection and try again.",
    );
    const next = screen.getByRole("button", { name: "Continue" });
    expect(next).toBeEnabled();

    fireEvent.click(next);
    expect(
      await screen.findByRole("button", { name: "Continue to Payment" }),
    ).toBeInTheDocument();
  });
});
