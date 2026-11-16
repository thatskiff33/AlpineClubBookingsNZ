/**
 * #4336: the read-only revived refund-note report, end to end over the
 * stateful Xero fake (`src/test/providers/xero-fake.ts`) through the real
 * reader, `callXeroApi` and `withXeroRetry`. The database is a double whose
 * every write method throws, and so is the Xero client: the report finishing
 * at all is the proof it writes nothing. No live provider or database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroClient } from "xero-node";
import { XeroFake } from "@/test/providers/xero-fake";
import { xeroTransport } from "@/test/providers/xero-transport";
import type { ActiveRefundNoteLink } from "@/lib/xero-revived-refund-note-report";

/** Every write method on the Prisma double throws; only reads answer. */
const READ_METHODS = new Set(["findMany", "findFirst", "findUnique", "count", "aggregate", "groupBy"]);
const writesAttempted: string[] = [];
function writeThrowingDb(models: Record<string, Record<string, unknown>>): unknown {
  return new Proxy(
    {},
    {
      get(_target, model) {
        if (model === "then") return undefined;
        const name = String(model);
        if (name.startsWith("$")) {
          return () => {
            writesAttempted.push(name);
            throw new Error(`write attempted: ${name}`);
          };
        }
        return new Proxy(
          {},
          {
            get(_m, method) {
              const key = `${name}.${String(method)}`;
              const impl = models[name]?.[String(method)];
              if (READ_METHODS.has(String(method)) && typeof impl === "function") return impl;
              return () => {
                writesAttempted.push(key);
                throw new Error(`write attempted: ${key}`);
              };
            },
          },
        );
      },
    },
  );
}

const usage = vi.hoisted(() => ({ record: vi.fn<(row: { workflow?: string }) => Promise<undefined>>(async () => undefined), budgetAllows: vi.fn(async () => true) }));
// The app-wide client: nothing here may read or write it. The report's own reads go through an injected double.
vi.mock("@/lib/prisma", () => ({ prisma: writeThrowingDb({}) }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// The API-usage meter every metered call writes: recorded here so the test can see it is the only write.
vi.mock("@/lib/xero-api-usage", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-usage")),
  recordXeroApiUsage: usage.record,
  xeroDailyBudgetAllowsDeferrableCall: usage.budgetAllows,
}));

const { resetXeroRateLimitStateForTests, withXeroRetry } = await import("@/lib/xero-api-client");
const { setXeroClientForTests, resetXeroClientForTests } = await import("@/lib/xero-test-client-override");
const report = await import("@/lib/xero-revived-refund-note-report");
const reader = await import("@/lib/xero-revived-refund-note-reader");

type LinkRow = { id: string; localModel: string; localId: string; xeroObjectType: string; xeroObjectId: string; xeroObjectNumber: string | null; role: string; active: boolean; metadata: unknown };
type PaymentRow = { id: string; bookingId: string; source: "STRIPE" | "INTERNET_BANKING"; xeroRefundCreditNoteId: string | null };

/** A read-only database double that honours the where, cursor and take the report sends. */
function reportDb(links: LinkRow[], payments: PaymentRow[]) {
  const linkFindMany = vi.fn(async (args: { where: { localModel: string; xeroObjectType: string; role: { in: string[] }; active: boolean }; take: number; cursor?: { id: string }; skip?: number }) => {
    const matching = links
      .filter((l) => l.localModel === args.where.localModel && l.xeroObjectType === args.where.xeroObjectType && args.where.role.in.includes(l.role) && l.active === args.where.active)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start = args.cursor ? matching.findIndex((l) => l.id === args.cursor!.id) + (args.skip ?? 0) : 0;
    return matching.slice(start, start + args.take).map(({ id, localId, xeroObjectId, xeroObjectNumber, role, metadata }) => ({ id, localId, xeroObjectId, xeroObjectNumber, role, metadata }));
  });
  const paymentFindMany = vi.fn(async (args: { where: { id: { in: string[] } } }) => payments.filter((p) => args.where.id.in.includes(p.id)));
  const db = writeThrowingDb({ xeroObjectLink: { findMany: linkFindMany }, payment: { findMany: paymentFindMany } });
  return { db: db as Parameters<typeof report.readActiveRefundNoteLinks>[0], linkFindMany, paymentFindMany };
}

