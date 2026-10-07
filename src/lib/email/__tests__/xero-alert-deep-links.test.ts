import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2314, decision 3: emailed Xero links carry the organisation short code,
 * stamped at SEND time.
 *
 * A screen can re-render and pick up the current organisation; an email cannot.
 * It is a point-in-time snapshot of everything else it reports, so the
 * organisation is named at the moment it is sent — and the URLs arriving here
 * are organisation-agnostic, because that is how #2314 keeps the two persisted
 * `xeroObjectUrl` columns correct across a reconnect.
 */

const ORG_SHORT_CODE = "!aBc12";

const h = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  getXeroOrgShortCode: vi.fn(),
  settlementTemplate: vi.fn((_data: unknown) => "<html>settlement</html>"),
  repeatedFailureTemplate: vi.fn(
    (_data: unknown) => "<html>repeated failure</html>",
  ),
  reconciliationTemplate: vi.fn((_report: unknown) => "<html>report</html>"),
}));

/** The stamped report the template was handed, in the shape asserted below. */
type StampedReport = {
  issueSections: Array<{ items: Array<{ xeroObjectUrl: string | null }> }>;
  repeatedFailures: Array<{ xeroObjectUrl?: string | null }>;
  unsupportedPartials: Array<{ xeroObjectUrl?: string | null }>;
};

vi.mock("server-only", () => ({}));

vi.mock("../admin-alerts-shared", () => ({
  sendToAdmins: h.sendToAdmins,
  shouldSendDirectAdminSystemEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/xero-link-short-code", () => ({
  getXeroOrgShortCode: h.getXeroOrgShortCode,
}));

// Derived from the module's own exports (#2689 review), so a new template
// cannot arrive here as `undefined`.
vi.mock("@/lib/email-templates/admin-finance", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminManualSettlementConflictTemplate: h.settlementTemplate,
  adminXeroRepeatedFailureTemplate: h.repeatedFailureTemplate,
}));

// The two scheduled reports live in their own module (#2689), so they need
// their own factory: a factory only replaces the module it names.
vi.mock("@/lib/email-templates/admin-xero-reports", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminXeroReconciliationReportTemplate: h.reconciliationTemplate,
}));

import {
  sendAdminManualSettlementConflictAlert,
  sendAdminXeroReconciliationReportAlert,
  sendAdminXeroRepeatedFailureAlert,
} from "@/lib/email/admin-alerts-finance";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

/** What a stored `xeroObjectUrl` holds: no organisation named. */
const GENERIC_URL = buildXeroInvoiceUrl("inv-1");
const SCOPED_URL = buildXeroInvoiceUrl("inv-1", { shortCode: ORG_SHORT_CODE });
/** A row written under a PREVIOUS Xero connection. */
const FOREIGN_URL = buildXeroInvoiceUrl("inv-1", { shortCode: "!old99" });

beforeEach(() => {
  vi.clearAllMocks();
  h.getXeroOrgShortCode.mockResolvedValue(ORG_SHORT_CODE);
});

