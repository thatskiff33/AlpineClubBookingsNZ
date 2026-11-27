/**
 * Real-PostgreSQL proof for #5391 (folded into #5235): the Account Mapping
 * screen's save checks the Opening Credits shared-account rule and writes its
 * rows in one transaction under the configuration-import key, so two writers
 * that would each pass alone cannot both land.
 *
 * - two saves at once, one mapping Opening Credits to an account and the other
 *   mapping Goodwill & Write-Offs to the same account: both pass their first
 *   read, both queue on the key, and exactly one is written;
 * - a save beside a writer that holds the import's key (the configuration
 *   import's apply transaction takes it first): the save waits, re-reads the
 *   rows the holder committed, and is refused.
 *
 * The club is made not GST-registered for the suite, so mapping Opening Credits
 * needs no Exempt tax category and nothing asks Xero. No Xero organisation is
 * connected in this database, so no chart of accounts is cached and the class
 * check has nothing to judge.
 *
 * Ordinary Vitest runs skip the file. Sekreton's `kept-change-realdb` check
 * runs it against a disposable loopback PostgreSQL; it puts back the mapping
 * and tax rows it found.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { backendPid, raiseRaceTransactionBudget, untilBlockedBy } from "./support/race-lock-waits";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
/** An account code no mapping defaults to. */
const SHARED_CODE = "820";
const SHARED_ACCOUNT_REFUSAL =
  "Opening Credits cannot use the same Xero account as Goodwill & Write-Offs. Choose an account for Opening Credits that no other mapping uses, or change the other mapping first. No account mapping was saved.";

let prisma: PrismaClient;
let save: typeof import("@/lib/xero-account-mapping-save");
let lock: typeof import("@/lib/config-transfer-lock");
let restoreBudget: () => void = () => undefined;
let mappingsBefore: Prisma.XeroAccountMappingCreateManyInput[] = [];
let taxBefore: Prisma.ClubTaxSettingsCreateManyInput[] = [];

const storedCodes = async () =>
  Object.fromEntries(
    (await prisma.xeroAccountMapping.findMany({ select: { key: true, code: true } })).map((row) => [row.key, row.code]),
  );

/** Open a transaction, run `first` in it, and hold it open until `letGo`. */
function holdTransaction(first: (tx: Prisma.TransactionClient) => Promise<void>) {
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
      await first(tx);
      resolveStarted();
      await released;
    },
    { timeout: 20_000 },
  );
  done.catch(rejectStarted);
  return { started, pid, letGo: () => letGo(), done };
}

(RUN ? describe : describe.skip)("#5391: the account mapping save under the configuration-import key", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Xero account mapping save race");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    save = await import("@/lib/xero-account-mapping-save");
    lock = await import("@/lib/config-transfer-lock");
    // The saves under test wait behind a held key for as long as the case takes
    // to see them queue; Prisma's 5-second default must not decide the race.
    restoreBudget = raiseRaceTransactionBudget(prisma);
    mappingsBefore = await prisma.xeroAccountMapping.findMany();
    taxBefore = await prisma.clubTaxSettings.findMany();
    await prisma.clubTaxSettings.deleteMany({});
    await prisma.clubTaxSettings.create({
      data: { id: "default", gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null },
    });
  });

  beforeEach(async () => {
    await prisma.xeroAccountMapping.deleteMany({});
  });

  afterAll(async () => {
    if (!prisma) return;
    restoreBudget();
    await prisma.xeroAccountMapping.deleteMany({});
    await prisma.clubTaxSettings.deleteMany({});
    if (mappingsBefore.length > 0) await prisma.xeroAccountMapping.createMany({ data: mappingsBefore });
    if (taxBefore.length > 0) await prisma.clubTaxSettings.createMany({ data: taxBefore });
    await prisma.$disconnect();
  });

  it("each of the two saves is accepted on its own", async () => {
    await expect(save.saveXeroAccountMappings({ openingCredits: { code: SHARED_CODE } })).resolves.toMatchObject({ ok: true });
    await prisma.xeroAccountMapping.deleteMany({});
    await expect(save.saveXeroAccountMappings({ goodwillWriteOffs: { code: SHARED_CODE } })).resolves.toMatchObject({ ok: true });
  });

  it("two saves that would share an account between them: one is written, the other is refused", async () => {
    // A holder of the key stands in front of both saves, so both have read the
    // rows (no conflict yet) before either may write.
    const holder = holdTransaction((tx) => lock.acquireConfigImportLock(tx));
    await holder.started;
    const holderPid = await holder.pid;

    const openingCredits = save.saveXeroAccountMappings({ openingCredits: { code: SHARED_CODE } });
    const [firstWaiter] = await untilBlockedBy(prisma, [holderPid], 1);
    const goodwill = save.saveXeroAccountMappings({ goodwillWriteOffs: { code: SHARED_CODE } });
    await untilBlockedBy(prisma, [holderPid, firstWaiter], 2);
    holder.letGo();
    await holder.done;

    const results = await Promise.all([openingCredits, goodwill]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused).toEqual({ ok: false, status: 409, error: SHARED_ACCOUNT_REFUSAL });

    // Whichever save won, the stored rows hold the account under one role only.
    const codes = await storedCodes();
    expect(Object.values(codes).filter((code) => code === SHARED_CODE)).toHaveLength(1);
    expect(Object.keys(codes)).toEqual([results[0].ok ? "openingCredits" : "goodwillWriteOffs"]);
  });

  it("a save beside a writer holding the import's key waits, then is refused on the rows that writer committed", async () => {
    const importer = holdTransaction(async (tx) => {
      await lock.acquireConfigImportLock(tx);
      await tx.xeroAccountMapping.create({ data: { key: "goodwillWriteOffs", code: SHARED_CODE } });
    });
    await importer.started;

    const saved = save.saveXeroAccountMappings({ openingCredits: { code: SHARED_CODE } });
    await untilBlockedBy(prisma, [await importer.pid], 1);
    importer.letGo();
    await importer.done;

    await expect(saved).resolves.toEqual({ ok: false, status: 409, error: SHARED_ACCOUNT_REFUSAL });
    await expect(storedCodes()).resolves.toEqual({ goodwillWriteOffs: SHARED_CODE });
  });
});
