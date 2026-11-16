// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationPreferences } from "@/app/(authenticated)/profile/notification-preferences";
import {
  BULK_EMAIL_CATEGORY_LABELS,
  CLUB_NOTICE_SCOPE,
} from "@/lib/email/bulk-audience";

// #4987, INV-SSOT: a member reading the Club notices switch and an officer
// choosing "Club notice" on the compose page are shown one definition of club
// business, not two copies that can drift.
const preferences = {
  bookingConfirmation: true,
  bookingReminder: true,
  bookingBumped: true,
  bookingCancelled: true,
  bookingAddedByFamily: true,
  choreRoster: true,
  clubNotices: true,
  marketingEmails: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotificationPreferences Club notices switch", () => {
  it("describes a club notice with the same wording the compose page uses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => preferences }) as Response),
    );

    render(<NotificationPreferences />);

    const description = await screen.findByText(CLUB_NOTICE_SCOPE);
    expect(description).toBeInTheDocument();
    expect(screen.getByLabelText("Club notices")).toHaveAttribute("aria-checked", "true");
    expect(BULK_EMAIL_CATEGORY_LABELS.clubNotice.description.startsWith(CLUB_NOTICE_SCOPE)).toBe(true);
  });
});