const link = (id: string, paymentId: string, noteId: string, over: Partial<LinkRow> = {}): LinkRow => ({
  id, localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: null,
  role: "REFUND_CREDIT_NOTE", active: true, metadata: { status: "AUTHORISED", total: 200, remainingCredit: 0 }, ...over,
});

const UPDATED = new Date("2026-06-20T03:00:00.000Z");

/**
 * The fake behind the real client seam, wrapped so every Xero write throws.
 * The fake models VOIDED only and sends no `UpdatedDateUTC`, so `deleted`
 * notes are answered DELETED and every note gets a fixed `UpdatedDateUTC`.
 */
function installXero(fake: XeroFake, deleted: ReadonlySet<string> = new Set()) {
  const session = xeroTransport(fake);
  const getCreditNote = vi.fn(async (...args: Parameters<XeroClient["accountingApi"]["getCreditNote"]>) => {
    const response = await session.xero.accountingApi.getCreditNote(...args);
    for (const note of response.body.creditNotes ?? []) {
      note.updatedDateUTC = UPDATED;
      if (note.creditNoteID && deleted.has(note.creditNoteID)) (note as { status: unknown }).status = "DELETED";
    }
    return response;
  });
  const accountingApi = new Proxy({}, {
    get(_t, name) {
      if (name === "then") return undefined;
      if (name === "getCreditNote") return getCreditNote;
      if (/^get[A-Z]/.test(String(name))) return Reflect.get(session.xero.accountingApi, name);
      writesAttempted.push(`xero.${String(name)}`);
      throw new Error(`Xero write attempted: ${String(name)}`);
    },
  });
  setXeroClientForTests({ tenantId: session.tenantId, xero: { accountingApi } as unknown as XeroClient });
  return { getCreditNote, failNext: session.failNext };
}

function notes(fake: XeroFake, count: number) {
  const contact = fake.createContact("contact", "member-a");
  return Array.from({ length: count }, (_, i) => fake.createCreditNote(`note-${i}`, contact.contactID, 20_000).creditNoteID);
}

const noPause = vi.fn(async () => undefined);
const run = (links: ActiveRefundNoteLink[]) => report.classifyRevivedRefundNotes(links, reader.createXeroCreditNoteReader(), { sleep: noPause });

beforeEach(() => {
  writesAttempted.length = 0;
  usage.record.mockClear();
  usage.budgetAllows.mockReset().mockResolvedValue(true);
  noPause.mockClear();
});
afterEach(() => {
  resetXeroClientForTests();
  resetXeroRateLimitStateForTests();
});

