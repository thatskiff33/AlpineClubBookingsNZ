/**
 * Real-PostgreSQL proof for #4988 (`INV-PAY-153`): an opening-credit file posts
 * once even when two officers confirm it at the same moment, the post queues
 * behind a member's credit-ledger lock, a reversal refuses a batch whose
 * credit has been spent and reverses one that has not (leaving no lot behind),
 * and a corrected file cannot credit a member twice.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/opening-credit-batch.realdb.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const ADMIN_ID = "race-4988-officer";
const MEMBER_A = "race-4988-member-a";
const MEMBER_B = "race-4988-member-b";
const MEMBER_IDS = [ADMIN_ID, MEMBER_A, MEMBER_B];
const FILE = `Member ID,Amount\n${MEMBER_A},40\n${MEMBER_B},12.50\n`;

function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) throw new Error("The race DB must be loopback-only.");
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) throw new Error("The race DB name must carry 'concurrency_race_1881'.");
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let credit: typeof import("@/lib/member-credit");
let batches: typeof import("@/lib/opening-credit-batch");
let creditLots: typeof import("@/lib/xero-applied-credit-lots");
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;
let lockHolderClient: import("@prisma/client").PrismaClient;
let observerClient: import("@prisma/client").PrismaClient;

(RUN ? describe : describe.skip)("#4988: an opening-credit batch posts once and reverses only unspent - real PostgreSQL", { timeout: 60_000 }, () => {
  async function deleteFixtures() {
    await prisma.memberCredit.deleteMany({ where: { memberId: { in: MEMBER_IDS } } });
    await prisma.openingCreditBatch.deleteMany({ where: { postedById: ADMIN_ID } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: { in: MEMBER_IDS } }, { actorMemberId: { in: MEMBER_IDS } }] } });
    await prisma.member.deleteMany({ where: { id: { in: MEMBER_IDS } } });
  }

  async function seed() {
    await deleteFixtures();
    await prisma.member.createMany({
      data: [
        { id: ADMIN_ID, email: "race-4988-officer@example.invalid", passwordHash: "x", firstName: "Opening", lastName: "Officer", role: "ADMIN", ageTier: "ADULT" },
        { id: MEMBER_A, email: "race-4988-a@example.invalid", passwordHash: "x", firstName: "Ana", lastName: "Carried", role: "USER", ageTier: "ADULT" },
        { id: MEMBER_B, email: "race-4988-b@example.invalid", passwordHash: "x", firstName: "Ben", lastName: "Carried", role: "USER", ageTier: "ADULT" },
      ],
    });
  }

  async function previewed() {
    const result = await batches.buildOpeningCreditPreview(FILE);
    if (!result.ok || !result.preview.batchKey) throw new Error("the fixture file should preview cleanly");
    return { csvText: FILE, expectedBatchKey: result.preview.batchKey, expectedTotalCents: result.preview.totalCents, adminId: ADMIN_ID };
  }

  async function waitUntilBlockedBy(holderPid: number) {
    const startedAt = process.hrtime.bigint();
    while (realElapsedMs(startedAt) < 5_000) {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
      `;
      if ((rows[0]?.count ?? 0) >= 1) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
    harnessRole = declareEnvironmentRoleForSuite("non-production");
    credit = await import("@/lib/member-credit");
    batches = await import("@/lib/opening-credit-batch");
    creditLots = await import("@/lib/xero-applied-credit-lots");
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
    const separate = (applicationName: string) => {
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("application_name", applicationName);
      return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
    };
    lockHolderClient = separate("race-4988-lock-holder");
    observerClient = separate("race-4988-observer");
    await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())));
    try {
      if (typeof prisma !== "undefined") {
        try {
          await deleteFixtures();
        } finally {
          await prisma.$disconnect().catch(() => {});
        }
      }
    } finally {
      harnessRole?.restore();
    }
  });

  it("posts one batch when two officers confirm the same file at once, and no balance doubles", async () => {
    await seed();
    const input = await previewed();
    const outcomes = await Promise.allSettled([batches.postOpeningCreditBatch(input), batches.postOpeningCreditBatch(input)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const [refused] = outcomes.filter((outcome) => outcome.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(batches.OpeningCreditBatchAlreadyPostedError);

    expect(await prisma.openingCreditBatch.count({ where: { postedById: ADMIN_ID } })).toBe(1);
    expect(await credit.getMemberCreditBalance(MEMBER_A)).toBe(4_000);
    expect(await credit.getMemberCreditBalance(MEMBER_B)).toBe(1_250);
    expect(await prisma.auditLog.count({ where: { action: "member.credit.opening_batch.post" } })).toBeGreaterThanOrEqual(1);

    // A later confirm of the same file is refused at the preview check too.
    await expect(batches.postOpeningCreditBatch(input)).rejects.toBeInstanceOf(batches.OpeningCreditBatchAlreadyPostedError);
    expect(await credit.getMemberCreditBalance(MEMBER_A)).toBe(4_000);
  });

  it("queues behind a member's credit-ledger lock and posts once it is released", async () => {
    await seed();
    const input = await previewed();
    let holderPid = 0;
    const holding = deferred();
    const release = deferred();
    const held = lockHolderClient.$transaction(async (tx) => {
      await credit.lockMemberCreditLedger(MEMBER_B, tx);
      holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      holding.resolve();
      await release.promise;
    }, { timeout: 30_000, maxWait: 10_000 });
    await holding.promise;

    const posting = batches.postOpeningCreditBatch(input);
    expect(await waitUntilBlockedBy(holderPid), "the post queues behind the member's key").toBe(true);
    expect(await credit.getMemberCreditBalance(MEMBER_A)).toBe(0);
    release.resolve();
    await held;
    await expect(posting).resolves.toMatchObject({ totalCents: 5_250, rowCount: 2 });
    expect(await credit.getMemberCreditBalance(MEMBER_B)).toBe(1_250);
  });

  it("refuses to reverse a batch with a spent credit and writes nothing", async () => {
    await seed();
    const posted = await batches.postOpeningCreditBatch(await previewed());
    // The member spends some of the carried-over credit.
    await prisma.memberCredit.create({
      data: { memberId: MEMBER_B, amountCents: -500, type: "ADMIN_ADJUSTMENT", description: "race 4988 spends some" },
    });
    await expect(batches.reverseOpeningCreditBatch({ batchId: posted.batchId, reason: "wrong file", adminId: ADMIN_ID })).rejects.toMatchObject({
      status: 409,
    });
    expect(await prisma.openingCreditBatch.findUnique({ where: { id: posted.batchId }, select: { reversedAt: true } })).toEqual({ reversedAt: null });
    expect(await credit.getMemberCreditBalance(MEMBER_A)).toBe(4_000);
    expect(await credit.getMemberCreditBalance(MEMBER_B)).toBe(750);
  });

  it("refuses a deduction committed after posting by a transaction that began before it", async () => {
    await seed();
    // Extra noteless funds keep the balance above the opening credit, so the
    // balance and allocation guards cannot mask a missed deduction.
    await prisma.memberCredit.createMany({ data: [
      { memberId: MEMBER_B, amountCents: 2000, type: "ADMIN_ADJUSTMENT", description: "Other funds" },
      { memberId: MEMBER_B, amountCents: -100, type: "ADMIN_ADJUSTMENT", description: "Prior deduction" },
    ] });
    const input = await previewed();
    const started = deferred();
    const spend = deferred<Date>();
    const spending = lockHolderClient.$transaction(async (tx) => {
      // Force the real PostgreSQL transaction to begin before the batch posts.
      await tx.$queryRaw`SELECT CURRENT_TIMESTAMP`;
      started.resolve();
      // The test clock is frozen, so stamp the row as a column default of
      // CURRENT_TIMESTAMP would: at this transaction's start, before the post.
      const stampedAt = await spend.promise;
      await credit.lockMemberCreditLedger(MEMBER_B, tx);
      return tx.memberCredit.create({ data: {
        memberId: MEMBER_B, amountCents: -500, type: "ADMIN_ADJUSTMENT", description: "Later deduction, older transaction", createdAt: stampedAt },
      });
    }, { timeout: 30_000, maxWait: 10_000 });
    await started.promise;
    let posted: Awaited<ReturnType<typeof batches.postOpeningCreditBatch>> | undefined;
    try {
      posted = await batches.postOpeningCreditBatch(input);
    } finally {
      spend.resolve(new Date((posted?.postedAt.getTime() ?? Date.UTC(2026, 6, 1)) - 1000));
    }
    const deducted = await spending;
    if (!posted) throw new Error("the batch did not post");
    expect(deducted.createdAt.getTime()).toBeLessThan(posted.postedAt.getTime());
    expect(await credit.getMemberCreditBalance(MEMBER_B)).toBe(2650);
    expect(await prisma.openingCreditBatch.findUnique({ where: { id: posted.batchId }, select: { negativeCreditCountAtPost: true } })).toEqual({ negativeCreditCountAtPost: 1 });
    await expect(batches.reverseOpeningCreditBatch({ batchId: posted.batchId, reason: "wrong file", adminId: ADMIN_ID })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.memberCredit.count({ where: { openingCreditBatchId: posted.batchId, amountCents: { lt: 0 } } })).toBe(0);
    expect(await prisma.openingCreditBatch.findUnique({ where: { id: posted.batchId }, select: { reversedAt: true } })).toEqual({ reversedAt: null });
  });

  it("reverses a batch left whole, once, when two officers reverse it at the same moment", async () => {
    await seed();
    const posted = await batches.postOpeningCreditBatch(await previewed());
    const reversals = await Promise.allSettled([
      batches.reverseOpeningCreditBatch({ batchId: posted.batchId, reason: "wrong file", adminId: ADMIN_ID }),
      batches.reverseOpeningCreditBatch({ batchId: posted.batchId, reason: "wrong file", adminId: ADMIN_ID }),
    ]);
    expect(reversals.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await credit.getMemberCreditBalance(MEMBER_A)).toBe(0);
    expect(await credit.getMemberCreditBalance(MEMBER_B)).toBe(0);
    expect(await prisma.openingCreditBatch.findUnique({ where: { id: posted.batchId }, select: { reversedById: true, reversalReason: true } })).toEqual({
      reversedById: ADMIN_ID,
      reversalReason: "wrong file",
    });
    // A reversed batch's credits are no longer lots a booking can draw on.
    const lots = await prisma.$transaction((tx) => creditLots.loadFreeCreditLots(tx, [MEMBER_A, MEMBER_B]));
    expect(lots.get(MEMBER_A)?.lots).toEqual([]);
    expect(lots.get(MEMBER_B)?.lots).toEqual([]);
  });

  it("refuses a corrected file naming a member who still holds an opening credit, until that batch is reversed", async () => {
    await seed();
    const posted = await batches.postOpeningCreditBatch(await previewed());
    const corrected = `Member ID,Amount\n${MEMBER_A},45\n`;
    const refused = await batches.buildOpeningCreditPreview(corrected);
    expect(refused.ok && refused.preview.batchKey).toBe(null);
    expect(refused.ok && refused.preview.rows[0]?.errors[0]).toMatch(/already has an opening credit/);

    await batches.reverseOpeningCreditBatch({ batchId: posted.batchId, reason: "wrong amounts", adminId: ADMIN_ID });
    const allowed = await batches.buildOpeningCreditPreview(corrected);
    if (!allowed.ok || !allowed.preview.batchKey) throw new Error("the corrected file should preview cleanly once reversed");
    await batches.postOpeningCreditBatch({
      csvText: corrected,
      expectedBatchKey: allowed.preview.batchKey,
      expectedTotalCents: allowed.preview.totalCents,
      adminId: ADMIN_ID,
    });
    expect(await credit.getMemberCreditBalance(MEMBER_A)).toBe(4_500);
    expect(await credit.getMemberCreditBalance(MEMBER_B)).toBe(0);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
