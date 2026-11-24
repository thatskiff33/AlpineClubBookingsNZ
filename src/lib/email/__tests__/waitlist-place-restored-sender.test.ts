import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2649 — the stranded-confirm repair's member notice, pinned at the SENDER.
 *
 * The repair returns a booking to the waitlist after the member's FREE waitlist
 * confirmation was left in PAYMENT_PENDING by a failure in our own code. It
 * originally reused `sendWaitlistOfferExpiredEmail`, whose subject, heading and
 * first line all say the offer EXPIRED — the opposite of what happened (the
 * member confirmed inside the window), and a direct contradiction of the #2648
 * message already sent telling them their confirmation was stuck and not to
 * retry.
 *
 * `sendWaitlistPlaceRestoredEmail` is the true sibling that fixes it, and
 * "sibling" is the property these tests exist to hold: identical plumbing —
 * booking-owner context, template data, optional lodge branding — so the ONLY
 * difference between the two messages is the copy.
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: mocks.sendEmail,
}));

import {
  sendWaitlistOfferExpiredEmail,
  sendWaitlistPlaceRestoredEmail,
} from "@/lib/email/waitlist";
import { EMAIL_DEFAULT_LODGE_NAME } from "@/lib/email-message-settings";

const CHECK_IN = new Date("2026-07-01T00:00:00Z");
const CHECK_OUT = new Date("2026-07-03T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendEmail.mockResolvedValue(undefined);
});

describe("sendWaitlistPlaceRestoredEmail", () => {
  it("sends the restored-place template with the booking-owner context and the member's new position", async () => {
    await sendWaitlistPlaceRestoredEmail(
      { bookingId: "bk_1", recipientMemberId: "mem_1" },
      "member@example.test",
      "Mike",
      CHECK_IN,
      CHECK_OUT,
      3,
      "lodge_1",
    );

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const payload = mocks.sendEmail.mock.calls[0][0];

    expect(payload.to).toBe("member@example.test");
    expect(payload.templateName).toBe("waitlist-place-restored");
    // House subject convention, matching its three waitlist siblings.
    expect(payload.subject).toBe(
      `Your Waitlist Place Is Back - ${EMAIL_DEFAULT_LODGE_NAME}`,
    );
    // Booking-scoped with a named member recipient, so the per-booking "No
    // emails" switch can withhold it and the canonical booking link is only
    // rendered after the server-side authority check.
    expect(payload.bookingContext).toEqual({
      bookingId: "bk_1",
      recipient: { kind: "member", memberId: "mem_1" },
    });
    expect(payload.templateData).toEqual({
      firstName: "Mike",
      checkIn: expect.any(String),
      checkOut: expect.any(String),
      position: 3,
    });
    // Multi-lodge branding is threaded through like every other booking mail.
    expect(payload.lodgeId).toBe("lodge_1");

    // The rendered body says the place is back and never that the offer lapsed.
    expect(payload.html).toContain("Your Waitlist Place Is Back");
    expect(payload.html).toContain("your offer did not run out");
    expect(payload.html.toLowerCase()).not.toContain("expir");
  });

  it("is a true sibling of the expiry notice — same arguments, same context, same tokens", async () => {
    await sendWaitlistPlaceRestoredEmail(
      { bookingId: "bk_1", recipientMemberId: "mem_1" },
      "member@example.test",
      "Mike",
      CHECK_IN,
      CHECK_OUT,
      3,
    );
    await sendWaitlistOfferExpiredEmail(
      // #5433: the expiry notice alone carries an event key (it is an owed
      // notice); the key is not part of what the two share below.
      { bookingId: "bk_1", recipientMemberId: "mem_1", idempotencyKey: "bk_1:1" },
      "member@example.test",
      "Mike",
      CHECK_IN,
      CHECK_OUT,
      3,
    );

    const [restored, expired] = mocks.sendEmail.mock.calls.map(
      (call) => call[0],
    );

    expect(restored.to).toBe(expired.to);
    expect(restored.bookingContext).toEqual(expired.bookingContext);
    expect(restored.templateData).toEqual(expired.templateData);
    // lodgeId is optional on both and defaults to undefined identically.
    expect(restored.lodgeId).toBe(expired.lodgeId);

    // Everything that differs is copy, and it differs in exactly the way the
    // fix is for.
    expect(restored.subject).not.toBe(expired.subject);
    expect(expired.html.toLowerCase()).toContain("has expired");
    expect(restored.html.toLowerCase()).not.toContain("expir");
  });
});
