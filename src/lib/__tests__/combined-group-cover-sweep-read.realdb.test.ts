/**
 * #4525 (ALP-437): the cover-release sweep's own read, `readVoidedUnreleasedPage`,
 * against real PostgreSQL. Its unit test mocks `$queryRaw`, so nothing there
 * proves the statement's JSONB containment, its join on the VOID's key, its
 * NOT EXISTS on the release, or its row-value cursor. This file runs the exact
 * statement on the fully migrated race database.
 *
 * The fixture is a SUCCEEDED VOID with each ended flag, interleaved in time with
 * every VOID the read must never return: one still bound (no ended flag), one
 * on an invoice carrying money, one still RUNNING, one whose manifest is already
 * released, and a live invoice with no VOID at all. Owed VOIDs are dated in
 * 2000 so they sort before any row another suite leaves behind, and pairs of
 * them share a timestamp, one pair across the page boundary, so the
 * `(createdAt, id)` cursor is what splits them.
 *
 * Ordinary Vitest runs skip the file. It owns `sweep-4525-` fixtures and
 * removes them, manifests included (`releaseBookingFinancialHistoryForTeardown`).
 */
import type { MemberMoneyExportCoverageReleaseReason } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { releaseBookingFinancialHistoryForTeardown } from "./support/booking-financial-history-teardown";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "sweep-4525";
const MEMBER_ID = `${PREFIX}-organiser`;
const LODGE_ID = `${PREFIX}-lodge`;
const GROUPS = [1, 2, 3].map((n) => ({
  bookingId: `${PREFIX}-booking-${n}`,
  groupId: `${PREFIX}-group-${n}`,
  settlementId: `${PREFIX}-settlement-${n}`,
  joinCode: `SWEEP4525${n}`,
}));
const SETTLEMENT_IDS = GROUPS.map((group) => group.settlementId);
const BOOKING_IDS = GROUPS.map((group) => group.bookingId);

/** More than one page of owed VOIDs, so the read pages once and stops part-way through the second. */
const OWED_COUNT = 130;
/** Every owed VOID is older than any row a suite writes today. */
const EPOCH = Date.UTC(2000, 0, 1);
const ENDED_FLAGS = ["cancelledAfterInvoiceCreation", "abandonedBySettlement", "invoiceAlreadyVoid", "invoiceNotFoundInXero"] as const;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let readVoidedUnreleasedPage: (typeof import("@/lib/member-money/internal/combined-group-invoice-manifest"))["readVoidedUnreleasedPage"];
let COMBINED_COVER_SWEEP_PAGE_SIZE: number;
let groupSettlementInvoiceVoidKey: (typeof import("@/lib/xero-group-settlement-invoice-outbox"))["groupSettlementInvoiceVoidKey"];
let groupSettlementInvoiceCreateKey: (typeof import("@/lib/xero-group-settlement-invoice-outbox"))["groupSettlementInvoiceCreateKey"];

interface Invoice {
  settlementId: string;
  invoiceId: string;
  attempt: number;
  release?: MemberMoneyExportCoverageReleaseReason;
}
interface Void {
  id: string;
  createdAt: Date;
  invoice: Invoice;
  path: "cancel" | "abandon";
  status: "SUCCEEDED" | "RUNNING";
  responsePayload: Record<string, unknown> | null;
}

/** Fixed width, so no invoice id is a substring of another (the read joins on `strpos`). */
const invoiceId = (n: number) => `${PREFIX}-invoice-${String(n).padStart(4, "0")}`;
const at = (seconds: number) => new Date(EPOCH + seconds * 1000);

