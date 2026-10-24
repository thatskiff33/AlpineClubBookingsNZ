import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4030 — the "Booking Modified" email names the guests a change added.
 *
 * The owner's decision on #4030 says the member gets "the usual change email
 * listing the guests and amount". The email used to say only that the guest
 * count went from 1 to 3. The names now ride the shared change rows
 * (`bookingModificationSummaryRows`), so the hand-built HTML email and the
 * admin-editable `{{changeSummary}}` body carry the same line, on every path
 * that sends the email (the officer's finished-stay approval and a member's own
 * edit both go through the batch service; the guest-add route sends it too).
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));
vi.mock("@/lib/email/core", () => ({ sendEmail }));

import { bookingModificationSummaryRows } from "@/lib/booking-money-lines";
import { bookingModifiedTemplate } from "@/lib/email-templates/booking";
import { sendBookingModifiedEmail } from "@/lib/email/booking";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-13T00:00:00.000Z");
const NIGHT_2 = new Date("2026-08-14T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-15T00:00:00.000Z");

const ARI = { firstName: "Ari", lastName: "Grandchild", stayStart: CHECK_IN, stayEnd: CHECK_OUT };
const BO = { firstName: "Bo", lastName: "Grandchild", stayStart: NIGHT_2, stayEnd: CHECK_OUT };

function params(addedGuests: ReadonlyArray<typeof ARI & { consentStatus?: string | null }>) {
  return {
    firstName: "Heidi",
    modificationType: "BATCH_MODIFY",
    oldCheckIn: CHECK_IN,
    oldCheckOut: CHECK_OUT,
    newCheckIn: CHECK_IN,
    newCheckOut: CHECK_OUT,
    oldGuestCount: 1,
    newGuestCount: 1 + addedGuests.length,
    oldFinalPriceCents: 9000,
    newFinalPriceCents: 18_500,
    changeFeeCents: 0,
    refundAmountCents: 0,
    additionalAmountCents: 9500,
    additionalPaymentMethod: "INTERNET_BANKING" as const,
    paymentReference: "BANK-REF-4030",
    xeroInvoiceNumber: "INV-4030",
    addedGuests,
    appliedCreditGivenBackCents: 0,
    unpaidAskCancelled: false,
    financialReviewPending: false,
    refundByBankTransfer: null,
    refundDestination: "own" as const,
  };
}

const EXPECTED_LINE = "Ari Grandchild; Bo Grandchild (14 Aug 2026 – 15 Aug 2026)";

beforeEach(() => sendEmail.mockClear());

describe("booking-modified email names the added guests (#4030)", () => {
  it("adds one row naming each guest, with nights only for a guest who stays part of the stay", () => {
    const rows = bookingModificationSummaryRows(params([ARI, BO]), CLUB_FORMAT_TEST);
    expect(rows).toContainEqual({ label: "Guests Added", value: EXPECTED_LINE });
    // Right after the counts it explains.
    const labels = rows.map((row) => row.label);
    expect(labels.indexOf("Guests Added")).toBe(labels.indexOf("New Guests") + 1);
  });

  it("marks a member guest still awaiting their consent (#4030 review S8)", () => {
    const rows = bookingModificationSummaryRows(
      params([ARI, { ...BO, consentStatus: "PENDING" }, { ...ARI, firstName: "Cy", consentStatus: "CONFIRMED" }]),
      CLUB_FORMAT_TEST,
    );
    expect(rows).toContainEqual({
      label: "Guests Added",
      value:
        "Ari Grandchild; Bo Grandchild (14 Aug 2026 – 15 Aug 2026) (waiting for them to accept); Cy Grandchild",
    });
  });

  it("adds no row when the change added nobody", () => {
    const rows = bookingModificationSummaryRows(params([]), CLUB_FORMAT_TEST);
    expect(rows.map((row) => row.label)).not.toContain("Guests Added");
  });

  it("the admin-editable body's {{changeSummary}} carries the names", async () => {
    await sendBookingModifiedEmail(
      { bookingId: "bk-1", recipientMemberId: "m-1", email: "heidi@example.org", ...params([ARI, BO]) },
      CLUB_FORMAT_TEST,
    );
    const [[call]] = sendEmail.mock.calls as unknown as [[{ templateData: { changeSummary: string } }]];
    expect(call.templateData.changeSummary).toContain(`Guests Added: ${EXPECTED_LINE}\n`);
  });

  it("the hand-built HTML email carries the same line, escaped at its edge", () => {
    const html = bookingModifiedTemplate(
      params([{ ...ARI, firstName: "Ari <script>" }, BO]),
      CLUB_FORMAT_TEST,
    );
    expect(html).toContain("Guests Added");
    expect(html).toContain("Ari &lt;script&gt; Grandchild; Bo Grandchild (14 Aug 2026 – 15 Aug 2026)");
    expect(html).not.toContain("<script>");
  });
});
