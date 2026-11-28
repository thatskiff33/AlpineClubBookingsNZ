import { describe, expect, it, vi } from "vitest";
import { normalizeEmailMessagePublicUrl } from "@/lib/email-message-public-url";
import {
  formatEmailFromAddressWithSettings,
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

  it("reads club fields from persisted but keeps lodge identity at config defaults", () => {
    const defaults = normalizeEmailMessageSettings(null);
    const withClub = normalizeEmailMessageSettings({ clubName: "River Valley Club" });

    // Club-level fields still come from the persisted singleton.
    expect(withClub.clubName).toBe("River Valley Club");
    // Lodge identity is no longer persisted here: normalize returns the config
    // defaults regardless of persisted input (real lodge identity resolves via
    // the load functions, from the Lodge table).
    expect(withClub.lodgeName).toBe(defaults.lodgeName);
    expect(withClub.lodgeTravelNote).toBe(defaults.lodgeTravelNote);
    expect(withClub.doorCode).toBeNull();
  });
});