/** Every manifest the suite writes, and the VOIDs on them. */
function fixture() {
  const invoices: Invoice[] = [];
  const voids: Void[] = [];
  const invoice = (n: number, release?: MemberMoneyExportCoverageReleaseReason): Invoice => {
    const settlementId = SETTLEMENT_IDS[n % SETTLEMENT_IDS.length]!;
    const row = { settlementId, invoiceId: invoiceId(n), attempt: n, release };
    invoices.push(row);
    return row;
  };
  const owed: Void[] = [];
  for (let n = 0; n < OWED_COUNT; n += 1) {
    const flag = ENDED_FLAGS[n % ENDED_FLAGS.length]!;
    // Pairs share a second: (0), (1, 2), (3, 4) … so 99 and 100 sit either side of the first page's end.
    const row: Void = {
      id: `${PREFIX}-void-${String(n).padStart(4, "0")}`,
      createdAt: at(Math.floor((n + 1) / 2) * 10),
      invoice: invoice(n),
      path: flag === "cancelledAfterInvoiceCreation" ? "cancel" : "abandon",
      status: "SUCCEEDED",
      responsePayload: { [flag]: true, voidInvoice: null },
    };
    owed.push(row);
    voids.push(row);
  }
  // Each VOID the read must never return, dated among the owed ones on both pages.
  const never = (n: number, seconds: number, status: Void["status"], responsePayload: Void["responsePayload"], release?: MemberMoneyExportCoverageReleaseReason) =>
    voids.push({ id: `${PREFIX}-void-${n}`, createdAt: at(seconds), invoice: invoice(n, release), path: "abandon", status, responsePayload });
  never(9001, 5, "SUCCEEDED", { skippedInvoiceStillLinkedToSettlement: true });
  never(9002, 495, "SUCCEEDED", { invoiceNotVoidedCarriesMoney: true, invoiceState: { kind: "has_money", status: "PAID" } });
  // Its payload already says ended: only its status keeps it out.
  never(9003, 505, "RUNNING", { abandonedBySettlement: true });
  never(9004, 600, "SUCCEEDED", { invoiceAlreadyVoid: true, invoiceStatus: "VOIDED" }, "VOIDED");
  never(9005, 15, "SUCCEEDED", { invoiceNotFoundInXero: true }, "NOT_FOUND");
  // A live invoice: a manifest and its CREATE, and no VOID.
  const live = invoice(9006);
  return { invoices, voids, owed, live };
}

async function deleteFixtures() {
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: SETTLEMENT_IDS } } });
  await releaseBookingFinancialHistoryForTeardown(prisma, BOOKING_IDS);
  await prisma.groupBookingSettlement.deleteMany({ where: { id: { in: SETTLEMENT_IDS } } });
  await prisma.groupBooking.deleteMany({ where: { id: { in: GROUPS.map((group) => group.groupId) } } });
  await prisma.booking.deleteMany({ where: { id: { in: BOOKING_IDS } } });
  await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
  await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
}

async function seed({ invoices, voids, live }: ReturnType<typeof fixture>) {
  await prisma.member.create({
    data: { id: MEMBER_ID, email: `${PREFIX}@example.test`, passwordHash: "x", firstName: "Sweep", lastName: "Organiser" },
  });
  await prisma.lodge.create({ data: { id: LODGE_ID, name: "Sweep 4525 Lodge", slug: PREFIX } });
  for (const group of GROUPS) {
    await prisma.booking.create({
      data: {
        id: group.bookingId,
        memberId: MEMBER_ID,
        lodgeId: LODGE_ID,
        checkIn: new Date("2027-08-01T00:00:00.000Z"),
        checkOut: new Date("2027-08-03T00:00:00.000Z"),
        totalPriceCents: 9000,
        finalPriceCents: 9000,
      },
    });
    await prisma.groupBooking.create({
      data: { id: group.groupId, organiserBookingId: group.bookingId, organiserMemberId: MEMBER_ID, joinCode: group.joinCode, paymentMode: "ORGANISER_PAYS" },
    });
    await prisma.groupBookingSettlement.create({ data: { id: group.settlementId, groupBookingId: group.groupId, amountCents: 9000 } });
  }
  const bookingOf = new Map(GROUPS.map((group) => [group.settlementId, group.bookingId]));
  const manifestId = (row: Invoice) => `${PREFIX}-manifest-${row.attempt}`;
  // One transaction: each COVERED manifest's coverage must add up to its total at commit.
  await prisma.$transaction([
    prisma.memberMoneyExportManifest.createMany({
      data: invoices.map((row) => ({
        id: manifestId(row),
        documentRole: "COMBINED_GROUP_INVOICE" as const,
        legacyKey: groupSettlementInvoiceCreateKey(row.settlementId, row.attempt),
        renderRevision: 1,
        bookingId: bookingOf.get(row.settlementId)!,
        settlementId: row.settlementId,
        outcome: "COVERED" as const,
        payloadHash: "d".repeat(64),
        frozenMapping: { source: "BUILT" },
        lineTotalCents: 9000,
        providerInvoiceId: row.invoiceId,
      })),
    }),
    prisma.memberMoneyExportCoverage.createMany({
      data: invoices.map((row) => ({
        manifestId: manifestId(row),
        documentRole: "COMBINED_GROUP_INVOICE" as const,
        account: "BOOKING_REVENUE" as const,
        chargeIdentity: `booking:${PREFIX}-child-${row.attempt}:charge`,
        coveredCents: 9000,
      })),
    }),
  ]);
  await prisma.memberMoneyExportCoverageRelease.createMany({
    data: invoices.filter((row) => row.release).map((row) => ({ manifestId: manifestId(row), reason: row.release! })),
  });
  const operation = (row: { settlementId: string; key: string; operationType: string; status: string; createdAt: Date; responsePayload: object | null }) => ({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: row.operationType,
    localModel: "GroupBookingSettlement",
    localId: row.settlementId,
    status: row.status,
    correlationKey: row.key,
    idempotencyKey: row.key,
    queueType: "GROUP_SETTLEMENT_INVOICE",
    responsePayload: row.responsePayload ?? undefined,
    createdAt: row.createdAt,
  });
  await prisma.xeroSyncOperation.createMany({
    data: [
      ...voids.map((row) => ({
        id: row.id,
        ...operation({
          settlementId: row.invoice.settlementId,
          key: groupSettlementInvoiceVoidKey(row.invoice.settlementId, row.invoice.invoiceId, row.path),
          operationType: "UPDATE",
          status: row.status,
          createdAt: row.createdAt,
          responsePayload: row.responsePayload,
        }),
      })),
      operation({
        settlementId: live.settlementId,
        key: groupSettlementInvoiceCreateKey(live.settlementId, live.attempt),
        operationType: "CREATE",
        status: "SUCCEEDED",
        createdAt: at(20),
        responsePayload: { invoiceId: live.invoiceId },
      }),
    ],
  });
}

