/**
 * Real-PostgreSQL proof for #5298 (`INV-INT-043`): an email a crash left
 * `QUEUED` is found, and either sent again exactly once or flagged to officers,
 * never sent twice.
 *
 * 1. A crash between the `QUEUED` row and the hand-over: the real `sendEmail`
 *    records its row and then stops before it reaches the mail server. The
 *    real `retryFailedEmails` leaves it alone until it is 30 minutes old, then
 *    sends it once; the next run sends nothing.
 * 2. The sweep racing a late sender: both write one guarded `updateMany` on the
 *    row, so whichever PostgreSQL lets through first wins and the other changes
 *    nothing. Both orders are forced by holding the row's lock until both
 *    writes are queued behind it, and each ends in exactly one send.
 * 3. A row that may already have reached the mail server (STARTED, or written
 *    by the previous release) is flagged `UNCONFIRMED` at the retry ceiling and
 *    sent by nobody; a never-sent row that kept no body lands at the ceiling.
 * 4. Through the real `sendEmail`: a sender that stalls past the threshold
 *    before its hand-over, while the sweep and the retry job send its email,
 *    writes nothing and sends nothing when it resumes (#5496 review). Two
 *    sweeps racing for one row settle it once, and a caller-retried alert is
 *    released to its owner, not re-sent.
 *
 * Only the delivery policy and the mail transport are replaced (a harness is
 * never the club's live site, and no provider is contacted). Ordinary Vitest
 * runs skip the file; Sekreton's `kept-change-realdb` check runs it against a
 * disposable loopback PostgreSQL. It cleans its own `race-5298` rows. Officer
 * alerts may reach admins other suites left behind, so sends are counted by
 * this file's own recipients.
 *
 * The retry job replays the 50 oldest-created `FAILED` rows a run, and the
 * suites before this one in the shared database can leave more than 50 behind.
 * A row the sweep hands back is then replayed a run later, not in the same run,
 * which the `Real-PostgreSQL suites (all)` job on #5496 hit (this file passed
 * alone). So the rows under test are created first (`FIRST_CREATED`), ahead of
 * anything another suite left, as `email-failure-requeue.realdb.test.ts` pins
 * its rows to the head of the review queue. Neither the sweep nor the 7-day
 * limit reads `createdAt`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "../../__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const transport = vi.hoisted(() => ({
  sendMail: vi.fn(),
  /** When set, the next `getEmailTransporter` never returns: the process "stops" there. */
  crashNext: false,
  crashed: false,
  /** When set, the next `getEmailTransporter` waits until the test lets it go: a sender that stalls. */
  stallNext: false,
  resumeStalled: null as null | ((outcome: "throws" | "returns") => void),
}));

vi.mock("@/lib/environment-delivery-policy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/environment-delivery-policy")),
  resolveDeliveryPolicy: vi.fn(async () => ({ kind: "allow", grounds: "production", clearance: {} })),
}));
vi.mock("@/lib/email/internal", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email/internal")),
  getEmailTransporter: vi.fn(() => {
    if (transport.crashNext) {
      transport.crashNext = false;
      transport.crashed = true;
      return new Promise<never>(() => {});
    }
    if (transport.stallNext) {
      transport.stallNext = false;
      return new Promise((resolve, reject) => {
        transport.resumeStalled = (outcome) =>
          outcome === "throws"
            ? reject(new Error("race-5298 transport configuration failed"))
            : resolve({ transporter: { sendMail: transport.sendMail }, modeLabel: "race-5298 fake transport" });
      });
    }
    return Promise.resolve({ transporter: { sendMail: transport.sendMail }, modeLabel: "race-5298 fake transport" });
  }),
}));

const P = "race-5298";
const SUBJECT = `${P} notice`;
// Keeps its body, and is not an alert its owner sends again (#4669): those are
// released to their owner rather than re-sent, and have a case of their own.
const TEMPLATE = "admin-payment-failure";
const CALLER_RETRIED_TEMPLATE = "admin-bank-transfer-settlement-figure";
const THIRTY_ONE_MINUTES = 31 * 60_000;
const FIRST_CREATED = new Date(Date.UTC(2000, 0, 1));

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let sendEmail: (typeof import("@/lib/email/core"))["sendEmail"];
let handover: typeof import("@/lib/email/handover");
let retryFailedEmails: (typeof import("@/lib/cron-email-retry"))["retryFailedEmails"];

