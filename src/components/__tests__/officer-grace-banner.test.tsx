// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { requireClubTimeZone } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { officerTwoFactorGraceEnd } from "@/lib/officer-two-factor-grace";

vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: async () => requireClubTimeZone("Pacific/Auckland"),
}));
vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: async () => CLUB_FORMAT_TEST,
}));

import { OfficerGraceBanner } from "@/components/officer-grace-banner";

describe("officer grace banner (#4618, #4620)", () => {
  it("names the deadline and links to where a factor is set up", async () => {
    const endsAt = officerTwoFactorGraceEnd({
      startedAt: new Date("2026-07-01T00:00:00.000Z"),
      graceDays: 14,
      zone: requireClubTimeZone("Pacific/Auckland"),
    }).getTime();
    render(await OfficerGraceBanner({ endsAt }));
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/Set up an authenticator app or a passkey by .+\./);
    expect(
      screen.getByRole("link", { name: "Set it up from your profile" }),
    ).toHaveAttribute("href", "/profile");
  });
});
