/** #4432: use only the existing disposable concurrency database, never DATABASE_URL. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const LOCAL_PROOF = process.env.XERO_CLAIM_LOCAL_PROOF === "1";
const RUN = LOCAL_PROOF || process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL_TEXT = LOCAL_PROOF ? "postgresql://postgres@127.0.0.1:55443/concurrency_race_1881" : process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
let localDirectory: string | undefined;
let localStarted = false;
function localPostgres(command: string, args: string[]) {
  const result = process.getuid?.() === 0
    ? spawnSync("runuser", ["-u", "postgres", "--", command, ...args], { encoding: "utf8" })
    : spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message}`);
}
const JOB = "xero-inbound-reconcile";
let runner: typeof import("@/lib/xero-cron-runner");
let service: typeof import("@/lib/xero-sync-now");
let claim: typeof import("@/lib/cron-run-claim");
const spies: Array<{ mockRestore(): void }> = [];
const cycle = { inbound: { batches: 1, found: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0 }, contactReconciliation: null, membershipReconciliation: null, invoiceReconciliation: null };

(RUN ? describe : describe.skip)("Xero inbound shared run claim, real PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(URL_TEXT);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || Number(url.port) < 55442 || !url.pathname.includes("concurrency_race_1881")) {
      throw new Error("Use a dedicated loopback concurrency_race_1881 database on port 55442+.");
    }
    if (LOCAL_PROOF) {
      localDirectory = mkdtempSync(join(tmpdir(), "xero-claim-"));
      if (process.getuid?.() === 0) {
        const uid = Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim());
        const gid = Number(spawnSync("id", ["-g", "postgres"], { encoding: "utf8" }).stdout.trim());
        chownSync(localDirectory, uid, gid);
      }
      localPostgres("initdb", ["-D", join(localDirectory, "data"), "-U", "postgres", "--auth=trust"]);
      localPostgres("pg_ctl", ["-D", join(localDirectory, "data"), "-l", join(localDirectory, "postgres.log"), "-o", `-h 127.0.0.1 -p 55443 -k ${localDirectory}`, "-w", "start"]);
      localStarted = true;
      const { Client } = await import("pg");
      const setup = new Client({ connectionString: "postgresql://postgres@127.0.0.1:55443/postgres" });
      await setup.connect();
      try { await setup.query('CREATE DATABASE "concurrency_race_1881"'); } finally { await setup.end(); }
    }
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
    if (localDirectory) {
      try { if (localStarted) localPostgres("pg_ctl", ["-D", join(localDirectory, "data"), "-m", "immediate", "-w", "stop"]); }
      finally { rmSync(localDirectory, { recursive: true, force: true }); }
    }
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
    await dead.connect();
    await dead.query("SELECT pg_advisory_lock(hashtext('cron-run-claim'), hashtext($1))", [JOB]);
    try {
      expect(await claim.withCronRunClaim(JOB, async () => "must not run")).toEqual({ claimed: false });
    } finally { await dead.end(); }
    expect(await claim.withCronRunClaim(JOB, async () => "recovered")).toEqual({ claimed: true, result: "recovered" });
  });
  it("releases a failed cycle so another invocation can run immediately", async () => {
    await expect(claim.withCronRunClaim(JOB, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(await claim.withCronRunClaim(JOB, async () => "next")).toEqual({ claimed: true, result: "next" });
  });
});
