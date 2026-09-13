// #2919 review. This endpoint is the seam the four client surfaces render
// through: it serves the effective message BODIES, which are templates full of
// `{{merge fields}}`, and it must also serve the club-level values those fields
// resolve to. Without the values a surface can only print braces, which is the
// defect the review found — so the payload shape is a contract, not an
// implementation detail, and the client-side tests all stub this response.
import { describe, expect, it, vi } from "vitest";

const { mockOverrideFindMany, mockLoadEmailMessageSettings } = vi.hoisted(() => ({
  mockOverrideFindMany: vi.fn(),
  mockLoadEmailMessageSettings: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { bookingMessageOverride: { findMany: mockOverrideFindMany } },
}));

// Partial mock: the token-shaping helper in this module stays real, so a change
// to which tokens it emits is visible here.
vi.mock("@/lib/email-message-settings", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/email-message-settings");
  return { ...actual, loadEmailMessageSettings: mockLoadEmailMessageSettings };
});

import { GET } from "@/app/api/booking-messages/route";
import { getDefaultBookingMessages } from "@/lib/booking-message-definitions";

function emailSettings() {
  return {
    clubName: "Alpine Club",
    bookingsName: "Alpine Club - Bookings",
    lodgeName: "Default Lodge",
    emailFromName: "Alpine Club",
    supportEmail: "support@example.test",
    contactEmail: "contact@example.test",
    publicUrl: "https://example.test",
    lodgeTravelNote: "Take the last left.",
    doorCode: "1234",
  };
}

describe("GET /api/booking-messages", () => {
  it("serves the effective bodies together with the club-level token values", async () => {
    mockOverrideFindMany.mockResolvedValue([
      {
        messageKey: "paymentLink.internetBanking.description",
        bodyText: "Transfer to {{CLUB_LODGE_NAME}} using {{paymentReference}}.",
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedByMemberId: "member-1",
      },
    ]);
    mockLoadEmailMessageSettings.mockResolvedValue(emailSettings());

    const body = await (await GET()).json();

    expect(body.messages["paymentLink.internetBanking.description"]).toBe(
      "Transfer to {{CLUB_LODGE_NAME}} using {{paymentReference}}."
    );
    // Untouched keys still come back with their shipped default body.
    expect(body.messages["booking.payment.card.description"]).toBe(
      getDefaultBookingMessages()["booking.payment.card.description"]
    );
    // The four club-level tokens every message may insert. A surface that knows
    // its own lodge overrides CLUB_LODGE_NAME; the other three never vary by
    // lodge, which is why one club-level read serves them all.
    expect(body.tokens).toEqual({
      CLUB_NAME: "Alpine Club",
      CLUB_LODGE_NAME: "Default Lodge",
      BASE_URL: "https://example.test",
      SUPPORT_EMAIL: "support@example.test",
    });
    // Nothing lodge-private rides along on a public endpoint.
    expect(JSON.stringify(body)).not.toContain("1234");
    expect(JSON.stringify(body)).not.toContain("Take the last left");
  });
});
