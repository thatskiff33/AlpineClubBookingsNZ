/**
 * Ledger M3b (#4627) against real PostgreSQL: the booking doors post their
 * legacy lines into the member-money journal, once, in the same transaction.
 *
 * Bookings are made and confirmed by the real writers the back-post proof uses
 * (`booking-ledger-history.ts`: the card settle, the edit chokepoint), then
 * cancelled through the cancellation chokepoint under `lock(1)` as every cancel
 * path is. Member merge is the real `executeMemberMerge`. The judge is the
 * database's own deferred checks at each commit, and then the census's JOURNAL
 * comparison over what was posted.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own namespaced rows,
 * releasing the immutable journal rows through the teardown support.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanHistories,
  createHistoryBooking,
  historyNames,
  postHistoryEdit,
  seedHistoryFixtures,
  settleHistoryByCard,
} from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-4627-";
const names = historyNames(PREFIX);
const LOSER = `${PREFIX}loser`;
const MASTER = `${PREFIX}master`;
/** Member merge is a Full Admin's (`actorIsFullAdmin`). */
const ADMIN = `${PREFIX}admin`;
const ORGANISATION = `${PREFIX}school`;
/** The context a door resolves before its transaction; the chokepoints this suite drives take it as a value. */
const JOURNAL = memberMoneyTestContext();
/** Two guests, two nights each, at 50.00: what `createHistoryBooking` makes. */
const PRICE = 20_000;

let prisma: PrismaClient;
let confirmationSync: typeof import("@/lib/booking-ledger-confirmation-sync");
let cancellationSync: typeof import("@/lib/booking-ledger-cancellation-sync");
let doors: typeof import("@/lib/member-money/doors");
let census: typeof import("@/lib/booking-ledger-projection-census-store");
let merge: typeof import("@/lib/member-merge");
let lodgeLock: typeof import("@/lib/lodge-capacity-lock");
let sequence = 0;

async function newBooking(owner: { memberId?: string; organisationId?: string } = {}): Promise<string> {
  const id = `${PREFIX}b${++sequence}`;
  await createHistoryBooking(prisma, names, id, { payment: { amountCents: PRICE, source: "STRIPE", intent: `pi_${id}` } });
  if (owner.memberId || owner.organisationId) {
    await prisma.booking.update({ where: { id }, data: { memberId: owner.memberId ?? null, organisationId: owner.organisationId ?? null } });
  }
  return id;
}

/** A settle as the settle body runs one: lock(1), the lodge key, a status-guarded PAID claim, then the confirmation poster. */
async function settleDoor(bookingId: string, hold?: { posted: () => void; release: Promise<void> }): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lodgeLock.acquireLodgeCapacityLock(tx, names.lodgeId);
    const claimed = await tx.booking.updateMany({ where: { id: bookingId, status: "PAYMENT_PENDING" }, data: { status: "PAID" } });
    if (claimed.count === 0) return false;
    await confirmationSync.postStoredBookingConfirmationLedgerLines(tx, bookingId, JOURNAL);
    if (hold) {
      hold.posted();
      await hold.release;
    }
    return true;
  }, { maxWait: 30_000, timeout: 60_000 });
}

/** A cancel as every cancel path runs one: lock(1), a status-guarded claim, then the cancellation poster. */
async function cancelDoor(bookingId: string, keptCents = 0): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const claimed = await tx.booking.updateMany({ where: { id: bookingId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED" } });
    if (claimed.count === 0) return false;
    await cancellationSync.postCancellationLedgerLines({
      store: tx, journal: JOURNAL, bookingId, lodgeId: names.lodgeId, keptCents, site: "race-4627",
    });
    return true;
  }, { maxWait: 30_000, timeout: 60_000 });
}

async function journalEvents(bookingId: string) {
  return prisma.memberMoneyEvent.findMany({
    where: { journal: { lines: { some: { bookingId } } } },
    orderBy: { recordedAt: "asc" },
    select: { eventKey: true, kind: true },
  });
}

