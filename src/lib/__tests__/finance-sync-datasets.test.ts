import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";
import type { FinanceSyncDatasetContext } from "@/lib/finance-sync-service";
import { captureHostTimeZone } from "./helpers/timezone";

const ACCREC = "ACCREC" as never;
const ACCPAY = "ACCPAY" as never;
const AUTHORISED = "AUTHORISED" as never;
const SUBMITTED = "SUBMITTED" as never;
const NZD = "NZD" as never;
const AUD = "AUD" as never;
const ACTIVE = "ACTIVE" as never;
const SECTION = "Section" as never;
const ROW = "Row" as never;
const SUMMARY_ROW = "SummaryRow" as never;

const { mockCallXeroApi, mockLoadFinanceMonthlyChartContext } = vi.hoisted(
  () => ({
    mockCallXeroApi: vi.fn(),
    mockLoadFinanceMonthlyChartContext: vi.fn(),
  })
);

vi.mock("@/lib/xero", () => ({
  callXeroApi: (fn: () => unknown, options: unknown) =>
    mockCallXeroApi(fn, options),
}));

vi.mock("@/lib/finance-monthly-fact-store", () => ({
  loadFinanceMonthlyChartContext: mockLoadFinanceMonthlyChartContext,
}));

import {
  FINANCE_SYNC_XERO_ACCOUNTS_RECEIVABLE_INVOICES_DATASET_KEY,
  FINANCE_SYNC_XERO_ACCOUNTS_PAYABLE_INVOICES_DATASET_KEY,
  FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY,
  FINANCE_SYNC_XERO_AGED_PAYABLES_DATASET_KEY,
  FINANCE_SYNC_XERO_BALANCE_SHEET_BY_MONTH_DATASET_KEY,
  FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
  FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
  FINANCE_SYNC_XERO_CHART_OF_ACCOUNTS_DATASET_KEY,
  FINANCE_SYNC_XERO_PROFIT_AND_LOSS_BY_MONTH_DATASET_KEY,
  FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
  buildFinanceAccountsReceivableInvoicesSnapshot,
  buildFinanceAccountsPayableInvoicesSnapshot,
  buildFinanceAgedReceivablesSnapshot,
  buildFinanceAgedPayablesSnapshot,
  buildFinanceChartOfAccountsSnapshot,
  buildFinanceReportSnapshot,
  syncFinanceAccountsReceivableInvoicesSnapshot,
  syncFinanceAccountsPayableInvoicesSnapshot,
  syncFinanceAgedReceivablesSnapshot,
  syncFinanceAgedPayablesSnapshot,
  syncFinanceBalanceSheetByMonthFacts,
  syncFinanceBalanceSheetSnapshot,
  syncFinanceBankBalancesSnapshot,
  syncFinanceChartOfAccountsSnapshot,
  syncFinanceProfitAndLossByMonthFacts,
  syncFinanceProfitAndLossMonthlySnapshot,
} from "@/lib/finance-sync-xero-datasets";
import { getFinanceSyncDatasets } from "@/lib/finance-sync-datasets";

/**
 * The club's own zone, pinned (CT-5, #2869).
 *
 * Every dataset dates its snapshot with `context.clubTimeZone`, so a fixture
 * that omits the field hands `undefined` to `Intl.DateTimeFormat`, which
 * silently falls back to the HOST's zone. The fixture used to do exactly that:
 * the expectations below read `2026-04-20` on this repository's own machines
 * (whose OS zone is Pacific/Auckland) and `2026-04-19` on CI (UTC), because the
 * value was never pinned at all. `context as never` at each call site is what
 * kept `tsc` quiet about the missing field.
 */
const CLUB_TIME_ZONE =
  "Pacific/Auckland" as FinanceSyncDatasetContext["clubTimeZone"];

/**
 * A host zone deliberately on the OTHER side of the day boundary from the club.
 *
 * `startedAt` below is 22:15 UTC, which is already the 20th in Auckland and
 * still the 19th in Denver. Pinning the host to Denver for this whole file
 * means the expected `2026-04-20` can ONLY have come from
 * {@link CLUB_TIME_ZONE}: if the club pin is ever dropped again, the fallback
 * answers `2026-04-19` and these tests fail on every machine, not just on CI.
 */
const HOSTILE_HOST_TIME_ZONE = "America/Denver";

const hostTimeZone = captureHostTimeZone();

function createFinanceSyncContext() {
  return {
    runId: "run-1",
    workflow: "daily-finance-sync",
    trigger: "SCHEDULED" as const,
    // 22:15 UTC on the 19th is 10:15 on the 20th in Auckland: the club's
    // calendar day, not the container's.
    startedAt: new Date("2026-04-19T22:15:00.000Z"),
    clubTimeZone: CLUB_TIME_ZONE,
    xeroTenantId: "tenant-123",
    xero: {
      accountingApi: {
        getReportProfitAndLoss: vi.fn(),
        getReportBalanceSheet: vi.fn(),
        getReportBankSummary: vi.fn(),
        getInvoices: vi.fn(),
        getAccounts: vi.fn(),
      },
    },
  };
}

function buildInsufficientScopeError() {
  return {
    response: {
      statusCode: 401,
      headers: {
        "www-authenticate": "insufficient_scope",
      },
    },
    body: {
      Detail: "AuthorizationUnsuccessful",
    },
  };
}

