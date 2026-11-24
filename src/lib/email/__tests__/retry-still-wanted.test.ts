/**
 * #5433 (round 3, item 2): the retry job's "still wanted?" seam answers for
 * the templates that register a check and passes every other one straight
 * through, loading no domain code for it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.hoisted(() => ({ waitlist: vi.fn() }));
vi.mock("@/lib/waitlist-offer-email-state", () => ({ waitlistOfferEmailStillWanted: check.waitlist }));

import { emailStillWanted, STILL_WANTED_TEMPLATE_NAMES } from "@/lib/email/retry-still-wanted";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("emailStillWanted", () => {
  it("registers the waitlist offer email, and only it", () => {
    expect(STILL_WANTED_TEMPLATE_NAMES).toEqual(["waitlist-offer"]);
  });

  it("asks the waitlist offer email's check, with the row's id and booking", async () => {
    check.waitlist.mockResolvedValue("the booking is WAITLISTED");
    await expect(emailStillWanted({ id: "row", bookingId: "bk", templateName: "waitlist-offer" })).resolves.toBe("the booking is WAITLISTED");
    expect(check.waitlist).toHaveBeenCalledWith({ id: "row", bookingId: "bk" });
  });

  it.each([["booking-confirmed"], ["waitlist-offer-expired"], ["constructor"], ["toString"]])(
    "passes %s straight through, asking nothing",
    async (templateName) => {
      await expect(emailStillWanted({ id: "row", bookingId: "bk", templateName })).resolves.toBe(true);
      expect(check.waitlist).not.toHaveBeenCalled();
    },
  );

  it("lets a failing check throw, so the job leaves the row as found", async () => {
    check.waitlist.mockRejectedValue(new Error("db down"));
    await expect(emailStillWanted({ id: "row", bookingId: "bk", templateName: "waitlist-offer" })).rejects.toThrow("db down");
  });
});