describe("#4336 revived refund-note report: classification", () => {
  it("lists a voided and a deleted note with every column, leaves live notes out, and totals cents per payment source", async () => {
    const fake = new XeroFake();
    const [voided, deleted, live, paid] = notes(fake, 4);
    fake.voidCreditNote(voided!);
    fake.payCreditNote("refund-paid", paid!, 20_000); // PAID is live
    const { db } = reportDb(
      [
        link("l1", "pay-bank", voided!, { xeroObjectNumber: "CN-1" }),
        link("l2", "pay-card", deleted!, { role: "REFUND_REQUEST_CREDIT_NOTE", metadata: { status: "AUTHORISED", total: 45.5, remainingCredit: 0, refundRequestId: "rr-1" } }),
        link("l3", "pay-live", live!),
        link("l4", "pay-paid", paid!),
      ],
      [
        { id: "pay-bank", bookingId: "book-1", source: "INTERNET_BANKING", xeroRefundCreditNoteId: voided! },
        { id: "pay-card", bookingId: "book-2", source: "STRIPE", xeroRefundCreditNoteId: "some-other-note" },
        { id: "pay-live", bookingId: "book-3", source: "STRIPE", xeroRefundCreditNoteId: null },
        { id: "pay-paid", bookingId: "book-4", source: "STRIPE", xeroRefundCreditNoteId: null },
      ],
    );
    installXero(fake, new Set([deleted!]));
    const result = await run(await report.readActiveRefundNoteLinks(db));

    expect(result.revived).toEqual([
      {
        linkId: "l1", paymentId: "pay-bank", bookingId: "book-1", paymentSource: "INTERNET_BANKING", role: "REFUND_CREDIT_NOTE", refundRequestId: null,
        creditNoteId: voided, creditNoteNumber: "CN-1", appStatus: "AUTHORISED", countedCents: 20_000, pointerNamesNote: true,
        xeroStatus: "VOIDED", xeroUpdatedAt: UPDATED.toISOString(),
      },
      {
        linkId: "l2", paymentId: "pay-card", bookingId: "book-2", paymentSource: "STRIPE", role: "REFUND_REQUEST_CREDIT_NOTE", refundRequestId: "rr-1",
        creditNoteId: deleted, creditNoteNumber: null, appStatus: "AUTHORISED", countedCents: 4_550, pointerNamesNote: false,
        xeroStatus: "DELETED", xeroUpdatedAt: UPDATED.toISOString(),
      },
    ].sort((a, b) => a.creditNoteId!.localeCompare(b.creditNoteId!)));
    expect(result.totals).toEqual({
      count: 2,
      bySource: [
        { paymentSource: "INTERNET_BANKING", count: 1, countedCents: 20_000 },
        { paymentSource: "STRIPE", count: 1, countedCents: 4_550 },
      ],
    });
    expect(result).toMatchObject({ activeLinks: 4, notesToRead: 4, readCount: 4, couldNotRead: [], stopped: null });
    expect(report.isRevivedRefundNoteReportComplete(result)).toBe(true);
  });

  it("reads active links of both refund-note roles only, through the app's own link definition", async () => {
    const fake = new XeroFake();
    const [own, request, inactive, other] = notes(fake, 4);
    const { db, linkFindMany } = reportDb(
      [
        link("l1", "p1", own!),
        link("l2", "p1", request!, { role: "REFUND_REQUEST_CREDIT_NOTE" }),
        link("l3", "p1", inactive!, { active: false }),
        link("l4", "p1", other!, { role: "CREDIT_NOTE_ALLOCATION" }),
      ],
      [{ id: "p1", bookingId: "b1", source: "STRIPE", xeroRefundCreditNoteId: null }],
    );
    const { getCreditNote } = installXero(fake);
    await run(await report.readActiveRefundNoteLinks(db));
    expect(linkFindMany.mock.calls[0]![0].where).toEqual({
      localModel: "Payment", xeroObjectType: "CREDIT_NOTE", role: { in: ["REFUND_CREDIT_NOTE", "REFUND_REQUEST_CREDIT_NOTE"] }, active: true,
    });
    expect(getCreditNote.mock.calls.map((call) => call[1]).sort()).toEqual([own, request].sort());
  });

  it("asks Xero once per note however many links name it, and paces the reads", async () => {
    const fake = new XeroFake();
    const [shared, second] = notes(fake, 2);
    fake.voidCreditNote(shared!);
    const { db } = reportDb(
      [link("l1", "p1", shared!), link("l2", "p2", shared!, { role: "REFUND_REQUEST_CREDIT_NOTE" }), link("l3", "p3", second!)],
      ["p1", "p2", "p3"].map((id) => ({ id, bookingId: `b-${id}`, source: "STRIPE" as const, xeroRefundCreditNoteId: null })),
    );
    const { getCreditNote } = installXero(fake);
    const result = await run(await report.readActiveRefundNoteLinks(db));
    expect(getCreditNote).toHaveBeenCalledTimes(2);
    expect(result.revived.map((row) => row.paymentId)).toEqual(["p1", "p2"]);
    expect(noPause.mock.calls).toEqual([[report.DEFAULT_READ_SPACING_MS]]);
    expect(report.DEFAULT_READ_SPACING_MS).toBeGreaterThan(1_000); // below Xero's 60 a minute
  });

  it("pages a large population and still reads every link", async () => {
    const links = Array.from({ length: 1_203 }, (_, i) => link(`l${String(i).padStart(5, "0")}`, `p${i % 700}`, `n${i}`));
    const payments = Array.from({ length: 700 }, (_, i) => ({ id: `p${i}`, bookingId: `b${i}`, source: "STRIPE" as const, xeroRefundCreditNoteId: null }));
    const { db, linkFindMany, paymentFindMany } = reportDb(links, payments);
    const read = await report.readActiveRefundNoteLinks(db);
    expect(read).toHaveLength(1_203);
    expect(new Set(read.map((l) => l.linkId)).size).toBe(1_203);
    expect(linkFindMany).toHaveBeenCalledTimes(3);
    expect(paymentFindMany).toHaveBeenCalledTimes(2);
    expect(read.every((l) => l.bookingId === `b${l.paymentId.slice(1)}`)).toBe(true);
  });

  it("puts a note Xero cannot find, or cannot be read, on the could-not-read list", async () => {
    const fake = new XeroFake();
    const [found404, failing] = notes(fake, 2);
    const { db } = reportDb(
      [link("l1", "p1", "never-in-xero"), link("l2", "p2", found404!), link("l3", "p3", failing!)],
      ["p1", "p2", "p3"].map((id) => ({ id, bookingId: `b-${id}`, source: "INTERNET_BANKING" as const, xeroRefundCreditNoteId: null })),
    );
    const { failNext } = installXero(fake);
    // Sorted note order: the two fake ids, then "never-in-xero" (an empty answer).
    failNext({ statusCode: 404 });
    failNext({ statusCode: 500, body: { Message: "member@example.invalid" } });
    const result = await run(await report.readActiveRefundNoteLinks(db));
    expect(result.couldNotRead).toEqual([
      { creditNoteId: found404, paymentIds: ["p2"], reason: "not-found", detail: null },
      { creditNoteId: failing, paymentIds: ["p3"], reason: "failed", detail: "Xero answered HTTP 500" },
      { creditNoteId: "never-in-xero", paymentIds: ["p1"], reason: "not-found", detail: null },
    ]);
    expect(result.revived).toEqual([]);
    expect(report.isRevivedRefundNoteReportComplete(result)).toBe(false);
  });

  it("stops after three failed reads in a row, and a good read resets the count", async () => {
    const fake = new XeroFake();
    const ids = notes(fake, 6).sort();
    const { db } = reportDb(
      ids.map((id, i) => link(`l${i}`, `p${i}`, id)),
      ids.map((_, i) => ({ id: `p${i}`, bookingId: `b${i}`, source: "STRIPE" as const, xeroRefundCreditNoteId: null })),
    );
    // fail, read, fail, fail, fail -> stop; the sixth note is never asked.
    const plan = [true, false, true, true, true];
    const result = await report.classifyRevivedRefundNotes(
      await report.readActiveRefundNoteLinks(db),
      async (id) => {
        const fails = plan[ids.indexOf(id)];
        if (fails) throw new Error("Xero answered HTTP 500");
        return { status: "AUTHORISED", number: null, updatedAt: null };
      },
      { sleep: noPause },
    );
    expect(result.couldNotRead.map((n) => n.creditNoteId)).toEqual([ids[0], ids[2], ids[3], ids[4]]);
    expect(result.stopped).toEqual({ reason: "consecutive-failures", detail: "3 reads failed in a row.", notReached: [ids[5]] });
    expect(result.readCount).toBe(1);
  });

  it("three failed live reads in a row end the run through the real reader", async () => {
    const fake = new XeroFake();
    const ids = notes(fake, 4).sort();
    const { db } = reportDb(ids.map((id, i) => link(`l${i}`, `p${i}`, id)), ids.map((_, i) => ({ id: `p${i}`, bookingId: `b${i}`, source: "STRIPE" as const, xeroRefundCreditNoteId: null })));
    const { getCreditNote, failNext } = installXero(fake);
    for (let i = 0; i < 3; i += 1) failNext({ statusCode: 502 });
    const result = await run(await report.readActiveRefundNoteLinks(db));
    expect(getCreditNote).toHaveBeenCalledTimes(3);
    expect(result.stopped).toMatchObject({ reason: "consecutive-failures", notReached: [ids[3]] });
  });
});

