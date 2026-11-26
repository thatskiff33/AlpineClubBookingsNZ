/**
 * Real-PostgreSQL proof for #5255 (`INV-INT-042`): the sweep's give-back of a
 * once-ever claim with no email behind it, and the alert's first email row,
 * cannot both win. The row confirms the claim (`confirmAlertCooldownSend`) in
 * the transaction that writes it, and the give-back deletes only a row still
 * marked (`releaseUnsentAlertCooldown`), so the `AlertCooldown` row lock orders
 * them:
 *
 * - the email row first: the sweep's delete waits, re-reads the row with the
 *   mark cleared, and deletes nothing - the claim is kept, so the alert is
 *   never sent a second time;
 * - the give-back first: the email row's confirm waits, finds no row, and
 *   `recordEmailAttempt` writes nothing and throws, so the email is never sent
 *   and the next run claims afresh.
 *
 * Ordinary Vitest runs skip the file. Sekreton's `kept-change-realdb` check
 * runs it against a disposable loopback PostgreSQL; it cleans its own
 * `race-5255:` rows.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { backendPid, untilBlockedChain } from "./support/race-lock-waits";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const KEY = "race-5255:alert";
const SUBJECT = "race-5255 alert";

let prisma: PrismaClient;
let cooldown: typeof import("@/lib/alert-cooldown");
let attemptLog: typeof import("@/lib/email/attempt-log");
let claimContext: typeof import("@/lib/once-ever-claim-context");
let sweep: typeof import("@/lib/admin-alert-once-sweep");

const claimedAt = new Date("2026-07-01T00:00:00.000Z");
const afterGrace = () => new Date(claimedAt.getTime() + 16 * 60_000);
const emailRows = () => prisma.emailLog.count({ where: { subject: SUBJECT } });

async function clean(): Promise<void> {
  await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: "race-5255:" } } });
  await prisma.emailLog.deleteMany({ where: { subject: SUBJECT } });
}

/** Open a transaction, run `first` in it, and hold it open until `letGo`. */
function holdTransaction(first: (tx: PrismaClient) => Promise<void>) {
  let letGo!: () => void;
  const released = new Promise<void>((resolve) => (letGo = resolve));
  let resolvePid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => (resolvePid = resolve));
  let resolveStarted!: () => void;
  let rejectStarted!: (err: unknown) => void;
  const started = new Promise<void>((resolve, reject) => ((resolveStarted = resolve), (rejectStarted = reject)));
  const done = prisma.$transaction(
    async (tx) => {
      resolvePid(await backendPid(tx));
      await first(tx as unknown as PrismaClient);
      resolveStarted();
      await released;
    },
    { timeout: 20_000 },
  );
  done.catch(rejectStarted);
  return { started, pid, letGo: () => letGo(), done };
}

(RUN ? describe : describe.skip)("#5255: the sweep's give-back against the alert's first email row", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Once-ever alert sweep race");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    cooldown = await import("@/lib/alert-cooldown");
    attemptLog = await import("@/lib/email/attempt-log");
    claimContext = await import("@/lib/once-ever-claim-context");
    sweep = await import("@/lib/admin-alert-once-sweep");
  });

  beforeEach(async () => {
    await clean();
    await cooldown.claimAlertCooldown({ key: KEY, windowMs: cooldown.ALERT_ONCE_EVER_WINDOW_MS, now: claimedAt, awaitingSend: true });
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.$disconnect();
  });

  it("the email row first: the sweep waits, finds the claim confirmed, and gives nothing back", async () => {
    const email = holdTransaction(async (tx) => {
      expect(await cooldown.confirmAlertCooldownSend({ key: KEY, claimedAt, store: tx })).toBe(true);
      await tx.emailLog.create({ data: { to: "officer@example.org", subject: SUBJECT, templateName: "admin-xero-sync-error", status: "QUEUED" } });
    });
    await email.started;

    const swept = sweep.sweepOnceEverAlerts(afterGrace());
    await untilBlockedChain(prisma, await email.pid);
    email.letGo();
    await email.done;

    await expect(swept).resolves.toMatchObject({ released: 0, failed: 0 });
    await expect(prisma.alertCooldown.findUnique({ where: { key: KEY } })).resolves.toMatchObject({ lastAlertedAt: claimedAt, awaitingSendSince: null });
    await expect(emailRows()).resolves.toBe(1);
  });

  it("the give-back first: the email row waits, finds no claim, and nothing is recorded or sent", async () => {
    const giveBack = holdTransaction(async (tx) => {
      expect(await cooldown.releaseUnsentAlertCooldown({ key: KEY, claimedAt, store: tx })).toBe(true);
    });
    await giveBack.started;

    const handle = claimContext.newOnceEverClaimHandle(KEY, claimedAt);
    const recorded = attemptLog.recordEmailAttempt({
      recipient: "officer@example.org",
      subject: SUBJECT,
      templateName: "admin-xero-sync-error",
      html: "<p>alert</p>",
      bookingContext: "none",
      bodyOverrideApplied: false,
      persistHtmlBody: true,
      hasAttachments: false,
      onceEverClaim: handle,
    });
    recorded.catch(() => undefined);
    await untilBlockedChain(prisma, await giveBack.pid);
    giveBack.letGo();
    await giveBack.done;

    await expect(recorded).rejects.toMatchObject({ cause: { message: expect.stringMatching(/no longer held/) } });
    expect(handle).toMatchObject({ rowWritten: false, rowWriteFailed: true });
    await expect(emailRows()).resolves.toBe(0);
    await expect(prisma.alertCooldown.findUnique({ where: { key: KEY } })).resolves.toBeNull();
  });
});
