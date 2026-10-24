/**
 * #4336: the read-only voided refund-note report, against a mocked Xero and a
 * mocked database. Nothing here reaches a live provider or database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCreditNote = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-client")),
  getAuthenticatedXeroClient: vi.fn(async () => ({ xero: { accountingApi: { getCreditNote } }, tenantId: "tenant" })),
}));

const { XeroDailyLimitError, resetXeroRateLimitStateForTests } = await import("@/lib/xero-api-client");
const {
  buildVoidedRefundNoteReport,
  createXeroCreditNoteReader,
  formatVoidedRefundNoteReport,
  isVoidedRefundNoteReportComplete,
  voidedRefundNoteReportCsv,
  REPORTED_REFUND_NOTE_ROLES,
} = await import("@/lib/xero-voided-refund-note-report");

type Reading = import("@/lib/xero-voided-refund-note-report").XeroCreditNoteReading;
type Link = { localId: string; xeroObjectId: string; xeroObjectNumber: string | null; role: string; metadata: unknown };

const link = (localId: string, xeroObjectId: string, over: Partial<Link> = {}): Link => ({
  localId, xeroObjectId, xeroObjectNumber: `CN-${xeroObjectId}`, role: "REFUND_CREDIT_NOTE", metadata: null, ...over,
});

function makeDb(links: Link[], payments: Array<{ id: string; bookingId: string }>) {
  const linkFindMany = vi.fn<(args: unknown) => Promise<Link[]>>(async () => links);
  const paymentFindMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
    payments.filter((payment) => args.where.id.in.includes(payment.id)),
  );
  const db = { xeroObjectLink: { findMany: linkFindMany }, payment: { findMany: paymentFindMany } };
  return { db: db as never, linkFindMany, paymentFindMany };
}

const live = (over: Partial<Reading> = {}): Reading => ({ status: "AUTHORISED", number: "CN-LIVE", totalCents: 20_000, ...over });
const noPause = async () => undefined;

describe("buildVoidedRefundNoteReport (#4336)", () => {
  it("lists VOIDED and DELETED notes with payment, booking, number, amount and the app's stored status, and skips live ones", async () => {
    const { db } = makeDb(
      [
        link("pay-1", "n-void", { metadata: { status: "AUTHORISED" } }),
        link("pay-2", "n-deleted", { role: "REFUND_REQUEST_CREDIT_NOTE" }),
        link("pay-3", "n-live"),
        link("pay-4", "n-paid"),
      ],
      [
        { id: "pay-1", bookingId: "abcdefgh1234" },
        { id: "pay-2", bookingId: "zyxwvuts9876" },
        { id: "pay-3", bookingId: "b3" },
        { id: "pay-4", bookingId: "b4" },
      ],
    );
    const readings: Record<string, Reading> = {
      "n-void": { status: "VOIDED", number: "CN-0101", totalCents: 20_000 },
      "n-deleted": { status: "deleted", number: null, totalCents: 4_550 },
      "n-live": live(),
      "n-paid": live({ status: "PAID" }),
    };
    const report = await buildVoidedRefundNoteReport({ db, readCreditNote: async (id) => readings[id], sleep: noPause });

    expect(report).toMatchObject({ activeLinks: 4, notesChecked: 4, notFound: [], unreadable: [], stoppedEarly: null });
    expect(report.voided).toEqual([
      {
        paymentId: "pay-1", bookingId: "abcdefgh1234", bookingReference: "ABCDEFGH", role: "REFUND_CREDIT_NOTE",
        creditNoteId: "n-void", creditNoteNumber: "CN-0101", xeroStatus: "VOIDED", amountCents: 20_000, storedStatus: "AUTHORISED",
      },
      {
        paymentId: "pay-2", bookingId: "zyxwvuts9876", bookingReference: "ZYXWVUTS", role: "REFUND_REQUEST_CREDIT_NOTE",
        creditNoteId: "n-deleted", creditNoteNumber: "CN-n-deleted", xeroStatus: "DELETED", amountCents: 4_550, storedStatus: null,
      },
    ]);
    expect(isVoidedRefundNoteReportComplete(report)).toBe(true);
  });

  it("walks only active links of both refund-note roles, and reads the database without writing", async () => {
    const { db, linkFindMany } = makeDb([], []);
    const readCreditNote = vi.fn();
    const report = await buildVoidedRefundNoteReport({ db, readCreditNote, sleep: noPause });
    expect(report).toMatchObject({ activeLinks: 0, notesChecked: 0, voided: [] });
    expect(readCreditNote).not.toHaveBeenCalled();
    expect(REPORTED_REFUND_NOTE_ROLES).toEqual(["REFUND_CREDIT_NOTE", "REFUND_REQUEST_CREDIT_NOTE"]);
    expect(linkFindMany.mock.calls[0][0]).toMatchObject({
      where: { localModel: "Payment", xeroObjectType: "CREDIT_NOTE", role: { in: ["REFUND_CREDIT_NOTE", "REFUND_REQUEST_CREDIT_NOTE"] }, active: true },
    });
    expect(Object.keys(db as object).sort()).toEqual(["payment", "xeroObjectLink"]);
    expect(Object.keys((db as { payment: object }).payment)).toEqual(["findMany"]);
    expect(Object.keys((db as { xeroObjectLink: object }).xeroObjectLink)).toEqual(["findMany"]);
  });

  it("asks Xero once per distinct note and reports every link that names a voided one", async () => {
    const { db } = makeDb(
      [link("pay-1", "n-shared"), link("pay-2", "n-shared", { role: "REFUND_REQUEST_CREDIT_NOTE" })],
      [{ id: "pay-1", bookingId: "b1" }, { id: "pay-2", bookingId: "b2" }],
    );
    const readCreditNote = vi.fn(async () => ({ status: "VOIDED", number: "CN-9", totalCents: 100 }));
    const report = await buildVoidedRefundNoteReport({ db, readCreditNote, sleep: noPause });
    expect(readCreditNote).toHaveBeenCalledTimes(1);
    expect(report.notesChecked).toBe(1);
    expect(report.voided.map((row) => row.paymentId)).toEqual(["pay-1", "pay-2"]);
  });

  it("falls back to the link's recorded amount when Xero sends no total, and leaves it unknown when neither does", async () => {
    const { db } = makeDb(
      [link("pay-1", "n-1", { metadata: { amountCents: 7_000 } }), link("pay-2", "n-2", { metadata: { total: 12.5 } }), link("pay-3", "n-3")],
      [{ id: "pay-1", bookingId: "b1" }, { id: "pay-2", bookingId: "b2" }, { id: "pay-3", bookingId: "b3" }],
    );
    const report = await buildVoidedRefundNoteReport({
      db, readCreditNote: async () => ({ status: "VOIDED", number: null, totalCents: null }), sleep: noPause,
    });
    expect(report.voided.map((row) => row.amountCents)).toEqual([7_000, 1_250, null]);
  });

  it("treats a note Xero reports no status for as live, not voided", async () => {
    const { db } = makeDb([link("pay-1", "n-1")], [{ id: "pay-1", bookingId: "b1" }]);
    const report = await buildVoidedRefundNoteReport({ db, readCreditNote: async () => live({ status: null }), sleep: noPause });
    expect(report.voided).toEqual([]);
  });

  it("lists a note Xero does not have apart from the voided ones", async () => {
    const { db } = makeDb([link("pay-1", "n-gone")], [{ id: "pay-1", bookingId: "b1" }]);
    const report = await buildVoidedRefundNoteReport({ db, readCreditNote: async () => null, sleep: noPause });
    expect(report.voided).toEqual([]);
    expect(report.notFound).toEqual([{ paymentId: "pay-1", creditNoteId: "n-gone", creditNoteNumber: "CN-n-gone" }]);
    expect(report.notesChecked).toBe(1);
    expect(formatVoidedRefundNoteReport(report)).toContain("Linked but not found in Xero: 1");
  });

  it("records a note that could not be read as unknown and marks the report incomplete, then carries on", async () => {
    const { db } = makeDb([link("pay-1", "n-bad"), link("pay-2", "n-void")], [{ id: "pay-1", bookingId: "b1" }, { id: "pay-2", bookingId: "b2" }]);
    const report = await buildVoidedRefundNoteReport({
      db,
      readCreditNote: async (id) => {
        if (id === "n-bad") throw new Error("Request failed with status code 500");
        return { status: "VOIDED", number: "CN-2", totalCents: 500 };
      },
      sleep: noPause,
    });
    expect(report.unreadable).toEqual([{ creditNoteId: "n-bad", error: "Request failed with status code 500" }]);
    expect(report.voided).toHaveLength(1);
    expect(isVoidedRefundNoteReportComplete(report)).toBe(false);
    expect(formatVoidedRefundNoteReport(report)).toContain("COULD NOT BE READ");
  });

  it("stops at Xero's daily limit and says how many notes were never asked", async () => {
    const { db } = makeDb(
      [link("pay-1", "n-1"), link("pay-2", "n-2"), link("pay-3", "n-3")],
      [{ id: "pay-1", bookingId: "b1" }, { id: "pay-2", bookingId: "b2" }, { id: "pay-3", bookingId: "b3" }],
    );
    const readCreditNote = vi.fn(async (id: string) => {
      if (id === "n-2") throw new XeroDailyLimitError(86_400);
      return { status: "VOIDED", number: "CN-1", totalCents: 500 };
    });
    const report = await buildVoidedRefundNoteReport({ db, readCreditNote, sleep: noPause });
    expect(readCreditNote).toHaveBeenCalledTimes(2);
    expect(report.voided).toHaveLength(1);
    expect(report.unreadable).toEqual([]);
    expect(report.stoppedEarly).toMatchObject({ notesNotChecked: 2 });
    expect(isVoidedRefundNoteReportComplete(report)).toBe(false);
    expect(formatVoidedRefundNoteReport(report)).toContain("INCOMPLETE");
  });

  it("pages the payment lookup and spaces the Xero reads", async () => {
    const count = 1_001;
    const links = Array.from({ length: count }, (_, i) => link(`pay-${i}`, `n-${i}`));
    const payments = Array.from({ length: count }, (_, i) => ({ id: `pay-${i}`, bookingId: `booking-${i}` }));
    const { db, paymentFindMany } = makeDb(links, payments);
    const sleep = vi.fn(async () => undefined);
    const report = await buildVoidedRefundNoteReport({
      db, readCreditNote: async () => ({ status: "VOIDED", number: "CN", totalCents: 1 }), sleep, spacingMs: 250,
    });
    expect(paymentFindMany).toHaveBeenCalledTimes(2);
    expect(paymentFindMany.mock.calls[0][0].where.id.in).toHaveLength(1_000);
    expect(sleep).toHaveBeenCalledTimes(count - 1);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(report.voided).toHaveLength(count);
    expect(report.voided[1_000].bookingId).toBe("booking-1000");
  });
});

describe("report output (#4336)", () => {
  const report = {
    activeLinks: 1, notesChecked: 1, notFound: [], unreadable: [], stoppedEarly: null,
    voided: [{
      paymentId: "pay-1", bookingId: "abcdefgh1234", bookingReference: "ABCDEFGH", role: "REFUND_CREDIT_NOTE",
      creditNoteId: "n-1", creditNoteNumber: "=CN-1", xeroStatus: "VOIDED", amountCents: 20_000, storedStatus: null,
    }],
  };

  it("prints a plain table with the amount, Xero's status and the stored status", () => {
    const text = formatVoidedRefundNoteReport(report);
    expect(text).toContain("while the app still links them as active: 1");
    expect(text).toMatch(/pay-1\s+abcdefgh1234\s+ABCDEFGH\s+REFUND_CREDIT_NOTE\s+=CN-1\s+n-1\s+200\.00\s+VOIDED\s+none recorded/);
    expect(text).toContain("Correct it by hand");
  });

  it("prints a clean line and no table when nothing is voided", () => {
    const text = formatVoidedRefundNoteReport({ ...report, voided: [] });
    expect(text).toContain("while the app still links them as active: 0");
    expect(text).not.toContain("paymentId");
  });

  it("writes CSV with a formula-looking cell neutralised", () => {
    const csv = voidedRefundNoteReportCsv(report);
    expect(csv.split("\n")[0]).toBe("paymentId,bookingId,bookingReference,role,creditNoteNumber,creditNoteId,amount,xeroStatus,appStoredStatus");
    expect(csv.split("\n")[1]).toBe("pay-1,abcdefgh1234,ABCDEFGH,REFUND_CREDIT_NOTE,'=CN-1,n-1,200.00,VOIDED,none recorded");
  });
});

describe("createXeroCreditNoteReader (#4336)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getCreditNote.mockReset();
    resetXeroRateLimitStateForTests(); // the daily-limit cooldown is process-wide
  });
  afterEach(() => {
    vi.useRealTimers();
    resetXeroRateLimitStateForTests();
  });

  const minuteLimit = () =>
    Object.assign(new Error("rate limited"), { response: { statusCode: 429, headers: { "retry-after": "2", "x-rate-limit-problem": "minute" } } });

  it("reads one note by id and converts its total to cents", async () => {
    getCreditNote.mockResolvedValue({ body: { creditNotes: [{ creditNoteID: "n-1", creditNoteNumber: "CN-1", status: "VOIDED", total: 200.5 }] } });
    const read = await createXeroCreditNoteReader();
    await expect(read("n-1")).resolves.toEqual({ status: "VOIDED", number: "CN-1", totalCents: 20_050 });
    expect(getCreditNote).toHaveBeenCalledWith("tenant", "n-1");
  });

  it("waits out a minute-limit 429 and retries", async () => {
    getCreditNote
      .mockRejectedValueOnce(minuteLimit())
      .mockResolvedValue({ body: { creditNotes: [{ creditNoteID: "n-1", status: "DELETED", total: 10 }] } });
    const read = await createXeroCreditNoteReader();
    const pending = read("n-1");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ status: "DELETED", totalCents: 1_000 });
    expect(getCreditNote).toHaveBeenCalledTimes(2);
  });

  it("stops at a daily-limit 429 with XeroDailyLimitError, without retrying", async () => {
    getCreditNote.mockRejectedValue(
      Object.assign(new Error("rate limited"), { response: { statusCode: 429, headers: { "retry-after": "3600", "x-rate-limit-problem": "day" } } }),
    );
    const read = await createXeroCreditNoteReader();
    await expect(read("n-1")).rejects.toBeInstanceOf(XeroDailyLimitError);
    expect(getCreditNote).toHaveBeenCalledTimes(1);
  });

  it("answers null for a 404 and for an empty answer, and rethrows anything else", async () => {
    const read = await createXeroCreditNoteReader();
    getCreditNote.mockRejectedValueOnce(Object.assign(new Error("not found"), { response: { statusCode: 404 } }));
    await expect(read("n-1")).resolves.toBeNull();
    getCreditNote.mockResolvedValueOnce({ body: { creditNotes: [] } });
    await expect(read("n-2")).resolves.toBeNull();
    getCreditNote.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { response: { statusCode: 403 } }));
    await expect(read("n-3")).rejects.toThrow("forbidden");
  });
});