function createReport(overrides?: {
  reportID?: string;
  reportName?: string;
  reportType?: string;
  reportDate?: string;
  updatedDateUTC?: Date;
}) {
  return {
    reportID: overrides?.reportID ?? "report-1",
    reportName: overrides?.reportName ?? "Profit and Loss",
    reportType: overrides?.reportType ?? "ProfitLoss",
    reportTitle: "Demo Finance Report",
    reportTitles: ["Demo Finance Report", "Example Alpine Club", "April 2026"],
    reportDate: overrides?.reportDate ?? "2026-04-20",
    updatedDateUTC:
      overrides?.updatedDateUTC ?? new Date("2026-04-20T00:05:00.000Z"),
    fields: [
      {
        fieldID: "period",
        description: "Period",
        value: "April 2026",
      },
    ],
    rows: [
      {
        rowType: SECTION,
        title: "Income",
        rows: [
          {
            rowType: ROW,
            cells: [{ value: "Accommodation income" }, { value: "1250.00" }],
          },
          {
            rowType: SUMMARY_ROW,
            cells: [{ value: "Total Income" }, { value: "1250.00" }],
          },
        ],
      },
    ],
  };
}

describe("finance-sync-datasets", () => {
  beforeAll(() => {
    process.env.TZ = HOSTILE_HOST_TIME_ZONE;
  });

  afterAll(() => {
    hostTimeZone.restore();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCallXeroApi.mockImplementation(async (fn: () => unknown) => fn());
  });

  it("registers the finance Xero datasets including the invoice detail snapshots", () => {
    expect(getFinanceSyncDatasets().map((dataset) => dataset.key)).toEqual([
      FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
      FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
      FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
      FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY,
      FINANCE_SYNC_XERO_ACCOUNTS_RECEIVABLE_INVOICES_DATASET_KEY,
      FINANCE_SYNC_XERO_AGED_PAYABLES_DATASET_KEY,
      FINANCE_SYNC_XERO_ACCOUNTS_PAYABLE_INVOICES_DATASET_KEY,
      FINANCE_SYNC_XERO_CHART_OF_ACCOUNTS_DATASET_KEY,
      // Monthly-fact datasets stay after chart-of-accounts: they resolve
      // report rows through the chart snapshot persisted earlier in the run.
      FINANCE_SYNC_XERO_PROFIT_AND_LOSS_BY_MONTH_DATASET_KEY,
      FINANCE_SYNC_XERO_BALANCE_SHEET_BY_MONTH_DATASET_KEY,
    ]);
  });

  it("maps Xero reports into JSON-safe finance snapshot payloads", () => {
    const snapshot = buildFinanceReportSnapshot({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodStart: new Date("2026-04-01T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      report: createReport(),
    });

    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      rowCount: 2,
      sourceUpdatedAt: new Date("2026-04-20T00:05:00.000Z"),
      payload: {
        reportId: "report-1",
        reportType: "ProfitLoss",
        reportDate: "2026-04-20",
        updatedDateUTC: "2026-04-20T00:05:00.000Z",
        rows: [
          {
            rowType: "Section",
            title: "Income",
            rows: [
              {
                rowType: "Row",
                cells: [{ value: "Accommodation income" }, { value: "1250.00" }],
              },
              {
                rowType: "SummaryRow",
                cells: [{ value: "Total Income" }, { value: "1250.00" }],
              },
            ],
          },
        ],
      },
    });
  });

  it("maps open receivable invoices into a currency-safe aged receivables snapshot", () => {
    const snapshot = buildFinanceAgedReceivablesSnapshot({
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      invoices: [
        {
          type: ACCREC,
          invoiceID: "inv-1",
          invoiceNumber: "INV-001",
          dueDate: "2026-04-10",
          date: "2026-04-01",
          amountDue: 100,
          amountPaid: 25,
          amountCredited: 0,
          total: 125,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "contact-1",
            name: "Alice",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:05:00.000Z"),
        },
        {
          type: ACCREC,
          invoiceID: "inv-2",
          invoiceNumber: "INV-002",
          dueDate: "2026-03-01",
          date: "2026-03-01",
          amountDue: 50,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "contact-1",
            name: "Alice",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:06:00.000Z"),
        },
        {
          type: ACCREC,
          invoiceID: "inv-3",
          invoiceNumber: "INV-003",
          dueDate: "2026-04-25",
          date: "2026-04-18",
          amountDue: 75,
          status: SUBMITTED,
          currencyCode: AUD,
          contact: {
            contactID: "contact-2",
            name: "Bob",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:07:00.000Z"),
        },
        {
          type: ACCPAY,
          invoiceID: "ignored-type",
          amountDue: 999,
        },
        {
          type: ACCREC,
          invoiceID: "ignored-zero",
          amountDue: 0,
        },
      ],
    });

    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.AGED_RECEIVABLES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 2,
      scope: "organisation",
      currency: null,
      sourceUpdatedAt: new Date("2026-04-20T00:07:00.000Z"),
      payload: {
        asOfDate: "2026-04-20",
        invoiceCount: 3,
        contactCount: 2,
        currencies: ["AUD", "NZD"],
        totalsByCurrency: [
          {
            currency: "AUD",
            invoiceCount: 1,
            contactCount: 1,
            totals: {
              current: 75,
              days1To30: 0,
              days31To60: 0,
              days61To90: 0,
              days91Plus: 0,
              overdue: 0,
              total: 75,
            },
          },
          {
            currency: "NZD",
            invoiceCount: 2,
            contactCount: 1,
            totals: {
              current: 0,
              days1To30: 100,
              days31To60: 50,
              days61To90: 0,
              days91Plus: 0,
              overdue: 150,
              total: 150,
            },
          },
        ],
        contacts: [
          {
            contactId: "contact-1",
            contactName: "Alice",
            currency: "NZD",
            invoiceCount: 2,
            oldestDueDate: "2026-03-01",
            latestDueDate: "2026-04-10",
            totals: {
              current: 0,
              days1To30: 100,
              days31To60: 50,
              days61To90: 0,
              days91Plus: 0,
              overdue: 150,
              total: 150,
            },
            invoices: [
              {
                invoiceId: "inv-2",
                invoiceNumber: "INV-002",
                amountDue: 50,
                bucket: "days31To60",
                daysOverdue: 50,
              },
              {
                invoiceId: "inv-1",
                invoiceNumber: "INV-001",
                amountDue: 100,
                bucket: "days1To30",
                daysOverdue: 10,
              },
            ],
          },
          {
            contactId: "contact-2",
            contactName: "Bob",
            currency: "AUD",
            invoiceCount: 1,
            oldestDueDate: "2026-04-25",
            latestDueDate: "2026-04-25",
            totals: {
              current: 75,
              days1To30: 0,
              days31To60: 0,
              days61To90: 0,
              days91Plus: 0,
              overdue: 0,
              total: 75,
            },
          },
        ],
      },
    });
  });

  it("normalizes Date-backed receivable invoice fields before sorting and persistence", () => {
    const asOfDate = new Date("2026-04-20T00:00:00.000Z");

    const agedSnapshot = buildFinanceAgedReceivablesSnapshot({
      asOfDate,
      invoices: [
        {
          type: ACCREC,
          invoiceID: "inv-2",
          invoiceNumber: "INV-002",
          dueDate: new Date("2026-04-18T00:00:00.000Z") as never,
          date: new Date("2026-04-02T00:00:00.000Z") as never,
          expectedPaymentDate: new Date("2026-04-22T00:00:00.000Z") as never,
          amountDue: 50,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "contact-1",
            name: "Alice",
            contactStatus: ACTIVE,
          },
        },
        {
          type: ACCREC,
          invoiceID: "inv-1",
          invoiceNumber: "INV-001",
          dueDate: new Date("2026-04-10T00:00:00.000Z") as never,
          date: new Date("2026-04-01T00:00:00.000Z") as never,
          amountDue: 75,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "contact-1",
            name: "Alice",
            contactStatus: ACTIVE,
          },
        },
      ],
    });

    const receivableDetailSnapshot = buildFinanceAccountsReceivableInvoicesSnapshot({
      asOfDate,
      invoices: [
        {
          type: ACCREC,
          invoiceID: "inv-2",
          invoiceNumber: "INV-002",
          dueDate: new Date("2026-04-18T00:00:00.000Z") as never,
          date: new Date("2026-04-02T00:00:00.000Z") as never,
          expectedPaymentDate: new Date("2026-04-22T00:00:00.000Z") as never,
          amountDue: 50,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "contact-1",
            name: "Alice",
            contactStatus: ACTIVE,
          },
        },
        {
          type: ACCREC,
          invoiceID: "inv-1",
          invoiceNumber: "INV-001",
          dueDate: new Date("2026-04-10T00:00:00.000Z") as never,
          date: new Date("2026-04-01T00:00:00.000Z") as never,
          amountDue: 75,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "contact-1",
            name: "Alice",
            contactStatus: ACTIVE,
          },
        },
      ],
    });

    expect(agedSnapshot).toMatchObject({
      payload: {
        contacts: [
          {
            invoices: [
              {
                invoiceId: "inv-1",
                invoiceDate: "2026-04-01",
                dueDate: "2026-04-10",
                // #2105: a Date-backed dueDate now drives the aging bucket /
                // days-overdue (was silently null → "current" before the fix).
                bucket: "days1To30",
                daysOverdue: 10,
              },
              {
                invoiceId: "inv-2",
                invoiceDate: "2026-04-02",
                dueDate: "2026-04-18",
                expectedPaymentDate: "2026-04-22",
                bucket: "days1To30",
                daysOverdue: 2,
              },
            ],
          },
        ],
      },
    });

    expect(receivableDetailSnapshot).toMatchObject({
      payload: {
        contacts: [
          {
            invoices: [
              {
                invoiceId: "inv-1",
                invoiceDate: "2026-04-01",
                dueDate: "2026-04-10",
              },
              {
                invoiceId: "inv-2",
                invoiceDate: "2026-04-02",
                dueDate: "2026-04-18",
                expectedPaymentDate: "2026-04-22",
              },
            ],
          },
        ],
      },
    });
  });

  it("maps open payable invoices into a currency-safe aged payables snapshot", () => {
    const snapshot = buildFinanceAgedPayablesSnapshot({
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      invoices: [
        {
          type: ACCPAY,
          invoiceID: "bill-1",
          invoiceNumber: "BILL-001",
          dueDate: "2026-04-12",
          date: "2026-04-01",
          amountDue: 180,
          amountPaid: 20,
          amountCredited: 0,
          total: 200,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "supplier-1",
            name: "Snow Supplies",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:08:00.000Z"),
        },
        {
          type: ACCPAY,
          invoiceID: "bill-2",
          invoiceNumber: "BILL-002",
          dueDate: "2026-02-15",
          date: "2026-02-01",
          amountDue: 60,
          status: SUBMITTED,
          currencyCode: NZD,
          contact: {
            contactID: "supplier-1",
            name: "Snow Supplies",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:09:00.000Z"),
        },
        {
          type: ACCPAY,
          invoiceID: "bill-3",
          invoiceNumber: "BILL-003",
          dueDate: "2026-04-30",
          date: "2026-04-18",
          amountDue: 90,
          status: AUTHORISED,
          currencyCode: AUD,
          contact: {
            contactID: "supplier-2",
            name: "Alpine Freight",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:10:00.000Z"),
        },
        {
          type: ACCREC,
          invoiceID: "ignored-type",
          amountDue: 999,
        },
        {
          type: ACCPAY,
          invoiceID: "ignored-zero",
          amountDue: 0,
        },
      ],
    });

    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.AGED_PAYABLES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 2,
      scope: "organisation",
      currency: null,
      sourceUpdatedAt: new Date("2026-04-20T00:10:00.000Z"),
      payload: {
        asOfDate: "2026-04-20",
        invoiceCount: 3,
        contactCount: 2,
        currencies: ["AUD", "NZD"],
        totalsByCurrency: [
          {
            currency: "AUD",
            invoiceCount: 1,
            contactCount: 1,
            totals: {
              current: 90,
              days1To30: 0,
              days31To60: 0,
              days61To90: 0,
              days91Plus: 0,
              overdue: 0,
              total: 90,
            },
          },
          {
            currency: "NZD",
            invoiceCount: 2,
            contactCount: 1,
            totals: {
              current: 0,
              days1To30: 180,
              days31To60: 0,
              days61To90: 60,
              days91Plus: 0,
              overdue: 240,
              total: 240,
            },
          },
        ],
        contacts: [
          {
            contactId: "supplier-1",
            contactName: "Snow Supplies",
            currency: "NZD",
            invoiceCount: 2,
            oldestDueDate: "2026-02-15",
            latestDueDate: "2026-04-12",
            totals: {
              current: 0,
              days1To30: 180,
              days31To60: 0,
              days61To90: 60,
              days91Plus: 0,
              overdue: 240,
              total: 240,
            },
            invoices: [
              {
                invoiceId: "bill-2",
                invoiceNumber: "BILL-002",
                amountDue: 60,
                bucket: "days61To90",
                daysOverdue: 64,
              },
              {
                invoiceId: "bill-1",
                invoiceNumber: "BILL-001",
                amountDue: 180,
                bucket: "days1To30",
                daysOverdue: 8,
              },
            ],
          },
          {
            contactId: "supplier-2",
            contactName: "Alpine Freight",
            currency: "AUD",
            invoiceCount: 1,
            oldestDueDate: "2026-04-30",
            latestDueDate: "2026-04-30",
            totals: {
              current: 90,
              days1To30: 0,
              days31To60: 0,
              days61To90: 0,
              days91Plus: 0,
              overdue: 0,
              total: 90,
            },
          },
        ],
      },
    });
  });

  it("maps open receivable invoices into an organisation-level accounts receivable invoice snapshot", () => {
    const snapshot = buildFinanceAccountsReceivableInvoicesSnapshot({
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      invoices: [
        {
          type: ACCREC,
          invoiceID: "inv-1",
          invoiceNumber: "INV-001",
          reference: "School booking April",
          dueDate: "2026-04-12",
          expectedPaymentDate: "2026-04-24",
          date: "2026-04-01",
          amountDue: 180,
          amountPaid: 20,
          amountCredited: 0,
          subTotal: 180,
          totalTax: 20,
          total: 200,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "customer-1",
            name: "Example High School",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:08:00.000Z"),
        },
        {
          type: ACCREC,
          invoiceID: "inv-2",
          invoiceNumber: "INV-002",
          dueDate: "2026-02-15",
          date: "2026-02-01",
          amountDue: 60,
          status: SUBMITTED,
          currencyCode: NZD,
          contact: {
            contactID: "customer-1",
            name: "Example High School",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:09:00.000Z"),
        },
        {
          type: ACCREC,
          invoiceID: "inv-3",
          invoiceNumber: "INV-003",
          dueDate: "2026-04-30",
          date: "2026-04-18",
          amountDue: 90,
          status: AUTHORISED,
          currencyCode: AUD,
          contact: {
            contactID: "customer-2",
            name: "Alpine College",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:10:00.000Z"),
        },
        {
          type: ACCPAY,
          invoiceID: "ignored-type",
          amountDue: 999,
        },
        {
          type: ACCREC,
          invoiceID: "ignored-zero",
          amountDue: 0,
        },
      ],
    });

    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.ACCOUNTS_RECEIVABLE_INVOICES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 3,
      scope: "organisation",
      currency: null,
      sourceUpdatedAt: new Date("2026-04-20T00:10:00.000Z"),
      payload: {
        asOfDate: "2026-04-20",
        invoiceCount: 3,
        contactCount: 2,
        currencies: ["AUD", "NZD"],
        totalsByCurrency: [
          {
            currency: "AUD",
            invoiceCount: 1,
            contactCount: 1,
            totalAmountDue: 90,
          },
          {
            currency: "NZD",
            invoiceCount: 2,
            contactCount: 1,
            totalAmountDue: 240,
          },
        ],
        contacts: [
          {
            contactId: "customer-1",
            contactName: "Example High School",
            currency: "NZD",
            invoiceCount: 2,
            totalAmountDue: 240,
            oldestDueDate: "2026-02-15",
            latestDueDate: "2026-04-12",
            invoices: [
              {
                invoiceId: "inv-2",
                invoiceNumber: "INV-002",
                amountDue: 60,
              },
              {
                invoiceId: "inv-1",
                invoiceNumber: "INV-001",
                reference: "School booking April",
                expectedPaymentDate: "2026-04-24",
                amountDue: 180,
                amountPaid: 20,
                amountCredited: 0,
                subTotal: 180,
                totalTax: 20,
                total: 200,
              },
            ],
          },
          {
            contactId: "customer-2",
            contactName: "Alpine College",
            currency: "AUD",
            invoiceCount: 1,
            totalAmountDue: 90,
            oldestDueDate: "2026-04-30",
            latestDueDate: "2026-04-30",
          },
        ],
      },
    });
  });

  it("normalizes non-string receivable contact metadata before grouping and sorting", () => {
    const asOfDate = new Date("2026-04-20T00:00:00.000Z");
    const invoices = [
      {
        type: ACCREC,
        invoiceID: "inv-1",
        invoiceNumber: "INV-001",
        dueDate: "2026-04-10",
        date: "2026-04-01",
        amountDue: 100,
        status: AUTHORISED,
        currencyCode: { toString: () => "NZD" } as never,
        contact: {
          contactID: 101 as never,
          firstName: 42 as never,
          lastName: "School" as never,
          contactStatus: ACTIVE,
        },
      },
      {
        type: ACCREC,
        invoiceID: "inv-2",
        invoiceNumber: "INV-002",
        dueDate: "2026-04-15",
        date: "2026-04-03",
        amountDue: 80,
        status: AUTHORISED,
        currencyCode: { toString: () => "AUD" } as never,
        contact: {
          contactID: 202 as never,
          name: 303 as never,
          contactStatus: ACTIVE,
        },
      },
    ];

    const agedSnapshot = buildFinanceAgedReceivablesSnapshot({
      asOfDate,
      invoices,
    });
    const receivableDetailSnapshot = buildFinanceAccountsReceivableInvoicesSnapshot({
      asOfDate,
      invoices,
    });

    expect(agedSnapshot).toMatchObject({
      payload: {
        currencies: ["AUD", "NZD"],
        contacts: [
          {
            contactId: "101",
            contactName: "42 School",
            currency: "NZD",
          },
          {
            contactId: "202",
            contactName: "303",
            currency: "AUD",
          },
        ],
      },
    });

    expect(receivableDetailSnapshot).toMatchObject({
      payload: {
        currencies: ["AUD", "NZD"],
        contacts: [
          {
            contactId: "101",
            contactName: "42 School",
            currency: "NZD",
          },
          {
            contactId: "202",
            contactName: "303",
            currency: "AUD",
          },
        ],
      },
    });
  });

  it("maps open payable invoices into an organisation-level accounts payable invoice snapshot", () => {
    const snapshot = buildFinanceAccountsPayableInvoicesSnapshot({
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      invoices: [
        {
          type: ACCPAY,
          invoiceID: "bill-1",
          invoiceNumber: "BILL-001",
          reference: "April food order",
          dueDate: "2026-04-12",
          plannedPaymentDate: "2026-04-22",
          date: "2026-04-01",
          amountDue: 180,
          amountPaid: 20,
          amountCredited: 0,
          subTotal: 180,
          totalTax: 20,
          total: 200,
          status: AUTHORISED,
          currencyCode: NZD,
          contact: {
            contactID: "supplier-1",
            name: "Snow Supplies",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:08:00.000Z"),
        },
        {
          type: ACCPAY,
          invoiceID: "bill-2",
          invoiceNumber: "BILL-002",
          dueDate: "2026-02-15",
          date: "2026-02-01",
          amountDue: 60,
          status: SUBMITTED,
          currencyCode: NZD,
          contact: {
            contactID: "supplier-1",
            name: "Snow Supplies",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:09:00.000Z"),
        },
        {
          type: ACCPAY,
          invoiceID: "bill-3",
          invoiceNumber: "BILL-003",
          dueDate: "2026-04-30",
          date: "2026-04-18",
          amountDue: 90,
          status: AUTHORISED,
          currencyCode: AUD,
          contact: {
            contactID: "supplier-2",
            name: "Alpine Freight",
            contactStatus: ACTIVE,
          },
          updatedDateUTC: new Date("2026-04-20T00:10:00.000Z"),
        },
        {
          type: ACCREC,
          invoiceID: "ignored-type",
          amountDue: 999,
        },
        {
          type: ACCPAY,
          invoiceID: "ignored-zero",
          amountDue: 0,
        },
      ],
    });

    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.ACCOUNTS_PAYABLE_INVOICES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 3,
      scope: "organisation",
      currency: null,
      sourceUpdatedAt: new Date("2026-04-20T00:10:00.000Z"),
      payload: {
        asOfDate: "2026-04-20",
        invoiceCount: 3,
        contactCount: 2,
        currencies: ["AUD", "NZD"],
        totalsByCurrency: [
          {
            currency: "AUD",
            invoiceCount: 1,
            contactCount: 1,
            totalAmountDue: 90,
          },
          {
            currency: "NZD",
            invoiceCount: 2,
            contactCount: 1,
            totalAmountDue: 240,
          },
        ],
        contacts: [
          {
            contactId: "supplier-1",
            contactName: "Snow Supplies",
            currency: "NZD",
            invoiceCount: 2,
            totalAmountDue: 240,
            oldestDueDate: "2026-02-15",
            latestDueDate: "2026-04-12",
            invoices: [
              {
                invoiceId: "bill-2",
                invoiceNumber: "BILL-002",
                amountDue: 60,
              },
              {
                invoiceId: "bill-1",
                invoiceNumber: "BILL-001",
                reference: "April food order",
                plannedPaymentDate: "2026-04-22",
                amountDue: 180,
                amountPaid: 20,
                amountCredited: 0,
                subTotal: 180,
                totalTax: 20,
                total: 200,
              },
            ],
          },
          {
            contactId: "supplier-2",
            contactName: "Alpine Freight",
            currency: "AUD",
            invoiceCount: 1,
            totalAmountDue: 90,
            oldestDueDate: "2026-04-30",
            latestDueDate: "2026-04-30",
          },
        ],
      },
    });
  });

  it("builds report, aged receivables, aged payables, and invoice detail snapshots from the finance sync window", async () => {
    const context = createFinanceSyncContext();
    const profitAndLossReport = createReport({
      reportID: "pnl-1",
      reportName: "Profit and Loss",
      reportType: "ProfitLoss",
    });
    const balanceSheetReport = createReport({
      reportID: "bs-1",
      reportName: "Balance Sheet",
      reportType: "BalanceSheet",
    });
    const bankSummaryReport = createReport({
      reportID: "bank-1",
      reportName: "Bank Summary",
      reportType: "BankSummary",
    });

    context.xero.accountingApi.getReportProfitAndLoss.mockResolvedValue({
      body: { reports: [profitAndLossReport] },
    });
    context.xero.accountingApi.getReportBalanceSheet.mockResolvedValue({
      body: { reports: [balanceSheetReport] },
    });
    context.xero.accountingApi.getReportBankSummary.mockResolvedValue({
      body: { reports: [bankSummaryReport] },
    });
    context.xero.accountingApi.getInvoices.mockImplementation(
      async (_tenantId: string, _ifModifiedSince: Date, where?: string) => {
        if (where?.includes('Type=="ACCREC"')) {
          return {
            body: {
              invoices: [
                {
                  type: ACCREC,
                  invoiceID: "inv-1",
                  invoiceNumber: "INV-001",
                  date: "2026-04-10",
                  dueDate: "2026-04-15",
                  amountDue: 42,
                  status: AUTHORISED,
                  currencyCode: NZD,
                  contact: {
                    contactID: "contact-1",
                    name: "Alice",
                    contactStatus: ACTIVE,
                  },
                },
              ],
            },
          };
        }

        return {
          body: {
            invoices: [
              {
                type: ACCPAY,
                invoiceID: "bill-1",
                invoiceNumber: "BILL-001",
                date: "2026-04-09",
                dueDate: "2026-04-14",
                amountDue: 21,
                status: AUTHORISED,
                currencyCode: NZD,
                contact: {
                  contactID: "supplier-1",
                  name: "Snow Supplies",
                  contactStatus: ACTIVE,
                },
              },
            ],
          },
        };
      }
    );

    const [
      profitAndLoss,
      balanceSheet,
      bankBalances,
      agedReceivables,
      accountsReceivableInvoices,
      agedPayables,
      accountsPayableInvoices,
    ] = await Promise.all([
      syncFinanceProfitAndLossMonthlySnapshot(context as never),
      syncFinanceBalanceSheetSnapshot(context as never),
      syncFinanceBankBalancesSnapshot(context as never),
      syncFinanceAgedReceivablesSnapshot(context as never),
      syncFinanceAccountsReceivableInvoicesSnapshot(context as never),
      syncFinanceAgedPayablesSnapshot(context as never),
      syncFinanceAccountsPayableInvoicesSnapshot(context as never),
    ]);

    expect(context.xero.accountingApi.getReportProfitAndLoss).toHaveBeenCalledWith(
      "tenant-123",
      "2026-04-01",
      "2026-04-20",
      1,
      "MONTH",
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      false
    );
    expect(context.xero.accountingApi.getReportBalanceSheet).toHaveBeenCalledWith(
      "tenant-123",
      "2026-04-20",
      1,
      "MONTH",
      undefined,
      undefined,
      true,
      false
    );
    expect(context.xero.accountingApi.getReportBankSummary).toHaveBeenCalledWith(
      "tenant-123",
      "2026-04-01",
      "2026-04-20"
    );
    expect(context.xero.accountingApi.getInvoices).toHaveBeenCalledWith(
      "tenant-123",
      undefined,
      'Type=="ACCREC" AND Date <= DateTime(2026,4,20)',
      "DueDate ASC",
      undefined,
      undefined,
      undefined,
      ["AUTHORISED", "SUBMITTED"],
      1,
      false,
      false,
      undefined,
      false,
      100
    );
    expect(context.xero.accountingApi.getInvoices).toHaveBeenCalledWith(
      "tenant-123",
      undefined,
      'Type=="ACCPAY" AND Date <= DateTime(2026,4,20)',
      "DueDate ASC",
      undefined,
      undefined,
      undefined,
      ["AUTHORISED", "SUBMITTED"],
      1,
      false,
      false,
      undefined,
      false,
      100
    );
    expect(context.xero.accountingApi.getInvoices).toHaveBeenCalledTimes(2);
    expect(profitAndLoss).toMatchObject({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodStart: new Date("2026-04-01T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(balanceSheet).toMatchObject({
      snapshotType: FinanceSnapshotType.BALANCE_SHEET,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodStart: null,
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(bankBalances).toMatchObject({
      snapshotType: FinanceSnapshotType.BANK_BALANCES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodStart: new Date("2026-04-01T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(agedReceivables).toMatchObject({
      snapshotType: FinanceSnapshotType.AGED_RECEIVABLES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 1,
      currency: "NZD",
      payload: {
        invoiceCount: 1,
        contactCount: 1,
      },
    });
    expect(accountsReceivableInvoices).toMatchObject({
      snapshotType: FinanceSnapshotType.ACCOUNTS_RECEIVABLE_INVOICES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 1,
      currency: "NZD",
      payload: {
        invoiceCount: 1,
        contactCount: 1,
      },
    });
    expect(agedPayables).toMatchObject({
      snapshotType: FinanceSnapshotType.AGED_PAYABLES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 1,
      currency: "NZD",
      payload: {
        invoiceCount: 1,
        contactCount: 1,
      },
    });
    expect(accountsPayableInvoices).toMatchObject({
      snapshotType: FinanceSnapshotType.ACCOUNTS_PAYABLE_INVOICES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 1,
      currency: "NZD",
      payload: {
        invoiceCount: 1,
        contactCount: 1,
      },
    });
  });

  it("maps the chart of accounts into an AccountID-to-GL-code snapshot", () => {
    const snapshot = buildFinanceChartOfAccountsSnapshot({
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      accounts: [
        {
          accountID: "acc-subs",
          code: "203",
          name: "Annual Subs",
          type: "REVENUE",
          _class: "REVENUE",
          status: "ACTIVE",
        },
        {
          accountID: "acc-hut",
          code: "200",
          name: "Hut Fees",
          type: "REVENUE",
          _class: "REVENUE",
          status: "ACTIVE",
        },
        // Dropped: no AccountID means the row cannot be matched to a P&L line.
        { accountID: "", code: "999", name: "Missing id" },
        { code: "998", name: "No id field" },
      ] as never,
    });

    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 2,
      payload: {
        accountCount: 2,
        // Sorted by GL code ascending.
        accounts: [
          {
            accountId: "acc-hut",
            code: "200",
            name: "Hut Fees",
            type: "REVENUE",
            class: "REVENUE",
            status: "ACTIVE",
          },
          {
            accountId: "acc-subs",
            code: "203",
            name: "Annual Subs",
          },
        ],
      },
    });
  });

  it("fetches the chart of accounts through the operational Xero client", async () => {
    const context = createFinanceSyncContext();
    context.xero.accountingApi.getAccounts.mockResolvedValue({
      body: {
        accounts: [
          {
            accountID: "acc-subs",
            code: "203",
            name: "Annual Subs",
            type: "REVENUE",
            _class: "REVENUE",
            status: "ACTIVE",
          },
          {
            accountID: "acc-hut",
            code: "200",
            name: "Hut Fees",
            type: "REVENUE",
            _class: "REVENUE",
            status: "ACTIVE",
          },
        ],
      },
    });

    const snapshot = await syncFinanceChartOfAccountsSnapshot(context as never);

    expect(context.xero.accountingApi.getAccounts).toHaveBeenCalledWith("tenant-123");
    expect(mockCallXeroApi).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ operation: "getAccounts", resourceType: "ACCOUNT" })
    );
    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 2,
      payload: {
        accountCount: 2,
        accounts: [{ code: "200" }, { code: "203" }],
      },
    });
  });

  it("rewrites insufficient-scope report failures with the granular required scope", async () => {
    const cases = [
      {
        operation: "getReportProfitAndLoss",
        requiredScope: "accounting.reports.profitandloss.read",
        reject(context: ReturnType<typeof createFinanceSyncContext>) {
          context.xero.accountingApi.getReportProfitAndLoss.mockRejectedValue(
            buildInsufficientScopeError()
          );
        },
        sync: syncFinanceProfitAndLossMonthlySnapshot,
      },
      {
        operation: "getReportBalanceSheet",
        requiredScope: "accounting.reports.balancesheet.read",
        reject(context: ReturnType<typeof createFinanceSyncContext>) {
          context.xero.accountingApi.getReportBalanceSheet.mockRejectedValue(
            buildInsufficientScopeError()
          );
        },
        sync: syncFinanceBalanceSheetSnapshot,
      },
      {
        operation: "getReportBankSummary",
        requiredScope: "accounting.reports.banksummary.read",
        reject(context: ReturnType<typeof createFinanceSyncContext>) {
          context.xero.accountingApi.getReportBankSummary.mockRejectedValue(
            buildInsufficientScopeError()
          );
        },
        sync: syncFinanceBankBalancesSnapshot,
      },
    ];

    for (const testCase of cases) {
      const context = createFinanceSyncContext();
      testCase.reject(context);

      await expect(testCase.sync(context as never)).rejects.toThrow(
        `Xero is missing a required OAuth scope for ${testCase.operation}. Add ${testCase.requiredScope} to the Xero app and reconnect Xero from the admin panel.`
      );
    }
  });

  describe("monthly fact datasets", () => {
    // The sync context starts at 2026-04-19T22:15Z, which is 2026-04-20 in
    // Pacific/Auckland — so the current (provisional) month is April 2026.
    function createMultiPeriodReport(overrides: Record<string, unknown> = {}) {
      return {
        reportID: "by-month-1",
        reportName: "Profit and Loss",
        reportTitle: "Profit and Loss",
        reportTitles: ["Profit and Loss"],
        reportDate: "2026-04-20",
        updatedDateUTC: new Date("2026-04-20T00:05:00.000Z"),
        rows: [
          {
            rowType: "Header" as never,
            cells: [
              { value: "" },
              { value: "30 Apr 26" },
              { value: "31 Mar 26" },
            ],
          },
          {
            rowType: SECTION,
            title: "Income",
            rows: [
              {
                rowType: ROW,
                cells: [
                  {
                    value: "Hut Fees",
                    attributes: [{ id: "account", value: "acc-hut" }],
                  },
                  { value: "1,250.00" },
                  { value: "980.50" },
                ],
              },
            ],
          },
        ],
        ...overrides,
      };
    }

    beforeEach(() => {
      mockLoadFinanceMonthlyChartContext.mockResolvedValue({
        accountsById: new Map([
          [
            "acc-hut",
            {
              accountId: "acc-hut",
              code: "200",
              name: "Hut Fees",
              type: "SALES",
              class: "REVENUE",
            },
          ],
        ]),
      });
    });

    it("pulls a 12-month profit-and-loss window and derives monthly facts", async () => {
      const context = createFinanceSyncContext();
      context.xero.accountingApi.getReportProfitAndLoss.mockResolvedValue({
        body: { reports: [createMultiPeriodReport()] },
      });

      const snapshot = await syncFinanceProfitAndLossByMonthFacts(
        context as never
      );

      expect(
        context.xero.accountingApi.getReportProfitAndLoss
      ).toHaveBeenCalledWith(
        "tenant-123",
        "2026-04-01",
        "2026-04-30",
        11,
        "MONTH",
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        false
      );
      expect(snapshot).toMatchObject({
        snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_BY_MONTH,
        asOfDate: new Date("2026-04-01T00:00:00.000Z"),
        periodStart: new Date("2026-03-01T00:00:00.000Z"),
        periodEnd: new Date("2026-04-30T00:00:00.000Z"),
        monthlyFacts: {
          statementKind: "PROFIT_AND_LOSS",
          months: ["2026-03", "2026-04"],
          sourceReport: "getReportProfitAndLoss",
          unresolvedRowLabels: [],
          rows: [
            {
              month: "2026-03",
              accountCode: "200",
              accountId: "acc-hut",
              accountName: "Hut Fees",
              accountType: "SALES",
              accountClass: "REVENUE",
              amountCents: 98050,
              isProvisional: false,
            },
            {
              month: "2026-04",
              accountCode: "200",
              accountId: "acc-hut",
              accountName: "Hut Fees",
              accountType: "SALES",
              accountClass: "REVENUE",
              amountCents: 125000,
              isProvisional: true,
            },
          ],
        },
      });
    });

    it("pulls month-end balance-sheet positions with the same window", async () => {
      const context = createFinanceSyncContext();
      context.xero.accountingApi.getReportBalanceSheet.mockResolvedValue({
        body: {
          reports: [
            createMultiPeriodReport({
              reportName: "Balance Sheet",
              reportTitle: "Balance Sheet",
            }),
          ],
        },
      });

      const snapshot = await syncFinanceBalanceSheetByMonthFacts(
        context as never
      );

      expect(
        context.xero.accountingApi.getReportBalanceSheet
      ).toHaveBeenCalledWith(
        "tenant-123",
        "2026-04-30",
        11,
        "MONTH",
        undefined,
        undefined,
        true,
        false
      );
      expect(snapshot).toMatchObject({
        snapshotType: FinanceSnapshotType.BALANCE_SHEET_BY_MONTH,
        asOfDate: new Date("2026-04-01T00:00:00.000Z"),
        monthlyFacts: {
          statementKind: "BALANCE_SHEET",
          months: ["2026-03", "2026-04"],
          sourceReport: "getReportBalanceSheet",
        },
      });
    });

    it("refuses to run without a stored chart of accounts", async () => {
      mockLoadFinanceMonthlyChartContext.mockResolvedValue({
        accountsById: new Map(),
      });
      const context = createFinanceSyncContext();

      await expect(
        syncFinanceProfitAndLossByMonthFacts(context as never)
      ).rejects.toThrow(/No chart-of-accounts snapshot is stored yet/);
      expect(
        context.xero.accountingApi.getReportProfitAndLoss
      ).not.toHaveBeenCalled();
    });

    it("fails loudly when the report header has no parseable period columns", async () => {
      const context = createFinanceSyncContext();
      context.xero.accountingApi.getReportProfitAndLoss.mockResolvedValue({
        body: {
          reports: [
            createMultiPeriodReport({
              rows: [
                {
                  rowType: "Header" as never,
                  cells: [{ value: "" }, { value: "Account" }],
                },
              ],
            }),
          ],
        },
      });

      await expect(
        syncFinanceProfitAndLossByMonthFacts(context as never)
      ).rejects.toThrow(/without parseable monthly period columns/);
    });

    it("fails loudly when no report row resolves to a GL code", async () => {
      mockLoadFinanceMonthlyChartContext.mockResolvedValue({
        accountsById: new Map([
          [
            "acc-other",
            {
              accountId: "acc-other",
              code: "999",
              name: "Other",
              type: "EXPENSE",
              class: "EXPENSE",
            },
          ],
        ]),
      });
      const context = createFinanceSyncContext();
      context.xero.accountingApi.getReportProfitAndLoss.mockResolvedValue({
        body: { reports: [createMultiPeriodReport()] },
      });

      await expect(
        syncFinanceProfitAndLossByMonthFacts(context as never)
      ).rejects.toThrow(/could not be matched to GL codes/);
    });

    it("fails loudly when the period header only partially parses", async () => {
      const context = createFinanceSyncContext();
      context.xero.accountingApi.getReportProfitAndLoss.mockResolvedValue({
        body: {
          reports: [
            createMultiPeriodReport({
              rows: [
                {
                  // Two period columns, but only "30 Apr 26" parses; the
                  // unrecognised "Foo 26" cell would silently drop March from
                  // both the extracted rows and the replace window.
                  rowType: "Header" as never,
                  cells: [{ value: "" }, { value: "30 Apr 26" }, { value: "Foo 26" }],
                },
                {
                  rowType: SECTION,
                  title: "Income",
                  rows: [
                    {
                      rowType: ROW,
                      cells: [
                        {
                          value: "Hut Fees",
                          attributes: [{ id: "account", value: "acc-hut" }],
                        },
                        { value: "1,250.00" },
                        { value: "980.50" },
                      ],
                    },
                  ],
                },
              ],
            }),
          ],
        },
      });

      await expect(
        syncFinanceProfitAndLossByMonthFacts(context as never)
      ).rejects.toThrow(/only partially parsed \(1 of 2 monthly columns\)/);
    });

    it("fails loudly when only some rows resolve to a GL code", async () => {
      // The chart snapshot (from beforeEach) knows acc-hut but not acc-new, as
      // happens when a newly created Xero account is missing from a stale
      // snapshot. Storing only the resolved subset would drop acc-new's amounts
      // from the whole replaced window, so the dataset must fail instead.
      const context = createFinanceSyncContext();
      context.xero.accountingApi.getReportProfitAndLoss.mockResolvedValue({
        body: {
          reports: [
            createMultiPeriodReport({
              rows: [
                {
                  rowType: "Header" as never,
                  cells: [
                    { value: "" },
                    { value: "30 Apr 26" },
                    { value: "31 Mar 26" },
                  ],
                },
                {
                  rowType: SECTION,
                  title: "Income",
                  rows: [
                    {
                      rowType: ROW,
                      cells: [
                        {
                          value: "Hut Fees",
                          attributes: [{ id: "account", value: "acc-hut" }],
                        },
                        { value: "1,250.00" },
                        { value: "980.50" },
                      ],
                    },
                    {
                      rowType: ROW,
                      cells: [
                        {
                          value: "New Account",
                          attributes: [{ id: "account", value: "acc-new" }],
                        },
                        { value: "500.00" },
                        { value: "0.00" },
                      ],
                    },
                  ],
                },
              ],
            }),
          ],
        },
      });

      await expect(
        syncFinanceProfitAndLossByMonthFacts(context as never)
      ).rejects.toThrow(/could not be matched to GL codes \(1 unresolved\)/);
    });
  });
});