/** Signed receivable per debtor on the booking (Dr positive). */
async function receivable(bookingId: string): Promise<Record<string, number>> {
  const legs = await prisma.memberMoneyLine.findMany({
    where: { bookingId, account: "MEMBER_RECEIVABLE" },
    select: { side: true, amountCents: true, memberId: true, organisationId: true },
  });
  const out: Record<string, number> = {};
  for (const leg of legs) {
    const who = leg.memberId ?? leg.organisationId ?? "?";
    out[who] = (out[who] ?? 0) + (leg.side === "DEBIT" ? leg.amountCents : -leg.amountCents);
  }
  return out;
}

/** The census's JOURNAL result and any unbridged line for one booking, from the census's own row read. */
async function judged(bookingId: string) {
  const row = await census.readBookingLedgerCensusRow(prisma, bookingId);
  const evaluation = census.evaluateWithJournal(row!);
  return {
    journal: evaluation.identities.find((identity) => identity.identity === "JOURNAL")!,
    unbridged: evaluation.integrity.filter((finding) => finding.kind === "UNBRIDGED_CHARGE_LINE"),
  };
}

async function expectAgreed(bookingId: string) {
  const { journal, unbridged } = await judged(bookingId);
  expect(journal.status, `JOURNAL on ${bookingId}: ${JSON.stringify(journal)}`).toBe("AGREE");
  expect(unbridged).toEqual([]);
}

/** Until another backend waits on a row or advisory lock this suite holds. */
async function untilSomeoneWaits(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no backend ever waited on the held booking row");
}

