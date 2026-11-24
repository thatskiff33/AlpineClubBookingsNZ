import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #5433: the officers' waitlist offer alert hands a saved text override its
 * tokens. {{offerNote}} says what became of the offer email, and {{expiresAt}}
 * is the deadline in force; a missing deadline renders a phrase, never the
 * "has until  to confirm" gap a saved override would show (round 3, item 3).
 */

const h = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../admin-alerts-shared", () => ({ sendToAdmins: h.sendToAdmins }));
vi.mock("@/lib/email-theme", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  renderEmailHtml: async (render: () => string) => render(),
}));

import { sendAdminWaitlistOfferAlert } from "@/lib/email/admin-alerts-booking";
import { waitlistOfferAlertNote } from "@/lib/waitlist-offer-alert-note";

const alert = {
  memberName: "Ada Proof",
  checkIn: new Date("2026-07-10T00:00:00.000Z"),
  checkOut: new Date("2026-07-12T00:00:00.000Z"),
  guestCount: 2,
  position: 1,
};

beforeEach(() => {
  h.sendToAdmins.mockReset();
  h.sendToAdmins.mockResolvedValue({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, failedBeforeLogged: 0 });
});

describe("sendAdminWaitlistOfferAlert", () => {
  it("gives a saved override a phrase for a missing deadline, not an empty gap", async () => {
    await sendAdminWaitlistOfferAlert({ ...alert, expiresAt: null, offerEmail: "sent" });
    expect(h.sendToAdmins.mock.calls[0][0].templateData.expiresAt).toBe("the deadline shown on the booking");
  });

  it("gives the deadline in force when there is one", async () => {
    await sendAdminWaitlistOfferAlert({ ...alert, expiresAt: new Date("2026-07-03T00:00:00.000Z"), offerEmail: "sent" });
    const { expiresAt } = h.sendToAdmins.mock.calls[0][0].templateData;
    expect(expiresAt).not.toBe("the deadline shown on the booking");
    expect(expiresAt).toMatch(/2026/);
  });

  it.each([["sent"], ["withheld"], ["not-delivered"]] as const)("hands {{offerNote}} the note for an offer email %s", async (outcome) => {
    await sendAdminWaitlistOfferAlert({ ...alert, expiresAt: null, offerEmail: outcome });
    expect(h.sendToAdmins.mock.calls[0][0].templateData.offerNote).toBe(waitlistOfferAlertNote("Ada Proof", outcome));
  });

  it("says what to do when the email was withheld, and that turning emails back on does not send it (round 4, item 2)", () => {
    const note = waitlistOfferAlertNote("Ada Proof", "withheld");
    expect(note).toContain('"No emails" was on for this booking');
    expect(note).toContain("Turning emails back on does not send it");
    expect(note).toContain("contact the member directly, or retract the offer");
    expect(note).not.toContain("live site");
  });
});
