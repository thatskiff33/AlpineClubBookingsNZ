/** #4695: prove the provider-call probe against real, independently pooled clients. */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { openClientTransactionsElsewhere } from "./support/open-client-transactions";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const WRITER_NAME = "race-4695-writer";

(RUN ? describe : describe.skip)("provider-call transaction probe - real PostgreSQL (#4695)", () => {
  let observer: PrismaClient;
  let writer: PrismaClient;
  let webhook: PrismaClient;

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "#4695 transaction probe");
    const { PrismaClient } = await import("@prisma/client");
    const { createPrismaPgAdapter } = await import("@/lib/prisma-adapter");
    const client = (name: string) => {
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("application_name", name);
      url.searchParams.set("connection_limit", "1");
      return new PrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
    };
    observer = client("race-4695-observer");
    writer = client(WRITER_NAME);
    webhook = client("race-4695-webhook");
  });

  afterAll(async () => {
    await Promise.all([observer?.$disconnect(), writer?.$disconnect(), webhook?.$disconnect()]);
  });

  it("does not count its own implicit read transaction", async () => {
    expect(await openClientTransactionsElsewhere(observer)).toBe(0);
  });

  it("catches a provider callback awaited inside the app's transaction and reports its backend", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stripeCall = async () => openClientTransactionsElsewhere(observer);
      // The callback must finish before this transaction can commit. Waiting
      // for unrelated work to drain must never let this violation pass.
      const count = await writer.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1`;
        return stripeCall();
      });
      expect(count).toBe(1);
      expect(diagnostic).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({
        pid: expect.any(Number),
        query: expect.any(String),
        xact_start: expect.any(Date),
        application_name: WRITER_NAME,
      })]);
      expect(await openClientTransactionsElsewhere(observer)).toBe(0);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("waits for an independent transaction to finish", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const transaction = writer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1`;
      entered();
      await released;
    });
    let probe: Promise<number> | undefined;
    try {
      await started;
      let completed = false;
      probe = openClientTransactionsElsewhere(observer).then((count) => {
        completed = true;
        return count;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(completed).toBe(false);
    } finally {
      release();
      await transaction;
      await probe;
    }
    expect(await probe).toBe(0);
  });

  it("excludes the held webhook connection while still catching the app transaction", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await webhook.$transaction(async (webhookTx) => {
        await webhookTx.$executeRaw`SELECT 1`;
        const options = { excludeApplicationName: "race-4695-webhook" };
        expect(await openClientTransactionsElsewhere(observer, options)).toBe(0);
        await writer.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT 1`;
          expect(await openClientTransactionsElsewhere(observer, options)).toBe(1);
        });
      });
    } finally {
      diagnostic.mockRestore();
    }
  });
});