(RUN ? describe : describe.skip)("booking doors post into the member-money journal — real PostgreSQL (#4627)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Booking ledger journal");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    confirmationSync = await import("@/lib/booking-ledger-confirmation-sync");
    cancellationSync = await import("@/lib/booking-ledger-cancellation-sync");
    doors = await import("@/lib/member-money/doors");
    census = await import("@/lib/booking-ledger-projection-census-store");
    merge = await import("@/lib/member-merge");
    lodgeLock = await import("@/lib/lodge-capacity-lock");
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    for (const id of [LOSER, MASTER]) {
      await prisma.member.create({
        data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: id === LOSER ? "Duplicate" : "Survivor", ageTier: "ADULT" },
      });
    }
    await prisma.member.create({
      data: {
        id: ADMIN, email: `${ADMIN}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: "Admin",
        ageTier: "ADULT", role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } },
      },
    });
    await prisma.organisation.create({ data: { id: ORGANISATION, name: "Race 4627 School" } });
  }, 120_000);

  async function cleanup() {
    await cleanHistories(prisma, PREFIX);
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: { in: [LOSER, MASTER, ADMIN] } }, { actorMemberId: ADMIN }, { targetId: { in: [LOSER, MASTER] } }] } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: ADMIN } });
    await prisma.member.deleteMany({ where: { id: { in: [LOSER, MASTER, ADMIN] } } });
    await prisma.organisation.deleteMany({ where: { id: ORGANISATION } });
    await prisma.clubTaxSettings.deleteMany({});
  }

  afterAll(async () => {
    if (prisma) await cleanup();
  }, 120_000);

  it("R01: the real card settle posts its lines once, each bridged, as one CHARGE batch the census agrees with", async () => {
    const id = await newBooking();
    await settleHistoryByCard(id, PRICE);
    const events = await journalEvents(id);
    expect(events).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE" }]);
    const legacy = await prisma.bookingLedgerLine.findMany({ where: { bookingId: id, side: "CHARGE" }, select: { id: true, memberMoneySourceLink: { select: { id: true } } } });
    expect(legacy).toHaveLength(4);
    expect(legacy.every((line) => line.memberMoneySourceLink !== null)).toBe(true);
    expect(await receivable(id)).toEqual({ [names.memberId]: PRICE });
    const revenue = await prisma.memberMoneyLine.findMany({ where: { bookingId: id, account: "BOOKING_REVENUE" }, select: { side: true, grossCents: true, chargeIdentity: true } });
    expect(revenue).toEqual([{ side: "CREDIT", grossCents: PRICE, chargeIdentity: `booking:${id}:charge` }]);
    await expectAgreed(id);

    // A retry of the confirmation, and of the journal call itself, posts nothing more.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await confirmationSync.postStoredBookingConfirmationLedgerLines(tx, id, JOURNAL);
      expect(await doors.postBookingLedgerJournal(tx, JOURNAL, {
        bookingId: id, lodgeId: names.lodgeId, event: { kind: "confirmation" },
        postingKeys: (await tx.bookingLedgerLine.findMany({ where: { bookingId: id }, select: { postingKey: true } })).map((line) => line.postingKey!),
      })).toBeNull();
    });
    expect(await journalEvents(id)).toHaveLength(1);
  });

  it("R02/R03 then R04: an edit with a change fee and the cancellation correct whole components, once each", async () => {
    const id = await newBooking();
    await settleHistoryByCard(id, PRICE);
    await postHistoryEdit(prisma, names, id, `${id}-edit`, { removeGuestId: `${id}-g2`, changeFeeCents: 2_500 });
    expect((await journalEvents(id)).map((event) => event.eventKey)).toEqual([`booking-charge:${id}`, `modification:${id}-edit`]);
    expect(await receivable(id)).toEqual({ [names.memberId]: PRICE - 10_000 + 2_500 });
    await expectAgreed(id);

    // Kept below the change fee: the fee is reversed too, and what is kept becomes the cancellation fee.
    expect(await cancelDoor(id, 1_000)).toBe(true);
    expect((await journalEvents(id)).map((event) => event.eventKey)).toContain(`cancellation:${id}:0`);
    expect(await receivable(id)).toEqual({ [names.memberId]: 1_000 });
    await expectAgreed(id);

    // The cancellation replayed (its lines are already posted) posts nothing more.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await cancellationSync.postCancellationLedgerLines({ store: tx, journal: JOURNAL, bookingId: id, lodgeId: names.lodgeId, keptCents: 1_000, site: "race-4627" });
    });
    expect(await journalEvents(id)).toHaveLength(3);
    await expectAgreed(id);
  });

  it("a booking confirmed before M3b posts nothing at its later edits: M9 back-posts it whole", async () => {
    const id = await newBooking();
    await settleHistoryByCard(id, PRICE);
    const { releaseBookingJournalForTeardown } = await import("./support/booking-financial-history-teardown");
    await releaseBookingJournalForTeardown(prisma, [id]);
    await postHistoryEdit(prisma, names, id, `${id}-edit`, { removeGuestId: `${id}-g2`, changeFeeCents: 0 });
    expect(await journalEvents(id)).toEqual([]);
    expect((await judged(id)).journal.status).toBe("NOT_APPLICABLE");
  });

  it("a refused posting rolls the settle back: no PAID, no legacy line, no journal row", async () => {
    const id = await newBooking();
    // A tax setting that starts after today: a fresh split is refused, never guessed (D3).
    await prisma.clubTaxSettings.create({ data: { id: "default", gstRegistered: true, taxRateBasisPoints: 1500, effectiveFrom: new Date("2099-01-01T00:00:00.000Z") } });
    try {
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      await expect(markBookingPaymentSucceeded({ bookingId: id, paymentIntentId: `pi_${id}`, amountCents: PRICE, paymentMethodId: null, format: (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST }))
        .rejects.toThrow(/tax setting starts on 2099-01-01/);
    } finally {
      await prisma.clubTaxSettings.deleteMany({});
    }
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("PAYMENT_PENDING");
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId: id } })).toBe(0);
    expect(await journalEvents(id)).toEqual([]);
  });

  it("an organisation-owned booking posts the organisation as the debtor", async () => {
    const id = await newBooking({ organisationId: ORGANISATION });
    await settleHistoryByCard(id, PRICE);
    expect(await receivable(id)).toEqual({ [ORGANISATION]: PRICE });
    const obligation = await prisma.memberMoneyObligation.findUniqueOrThrow({ where: { obligationKey: `booking-charge:${id}` } });
    expect(obligation).toMatchObject({ debtorKind: "ORGANISATION", organisationId: ORGANISATION, memberId: null, faceCents: PRICE });
    await expectAgreed(id);
  });

  it("receipt against cancel: whichever wins lock(1), each event posts at most once and the census agrees", async () => {
    for (let trial = 0; trial < 4; trial += 1) {
      const id = await newBooking();
      // Each order is started first in turn; lock(1) decides who actually goes first.
      const settleFirst = trial % 2 === 0;
      const first = settleFirst ? settleDoor(id) : cancelDoor(id);
      const second = settleFirst ? cancelDoor(id) : settleDoor(id);
      const [a, b] = await Promise.all([first, second]);
      const [settled, cancelled] = settleFirst ? [a, b] : [b, a];
      expect(cancelled).toBe(true);
      const keys = (await journalEvents(id)).map((event) => event.eventKey);
      expect(new Set(keys).size).toBe(keys.length);
      if (settled) {
        expect([...keys].sort()).toEqual([`booking-charge:${id}`, `cancellation:${id}:0`]);
        expect(await receivable(id)).toEqual({ [names.memberId]: 0 });
        await expectAgreed(id);
      } else {
        expect(keys).toEqual([]);
        expect((await judged(id)).journal.status).toBe("NOT_APPLICABLE");
      }
    }
  });

  it("edit against cancel: serialised on lock(1), nothing double-posted or stranded", async () => {
    for (let trial = 0; trial < 3; trial += 1) {
      const id = await newBooking();
      await settleHistoryByCard(id, PRICE);
      await Promise.allSettled([
        postHistoryEdit(prisma, names, id, `${id}-edit`, { reprice: { guestId: `${id}-g1`, stayDate: new Date("2027-08-01T00:00:00.000Z"), priceCents: 7_000 }, changeFeeCents: 0 }),
        cancelDoor(id),
      ]);
      const keys = (await journalEvents(id)).map((event) => event.eventKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toContain(`cancellation:${id}:0`);
      expect(await receivable(id)).toEqual({ [names.memberId]: 0 });
      await expectAgreed(id);
    }
  });

  it("merge against a settle of a booking the merged-away member owns: the transfer waits for the settle and moves its charge", async () => {
    const id = await newBooking({ memberId: LOSER });
    let posted!: () => void;
    let release!: () => void;
    const postedSignal = new Promise<void>((resolve) => { posted = resolve; });
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const settling = settleDoor(id, { posted, release: releaseSignal });
    await postedSignal;
    let merging: Promise<unknown> = Promise.resolve();
    try {
      const preview = await merge.buildMemberMergePreview({ masterId: MASTER, loserId: LOSER, actorMemberId: ADMIN });
      expect(preview.blockers).toEqual([]);
      merging = merge.executeMemberMerge({
        masterId: MASTER, loserId: LOSER, actorMemberId: ADMIN,
        previewToken: preview.previewToken, confirmationText: preview.confirmationPhrase,
      });
      // The merge reaches the owner move and waits on the booking row the settle holds.
      await untilSomeoneWaits();
    } finally {
      release();
    }
    expect(await settling).toBe(true);
    await merging;

    expect(await receivable(id)).toEqual({ [LOSER]: 0, [MASTER]: PRICE });
    const transfer = await prisma.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey: `merge:${LOSER}:${MASTER}` }, select: { kind: true, actorMemberId: true } });
    expect(transfer).toEqual({ kind: "ADJUSTMENT", actorMemberId: ADMIN });
    // The charge is still exactly the booking's: the transfer moved the debt, not the revenue.
    await expectAgreed(id);

    // A later door posts to the survivor, as the booking's owner now is.
    expect(await cancelDoor(id)).toBe(true);
    expect(await receivable(id)).toEqual({ [LOSER]: 0, [MASTER]: 0 });
    await expectAgreed(id);
  });

  it("the census reports zero JOURNAL differences and no unbridged line on the whole population", async () => {
    const report = await census.censusBookingLedgerProjection(prisma);
    expect(report.identities.JOURNAL.applicable).toBeGreaterThan(0);
    expect(report.identities.JOURNAL.disagree).toBe(0);
    expect(report.disagreements.filter((row) => row.identity === "JOURNAL")).toEqual([]);
    expect(report.integrity.counts.UNBRIDGED_CHARGE_LINE).toBe(0);
  });
});
