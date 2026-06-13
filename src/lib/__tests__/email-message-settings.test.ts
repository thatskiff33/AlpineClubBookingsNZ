import { describe, expect, it, vi } from "vitest";
import {
  formatEmailFromAddressWithSettings,
  normalizeEmailMessagePublicUrl,
  normalizeEmailMessageSettings,
  type EmailMessageSettings,
} from "@/lib/email-message-settings";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

const baseSettings: EmailMessageSettings = {
  clubName: "Example Mountain Club",
  bookingsName: "Example Mountain Club - Bookings",
  lodgeName: "Example Mountain Club Lodge",
  emailFromName: "Example Mountain Club",
  supportEmail: "support@example.org",
  contactEmail: "bookings@example.org",
  publicUrl: "https://bookings.example.org",
  lodgeTravelNote: "Please allow adequate travel time.",
  doorCode: null,
};

describe("email message settings", () => {
  it("escapes backslashes and quotes in From display names", () => {
    expect(
      formatEmailFromAddressWithSettings(
        {
          ...baseSettings,
          emailFromName: 'Example \\ "Bookings"\r\nTeam',
        },
        "sender@example.org",
      ),
    ).toBe(String.raw`"Example \\ \"Bookings\" Team" <sender@example.org>`);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "mailto:support@example.org",
    "ftp://bookings.example.org",
  ])("rejects non-http public URLs: %s", (publicUrl) => {
    expect(normalizeEmailMessagePublicUrl(publicUrl)).toBeNull();
  });

  it.each([
    ["https://bookings.example.org///", "https://bookings.example.org"],
    ["http://localhost:3000/", "http://localhost:3000"],
  ])("normalizes http public URLs", (publicUrl, normalized) => {
    expect(normalizeEmailMessagePublicUrl(publicUrl)).toBe(normalized);
  });

  it("falls back when persisted publicUrl uses a non-http scheme", () => {
    const normalized = normalizeEmailMessageSettings({
      publicUrl: "javascript:alert(1)",
    });

    expect(normalized.publicUrl).toMatch(/^https?:\/\//);
    expect(normalized.publicUrl).not.toContain("javascript");
  });

  it("normalizes blank and configured door codes", () => {
    expect(normalizeEmailMessageSettings({ doorCode: "  2468  " }).doorCode).toBe(
      "2468",
    );
    expect(normalizeEmailMessageSettings({ doorCode: "   " }).doorCode).toBeNull();
    expect(normalizeEmailMessageSettings({}).doorCode).toBeNull();
  });
});
