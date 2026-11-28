/**
 * Real-PostgreSQL proof for #5297 (`INV-INT-045`): a raised-once admin alert
 * fired while the database refuses every call is still delivered once the
 * database answers, and never twice.
 *
 * The outage is simulated in front of the real client: `@/lib/prisma` is the
 * application client with one query extension that answers every call with
 * Prisma's "can't reach database server" error (P1001) while `outage.down` is
 * set, or for the calls `outage.fail` picks, before or after the call reaches
 * PostgreSQL (a write that commits and whose reply is lost). Everything else
 * is real: the once-ever claim, the spool on a real temporary directory, the
 * sweep, the alert's `EmailLog` row and its hand-over claim (#5298), and the
 * email retry job. Only the delivery policy and the mail transport are
 * replaced, as `stranded-queued-email.realdb.test.ts` replaces them.
 *
 * 1. Every call fails: nothing is sent or written and one file is spooled.
 *    Once the database answers, three sweeps send the alert exactly once.
 * 2. The claim commits but its reply is lost, and its give-back fails too:
 *    the sweep gives the claim back after 15 minutes, then sends once.
 * 3. Only the owed row's write fails: the alert goes out at once, and the
 *    file it left is settled by the sweep with no second send.
 * 4. A crash after the alert's `EmailLog` row (the claim is kept, the row
 *    `QUEUED`): the spooled file is settled without a send, and the stranded
 *    email is sent once, by the retry job.
 *
 * Ordinary Vitest runs skip the file; Sekreton's `kept-change-realdb` check
 * runs it against a disposable loopback PostgreSQL. It cleans its own
 * `race-5297` rows, and counts mail and rows by its own admin's address.
 */
import { readdirSync, rmSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

type FailPoint = "before" | "after" | null;
const outage = vi.hoisted(() => ({
  down: false,
  fail: null as null | ((model: string | undefined, operation: string, args: unknown) => FailPoint),
}));

vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/prisma");
  const { Prisma } = await import("@prisma/client");
  const unreachable = () =>
    new Prisma.PrismaClientKnownRequestError("Can't reach database server at 127.0.0.1", {
      code: "P1001",
      clientVersion: Prisma.prismaVersion.client,
    });
  const prisma = real.prisma.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        const point = outage.down ? "before" : (outage.fail?.(model, operation, args) ?? null);
        if (point === "before") throw unreachable();
        const result = await query(args);
        if (point === "after") throw unreachable();
        return result;
      },
    },
  });
  return { ...real, prisma };
});

const transport = vi.hoisted(() => ({
  sendMail: vi.fn(),
  /** When set, the next `getEmailTransporter` never returns: the process "stops" there. */
  crashNext: false,
  crashed: false,
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
    return Promise.resolve({ transporter: { sendMail: transport.sendMail }, modeLabel: "race-5297 fake transport" });
  }),
}));

const P = "race-5297";
const ADMIN_ID = `${P}-admin`;
const ADMIN_EMAIL = `admin@${P}.test`;
const FIFTEEN_MINUTES = 15 * 60_000;
const THIRTY_ONE_MINUTES = 31 * 60_000;
const FIRST_CREATED = new Date(Date.UTC(2000, 0, 1));

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let replayable: typeof import("@/lib/admin-alert-once-replayable");
let sweep: typeof import("@/lib/admin-alert-once-sweep");
let readOnceEverClaimState: (typeof import("@/lib/admin-alert-once"))["readOnceEverClaimState"];
let retryFailedEmails: (typeof import("@/lib/cron-email-retry"))["retryFailedEmails"];

