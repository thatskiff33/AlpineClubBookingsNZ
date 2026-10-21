/**
 * #4234: a realdb suite owns its queued Xero work, including work enqueued
 * indirectly by a cancellation or hand-back. Never drain or delete another
 * suite's rows to make a processor test pass.
 *
 * Imported after the environment guard and before the realdb suites, this
 * registers a root afterAll that runs after their teardown (hooks: "stack").
 * That end-state check alone could miss a leak consumed by a later suite, so
 * every global processor consumer also calls the ownership assertion BEFORE
 * processing or parking rows. Own pending work is legitimate within a suite.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll } from "vitest";

import { assertSafeRaceDbUrl } from "./race-db-url";

/** Read-only: report every pending row not owned by these exact fixture ids. */
export async function assertNoForeignPendingXeroOperations(
  store: Pick<PrismaClient, "xeroSyncOperation">,
  ownedLocalIds: readonly string[] = [],
): Promise<void> {
  const pending = await store.xeroSyncOperation.findMany({
    where: { status: "PENDING" },
    select: { id: true, localModel: true, localId: true, queueType: true },
    orderBy: { id: "asc" },
  });
  const owned = new Set(ownedLocalIds);
  const foreign = pending.filter((row) => row.localId === null || !owned.has(row.localId));
  if (foreign.length > 0) {
    throw new Error(
      `#4234: race-harness suites leaked PENDING Xero operations; clean them in the owning suite's teardown: ${JSON.stringify(foreign)}`,
    );
  }
}

afterAll(async () => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS !== "1") return;
  const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
  assertSafeRaceDbUrl(url, "Xero outbox isolation");
  // Suites disconnect their app client. Use a separate guarded connection so
  // the final assertion also works after those teardown hooks have finished.
  const [{ PrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
    import("@prisma/client"),
    import("@/lib/prisma-adapter"),
  ]);
  const store = new PrismaClient({ adapter: createPrismaPgAdapter(url) });
  try {
    await assertNoForeignPendingXeroOperations(store);
  } finally {
    await store.$disconnect();
  }
});
