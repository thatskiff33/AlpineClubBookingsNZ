import { describe, expect, it } from "vitest";
import {
  adminCreditSyncDriftTemplate,
  type CreditSyncDriftReportEmail,
} from "@/lib/email-templates/admin-xero-reports";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("adminCreditSyncDriftTemplate", () => {
  const report: CreditSyncDriftReportEmail = {
    generatedAt: new Date("2026-08-02T12:00:00.000Z"),
    scannedBookings: 3,
    checkedBookings: 3,
    deferredBookings: 0,
    totalDriftCents: 9000,
    drifts: [
      {
        kind: "missing_in_xero",
        bookingId: "bkg_abcdef123456",
        memberName: "Ada Lovelace",
        invoiceId: "inv_1",
        invoiceNumber: "INV-001",
        invoiceUrl: "https://go.xero.com/invoice/inv_1",
        localCents: 12000,
        xeroCents: 3000,
        deltaCents: 9000,
        notes: [
          { creditNoteId: "cn_1", creditNoteNumber: "CN-9", appliedCents: 3000 },
        ],
      },
    ],
  };

  it("renders the exact BookingApp, Xero and drift amounts and the member/invoice", () => {
    const html = adminCreditSyncDriftTemplate(report, CLUB_FORMAT_TEST);

    // Detailed as to the amount: both sides and the exact drift.
    expect(html).toContain("$120.00"); // BookingApp known credit
    expect(html).toContain("$30.00"); // Xero live allocation
    expect(html).toContain("$90.00"); // exact drift
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("INV-001");
    // The invoice deep link and the per-note breakdown.
    expect(html).toContain("https://go.xero.com/invoice/inv_1");
    expect(html).toContain("CN-9");
    // States plainly that nothing was changed (warning, not auto-correct).
    expect(html).toMatch(/Nothing has been changed/i);
  });

  it("escapes member names to prevent HTML injection in the alert", () => {
    const html = adminCreditSyncDriftTemplate({
      ...report,
      drifts: [
        {
          ...report.drifts[0],
          memberName: "<script>alert(1)</script>",
        },
      ],
    }, CLUB_FORMAT_TEST);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