describe("#4336 revived refund-note report: Xero limits and the breaker", () => {
  async function oneOfEach(count: number) {
    const fake = new XeroFake();
    const ids = notes(fake, count).sort();
    for (const id of ids) fake.voidCreditNote(id);
    const { db } = reportDb(ids.map((id, i) => link(`l${i}`, `p${i}`, id)), ids.map((_, i) => ({ id: `p${i}`, bookingId: `b${i}`, source: "STRIPE" as const, xeroRefundCreditNoteId: null })));
    return { ids, links: await report.readActiveRefundNoteLinks(db), xero: installXero(fake) };
  }

  it("never arms the app-wide transient breaker, however its reads fail", async () => {
    expect(reader.REVIVED_REPORT_READ_OPTIONS.armTransientBreaker).toBe(false);
    const { links, xero } = await oneOfEach(2);
    xero.failNext({ statusCode: 503 });
    const result = await run(links);
    expect(result.couldNotRead).toHaveLength(1);
    expect(result.revived).toHaveLength(1); // the next read went out
    // The app's own next Xero call is not refused by a cooldown.
    await expect(withXeroRetry(async () => "ok", { maxTransientRetries: 0 })).resolves.toBe("ok");
  });

  it("stops with an outage reason when a breaker armed elsewhere is cooling down", async () => {
    const { links } = await oneOfEach(2);
    await expect(withXeroRetry(async () => { throw Object.assign(new Error("down"), { response: { statusCode: 503 } }); }, { maxTransientRetries: 0 })).rejects.toThrow();
    const result = await run(links);
    expect(result.stopped).toMatchObject({ reason: "outage", notReached: links.map((l) => l.creditNoteId).sort() });
    expect(result.readCount).toBe(0);
  });

  it("waits on a minute rate limit and reads the note", async () => {
    const { links, xero } = await oneOfEach(1);
    xero.failNext({ statusCode: 429, headers: { "retry-after": "0", "x-rate-limit-problem": "minute" } });
    const result = await run(links);
    expect(xero.getCreditNote).toHaveBeenCalledTimes(2);
    expect(result.revived).toHaveLength(1);
    expect(result.stopped).toBeNull();
  });

  it("stops cleanly on Xero's daily limit and keeps what it read", async () => {
    const { ids, links, xero } = await oneOfEach(3);
    // The first note reads; the second hits the daily limit.
    const result = await report.classifyRevivedRefundNotes(links, (() => {
      const live = reader.createXeroCreditNoteReader();
      let calls = 0;
      return async (id: string) => {
        calls += 1;
        if (calls === 2) xero.failNext({ statusCode: 429, headers: { "retry-after": "60", "x-rate-limit-problem": "day" } });
        return live(id);
      };
    })(), { sleep: noPause });
    expect(result.revived.map((r) => r.creditNoteId)).toEqual([ids[0]]);
    expect(result.stopped).toMatchObject({ reason: "daily-limit", notReached: [ids[1], ids[2]] });
  });

  it("stops before any call when the app's share of today's Xero calls is used up", async () => {
    const { links, xero } = await oneOfEach(2);
    usage.budgetAllows.mockResolvedValue(false);
    const result = await run(links);
    expect(xero.getCreditNote).not.toHaveBeenCalled();
    expect(result.stopped).toMatchObject({ reason: "daily-limit" });
  });
});