(RUN ? describe : describe.skip)("an admin alert raised during a database outage - real PostgreSQL (#5297)", { timeout: 120_000 }, () => {
  const spoolDir = () => process.env.ADMIN_ALERT_SPOOL_DIR!;
  const spooled = () => {
    try {
      return readdirSync(spoolDir()).length;
    } catch {
      return 0;
    }
  };
  const mails = () =>
    transport.sendMail.mock.calls.filter(([message]) => (message as { to: string }).to === ADMIN_EMAIL).length;
  const emailRows = () => prisma.emailLog.count({ where: { to: ADMIN_EMAIL } });
  const cooldownRows = () => prisma.alertCooldown.count({ where: { key: { contains: P } } });
  const moveClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

  /** Raise this case's raised-once alert, as `xero-success-after-resolution-alert.ts` does. */
  const raise = (key: string) =>
    replayable.sendReplayableAdminAlertOnceEver({
      key,
      label: `${P} alert`,
      context: { case: key },
      alert: {
        kind: "xero-sync-error",
        errorType: "XERO_SUCCESS_AFTER_RESOLUTION",
        operation: `${P} operation`,
        errorMessage: `${P}: check Xero`,
        timestamp: new Date().toISOString(),
      },
    });

  /** The owed row's write never reaches PostgreSQL; everything else does. */
  const refuseOwedRow = (key: string) => (model: string | undefined, operation: string, args: unknown): FailPoint =>
    model === "AlertCooldown" && operation === "create" && (args as { data: { key: string } }).data.key === replayable.onceEverOwedKey(key)
      ? "before"
      : null;

  async function clean() {
    await prisma.alertCooldown.deleteMany({ where: { key: { contains: P } } });
    await prisma.emailLog.deleteMany({ where: { to: ADMIN_EMAIL } });
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "admin alert database outage proof");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    replayable = await import("@/lib/admin-alert-once-replayable");
    sweep = await import("@/lib/admin-alert-once-sweep");
    ({ readOnceEverClaimState } = await import("@/lib/admin-alert-once"));
    ({ retryFailedEmails } = await import("@/lib/cron-email-retry"));
    await clean();
    await prisma.memberAccessRole.deleteMany({ where: { memberId: ADMIN_ID } });
    await prisma.member.deleteMany({ where: { id: ADMIN_ID } });
    await prisma.member.create({
      data: {
        id: ADMIN_ID, email: ADMIN_EMAIL, passwordHash: "not-a-real-password", firstName: "Outage", lastName: "Admin",
        ageTier: "ADULT", role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } },
      },
    });
  }, 60_000);

  beforeEach(async () => {
    outage.down = false;
    outage.fail = null;
    await clean();
    rmSync(spoolDir(), { recursive: true, force: true });
    transport.sendMail.mockReset();
    transport.sendMail.mockResolvedValue({ messageId: `${P}-message` });
    transport.crashNext = false;
    transport.crashed = false;
  });

  afterAll(async () => {
    if (typeof prisma === "undefined") return;
    outage.down = false;
    outage.fail = null;
    try {
      await clean();
      await prisma.memberAccessRole.deleteMany({ where: { memberId: ADMIN_ID } });
      await prisma.member.deleteMany({ where: { id: ADMIN_ID } });
    } finally {
      rmSync(spoolDir(), { recursive: true, force: true });
      await prisma.$disconnect().catch(() => {});
    }
  });

  it("delivers an alert raised while every database call fails exactly once, after the database answers", async () => {
    const key = `${P}:every-call-fails`;
    outage.down = true;
    await expect(raise(key)).resolves.toBe(false);
    await expect(sweep.sweepOnceEverAlerts(), "a sweep while still down").resolves.toMatchObject({ spooled: 0, resent: 0 });
    outage.down = false;

    expect(mails()).toBe(0);
    await expect(emailRows()).resolves.toBe(0);
    await expect(cooldownRows()).resolves.toBe(0);
    expect(spooled()).toBe(1);

    await expect(sweep.sweepOnceEverAlerts()).resolves.toMatchObject({ spooled: 1, resent: 1, failed: 0 });
    moveClock(FIFTEEN_MINUTES);
    await sweep.sweepOnceEverAlerts();
    moveClock(FIFTEEN_MINUTES);
    await sweep.sweepOnceEverAlerts();
    await expect(raise(key), "the caller raising it again").resolves.toBe(false);

    expect(mails()).toBe(1);
    await expect(emailRows()).resolves.toBe(1);
    expect(spooled()).toBe(0);
    await expect(readOnceEverClaimState(key, new Date())).resolves.toBe("kept");
    await expect(prisma.alertCooldown.count({ where: { key: replayable.onceEverOwedKey(key) } })).resolves.toBe(0);
  });

  it("sends once when the claim committed but its reply was lost and its give-back failed", async () => {
    const key = `${P}:claim-reply-lost`;
    const owedRow = refuseOwedRow(key);
    outage.fail = (model, operation, args) => {
      if (model === "AlertCooldown" && operation === "create" && (args as { data: { key: string } }).data.key === key) {
        // The claim lands, the reply is lost, and the database stays down for the give-back.
        outage.down = true;
        return "after";
      }
      return owedRow(model, operation, args);
    };
    await expect(raise(key)).resolves.toBe(false);
    outage.down = false;
    outage.fail = null;

    expect(mails()).toBe(0);
    expect(spooled()).toBe(1);
    await expect(readOnceEverClaimState(key, new Date())).resolves.toBe("awaiting-send");

    await expect(sweep.sweepOnceEverAlerts(), "the claim is not yet stale").resolves.toMatchObject({ spooled: 1, released: 0, resent: 0 });
    expect(mails()).toBe(0);
    moveClock(FIFTEEN_MINUTES + 60_000);
    await expect(sweep.sweepOnceEverAlerts()).resolves.toMatchObject({ released: 1, resent: 1, failed: 0 });
    moveClock(FIFTEEN_MINUTES);
    await sweep.sweepOnceEverAlerts();

    expect(mails()).toBe(1);
    await expect(emailRows()).resolves.toBe(1);
    expect(spooled()).toBe(0);
  });

  it("settles a spooled file whose alert went out meanwhile, without a second send", async () => {
    const key = `${P}:only-owed-row-fails`;
    outage.fail = refuseOwedRow(key);
    await expect(raise(key)).resolves.toBe(true);
    outage.fail = null;
    expect(mails()).toBe(1);
    expect(spooled()).toBe(1);

    await expect(sweep.sweepOnceEverAlerts()).resolves.toMatchObject({ spooled: 1, settled: 1, resent: 0 });
    moveClock(FIFTEEN_MINUTES);
    await sweep.sweepOnceEverAlerts();

    expect(mails()).toBe(1);
    await expect(emailRows()).resolves.toBe(1);
    expect(spooled()).toBe(0);
    await expect(cooldownRows(), "only the kept claim").resolves.toBe(1);
  });

  it("leaves an alert a crash stranded QUEUED to the retry job, which sends it once; the spool sends nothing", async () => {
    const key = `${P}:crash-after-email-row`;
    outage.fail = refuseOwedRow(key);
    transport.crashNext = true;
    // Never settles: the sender "stops" between its QUEUED row and the hand-over.
    void raise(key);
    await vi.waitFor(() => expect(transport.crashed).toBe(true), { timeout: 30_000 });
    outage.fail = null;

    const [row] = await prisma.emailLog.findMany({ where: { to: ADMIN_EMAIL } });
    expect(row).toEqual(expect.objectContaining({ status: "QUEUED", handoverState: "PENDING" }));
    // Ahead of any FAILED rows other suites left, so the retry job reaches it this run.
    await prisma.emailLog.update({ where: { id: row!.id }, data: { createdAt: FIRST_CREATED } });
    expect(spooled()).toBe(1);

    await expect(sweep.sweepOnceEverAlerts()).resolves.toMatchObject({ spooled: 1, settled: 1, resent: 0 });
    expect(mails()).toBe(0);

    moveClock(THIRTY_ONE_MINUTES);
    await retryFailedEmails();
    await sweep.sweepOnceEverAlerts();
    moveClock(THIRTY_ONE_MINUTES);
    await retryFailedEmails();
    await sweep.sweepOnceEverAlerts();

    expect(mails()).toBe(1);
    await expect(emailRows()).resolves.toBe(1);
    expect(spooled()).toBe(0);
  });
});