(RUN ? describe : describe.skip)("an email a crash left QUEUED - real PostgreSQL (#5298)", { timeout: 120_000 }, () => {
  const deleteFixtures = () => prisma.emailLog.deleteMany({ where: { subject: SUBJECT } });
  const read = (id: string) => prisma.emailLog.findUniqueOrThrow({ where: { id } });
  const sendsTo = (to: string) =>
    transport.sendMail.mock.calls.filter(([message]) => (message as { to: string }).to === to).length;
  const moveClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

  /** A row as `sendEmail` records it just before the hand-over, stranded since `ago`. */
  const recorded = (to: string, extra: Record<string, unknown> = {}, ago = THIRTY_ONE_MINUTES) =>
    prisma.emailLog.create({
      data: {
        to,
        subject: SUBJECT,
        templateName: TEMPLATE,
        htmlBody: `<p>message for ${to}</p>`,
        status: "QUEUED",
        handoverState: "PENDING",
        lastAttemptAt: new Date(Date.now() - ago),
        createdAt: FIRST_CREATED,
        ...extra,
      },
    });

  async function waitForLockWaiters(n: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%"EmailLog"%'`;
      if (waiting >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`never saw ${n} queued lock waits`);
  }

  /** Hold the row's lock until released, so later writers queue behind it in order. */
  async function holdRow(id: string) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "EmailLog" WHERE id = ${id} FOR UPDATE`;
        locked();
        await held;
      },
      { maxWait: 30_000, timeout: 60_000 },
    );
    await lockTaken;
    return async () => {
      release();
      await holder;
    };
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "stranded QUEUED email proof");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    ({ sendEmail } = await import("@/lib/email/core"));
    handover = await import("@/lib/email/handover");
    ({ retryFailedEmails } = await import("@/lib/cron-email-retry"));
    await deleteFixtures();
  }, 60_000);

  beforeEach(async () => {
    await deleteFixtures();
    transport.sendMail.mockReset();
    transport.sendMail.mockResolvedValue({ messageId: `${P}-message` });
    transport.crashNext = false;
    transport.crashed = false;
    transport.stallNext = false;
    transport.resumeStalled = null;
  });

  afterAll(async () => {
    if (typeof prisma === "undefined") return;
    try {
      await deleteFixtures();
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it("sends an email whose sender stopped before the hand-over exactly once, after the threshold", async () => {
    const to = `crash@${P}.test`;
    transport.crashNext = true;
    // Never settles: the sender "stops" between its QUEUED row and the hand-over.
    void sendEmail({ to, subject: SUBJECT, html: "<p>Your refund is on its way</p>", templateName: TEMPLATE, bookingContext: "none" });
    await vi.waitFor(() => expect(transport.crashed).toBe(true), { timeout: 30_000 });

    const [row] = await prisma.emailLog.findMany({ where: { subject: SUBJECT, to } });
    expect(row).toEqual(expect.objectContaining({ status: "QUEUED", handoverState: "PENDING", attempts: 1 }));
    await prisma.emailLog.update({ where: { id: row!.id }, data: { createdAt: FIRST_CREATED } });

    // Inside the threshold the send may still be in flight, so it is left alone.
    await retryFailedEmails();
    expect(await read(row!.id)).toEqual(expect.objectContaining({ status: "QUEUED", handoverState: "PENDING" }));
    expect(sendsTo(to)).toBe(0);

    moveClock(THIRTY_ONE_MINUTES);
    await retryFailedEmails();
    expect(sendsTo(to)).toBe(1);
    expect(await read(row!.id)).toEqual(
      expect.objectContaining({ status: "SENT", handoverState: "STARTED", attempts: 2, messageId: `${P}-message` }),
    );

    moveClock(THIRTY_ONE_MINUTES);
    await retryFailedEmails();
    expect(sendsTo(to)).toBe(1);
  });

  it.each([
    ["the sweep reaches the row first", "sweep-first"],
    ["the late sender reaches the row first", "sender-first"],
  ] as const)("sends once when %s", async (_label, order) => {
    const to = `race-${order}@${P}.test`;
    const row = await recorded(to);
    const release = await holdRow(row.id);

    let sweep!: Promise<unknown>;
    let claim!: Promise<Date | null>;
    if (order === "sweep-first") {
      sweep = handover.sweepStrandedQueuedEmails();
      await waitForLockWaiters(1);
      claim = handover.claimEmailHandover(row.id);
    } else {
      claim = handover.claimEmailHandover(row.id);
      await waitForLockWaiters(1);
      sweep = handover.sweepStrandedQueuedEmails();
    }
    await waitForLockWaiters(2);
    await release();
    const [claimedAt] = await Promise.all([claim, sweep]);
    const senderWon = claimedAt !== null;

    expect(senderWon).toBe(order === "sender-first");
    // A row is handed over once: no second claim wins it, whoever holds it.
    await expect(handover.claimEmailHandover(row.id)).resolves.toBeNull();
    // The late sender sends only after winning; the retry job sends a row only
    // the sweep handed back.
    if (senderWon) await transport.sendMail({ to });
    await retryFailedEmails();
    expect(sendsTo(to)).toBe(1);
    expect(await read(row.id)).toEqual(
      expect.objectContaining(senderWon ? { status: "QUEUED", handoverState: "STARTED" } : { status: "SENT", attempts: 2 }),
    );
  });

  // #5496 review, item 1: a sender that stalls past the threshold before its
  // hand-over must not undo the sweep's work when it resumes.
  it.each([
    ["its transport then fails", "throws"],
    ["its transport then answers", "returns"],
  ] as const)("sends once when a stalled sender resumes after the sweep and the retry job sent its email: %s", async (_label, outcome) => {
    const to = `stalled-${outcome}@${P}.test`;
    transport.stallNext = true;
    const sender = sendEmail({ to, subject: SUBJECT, html: "<p>Your payment failed</p>", templateName: TEMPLATE, bookingContext: "none" });
    await vi.waitFor(() => expect(transport.resumeStalled).not.toBeNull(), { timeout: 30_000 });
    const [row] = await prisma.emailLog.findMany({ where: { subject: SUBJECT, to } });
    await prisma.emailLog.update({ where: { id: row!.id }, data: { createdAt: FIRST_CREATED } });

    moveClock(THIRTY_ONE_MINUTES);
    await retryFailedEmails();
    expect(sendsTo(to)).toBe(1);
    const sent = await read(row!.id);
    expect(sent).toEqual(expect.objectContaining({ status: "SENT", handoverState: "STARTED", attempts: 2 }));

    transport.resumeStalled!(outcome);
    if (outcome === "throws") await expect(sender).rejects.toThrow("race-5298 transport configuration failed");
    else await expect(sender).resolves.toEqual({ status: "handover_lost", emailLogId: row!.id });
    // Its late write matched nothing: the row is as the retry job left it.
    expect(await read(row!.id)).toEqual(sent);

    moveClock(THIRTY_ONE_MINUTES);
    await retryFailedEmails();
    expect(sendsTo(to)).toBe(1);
  });

  it("settles a row once when two sweeps race for it", async () => {
    const to = `two-sweeps@${P}.test`;
    const row = await recorded(to);
    const release = await holdRow(row.id);

    const sweeps = Promise.all([handover.sweepStrandedQueuedEmails(), handover.sweepStrandedQueuedEmails()]);
    await waitForLockWaiters(2);
    await release();
    const results = await sweeps;

    expect(results.reduce((sum, result) => sum + result.requeued, 0)).toBe(1);
    await retryFailedEmails();
    await retryFailedEmails();
    expect(sendsTo(to)).toBe(1);
  });

  // #5496 review, item 2: the alert's owner sends it again when nobody got it.
  it("releases a never-handed-over caller-retried alert to its owner and sends it to nobody", async () => {
    const owned = await recorded(`owned@${P}.test`, { templateName: CALLER_RETRIED_TEMPLATE });

    await retryFailedEmails();
    moveClock(THIRTY_ONE_MINUTES);
    await retryFailedEmails();

    expect(sendsTo(owned.to)).toBe(0);
    expect(await read(owned.id)).toEqual(
      expect.objectContaining({ status: "FAILED", attempts: 1, htmlBody: null, bookingRetryHtmlBody: null }),
    );
  });

  it("flags a row that may have reached the mail server, sends it to nobody, and puts a bodiless one at the ceiling", async () => {
    const started = await recorded(`started@${P}.test`, { handoverState: "STARTED" });
    const legacy = await recorded(`legacy@${P}.test`, { handoverState: null });
    const retriedByOldCode = await recorded(`old-retry@${P}.test`, { attempts: 2 });
    const bodiless = await recorded(`bodiless@${P}.test`, { htmlBody: null });

    await retryFailedEmails();

    for (const flagged of [started, legacy, retriedByOldCode]) {
      expect(sendsTo(flagged.to)).toBe(0);
      expect(await read(flagged.id)).toEqual(
        expect.objectContaining({
          status: "FAILED",
          attempts: 3,
          handoverState: "UNCONFIRMED",
          errorMessage: expect.stringContaining("may already have reached the recipient"),
        }),
      );
    }
    expect(sendsTo(bodiless.to)).toBe(0);
    expect(await read(bodiless.id)).toEqual(
      expect.objectContaining({ status: "FAILED", attempts: 3, handoverState: "PENDING", errorMessage: expect.stringContaining("Never sent") }),
    );

    // Nothing more happens on later runs: the rows wait for an officer.
    moveClock(THIRTY_ONE_MINUTES);
    await retryFailedEmails();
    for (const row of [started, legacy, retriedByOldCode, bodiless]) expect(sendsTo(row.to)).toBe(0);
  });

  it("leaves a stranded row older than a week alone", async () => {
    const old = await recorded(`old@${P}.test`, {}, 8 * 24 * 60 * 60_000);

    await retryFailedEmails();

    expect(sendsTo(old.to)).toBe(0);
    expect(await read(old.id)).toEqual(expect.objectContaining({ status: "QUEUED", handoverState: "PENDING" }));
  });
});