describe("sendAdminManualSettlementConflictAlert", () => {
  const data = {
    memberName: "Riley Chen",
    checkIn: new Date("2026-05-01T00:00:00.000Z"),
    checkOut: new Date("2026-05-03T00:00:00.000Z"),
    amountCents: 12345,
    bookingId: "book_1",
    bookingStatus: "PAID",
    xeroInvoiceNumber: "INV-001",
    xeroInvoiceUrl: GENERIC_URL,
  };

  it("stamps the organisation on the invoice link in body and template", async () => {
    await sendAdminManualSettlementConflictAlert(data, CLUB_FORMAT_TEST);

    expect(h.settlementTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ xeroInvoiceUrl: SCOPED_URL }),
      CLUB_FORMAT_TEST,
    );
    expect(h.sendToAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        templateData: expect.objectContaining({ xeroObjectUrl: SCOPED_URL }),
      }),
    );
  });

  it("leaves the link generic when no short code is available", async () => {
    h.getXeroOrgShortCode.mockResolvedValue(null);

    await sendAdminManualSettlementConflictAlert(data, CLUB_FORMAT_TEST);

    expect(h.settlementTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ xeroInvoiceUrl: GENERIC_URL }),
      CLUB_FORMAT_TEST,
    );
  });

  // #2314 review: the short-code cache is per process and its invalidation bus
  // only reaches the process that handled the reconnect, so a cron/worker can
  // hold the previous organisation for up to 12 hours. A screen re-renders; an
  // email is stamped forever, so send time confirms the organisation live.
  it("confirms the organisation with Xero rather than trusting the cache", async () => {
    await sendAdminManualSettlementConflictAlert(data, CLUB_FORMAT_TEST);

    expect(h.getXeroOrgShortCode).toHaveBeenCalledWith({ confirmLive: true });
  });

  // The other half of the same rule: an unconfirmable organisation must not be
  // the one the email points at either. A stored URL carrying a previous
  // organisation degrades to the generic link, which is live.
  it("strips a previous organisation when none can be confirmed", async () => {
    h.getXeroOrgShortCode.mockResolvedValue(null);

    await sendAdminManualSettlementConflictAlert({
      ...data,
      xeroInvoiceUrl: FOREIGN_URL,
    }, CLUB_FORMAT_TEST);

    expect(h.settlementTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ xeroInvoiceUrl: GENERIC_URL }),
      CLUB_FORMAT_TEST,
    );
  });

  it("sends nothing extra when there is no invoice link at all", async () => {
    await sendAdminManualSettlementConflictAlert({
      ...data,
      xeroInvoiceUrl: null,
    }, CLUB_FORMAT_TEST);

    expect(h.settlementTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ xeroInvoiceUrl: null }),
      CLUB_FORMAT_TEST,
    );
    expect(h.sendToAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        templateData: expect.objectContaining({ xeroObjectUrl: "" }),
      }),
    );
  });
});

describe("sendAdminXeroRepeatedFailureAlert", () => {
  const data = {
    subject: "Repeated Xero failure",
    correlationKey: "corr_1",
    failureCount: 3,
    windowHours: 24,
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_1",
    localUrl: "/admin/xero/records/Payment/pay_1",
    xeroObjectUrl: GENERIC_URL,
    latestErrorMessage: "Rate limit exceeded",
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
  };

  it("stamps the organisation on the html link, the token and the flat line", async () => {
    await sendAdminXeroRepeatedFailureAlert(data);

    expect(h.repeatedFailureTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ xeroObjectUrl: SCOPED_URL }),
    );

    const call = h.sendToAdmins.mock.calls[0][0];
    expect(call.templateData.xeroObjectUrl).toBe(SCOPED_URL);
    // The pre-composed flat-body line must carry the same URL — it is a second
    // rendering of the link, and #2268 built it from the raw field.
    expect(call.templateData.xeroLinksNote).toContain(SCOPED_URL);
    expect(call.templateData.xeroLinksNote).not.toContain(
      `Open Xero object: ${GENERIC_URL}\n`,
    );
  });

  it("leaves the link generic when no short code is available", async () => {
    h.getXeroOrgShortCode.mockResolvedValue(null);

    await sendAdminXeroRepeatedFailureAlert(data);

    expect(h.repeatedFailureTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ xeroObjectUrl: GENERIC_URL }),
    );
  });

  it("confirms the organisation with Xero rather than trusting the cache", async () => {
    await sendAdminXeroRepeatedFailureAlert(data);

    expect(h.getXeroOrgShortCode).toHaveBeenCalledWith({ confirmLive: true });
  });

  it("strips a previous organisation when none can be confirmed", async () => {
    h.getXeroOrgShortCode.mockResolvedValue(null);

    await sendAdminXeroRepeatedFailureAlert({
      ...data,
      xeroObjectUrl: FOREIGN_URL,
    });

    const call = h.sendToAdmins.mock.calls[0][0];
    expect(call.templateData.xeroObjectUrl).toBe(GENERIC_URL);
    expect(call.templateData.xeroLinksNote).not.toContain("shortcode=");
  });
});

