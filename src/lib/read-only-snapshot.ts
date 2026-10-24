/**
 * ONE READ-ONLY SNAPSHOT (#4285 review, `INV-SSOT`): run reads that must see
 * the database as of one moment, and can write nothing.
 *
 * `RepeatableRead` is what makes it one snapshot: under PostgreSQL's default
 * READ COMMITTED every statement takes a fresh one. `SET TRANSACTION READ ONLY`
 * makes the server refuse a write inside it (SQLSTATE `25006`); it implies no
 * snapshot, so both are set. A read-only `RepeatableRead` transaction takes no
 * lock beyond a plain read's and cannot raise a serialization failure.
 *
 * The AI diagnostics seam (`diagnostics/tools/read-only-transaction.ts`) adds a
 * statement timeout and pool bounds of its own, so it keeps its own opener.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export async function withReadOnlySnapshot<T>(
  client: Pick<PrismaClient, "$transaction">,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  /** Interactive-transaction bounds, for a long read (the ledger census). */
  bounds: { maxWait?: number; timeout?: number } = {},
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return run(tx);
    },
    { isolationLevel: "RepeatableRead", ...bounds },
  );
}