const asRow = (row: Void) => ({ id: row.id, createdAt: row.createdAt, settlementId: row.invoice.settlementId, invoiceId: row.invoice.invoiceId });
const ours = <T extends { settlementId: string }>(rows: T[]) => rows.filter((row) => SETTLEMENT_IDS.includes(row.settlementId));

(RUN ? describe : describe.skip)("the cover-release sweep's read against real PostgreSQL (#4525, ALP-437)", () => {
  const data = fixture();

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Combined cover sweep read");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    ({ readVoidedUnreleasedPage, COMBINED_COVER_SWEEP_PAGE_SIZE } = await import("@/lib/member-money/internal/combined-group-invoice-manifest"));
    ({ groupSettlementInvoiceVoidKey, groupSettlementInvoiceCreateKey } = await import("@/lib/xero-group-settlement-invoice-outbox"));
    await deleteFixtures();
    await seed(data);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await deleteFixtures();
    await prisma.$disconnect();
  }, 60_000);

  it("returns exactly the VOIDs still owed a release, oldest first, a full page then the rest after the cursor", async () => {
    expect(OWED_COUNT).toBeGreaterThan(COMBINED_COVER_SWEEP_PAGE_SIZE);
    expect(OWED_COUNT).toBeLessThan(2 * COMBINED_COVER_SWEEP_PAGE_SIZE);
    const expected = data.owed.map(asRow);

    const first = await readVoidedUnreleasedPage(null);
    // Every owed fixture predates any other suite's row, so the first page is ours alone.
    expect(first).toEqual(expected.slice(0, COMBINED_COVER_SWEEP_PAGE_SIZE));
    // The page ends inside a pair sharing one timestamp: the id breaks the tie.
    const last = first[first.length - 1]!;
    expect(expected[COMBINED_COVER_SWEEP_PAGE_SIZE]!.createdAt).toEqual(last.createdAt);

    const second = await readVoidedUnreleasedPage({ createdAt: last.createdAt, id: last.id });
    expect(ours(second)).toEqual(expected.slice(COMBINED_COVER_SWEEP_PAGE_SIZE));
    expect(second.slice(0, OWED_COUNT - COMBINED_COVER_SWEEP_PAGE_SIZE)).toEqual(expected.slice(COMBINED_COVER_SWEEP_PAGE_SIZE));
  });

  it("never returns a still-bound, money-carrying, running or released VOID, or a live invoice", async () => {
    // Page as the sweep does, until a short page.
    const read: Awaited<ReturnType<typeof readVoidedUnreleasedPage>> = [];
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page = await readVoidedUnreleasedPage(cursor);
      read.push(...page);
      if (page.length < COMBINED_COVER_SWEEP_PAGE_SIZE) break;
      cursor = { createdAt: page[page.length - 1]!.createdAt, id: page[page.length - 1]!.id };
    }
    const invoices = new Set(ours(read).map((row) => row.invoiceId));
    for (const n of [9001, 9002, 9003, 9004, 9005, 9006]) expect(invoices.has(invoiceId(n))).toBe(false);
    expect(invoices.size).toBe(OWED_COUNT);
  });
});
