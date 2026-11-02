/**
 * Real-PostgreSQL proof of #4669's release: a caller-retried admin alert nobody
 * received has its `FAILED` rows released (body dropped) in one transaction, and
 * the email retry cron's guarded claim and that release never both win a row.
 *
 * The cron's claim is issued here as the exact guarded `updateMany` it runs
 * (`cron-email-retry.ts`), because the whole cron refuses to send on a harness
 * that is not the club's live site, and that refusal is the point of it. The
 * release is the real `releaseUnreceivedAlertCopies`. Row locks are real, and
 * each interleaving is forced by holding a lock in a second transaction and
 * waiting until PostgreSQL shows the other writer queued behind it.
 *
 * Ordinary Vitest runs skip the whole file. It needs the guarded, disposable
 * loopback PostgreSQL every realdb suite uses (`CONCURRENCY_RACE_DATABASE_URL`,
 * `RUN_CONCURRENCY_RACE_TESTS=1`), and owns and cleans its own `race-4669` rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const SUBJECT = "race-4669 Stripe payment the app did not create";
const TEMPLATE = "admin-unrecognised-stripe-payment";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let releaseUnreceivedAlertCopies: (typeof import("@/lib/email/caller-retried-alert"))["releaseUnreceivedAlertCopies"];

(RUN ? describe : describe.skip)("releasing a caller-retried alert nobody received - real PostgreSQL (#4669)", { timeout: 120_000 }, () => {
  const deleteFixtures = () => prisma.emailLog.deleteMany({ where: { subject: SUBJECT } });

  /** One recipient's copy as `sendEmail` leaves it after the send failed. */
  async function failedCopy(to: string, extra: Record<string, unknown> = {}) {
    const row = await prisma.emailLog.create({
      data: {
        to,
        subject: SUBJECT,
        templateName: TEMPLATE,
        htmlBody: `<p>alert for ${to}</p>`,
        status: "FAILED",
        errorMessage: "SMTP throttled",
        lastAttemptAt: new Date(Date.now() - 20 * 60_000),
        ...extra,
      },
    });
    return row;
  }

  /** `retryFailedEmails`'s claim, verbatim in shape, on the row as the cron read it. */
  const cronClaim = (
    store: Pick<typeof prisma, "emailLog">,
    row: { id: string; attempts: number; htmlBody: string | null; bookingRetryHtmlBody: string | null },
  ) =>
    store.emailLog.updateMany({
      where: {
        id: row.id,
        status: "FAILED",
        attempts: row.attempts,
        htmlBody: row.htmlBody,
        bookingRetryHtmlBody: row.bookingRetryHtmlBody,
      },
      data: { status: "QUEUED", attempts: row.attempts + 1, lastAttemptAt: new Date() },
    });

  const read = (id: string) => prisma.emailLog.findUniqueOrThrow({ where: { id } });

  /** Wait until `n` row-lock waits are queued, so the interleaving is the one the case names. */
  async function waitForLockWaiters(n: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (waiting >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`never saw ${n} queued lock waits`);
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "caller-retried alert release proof");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    ({ releaseUnreceivedAlertCopies } = await import("@/lib/email/caller-retried-alert"));
    await deleteFixtures();
  }, 60_000);

  beforeEach(async () => {
    await deleteFixtures();
  });

  afterAll(async () => {
    if (typeof prisma === "undefined") return;
    try {
      await deleteFixtures();
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it("drops every failed copy's body, rewrites an environment fault's message, and leaves a suppressed copy alone", async () => {
    const transport = await failedCopy("a@race-4669.test");
    const environment = await failedCopy("b@race-4669.test", {
      deliveryBlockReason: "ENVIRONMENT_DECLARATION_MISSING",
      errorMessage: "It is queued and will go out once the environment role is declared",
    });
    const suppressed = await failedCopy("c@race-4669.test", { status: "BOUNCED", htmlBody: null });

    expect(await releaseUnreceivedAlertCopies([transport.id, environment.id, suppressed.id], TEMPLATE)).toBe("released");

    expect(await read(transport.id)).toEqual(
      expect.objectContaining({ status: "FAILED", attempts: 1, htmlBody: null, errorMessage: "SMTP throttled" }),
    );
    const released = await read(environment.id);
    expect(released).toEqual(expect.objectContaining({ status: "FAILED", attempts: 1, htmlBody: null }));
    expect(released.deliveryBlockReason).toBe("ENVIRONMENT_DECLARATION_MISSING");
    expect(released.errorMessage).toMatch(/sent again by the alert's own retry/);
    expect(await read(suppressed.id)).toEqual(expect.objectContaining({ status: "BOUNCED", htmlBody: null }));

    // Out of the cron's reach, and not in the review queue (attempts < 3).
    expect(await cronClaim(prisma, transport)).toEqual({ count: 0 });
  });

  it("rolls back and leaves every copy to the cron when it claimed one first", async () => {
    const claimed = await failedCopy("a@race-4669.test");
    const sibling = await failedCopy("b@race-4669.test");
    expect(await cronClaim(prisma, claimed)).toEqual({ count: 1 });

    expect(await releaseUnreceivedAlertCopies([claimed.id, sibling.id], TEMPLATE)).toBe("cron-holds-a-copy");
    expect((await read(sibling.id)).htmlBody).toBe(sibling.htmlBody);
    expect(await read(claimed.id)).toEqual(expect.objectContaining({ status: "QUEUED", attempts: 2, htmlBody: claimed.htmlBody }));
  });

  it("a cron claim in flight when the release starts wins its row, and the release rolls back", async () => {
    const claimed = await failedCopy("a@race-4669.test");
    const sibling = await failedCopy("b@race-4669.test");
    let commitClaim!: () => void;
    let claimCount = -1;
    const claimHeld = new Promise<void>((resolve) => (commitClaim = resolve));

    // The cron has claimed the row and not committed: it holds the row lock.
    let claimTaken!: () => void;
    const taken = new Promise<void>((resolve) => (claimTaken = resolve));
    const claimTx = prisma.$transaction(
      async (tx) => {
        claimCount = (await cronClaim(tx, claimed)).count;
        claimTaken();
        await claimHeld;
      },
      { timeout: 30_000 },
    );
    await taken;

    const release = releaseUnreceivedAlertCopies([claimed.id, sibling.id], TEMPLATE);
    await waitForLockWaiters(1);
    commitClaim();
    await claimTx;

    expect(claimCount).toBe(1);
    expect(await release).toBe("cron-holds-a-copy");
    expect((await read(sibling.id)).htmlBody).toBe(sibling.htmlBody);
    expect(await read(claimed.id)).toEqual(expect.objectContaining({ status: "QUEUED", attempts: 2, htmlBody: claimed.htmlBody }));
  });

  it("a release in flight when the cron claims wins the row, and the claim matches nothing", async () => {
    const copy = await failedCopy("a@race-4669.test");
    // An environment fault, so only the release's SECOND statement touches it:
    // the first has locked `copy` by the time the release queues behind this.
    const held = await failedCopy("b@race-4669.test", { deliveryBlockReason: "ENVIRONMENT_DECLARATION_MISSING" });
    let releaseHold!: () => void;
    const holding = new Promise<void>((resolve) => (releaseHold = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holdTx = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "EmailLog" WHERE id = ${held.id} FOR UPDATE`;
        locked();
        await holding;
      },
      { timeout: 30_000 },
    );
    await isLocked;

    const release = releaseUnreceivedAlertCopies([copy.id, held.id], TEMPLATE);
    await waitForLockWaiters(1);
    // The cron read the row before the release and claims it now: it queues behind the release.
    // A Prisma query is lazy until awaited, so `.then` sends it now.
    const claim = cronClaim(prisma, copy).then((result) => result);
    await waitForLockWaiters(2);
    releaseHold();
    await holdTx;

    expect(await release).toBe("released");
    expect(await claim).toEqual({ count: 0 });
    expect(await read(copy.id)).toEqual(expect.objectContaining({ status: "FAILED", attempts: 1, htmlBody: null }));
    expect((await read(held.id)).htmlBody).toBeNull();
  });
});
