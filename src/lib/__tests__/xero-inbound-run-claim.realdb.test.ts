/** #4432: use only the existing disposable concurrency database, never DATABASE_URL. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL_TEXT = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const JOB = "xero-inbound-reconcile";
let runner: typeof import("@/lib/xero-cron-runner");
let service: typeof import("@/lib/xero-sync-now");
let claim: typeof import("@/lib/cron-run-claim");
const spies: Array<{ mockRestore(): void }> = [];
const cycle = { inbound: { batches: 1, found: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0 }, contactReconciliation: null, membershipReconciliation: null, invoiceReconciliation: null };

(RUN ? describe : describe.skip)("Xero inbound shared run claim, real PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL_TEXT, "Xero inbound shared run claim");
    process.env.DATABASE_URL = URL_TEXT;
    runner = await import("@/lib/xero-cron-runner");
    service = await import("@/lib/xero-sync-now");
    claim = await import("@/lib/cron-run-claim");
    const cron = await import("@/lib/cron-job-run");
    spies.push(vi.spyOn(cron, "recordCronJobRunSafe").mockResolvedValue(undefined));
    const modules = await import("@/lib/admin-modules");
    const tokens = await import("@/lib/xero-token-store");
    const format = await import("@/lib/club-format-server");
    const alerts = await import("@/lib/xero-inbound/cash-settlement-alert-retry");
    spies.push(vi.spyOn(modules, "isEffectiveModuleEnabled").mockResolvedValue(true));
    spies.push(vi.spyOn(tokens, "isXeroConnected").mockResolvedValue(true));
    spies.push(vi.spyOn(format, "clubFormatValues").mockResolvedValue(CLUB_FORMAT_TEST));
    spies.push(vi.spyOn(alerts, "retryCashSettlementAlerts").mockResolvedValue(0));
  });
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();

  });

  it.each(["scheduled", "manual"])("refuses the other entry point while %s holds the claim", async (holder) => {
    const inbound = await import("@/lib/xero-inbound-reconciliation");
    const mirror = await import("@/lib/xero-credit-note-mirror-sweep");
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(inbound, "runXeroInboundReconciliationCycle").mockImplementation(async () => { entered(); await gate; return cycle; });
    const sweep = vi.spyOn(mirror, "runCreditNoteMirrorSweep").mockResolvedValue({ skipped: false, read: 0, writtenDown: 0, restored: 0, refused: {}, readFailures: 0, mirrorFailures: 0, completePass: true });
    const first = holder === "manual" ? service.syncClubFromXeroNow() : runner.runXeroInboundCronCycle();
    try {
      await ready;
      const refused = holder === "manual" ? await runner.runXeroInboundCronCycle() : await service.syncClubFromXeroNow();
      expect(refused.message).toBe("A sync is already running.");
      expect(read).toHaveBeenCalledOnce(); expect(sweep).not.toHaveBeenCalled();
    } finally { release(); await first; read.mockRestore(); sweep.mockRestore(); }
    expect(await claim.withCronRunClaim(JOB, async () => "next")).toEqual({ claimed: true, result: "next" });
  });

  it("recovers a dead holder's database session without waiting for a lease expiry", async () => {
    const { Client } = await import("pg");
    const dead = new Client({ connectionString: URL_TEXT });
    dead.on("error", () => {});
    await dead.connect();
    await dead.query("SELECT pg_advisory_lock(hashtext('cron-run-claim'), hashtext($1))", [JOB]);
    try {
      expect(await claim.withCronRunClaim(JOB, async () => "must not run")).toEqual({ claimed: false });
      const observer = new Client({ connectionString: URL_TEXT });
      await observer.connect();
      try {
        const { rows } = await dead.query("SELECT pg_backend_pid() AS pid");
        await observer.query("SELECT pg_terminate_backend($1, 5000)", [rows[0].pid]);
      } finally { await observer.end(); }
    } finally { await dead.end(); }
    expect(await claim.withCronRunClaim(JOB, async () => "recovered")).toEqual({ claimed: true, result: "recovered" });
  });
  it("releases a failed cycle so another invocation can run immediately", async () => {
    await expect(claim.withCronRunClaim(JOB, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(await claim.withCronRunClaim(JOB, async () => "next")).toEqual({ claimed: true, result: "next" });
  });

  // #4922: the webhook's after-response kick shares the claim but never waits on it.
  describe("webhook kick", () => {
    const KEY = "xero:webhook:test:4922-kick";
    let prisma: (typeof import("@/lib/prisma"))["prisma"];
    const steps: Array<{ mock: { calls: unknown[] }; mockClear(): void; mockRestore(): void }> = [];
    async function seedReceivedEvent() {
      await prisma.xeroInboundEvent.create({ data: { eventCategory: "INVOICE", eventType: "UPDATE", correlationKey: KEY, payload: {} } });
    }
    async function cleanUp() {
      for (const step of steps) step.mockClear();
      await prisma.xeroSyncOperation.deleteMany({ where: { correlationKey: KEY } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: KEY, source: "xero" } });
      await prisma.xeroInboundEvent.deleteMany({ where: { correlationKey: KEY } });
    }
    beforeAll(async () => {
      prisma = (await import("@/lib/prisma")).prisma;
      const incremental = await import("@/lib/xero-inbound/incremental-reconciliation");
      const invoice = await import("@/lib/xero-inbound/invoice");
      const deleted = await import("@/lib/xero-inbound/deleted-payment-links");
      steps.push(vi.spyOn(incremental, "runIncrementalContactReconciliation").mockResolvedValue({ skipped: true } as never));
      steps.push(vi.spyOn(incremental, "runIncrementalMembershipReconciliation").mockResolvedValue({ skipped: true } as never));
      steps.push(vi.spyOn(invoice, "runIncrementalInvoiceReconciliation").mockResolvedValue({ skipped: true } as never));
      steps.push(vi.spyOn(deleted, "recheckPendingDeletedPaymentLinks").mockResolvedValue({ skipped: true } as never));
    });
    afterAll(async () => {
      for (const step of steps) step.mockRestore();
      await cleanUp();
    });

    it("applies a stored event but leaves every cursor reconciliation to the holder", async () => {
      await cleanUp();
      await seedReceivedEvent();
      const { Client } = await import("pg");
      const holder = new Client({ connectionString: URL_TEXT });
      await holder.connect();
      try {
        await holder.query("SELECT pg_advisory_lock(hashtext('cron-run-claim'), hashtext($1))", [JOB]);
        const kick = await runner.runXeroWebhookInboundKick({ batchSize: 10, maxBatches: 3 });
        expect(kick.claimed).toBe(false);
      } finally { await holder.end(); }
      expect(await prisma.xeroInboundEvent.findUnique({ where: { correlationKey: KEY }, select: { status: true } })).toEqual({ status: "PROCESSED" });
      for (const step of steps) expect(step.mock.calls).toHaveLength(0);
    });

    it("runs the whole cycle when the claim is free, then releases it", async () => {
      await cleanUp();
      await seedReceivedEvent();
      const kick = await runner.runXeroWebhookInboundKick({ batchSize: 10, maxBatches: 3 });
      expect(kick.claimed).toBe(true);
      expect(await prisma.xeroInboundEvent.findUnique({ where: { correlationKey: KEY }, select: { status: true } })).toEqual({ status: "PROCESSED" });
      for (const step of steps) expect(step.mock.calls).toHaveLength(1);
      expect(await claim.withCronRunClaim(JOB, async () => "next")).toEqual({ claimed: true, result: "next" });
    });
  });
});
