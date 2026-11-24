/**
 * #5433 (round 3, item 4): one rule for whether an email to an address can go
 * at all, shared by the additional-payment chase and the waitlist offer's
 * restart. Real: the rule, the placeholder rule and the chase's mapping.
 * Doubled: the suppression read and the logger.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const suppression = vi.hoisted(() => ({ read: vi.fn() }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/email-suppression", () => ({ getActiveEmailSuppression: suppression.read }));
vi.mock("@/lib/logger", () => ({ default: log }));

import { emailReachability } from "@/lib/email-reachability";
import { PLACEHOLDER_CONTACT_EMAIL_DOMAIN } from "@/lib/placeholder-contact-email";
import { canReceiveChaseEmail } from "@/lib/reminder-recipient-reachability";

beforeEach(() => {
  vi.clearAllMocks();
  suppression.read.mockResolvedValue(null);
});

describe("emailReachability", () => {
  it.each([
    ["an ordinary address", "ada@example.test", null, "reachable"],
    ["an address on the suppression list", "ada@example.test", { id: "s1" }, "suppressed"],
    ["an empty address", "", null, "no-address"],
    ["a blank address", "   ", null, "no-address"],
    ["no address at all", null, null, "no-address"],
    ["a walk-in placeholder", `walk-in@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`, null, "placeholder"],
  ])("reads %s", async (_case, email, row, answer) => {
    suppression.read.mockResolvedValue(row);
    await expect(emailReachability(email)).resolves.toBe(answer);
  });

  it("asks the suppression list nothing for an address that cannot receive mail", async () => {
    await emailReachability(`walk-in@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`);
    await emailReachability("");
    expect(suppression.read).not.toHaveBeenCalled();
  });

  it("answers unknown, never reachable, when the suppression list cannot be read", async () => {
    suppression.read.mockRejectedValue(new Error("db down"));
    await expect(emailReachability("ada@example.test")).resolves.toBe("unknown");
  });
});

describe("canReceiveChaseEmail, the additional-payment chase's use of it", () => {
  it.each([
    ["an ordinary address", "ada@example.test", null, true],
    ["a suppressed address", "ada@example.test", { id: "s1" }, false],
    ["a placeholder", `walk-in@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`, null, false],
    // As before #5433: an empty address passes, so the chase's preparation (the officers' note) still runs.
    ["an empty address", "", null, true],
  ])("answers for %s", async (_case, email, row, answer) => {
    suppression.read.mockResolvedValue(row);
    await expect(canReceiveChaseEmail(email, "booking1")).resolves.toBe(answer);
  });

  it("skips this pass, as before, when the suppression list cannot be read, on one log line carrying the error and the booking (round 5, F6)", async () => {
    const failure = new Error("db down");
    suppression.read.mockRejectedValue(failure);
    await expect(canReceiveChaseEmail("ada@example.test", "booking1")).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: failure, bookingId: "booking1" }), expect.any(String));
  });
});
