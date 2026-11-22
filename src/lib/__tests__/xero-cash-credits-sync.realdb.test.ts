/**
 * #5204: the Xero overpayment and prepayment refresh against real PostgreSQL,
 * reading the stateful Xero fake through the real reader, `callXeroApi` and
 * `withXeroRetry`. No live provider. The usage meter is stubbed so the suite
 * leaves no shared daily counters behind.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroClient } from "xero-node";
import { XeroFake } from "@/test/providers/xero-fake";
import { xeroTransport } from "@/test/providers/xero-transport";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

vi.mock("@/lib/xero-api-usage", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-usage")),
  recordXeroApiUsage: async () => undefined,
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "race-5204-";
const MEMBER = "race-5204-member";

let db: (typeof import("@/lib/prisma"))["prisma"];
let cash: typeof import("@/lib/xero-cash-credits");
let override: typeof import("@/lib/xero-test-client-override");
let resetRateLimits: () => void;

(RUN ? describe : describe.skip)("Xero cash-credit refresh, real PostgreSQL", () => {
  let fake: XeroFake;
  let contact: string;
  let otherContact: string;
  let failPage: { kind: string; page: number } | null;
  let beforePage: { kind: string; page: number; run: () => void } | null;
  let notFoundId: string | null;

  function install() {
    const session = xeroTransport(fake);
    const accountingApi = new Proxy({}, {
      get(_t, name) {
        if (name === "then") return undefined;
        const real = Reflect.get(session.xero.accountingApi, name) as (...args: unknown[]) => unknown;
        if (name === "getOverpayment") {
          return (...args: unknown[]) => {
            if (args[1] === notFoundId) session.failNext({ statusCode: 404, body: { Message: "not found" } });
            return real(...args);
          };
        }
        if (name !== "getOverpayments" && name !== "getPrepayments") return real;
        return (...args: unknown[]) => {
          const kind = name === "getOverpayments" ? "OVERPAYMENT" : "PREPAYMENT";
          // A 400 is not retried, so the injected failure is the page's answer.
          if (failPage?.kind === kind && failPage.page === args[4]) session.failNext({ statusCode: 400, body: { Message: "page failed" } });
          if (beforePage?.kind === kind && beforePage.page === args[4]) beforePage.run();
          return real(...args);
        };
      },
    });
    override.setXeroClientForTests({ tenantId: session.tenantId, xero: { accountingApi } as unknown as XeroClient });
  }

  const at = (iso: string) => () => new Date(iso);
  const rows = () => db.xeroCashCredit.findMany({
    where: { xeroDocumentId: { startsWith: PREFIX } },
    orderBy: { xeroDocumentId: "asc" },
    select: { kind: true, xeroDocumentId: true, xeroContactId: true, currencyCode: true, documentDate: true, totalCents: true, remainingCents: true, syncedAt: true },
  });
  async function clean() {
    await db.xeroCashCredit.deleteMany({ where: { xeroDocumentId: { startsWith: PREFIX } } });
    await db.xeroSyncCursor.deleteMany({ where: { resourceType: "XERO_CASH_CREDITS" } });
    await db.member.deleteMany({ where: { id: MEMBER } });
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(DB_URL, "Xero cash-credit refresh");
    process.env.DATABASE_URL = DB_URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    cash = await import("@/lib/xero-cash-credits");
    override = await import("@/lib/xero-test-client-override");
    ({ resetXeroRateLimitStateForTests: resetRateLimits } = await import("@/lib/xero-api-client"));
  });
  beforeEach(async () => {
    await clean();
    fake = new XeroFake(PREFIX);
    contact = fake.createContact("contact-a", "Member A").contactID;
    otherContact = fake.createContact("contact-b", "Organisation B").contactID;
    failPage = null;
    beforePage = null;
    notFoundId = null;
    install();
    await db.member.create({ data: {
      id: MEMBER, email: "race-5204@example.invalid", passwordHash: "test-only", firstName: "Cash", lastName: "Credit",
      ageTier: "ADULT", xeroContactId: contact, joinedDate: new Date("2026-01-01T00:00:00.000Z"),
    } });
  });
  afterEach(() => {
    override.resetXeroClientForTests();
    resetRateLimits();
  });
  afterAll(async () => {
    try { if (db) await clean(); } finally { await db?.$disconnect(); }
  });

  it("snapshots open overpayments and prepayments and matches each to the member whose contact it is", async () => {
    const over = fake.createCashCredit("over", "OVERPAYMENT", contact, 12_345, "2026-06-20");
    const pre = fake.createCashCredit("pre", "PREPAYMENT", otherContact, 50_000, "2026-06-25");

    const result = await cash.refreshXeroCashCredits({ now: at("2026-07-01T00:00:00.000Z") });

    expect(result).toEqual({ open: 2, written: 2, zeroed: 0, current: true });
    expect(await rows()).toEqual([
      { kind: "OVERPAYMENT", xeroDocumentId: over.cashCreditID, xeroContactId: contact, currencyCode: "NZD", documentDate: new Date("2026-06-20T00:00:00.000Z"), totalCents: 12_345, remainingCents: 12_345, syncedAt: new Date("2026-07-01T00:00:00.000Z") },
      { kind: "PREPAYMENT", xeroDocumentId: pre.cashCreditID, xeroContactId: otherContact, currencyCode: "NZD", documentDate: new Date("2026-06-25T00:00:00.000Z"), totalCents: 50_000, remainingCents: 50_000, syncedAt: new Date("2026-07-01T00:00:00.000Z") },
    ]);
    const queue = await cash.listXeroCashCreditQueue(db);
    expect(queue.refreshedAt).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(queue.rows.map((row) => [row.xeroDocumentId, row.documentDate, row.remainingCents, row.member])).toEqual([
      [over.cashCreditID, "2026-06-20", 12_345, { id: MEMBER, name: "Cash Credit" }],
      [pre.cashCreditID, "2026-06-25", 50_000, null],
    ]);
  });

  it("zeroes a document a complete read no longer lists, and keeps the row", async () => {
    const over = fake.createCashCredit("over", "OVERPAYMENT", contact, 10_000, "2026-06-20");
    await cash.refreshXeroCashCredits({ now: at("2026-07-01T00:00:00.000Z") });
    fake.voidCashCredit(over.cashCreditID);

    const result = await cash.refreshXeroCashCredits({ now: at("2026-07-01T01:00:00.000Z") });

    expect(result).toEqual({ open: 0, written: 0, zeroed: 1, current: true });
    expect((await rows()).map((row) => [row.xeroDocumentId, row.remainingCents])).toEqual([[over.cashCreditID, 0]]);
    expect((await cash.listXeroCashCreditQueue(db)).rows).toEqual([]);
  });

  it("reads every page, and a failed second page changes nothing at all", async () => {
    const first = fake.createCashCredit("first", "OVERPAYMENT", contact, 10_000, "2026-06-01");
    await cash.refreshXeroCashCredits({ now: at("2026-07-01T00:00:00.000Z") });
    fake.voidCashCredit(first.cashCreditID);
    for (let i = 0; i < cash.XERO_CASH_CREDIT_PAGE_SIZE + 1; i++) fake.createCashCredit(`bulk-${i}`, "OVERPAYMENT", otherContact, 100 + i, "2026-06-02");
    const before = await rows();

    failPage = { kind: "OVERPAYMENT", page: 2 };
    await expect(cash.refreshXeroCashCredits({ now: at("2026-07-01T01:00:00.000Z") })).rejects.toBeTruthy();
    expect(await rows()).toEqual(before);
    expect((await cash.listXeroCashCreditQueue(db)).refreshedAt).toEqual(new Date("2026-07-01T00:00:00.000Z"));

    failPage = null;
    const result = await cash.refreshXeroCashCredits({ now: at("2026-07-01T02:00:00.000Z") });
    expect(result).toMatchObject({ open: cash.XERO_CASH_CREDIT_PAGE_SIZE + 1, zeroed: 1, current: true });
    expect((await cash.listXeroCashCreditQueue(db)).rows).toHaveLength(cash.XERO_CASH_CREDIT_PAGE_SIZE + 1);
  });

  it("confirms by id a stored open document a multi-page list skipped, rather than zeroing it", async () => {
    const bulk = Array.from({ length: cash.XERO_CASH_CREDIT_PAGE_SIZE + 1 }, (_, i) =>
      fake.createCashCredit(`bulk-${i}`, "OVERPAYMENT", otherContact, 100 + i, "2026-06-02"));
    await cash.refreshXeroCashCredits({ now: at("2026-07-01T00:00:00.000Z") });
    // Using up a page-1 document between the two page reads shifts the 101st
    // document onto page 1, so the list never returns it.
    beforePage = { kind: "OVERPAYMENT", page: 2, run: () => fake.voidCashCredit(bulk[0]!.cashCreditID) };

    const result = await cash.refreshXeroCashCredits({ now: at("2026-07-01T01:00:00.000Z") });

    // The voided document was still open when page 1 was read; the next refresh zeroes it.
    expect(result).toMatchObject({ open: cash.XERO_CASH_CREDIT_PAGE_SIZE + 1, zeroed: 0, current: true });
    expect((await cash.listXeroCashCreditQueue(db)).rows.map((row) => row.xeroDocumentId)).toContain(bulk[cash.XERO_CASH_CREDIT_PAGE_SIZE]!.cashCreditID);
    beforePage = null;
    expect(await cash.refreshXeroCashCredits({ now: at("2026-07-01T02:00:00.000Z") })).toMatchObject({ open: cash.XERO_CASH_CREDIT_PAGE_SIZE, zeroed: 1 });
  });

  it("zeroes a stored open document Xero answers 404 for, rather than failing every multi-page refresh", async () => {
    for (let i = 0; i < cash.XERO_CASH_CREDIT_PAGE_SIZE + 1; i++) fake.createCashCredit(`bulk-${i}`, "OVERPAYMENT", otherContact, 100 + i, "2026-06-02");
    const gone = `${PREFIX}gone`;
    await db.xeroCashCredit.create({ data: {
      kind: "OVERPAYMENT", xeroDocumentId: gone, xeroContactId: contact, currencyCode: "NZD",
      totalCents: 5_000, remainingCents: 5_000, syncedAt: new Date("2026-06-30T00:00:00.000Z"),
    } });
    notFoundId = gone;

    const result = await cash.refreshXeroCashCredits({ now: at("2026-07-01T00:00:00.000Z") });

    expect(result).toMatchObject({ open: cash.XERO_CASH_CREDIT_PAGE_SIZE + 1, zeroed: 1, current: true });
    expect(await db.xeroCashCredit.findUnique({ where: { xeroDocumentId: gone }, select: { remainingCents: true } })).toEqual({ remainingCents: 0 });
  });

  it("replaying the same read writes nothing a second time", async () => {
    fake.createCashCredit("over", "OVERPAYMENT", contact, 10_000, "2026-06-20");
    const documents = await cash.readXeroCashCreditDocuments();
    const started = new Date("2026-07-01T00:00:00.000Z");

    expect(await cash.applyXeroCashCreditSnapshot(documents, started, db)).toMatchObject({ written: 1, current: true });
    const after = await db.xeroCashCredit.findMany({ where: { xeroDocumentId: { startsWith: PREFIX } } });
    expect(await cash.applyXeroCashCreditSnapshot(documents, started, db)).toEqual({ open: 1, written: 0, zeroed: 0, current: false });
    expect(await db.xeroCashCredit.findMany({ where: { xeroDocumentId: { startsWith: PREFIX } } })).toEqual(after);
  });

  it("an older read committed after a newer one writes nothing, in either commit order and when they race", async () => {
    const spent = fake.createCashCredit("spent", "OVERPAYMENT", contact, 10_000, "2026-06-20");
    const older = await cash.readXeroCashCreditDocuments();
    fake.voidCashCredit(spent.cashCreditID);
    const later = fake.createCashCredit("later", "PREPAYMENT", contact, 7_500, "2026-06-30");
    const newer = await cash.readXeroCashCreditDocuments();
    const olderStart = new Date("2026-07-01T00:00:00.000Z");
    const newerStart = new Date("2026-07-01T00:05:00.000Z");
    const expected = [[later.cashCreditID, 7_500]];
    const open = async () => (await cash.listXeroCashCreditQueue(db)).rows.map((row) => [row.xeroDocumentId, row.remainingCents]);

    expect(await cash.applyXeroCashCreditSnapshot(newer, newerStart, db)).toMatchObject({ current: true });
    expect(await cash.applyXeroCashCreditSnapshot(older, olderStart, db)).toMatchObject({ written: 0, current: false });
    expect(await open()).toEqual(expected);
    // The spent document was never written, so the older read could only have created it.
    expect((await rows()).map((row) => row.xeroDocumentId)).toEqual([later.cashCreditID]);

    const startAgain = async () => {
      await clean();
      await db.member.create({ data: {
        id: MEMBER, email: "race-5204@example.invalid", passwordHash: "test-only", firstName: "Cash", lastName: "Credit",
        ageTier: "ADULT", xeroContactId: contact, joinedDate: new Date("2026-01-01T00:00:00.000Z"),
      } });
    };

    // The other commit order (#5359): the older read lands first and writes the spent document as still open;
    // the newer read then zeroes it and is the snapshot that stands.
    await startAgain();
    expect(await cash.applyXeroCashCreditSnapshot(older, olderStart, db)).toMatchObject({ written: 1, zeroed: 0, current: true });
    expect(await open()).toEqual([[spent.cashCreditID, 10_000]]);
    expect(await cash.applyXeroCashCreditSnapshot(newer, newerStart, db)).toMatchObject({ written: 1, zeroed: 1, current: true });
    expect(await open()).toEqual(expected);
    expect((await rows()).map((row) => [row.xeroDocumentId, row.remainingCents]).sort()).toEqual([[later.cashCreditID, 7_500], [spent.cashCreditID, 0]].sort());
    expect((await cash.listXeroCashCreditQueue(db)).refreshedAt).toEqual(newerStart);

    await startAgain();
    const outcomes = await Promise.all([
      cash.applyXeroCashCreditSnapshot(older, olderStart, db),
      cash.applyXeroCashCreditSnapshot(newer, newerStart, db),
    ]);
    expect(outcomes[1]!.current).toBe(true);
    expect(await open()).toEqual(expected);
    expect((await cash.listXeroCashCreditQueue(db)).refreshedAt).toEqual(newerStart);
  });
});
