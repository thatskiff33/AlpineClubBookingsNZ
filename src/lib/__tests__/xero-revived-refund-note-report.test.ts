/**
 * #4336: the read-only revived refund-note report, end to end over the
 * stateful Xero fake (`src/test/providers/xero-fake.ts`) through the real
 * reader, `callXeroApi` and `withXeroRetry`. The database is a double whose
 * every write method throws, and so is the Xero client: the report finishing
 * at all is the proof it writes nothing. No live provider or database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import pino from "pino";
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

// The app-wide client the script hands the report. Each test points it at its own double; by default
// it is a double with no reads at all, whose every write throws.
const prismaHolder = vi.hoisted(() => ({ db: null as unknown }));
const usage = vi.hoisted(() => ({ record: vi.fn<(row: { workflow?: string }) => Promise<undefined>>(async () => undefined), budgetAllows: vi.fn(async () => true) }));
// The app-wide client: nothing here may read or write it. The report's own reads go through an injected double.
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : Reflect.get(prismaHolder.db as object, key)) }),
}));
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
const { formatRevivedRefundNoteReport } = await import("@/lib/xero-revived-refund-note-format");
const cli = await import("@/lib/xero-revived-refund-note-cli");
const { prisma } = await import("@/lib/prisma");
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
  // Any refund-note link, active or not, naming a note: the resume cursor's "was it ever ours?" check.
  const linkFindFirst = vi.fn(async (args: { where: { role: { in: string[] }; xeroObjectId: string } }) => {
    const found = links.find((l) => l.localModel === "Payment" && l.xeroObjectType === "CREDIT_NOTE" && args.where.role.in.includes(l.role) && l.xeroObjectId === args.where.xeroObjectId);
    return found ? { id: found.id } : null;
  });
  const db = writeThrowingDb({ xeroObjectLink: { findMany: linkFindMany, findFirst: linkFindFirst }, payment: { findMany: paymentFindMany } });
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
  prismaHolder.db = writeThrowingDb({});
  usage.record.mockClear();
  usage.budgetAllows.mockReset().mockResolvedValue(true);
  noPause.mockClear();
});
afterEach(() => {
  resetXeroClientForTests();
  resetXeroRateLimitStateForTests();
  // EVERY test is a read-only proof: no write reached the database double or the Xero client.
  expect(writesAttempted).toEqual([]);
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
        creditNoteId: voided, creditNoteNumber: "CN-1", appStatus: "AUTHORISED", countedCents: 20_000, requestNoteCents: null, pointerNamesNote: true,
        xeroStatus: "VOIDED", xeroUpdatedAt: UPDATED.toISOString(),
      },
      {
        linkId: "l2", paymentId: "pay-card", bookingId: "book-2", paymentSource: "STRIPE", role: "REFUND_REQUEST_CREDIT_NOTE", refundRequestId: "rr-1",
        creditNoteId: deleted, creditNoteNumber: null, appStatus: "AUTHORISED", countedCents: null, requestNoteCents: 4_550, pointerNamesNote: false,
        xeroStatus: "DELETED", xeroUpdatedAt: UPDATED.toISOString(),
      },
    ].sort((a, b) => a.creditNoteId!.localeCompare(b.creditNoteId!)));
    expect(result.totals).toEqual({
      scope: "whole-population",
      count: 2,
      bySource: [
        { paymentSource: "INTERNET_BANKING", count: 1, countedCents: 20_000, requestNoteCents: 0 },
        // A refund request's own note: shown by its value, never as cents the app counts.
        { paymentSource: "STRIPE", count: 1, countedCents: 0, requestNoteCents: 4_550 },
      ],
    });
    expect(result).toMatchObject({
      complete: true, walkFinished: true, resumeFrom: null, noProgress: false, activeLinks: 4, readCount: 4, couldNotRead: [], alreadyRecordedCancelled: [], stopped: null,
      scope: { resumedFrom: null, notesInPopulation: 4, notesInThisRun: 4 },
    });
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
    expect(result.complete).toBe(false);
    expect(result.stopped).toBeNull();
    // Only the failed read is left to retry; a definite "no such note" is an answer.
    expect(result.resumeFrom).toBe(failing);
    // Not stopped, still incomplete: the text says so, not only the exit code.
    expect(formatRevivedRefundNoteReport(result)).toContain("THE LIST IS INCOMPLETE");
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
    // The resume id is the earliest note not read, so the next part retries the failures.
    expect(result.resumeFrom).toBe(ids[0]);
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

  it("a pause armed earlier in the same process fails reads like any other failure (the pause is per process)", async () => {
    const { links } = await oneOfEach(2);
    await expect(withXeroRetry(async () => { throw Object.assign(new Error("down"), { response: { statusCode: 503 } }); }, { maxTransientRetries: 0 })).rejects.toThrow();
    const result = await run(links);
    expect(result.couldNotRead.map((n) => n.detail)).toEqual(["no answer from Xero", "no answer from Xero"]);
    expect(result).toMatchObject({ stopped: null, readCount: 0, complete: false });
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
    expect(result.resumeFrom).toBe(ids[1]);
  });

  it("stops before any call when the app's share of today's Xero calls is used up", async () => {
    const { links, xero } = await oneOfEach(2);
    usage.budgetAllows.mockResolvedValue(false);
    const result = await run(links);
    expect(xero.getCreditNote).not.toHaveBeenCalled();
    expect(result.stopped).toMatchObject({ reason: "daily-limit" });
  });

  it("a budget check that throws fails the note through the same safe description", async () => {
    const { links } = await oneOfEach(1);
    usage.budgetAllows.mockRejectedValue(new Error("connect ECONNREFUSED postgres://user:pw@db"));
    const result = await run(links);
    expect(result.couldNotRead).toEqual([expect.objectContaining({ reason: "failed", detail: "no answer from Xero" })]);
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
    expect(fake.snapshot()).toEqual(before);
    // The one row-writer reached: the metered call's usage row, once per read.
    expect(usage.record).toHaveBeenCalledTimes(2);
    expect(usage.record.mock.calls.every(([row]) => row.workflow === reader.REVIVED_REFUND_NOTE_REPORT_WORKFLOW)).toBe(true);
  });

  it("the double really throws on a write (the proof's own control)", async () => {
    const { db } = reportDb([], []);
    expect(() => (db.xeroObjectLink as unknown as { updateMany: () => void }).updateMany()).toThrow("write attempted");
    expect(() => (db.payment as unknown as { update: () => void }).update()).toThrow("write attempted");
    expect(writesAttempted).toEqual(["xeroObjectLink.updateMany", "payment.update"]);
    writesAttempted.length = 0; // the control's own writes, so the afterEach proof stays meaningful
  });
});

describe("#4336 revived refund-note report: the app already records the void", () => {
  it("puts a link the app already records VOIDED in its own bucket, outside the list and its totals", async () => {
    const fake = new XeroFake();
    const [healed, revived] = notes(fake, 2);
    fake.voidCreditNote(healed!);
    fake.voidCreditNote(revived!);
    const { db } = reportDb(
      [link("l1", "p1", healed!, { metadata: { status: "VOIDED", total: 200 } }), link("l2", "p2", revived!)],
      [{ id: "p1", bookingId: "b1", source: "INTERNET_BANKING", xeroRefundCreditNoteId: null }, { id: "p2", bookingId: "b2", source: "INTERNET_BANKING", xeroRefundCreditNoteId: null }],
    );
    installXero(fake);
    const result = await run(await report.readActiveRefundNoteLinks(db));
    expect(result.alreadyRecordedCancelled.map((r) => r.linkId)).toEqual(["l1"]);
    expect(result.revived.map((r) => r.linkId)).toEqual(["l2"]);
    expect(result.totals).toEqual({ scope: "whole-population", count: 1, bySource: [{ paymentSource: "INTERNET_BANKING", count: 1, countedCents: 20_000, requestNoteCents: 0 }] });
    expect(result.complete).toBe(true);
  });
});

describe("#4336 revived refund-note report: the command line", () => {
  /** The script's own wiring: the shared `prisma` import, the live reader, and captured stdout and stderr. */
  function cliRun(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = cli.runRevivedRefundNoteReportCli(argv, {
      db: prisma as unknown as Parameters<typeof report.readActiveRefundNoteLinks>[0],
      preflight: async () => undefined,
      reader: () => reader.createXeroCreditNoteReader(),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      sleep: noPause,
    });
    return code.then((exit) => ({ exit, out: out.join("\n"), err: err.join("\n") }));
  }

  function population(count: number, voidedEvery = 2) {
    const fake = new XeroFake();
    const ids = notes(fake, count).sort();
    ids.forEach((id, i) => { if (i % voidedEvery === 0) fake.voidCreditNote(id); });
    const fixture = reportDb(
      ids.map((id, i) => link(`l${i}`, `p${i}`, id)),
      ids.map((_, i) => ({ id: `p${i}`, bookingId: `b${i}`, source: "INTERNET_BANKING" as const, xeroRefundCreditNoteId: null })),
    );
    prismaHolder.db = fixture.db;
    return { ids, xero: installXero(fake) };
  }

  it("--json prints only the report as JSON on stdout, even when a rate-limit retry is logged", async () => {
    const { ids, xero } = population(3);
    xero.failNext({ statusCode: 429, headers: { "retry-after": "0", "x-rate-limit-problem": "minute" } });
    const { exit, out } = await cliRun(["--json"]);
    const parsed = JSON.parse(out);
    expect(exit).toBe(0);
    expect(parsed).toMatchObject({ complete: true, readCount: 3, stopped: null, totals: { count: 2 } });
    expect(parsed.revived.map((r: { creditNoteId: string }) => r.creditNoteId)).toEqual([ids[0], ids[2]]);
    expect(Object.keys(parsed.revived[0]).sort()).toEqual([
      "appStatus", "bookingId", "countedCents", "creditNoteId", "creditNoteNumber", "linkId", "paymentId", "paymentSource",
      "pointerNamesNote", "refundRequestId", "requestNoteCents", "role", "xeroStatus", "xeroUpdatedAt",
    ]);
  });

  it("the script sends logs to stderr before it does any work", () => {
    const logger = pino();
    cli.sendLogsToStderr(logger);
    expect(((logger as unknown as Record<symbol, { fd: number }>)[pino.symbols.streamSym]).fd).toBe(2);
    const source = readFileSync(path.join(process.cwd(), "scripts/xero-revived-refund-note-report.ts"), "utf8");
    expect(source.indexOf("sendLogsToStderr(logger);")).toBeGreaterThan(0);
    expect(source.indexOf("sendLogsToStderr(logger);")).toBeLessThan(source.indexOf("runRevivedRefundNoteReportCli(process.argv"));
  });

  it("prints the list first and the totals last, and a clean run exits 0", async () => {
    population(2);
    const { exit, out } = await cliRun(["--list"]);
    expect(exit).toBe(0);
    const lines = out.split("\n");
    expect(lines.findIndex((l) => l.includes("payment p0"))).toBeLessThan(lines.findIndex((l) => l.startsWith("Total:")));
    expect(lines.at(-1)).toBe("  INTERNET_BANKING: 1 link(s); the app counts 200.00");
    expect(out).not.toContain("INCOMPLETE");
  });

  it("a population larger than one day's share completes across two runs, no note read twice and none skipped", async () => {
    const { ids, xero } = population(7);
    let allowed = 4; // today's share
    usage.budgetAllows.mockImplementation(async () => allowed-- > 0);
    const first = await cliRun(["--json"]);
    const day1 = JSON.parse(first.out);
    expect(first.exit).toBe(2);
    expect(day1).toMatchObject({ complete: false, walkFinished: false, readCount: 4, resumeFrom: ids[4], stopped: { reason: "daily-limit" } });

    allowed = 100; // the next day
    const second = await cliRun(["--json", "--resume-from", day1.resumeFrom]);
    const day2 = JSON.parse(second.out);
    expect(second.exit).toBe(0);
    // A resumed run never claims the whole population; it says the walk is finished.
    expect(day2).toMatchObject({
      complete: false, walkFinished: true, resumeFrom: null, noProgress: false, readCount: 3, totals: { scope: "this-run-only" },
      scope: { resumedFrom: ids[4], startedFrom: ids[4], coversWholePopulation: false, notesInPopulation: 7, notesInThisRun: 3 },
    });

    const asked = xero.getCreditNote.mock.calls.map((call) => call[1]);
    expect(asked).toEqual(ids); // each once, in order, none skipped
    const listed = [...day1.revived, ...day2.revived].map((r: { creditNoteId: string }) => r.creditNoteId);
    expect(listed).toEqual(ids.filter((_, i) => i % 2 === 0));
  });

  it("labels a resumed run's totals as covering only that run, and prints the resume id when it stops", async () => {
    const { ids } = population(4);
    usage.budgetAllows.mockImplementation(async () => true);
    const resumed = await cliRun(["--resume-from", ids[2]!]);
    expect(resumed.exit).toBe(0);
    expect(resumed.out).toContain(`Resumed from note ${ids[2]}. This run covers 2 of the 4 credit notes; the notes before it were covered by earlier runs. Everything below, totals included, is THIS RUN ONLY.`);
    expect(resumed.out).toContain(`This was the last part: every note from ${ids[2]} to the end was read; the notes before it were covered by earlier runs.`);
    expect(resumed.out).toContain("Total, THIS RUN ONLY:");
    expect(resumed.out).not.toContain("INCOMPLETE");
    let allowed = 1;
    usage.budgetAllows.mockImplementation(async () => allowed-- > 0);
    const stopped = await cliRun([]);
    expect(stopped.exit).toBe(2);
    expect(stopped.out).toContain(`To carry on, run again with --resume-from ${ids[1]}`);
    expect(stopped.out).toContain("THE LIST IS INCOMPLETE");
  });

  it("refuses a resume cursor that was never a refund note on any link, before reading Xero", async () => {
    const { xero } = population(3);
    for (const cursor of ["no-such-note", "zzzz-after-every-note"]) {
      const { exit, err, out } = await cliRun(["--resume-from", cursor]);
      expect(exit).toBe(1);
      expect(err).toContain("--resume-from names no credit note on any refund-note link");
      expect(out).toBe("");
    }
    expect(xero.getCreditNote).not.toHaveBeenCalled();
  });

  it("a cursor whose note has left the active set starts at the next note after it, and says so", async () => {
    const fake = new XeroFake();
    const ids = notes(fake, 4).sort();
    prismaHolder.db = reportDb(
      ids.map((id, i) => link(`l${i}`, `p${i}`, id, { active: i !== 1 })), // ids[1] was handled since
      ids.map((_, i) => ({ id: `p${i}`, bookingId: `b${i}`, source: "STRIPE" as const, xeroRefundCreditNoteId: null })),
    ).db;
    const xero = installXero(fake);
    const { exit, out } = await cliRun(["--json", "--resume-from", ids[1]!]);
    expect(exit).toBe(0);
    expect(JSON.parse(out).scope).toEqual({ resumedFrom: ids[1], startedFrom: ids[2], coversWholePopulation: false, notesInPopulation: 3, notesInThisRun: 2 });
    expect(xero.getCreditNote.mock.calls.map((call) => call[1])).toEqual([ids[2], ids[3]]);
    const text = await cliRun(["--resume-from", ids[1]!]);
    expect(text.out).toContain(`Resumed from note ${ids[1]}, which is no longer on an active link, so this run started at ${ids[2]}, the next note after it.`);
  });

  /** Fail the reads whose 1-based call numbers are listed, by queueing a 500 just before each. */
  function failCalls(xero: ReturnType<typeof installXero>, calls: number[]) {
    let call = 0;
    usage.budgetAllows.mockImplementation(async () => {
      call += 1;
      if (calls.includes(call)) xero.failNext({ statusCode: 500 });
      return true;
    });
  }

  it("a to f, with b, c and d failing in run 1: the resume id retries them, and every note is read once successfully", async () => {
    const { ids, xero } = population(6, 1);
    failCalls(xero, [2, 3, 4]);
    const first = JSON.parse((await cliRun(["--json"])).out);
    expect(first).toMatchObject({ complete: false, walkFinished: false, resumeFrom: ids[1], stopped: { reason: "consecutive-failures", notReached: [ids[4], ids[5]] } });
    expect(first.couldNotRead.map((n: { creditNoteId: string }) => n.creditNoteId)).toEqual([ids[1], ids[2], ids[3]]);

    failCalls(xero, []);
    const second = await cliRun(["--json", "--resume-from", first.resumeFrom]);
    const run2 = JSON.parse(second.out);
    expect(second.exit).toBe(0);
    expect(run2).toMatchObject({ walkFinished: true, complete: false, couldNotRead: [], scope: { resumedFrom: ids[1], notesInThisRun: 5 } });
    const succeeded = [...first.revived, ...run2.revived].map((r: { creditNoteId: string }) => r.creditNoteId);
    expect(succeeded).toEqual(ids); // all six, each once
    expect(xero.getCreditNote.mock.calls.map((call) => call[1])).toEqual([...ids.slice(0, 4), ...ids.slice(1)]);
  });

  it("the three-in-a-row stop still fires on a resume, and a resume that makes no progress says so", async () => {
    const { ids, xero } = population(5, 1);
    failCalls(xero, [1, 2, 3]);
    const { exit, out } = await cliRun(["--resume-from", ids[1]!]);
    expect(exit).toBe(2);
    expect(out).toContain("three reads failed in a row");
    // No progress: the output names the stuck note and must NOT also tell the
    // operator to run again with the same id, which would loop for ever.
    expect(out).toContain("THE LIST IS INCOMPLETE");
    expect(out).not.toContain("To carry on, run again with --resume-from");
    expect(out).toContain(`NO PROGRESS: note ${ids[1]} was not read again.`);
    expect(out).toContain("do not re-run with the same id");
    const json = JSON.parse((failCalls(xero, [1, 2, 3]), await cliRun(["--json", "--resume-from", ids[1]!])).out);
    expect(json).toMatchObject({ noProgress: true, resumeFrom: ids[1] });
  });

  it("a note Xero says does not exist, before the cursor, is not retried", async () => {
    const { ids, xero } = population(4, 1);
    let call = 0;
    usage.budgetAllows.mockImplementation(async () => {
      call += 1;
      if (call === 1) xero.failNext({ statusCode: 404 });
      return call <= 2;
    });
    const first = JSON.parse((await cliRun(["--json"])).out);
    expect(first.couldNotRead).toEqual([expect.objectContaining({ creditNoteId: ids[0], reason: "not-found" })]);
    expect(first.resumeFrom).toBe(ids[2]); // past the 404, at the first note not reached
    usage.budgetAllows.mockImplementation(async () => true);
    const second = JSON.parse((await cliRun(["--json", "--resume-from", first.resumeFrom])).out);
    expect(second).toMatchObject({ walkFinished: true, scope: { notesInThisRun: 2 } });
    expect(xero.getCreditNote.mock.calls.filter((c) => c[1] === ids[0])).toHaveLength(1);
  });

  it("refuses a missing, repeated or unknown argument, and prints help", async () => {
    population(1);
    expect((await cliRun(["--resume-from"])).exit).toBe(1);
    expect((await cliRun(["--resume-from", "--json"])).err).toContain("needs the credit note id");
    expect((await cliRun(["--resume-from", "a", "--resume-from", "b"])).err).toContain("may be given once");
    expect((await cliRun(["--bogus"])).err).toContain("Unknown argument: --bogus");
    const help = await cliRun(["--help"]);
    expect(help).toMatchObject({ exit: 0, out: cli.REVIVED_REPORT_USAGE });
  });

  it("text output: request-note cents are shown apart from the cents the app counts", async () => {
    const fake = new XeroFake();
    const [own, request] = notes(fake, 2);
    fake.voidCreditNote(own!);
    fake.voidCreditNote(request!);
    prismaHolder.db = reportDb(
      [link("l1", "p1", own!), link("l2", "p1", request!, { role: "REFUND_REQUEST_CREDIT_NOTE", metadata: { status: "AUTHORISED", total: 45.5, refundRequestId: "rr-1" } })],
      [{ id: "p1", bookingId: "b1", source: "STRIPE", xeroRefundCreditNoteId: own! }],
    ).db;
    installXero(fake);
    const { out } = await cliRun(["--list"]);
    for (const part of [
      "payment p1  booking b1  source STRIPE",
      "role REFUND_REQUEST_CREDIT_NOTE  refund request rr-1",
      "note value 45.50 (a refund request's own note: not in the refunded total)",
      "app counts 200.00",
      "Payment.xeroRefundCreditNoteId names it: yes",
      "  STRIPE: 2 link(s); the app counts 200.00; refund requests' own notes 45.50 (not part of the refunded total)",
    ]) expect(out).toContain(part);
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
