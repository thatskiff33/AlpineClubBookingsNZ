// @vitest-environment jsdom

/**
 * A refused seasonal-membership load, preview or save says why (#4976,
 * ALP-589).
 *
 * All three parsed every reply as JSON and showed `err.message`, so an HTML
 * 502 from the proxy read as a JSON parse error and a dropped connection as
 * "Failed to fetch". Each now parses with a catch and throws an
 * `ApiRefusalError`, so anything else shows the card's own fallback.
 */

import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

import { MemberSeasonalMembershipCard } from "@/app/(admin)/admin/members/[id]/_components/member-seasonal-membership-card";

type CardMember = ComponentProps<typeof MemberSeasonalMembershipCard>["member"];

const member = {
  id: "m1",
  role: "MEMBER",
  currentSeasonYear: 2026,
  subscriptions: [],
  seasonalMembershipAssignments: [],
} as unknown as CardMember;

const fullType = {
  id: "type-full",
  key: "FULL",
  name: "Full",
  isActive: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
};

const emptySummary = { count: 0, truncatedCount: 0, list: [] };

const preview = {
  seasonYear: 2026,
  applyFrom: null,
  previousAssignment: null,
  newMembershipType: fullType,
  resultingBookingBehavior: "MEMBER_RATE",
  resultingSubscriptionBehavior: "REQUIRED",
  behaviorChanged: false,
  bookingBehaviorChanged: false,
  subscriptionBehaviorChanged: false,
  affectedCounts: { futureConfirmedBookings: 0, draftBookings: 0, waitlistRecords: 0 },
  futureConfirmedBookings: emptySummary,
  draftBookings: emptySummary,
  waitlistRecords: emptySummary,
  currentSeasonSubscription: {
    seasonYear: 2026,
    status: "PAID",
    hasInvoice: false,
    xeroInvoiceNumber: null,
    paidAt: null,
  },
  subscriptionHistory: { totalRecords: 0, recent: [] },
  previewToken: "token-1",
};

type Answer = () => Response | Promise<Response>;

const onSaved = vi.fn(async () => {});

function renderWith({ load, previewAnswer, save }: { load?: Answer; previewAnswer?: Answer; save?: Answer }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/seasonal-membership/preview")) {
        return (previewAnswer ?? (() => Response.json({ preview })))();
      }
      if (url.endsWith("/seasonal-membership")) {
        return (save ?? (() => Response.json({ success: true })))();
      }
      if (url === "/api/admin/membership-types") {
        return (load ?? (() => Response.json({ membershipTypes: [fullType] })))();
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  render(<MemberSeasonalMembershipCard member={member} onSaved={onSaved} />);
}

async function pressPreview() {
  const button = await screen.findByRole("button", { name: /Preview/ });
  await vi.waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
}

async function previewAndSave() {
  await pressPreview();
  fireEvent.change(await screen.findByLabelText("Admin reason"), {
    target: { value: "Moved to full membership" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Save Membership Type/ }));
}

describe("seasonal membership card refusals", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    onSaved.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  describe("loading membership types", () => {
    itShowsEveryRefusal({
      fallback: "Failed to load membership types",
      submit: async (answer) => renderWith({ load: answer }),
    });
  });

  describe("previewing a change", () => {
    itShowsEveryRefusal({
      fallback: "Failed to preview membership change",
      submit: async (answer) => {
        renderWith({ previewAnswer: answer });
        await pressPreview();
      },
    });
  });

  describe("saving a change", () => {
    itShowsEveryRefusal({
      fallback: "Failed to save membership change",
      submit: async (answer) => {
        renderWith({ save: answer });
        await previewAndSave();
      },
    });

    it("reports a saved change and refreshes the member", async () => {
      renderWith({});
      await previewAndSave();

      expect(await screen.findByText("Seasonal membership type saved.")).toBeInTheDocument();
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });
});
