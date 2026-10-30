// @vitest-environment jsdom

/**
 * Subscription-category decoupling: the card's new, independent "Subscription
 * Category" selector. It must default to "Individual", never gate on or
 * change Membership Type, and flow through to both the preview and save
 * request bodies as subscriptionCategoryId (null for Individual).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
// The shared renderer, not Testing Library directly: this card reads the
// club's zone from `useClubTime()`, which throws deliberately with no
// provider mounted.
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit", bookings: "edit", membership: "edit", finance: "edit",
          lodge: "edit", content: "edit", support: "edit",
        },
      },
    },
  }),
}));

import { MemberSeasonalMembershipCard } from "@/app/(admin)/admin/members/[id]/_components/member-seasonal-membership-card";

type CardMember = ComponentProps<typeof MemberSeasonalMembershipCard>["member"];

function member(overrides: Record<string, unknown> = {}): CardMember {
  return {
    id: "m1",
    role: "MEMBER",
    currentSeasonYear: 2026,
    subscriptions: [],
    seasonalMembershipAssignments: [],
    ...overrides,
  } as unknown as CardMember;
}

const membershipType = { id: "type-full", name: "Full", isActive: true, bookingBehavior: "MEMBER_RATE", subscriptionBehavior: "REQUIRED" };
const subscriptionCategory = { id: "cat-couple", key: "COUPLE", name: "Couple", isActive: true, isBuiltIn: false };

const assignment = {
  id: "a1",
  seasonYear: 2026,
  applyFrom: null,
  membershipTypeId: "type-full",
  membershipType,
  subscriptionCategoryId: "cat-couple",
  subscriptionCategory,
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function stubFetch(previewBody?: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/admin/membership-types")) {
      return jsonResponse({ membershipTypes: [membershipType] });
    }
    if (url.endsWith("/api/admin/subscription-categories")) {
      return jsonResponse({ subscriptionCategories: [subscriptionCategory] });
    }
    if (url.includes("/seasonal-membership/preview")) {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({
        preview: previewBody ?? {
          seasonYear: 2026, applyFrom: null, previousAssignment: null,
          newMembershipType: membershipType,
          resultingBookingBehavior: "MEMBER_RATE", resultingSubscriptionBehavior: "REQUIRED",
          behaviorChanged: false, bookingBehaviorChanged: false, subscriptionBehaviorChanged: false,
          newSubscriptionCategory: subscriptionCategory, subscriptionCategoryChanged: true,
          affectedCounts: { futureConfirmedBookings: 0, draftBookings: 0, waitlistRecords: 0 },
          futureConfirmedBookings: { count: 0, truncatedCount: 0, list: [] },
          draftBookings: { count: 0, truncatedCount: 0, list: [] },
          waitlistRecords: { count: 0, truncatedCount: 0, list: [] },
          currentSeasonSubscription: { seasonYear: 2026, status: "NOT_INVOICED", hasInvoice: false, xeroInvoiceNumber: null, paidAt: null },
          subscriptionHistory: { totalRecords: 0, recent: [] },
          previewToken: "token-1",
        },
      });
    }
    if (url.endsWith("/seasonal-membership") && init?.method === "PATCH") {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return jsonResponse({ assignment: { ...assignment }, changed: true });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("MemberSeasonalMembershipCard subscription category", () => {
  it("defaults to Individual for a member with no category assignment", async () => {
    stubFetch();
    render(<MemberSeasonalMembershipCard member={member()} onSaved={vi.fn()} />);
    await screen.findByText("Subscription Category");
    // The trigger renders the selected value's text; Individual is the default.
    expect(await screen.findByText("Individual")).toBeTruthy();
  });

  it("shows the member's current category when one is assigned", async () => {
    stubFetch();
    render(
      <MemberSeasonalMembershipCard
        member={member({ seasonalMembershipAssignments: [assignment] })}
        onSaved={vi.fn()}
      />,
    );
    expect(await screen.findByText("Couple")).toBeTruthy();
  });

  it("sends subscriptionCategoryId in the preview and save requests", async () => {
    const calls = stubFetch();
    render(
      <MemberSeasonalMembershipCard
        member={member({ seasonalMembershipAssignments: [assignment] })}
        onSaved={vi.fn()}
      />,
    );
    await screen.findByText("Couple");

    // currentAssignment already has the category, applyFrom unchanged, type
    // unchanged — targetChanged is false until something actually differs.
    // Changing applyFrom is the simplest way to make Preview clickable here.
    const applyFromInput = document.querySelector("#seasonal-membership-apply-from") as HTMLInputElement;
    fireEvent.change(applyFromInput, { target: { value: "2026-05-01" } });

    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/preview"))).toBe(true));
    const previewCall = calls.find((c) => c.url.includes("/preview"))!;
    expect(previewCall.body).toMatchObject({ subscriptionCategoryId: "cat-couple" });

    fireEvent.change(screen.getByLabelText("Admin reason"), { target: { value: "testing" } });
    fireEvent.click(screen.getByRole("button", { name: /save membership type/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/seasonal-membership"))).toBe(true));
    const saveCall = calls.find((c) => c.url.endsWith("/seasonal-membership"))!;
    expect(saveCall.body).toMatchObject({ subscriptionCategoryId: "cat-couple" });
  });

  it("sends null when the member stays on Individual", async () => {
    const calls = stubFetch();
    render(<MemberSeasonalMembershipCard member={member()} onSaved={vi.fn()} />);
    await screen.findByText("Individual");

    const applyFromInput = document.querySelector("#seasonal-membership-apply-from") as HTMLInputElement;
    fireEvent.change(applyFromInput, { target: { value: "2026-05-01" } });
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => expect(calls.some((c) => c.url.includes("/preview"))).toBe(true));
    const previewCall = calls.find((c) => c.url.includes("/preview"))!;
    expect(previewCall.body).toMatchObject({ subscriptionCategoryId: null });
  });
});