describe("sendAdminXeroReconciliationReportAlert", () => {
  function report() {
    return {
      generatedAt: new Date("2026-05-01T00:00:00.000Z"),
      lookbackHours: 24,
      stalePendingMinutes: 30,
      summary: {
        missingMemberContactLinks: 0,
        missingPaymentInvoiceLinks: 0,
        missingPaymentRefundCreditNoteLinks: 0,
        missingSubscriptionInvoiceLinks: 0,
        mismatchedCanonicalLinks: 0,
        staleCanonicalLinks: 0,
        duplicateActiveCanonicalLinks: 0,
        overCoveredStripeRefundPayments: 0,
        stalePendingOperations: 0,
        recentFailedOperations: 1,
        recentPartialOperations: 0,
        unsupportedPartialOperations: 1,
        repeatedFailureCorrelations: 1,
        failedInboundEvents: 0,
        issueCategoryCount: 1,
        issueTotalCount: 1,
      },
      issueSections: [
        {
          id: "failed",
          title: "Failed operations",
          severity: "critical" as const,
          count: 1,
          whatWentWrong: "An operation failed.",
          howToFix: "Retry it.",
          items: [
            {
              label: "Payment pay_1",
              localModel: "Payment",
              localId: "pay_1",
              localUrl: "/admin/xero/records/Payment/pay_1",
              xeroObjectType: "INVOICE",
              xeroObjectId: "inv-1",
              xeroObjectNumber: "INV-001",
              xeroObjectUrl: GENERIC_URL,
              operationId: "op_1",
              operationStatus: "FAILED",
              operationType: "CREATE",
              correlationKey: "corr_1",
              detail: "Failed",
              latestErrorMessage: null,
              createdAt: null,
            },
          ],
        },
      ],
      repeatedFailures: [
        {
          correlationKey: "corr_1",
          failureCount: 3,
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: "pay_1",
          localUrl: "/admin/xero/records/Payment/pay_1",
          latestErrorMessage: null,
          xeroObjectUrl: GENERIC_URL,
        },
      ],
      unsupportedPartials: [
        {
          operationId: "op_2",
          entityType: "INVOICE",
          operationType: "UPDATE",
          localModel: "Payment",
          localId: "pay_2",
          localUrl: "/admin/xero/records/Payment/pay_2",
          xeroObjectUrl: GENERIC_URL,
          reason: "Partial",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
    };
  }

  it("stamps the organisation on every link the report carries", async () => {
    await sendAdminXeroReconciliationReportAlert(report());

    const stamped = h.reconciliationTemplate.mock.calls[0][0] as StampedReport;
    expect(stamped.issueSections[0].items[0].xeroObjectUrl).toBe(SCOPED_URL);
    expect(stamped.repeatedFailures[0].xeroObjectUrl).toBe(SCOPED_URL);
    expect(stamped.unsupportedPartials[0].xeroObjectUrl).toBe(SCOPED_URL);
  });

  it("does not mutate the report it was handed", async () => {
    const input = report();

    await sendAdminXeroReconciliationReportAlert(input);

    expect(input.issueSections[0].items[0].xeroObjectUrl).toBe(GENERIC_URL);
    expect(input.repeatedFailures[0].xeroObjectUrl).toBe(GENERIC_URL);
    expect(input.unsupportedPartials[0].xeroObjectUrl).toBe(GENERIC_URL);
  });

  it("leaves every link generic when no short code is available", async () => {
    h.getXeroOrgShortCode.mockResolvedValue(null);

    await sendAdminXeroReconciliationReportAlert(report());

    const passed = h.reconciliationTemplate.mock.calls[0][0] as StampedReport;
    expect(passed.issueSections[0].items[0].xeroObjectUrl).toBe(GENERIC_URL);
    expect(passed.repeatedFailures[0].xeroObjectUrl).toBe(GENERIC_URL);
    expect(passed.unsupportedPartials[0].xeroObjectUrl).toBe(GENERIC_URL);
  });

  it("confirms the organisation once for the whole report", async () => {
    await sendAdminXeroReconciliationReportAlert(report());

    expect(h.getXeroOrgShortCode).toHaveBeenCalledTimes(1);
    expect(h.getXeroOrgShortCode).toHaveBeenCalledWith({ confirmLive: true });
  });

  it("strips a previous organisation from every link when none can be confirmed", async () => {
    h.getXeroOrgShortCode.mockResolvedValue(null);
    const input = report();
    input.issueSections[0].items[0].xeroObjectUrl = FOREIGN_URL;
    input.repeatedFailures[0].xeroObjectUrl = FOREIGN_URL;
    input.unsupportedPartials[0].xeroObjectUrl = FOREIGN_URL;

    await sendAdminXeroReconciliationReportAlert(input);

    const passed = h.reconciliationTemplate.mock.calls[0][0] as StampedReport;
    expect(passed.issueSections[0].items[0].xeroObjectUrl).toBe(GENERIC_URL);
    expect(passed.repeatedFailures[0].xeroObjectUrl).toBe(GENERIC_URL);
    expect(passed.unsupportedPartials[0].xeroObjectUrl).toBe(GENERIC_URL);
  });
});
