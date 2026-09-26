import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chore-roster email renders its date ONCE (#3566, review finding A4).
 *
 * The date comes from the email seam's locale cache, which can refresh while
 * the sender awaits the email palette. Rendering the date for the subject and
 * again inside the body, either side of that await, could therefore put two
 * different dates in one message. The seam is stubbed here to answer
 * differently on every call, so a sender that asked it twice fails.
 */

const h = vi.hoisted(() => ({
  calls: 0,
  sendEmail: vi.fn<(args: { subject: string; html: string }) => Promise<void>>(
    async () => undefined,
  ),
}));

vi.mock("@/lib/email-templates-club-time", () => ({
  emailCalendarDay: () => "unused",
  emailLongWeekdayCalendarDay: () => {
    h.calls += 1;
    return h.calls === 1 ? "Thursday, 16 April 2026" : "Donnerstag, 16. April 2026";
  },
}));
vi.mock("@/lib/email/core", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/email-theme", () => ({
  renderEmailHtml: async (build: () => string) => {
    // The await the finding is about: a refresh can land here.
    await Promise.resolve();
    return build();
  },
  emailPalette: () => ({ charcoal: "#333" }),
}));

import { sendChoreRosterEmail } from "@/lib/email/chores";

beforeEach(() => {
  h.calls = 0;
  h.sendEmail.mockClear();
});

describe("chore-roster email: one date, rendered once (#3566)", () => {
  it("puts the same date in the subject and the body, asking the seam once", async () => {
    await sendChoreRosterEmail(
      { bookingId: "bk_1", recipient: { kind: "member", memberId: "m_1" } },
      "ada@example.com",
      "Ada",
      "2026-04-16",
      [{ name: "Sweep", description: null }],
    );
    expect(h.calls).toBe(1);
    const sent = h.sendEmail.mock.calls[0][0];
    expect(sent.subject).toContain("Thursday, 16 April 2026");
    expect(sent.html).toContain("Thursday, 16 April 2026");
    expect(sent.html).not.toContain("Donnerstag");
  });
});