describe("#4336 revived refund-note report: read-only proof", () => {
  it("runs end to end against a database and a Xero client whose every write throws, and writes only the usage meter", async () => {
    const fake = new XeroFake();
    const [voided, live] = notes(fake, 2);
    fake.voidCreditNote(voided!);
    const { db } = reportDb(
      [link("l1", "p1", voided!), link("l2", "p2", live!, { role: "REFUND_REQUEST_CREDIT_NOTE" })],
      [{ id: "p1", bookingId: "b1", source: "INTERNET_BANKING", xeroRefundCreditNoteId: voided! }, { id: "p2", bookingId: "b2", source: "STRIPE", xeroRefundCreditNoteId: null }],
    );
    installXero(fake);
    const before = fake.snapshot();
    const result = await run(await report.readActiveRefundNoteLinks(db));
    expect(result.revived).toHaveLength(1);
    expect(writesAttempted).toEqual([]);
    expect(fake.snapshot()).toEqual(before);
    // The one row-writer reached: the metered call's usage row, once per read.
    expect(usage.record).toHaveBeenCalledTimes(2);
    expect(usage.record.mock.calls.every(([row]) => row.workflow === reader.REVIVED_REFUND_NOTE_REPORT_WORKFLOW)).toBe(true);
  });

  it("the double really throws on a write (the proof's own control)", async () => {
    const { db } = reportDb([], []);
    expect(() => (db.xeroObjectLink as unknown as { updateMany: () => void }).updateMany()).toThrow("write attempted");
    expect(() => (db.payment as unknown as { update: () => void }).update()).toThrow("write attempted");
  });
});

describe("#4336 revived refund-note report: output", () => {
  const sample: Awaited<ReturnType<typeof report.classifyRevivedRefundNotes>> = {
    activeLinks: 3,
    notesToRead: 3,
    readCount: 2,
    revived: [{
      linkId: "l1", paymentId: "pay-1", bookingId: "book-1", paymentSource: "INTERNET_BANKING", role: "REFUND_REQUEST_CREDIT_NOTE", refundRequestId: "rr-1",
      creditNoteId: "note-1", creditNoteNumber: "CN-0101", appStatus: "AUTHORISED", countedCents: 20_000, pointerNamesNote: false,
      xeroStatus: "VOIDED", xeroUpdatedAt: "2026-06-20T03:00:00.000Z",
    }],
    couldNotRead: [{ creditNoteId: "note-2", paymentIds: ["pay-2"], reason: "failed", detail: "Xero answered HTTP 500" }],
    stopped: { reason: "daily-limit", detail: "Xero's daily limit was reached; run the report again tomorrow.", notReached: ["note-3"] },
    totals: { count: 1, bySource: [{ paymentSource: "INTERNET_BANKING", count: 1, countedCents: 20_000 }] },
  };

  it("prints counts and cents per source, and points to --list", () => {
    expect(report.formatRevivedRefundNoteReport(sample)).toBe([
      "Read-only: this report changed nothing.",
      "Active refund-note links: 3, on 3 credit note(s). Read from Xero: 2.",
      "Xero says VOIDED or DELETED, the app still has the link active: 1",
      "  INTERNET_BANKING: 1 link(s), the app counts 200.00",
      "Could not read: 1 credit note(s)",
      "STOPPED EARLY, the list is incomplete: Xero's daily limit, or the app's share of it, was reached. 1 credit note(s) not read. Xero's daily limit was reached; run the report again tomorrow.",
      "Run again with --list for each payment and note.",
    ].join("\n"));
  });

  it("with --list prints every column of each line and each unread note", () => {
    const text = report.formatRevivedRefundNoteReport(sample, { list: true });
    for (const part of [
      "payment pay-1  booking book-1  source INTERNET_BANKING",
      "role REFUND_REQUEST_CREDIT_NOTE  refund request rr-1",
      "note CN-0101  note-1",
      "Xero VOIDED (updated 2026-06-20T03:00:00.000Z)  app records AUTHORISED  app counts 200.00",
      "Payment.xeroRefundCreditNoteId names it: no",
      "note note-2  read failed (Xero answered HTTP 500)  payment(s) pay-2",
      "not read: note note-3",
    ]) expect(text).toContain(part);
    expect(text).not.toContain("--list");
  });

  it("prints a clean run plainly", () => {
    const clean = { ...sample, revived: [], couldNotRead: [], stopped: null, readCount: 3, totals: { count: 0, bySource: [] } };
    expect(report.formatRevivedRefundNoteReport(clean)).toBe([
      "Read-only: this report changed nothing.",
      "Active refund-note links: 3, on 3 credit note(s). Read from Xero: 3.",
      "Xero says VOIDED or DELETED, the app still has the link active: 0",
      "Could not read: 0 credit note(s)",
    ].join("\n"));
  });

  it("the JSON output carries every field the text does", () => {
    const parsed = JSON.parse(JSON.stringify(sample, null, 2));
    expect(parsed).toEqual(sample);
    expect(Object.keys(parsed.revived[0]).sort()).toEqual([
      "appStatus", "bookingId", "countedCents", "creditNoteId", "creditNoteNumber", "linkId", "paymentId", "paymentSource",
      "pointerNamesNote", "refundRequestId", "role", "xeroStatus", "xeroUpdatedAt",
    ]);
  });
});

describe("#4336 credentials preflight", () => {
  const readable = async () => "readable" as const;
  const config = async () => ({ clientId: "id", clientSecret: "secret" });

  it("refuses when Xero is not connected, when the stored login or client secret cannot be read, and passes otherwise", async () => {
    await expect(reader.assertXeroReadableHere({ tokenReadability: async () => "no_tokens", clientConfig: config })).rejects.toThrow(reader.XERO_NOT_CONNECTED_MESSAGE);
    await expect(reader.assertXeroReadableHere({ tokenReadability: async () => "unreadable", clientConfig: config })).rejects.toThrow(reader.XERO_UNREADABLE_HERE_MESSAGE);
    await expect(reader.assertXeroReadableHere({ tokenReadability: readable, clientConfig: async () => ({ clientId: "id", clientSecret: "" }) })).rejects.toBeInstanceOf(reader.XeroReportPreflightError);
    await expect(reader.assertXeroReadableHere({ tokenReadability: readable, clientConfig: config })).resolves.toBeUndefined();
  });

  it("its messages name no secret value", () => {
    for (const message of [reader.XERO_UNREADABLE_HERE_MESSAGE, reader.XERO_NOT_CONNECTED_MESSAGE]) {
      expect(message).not.toMatch(/=|postgres|secret:/i);
    }
  });
});
