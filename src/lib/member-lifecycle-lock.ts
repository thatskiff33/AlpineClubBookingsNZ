import type { Prisma } from "@prisma/client";

/** Acquire canonical per-member lifecycle locks in deterministic id order. */
export async function acquireMemberLifecycleLocks(
  tx: Prisma.TransactionClient,
  memberIds: readonly string[],
): Promise<void> {
  for (const memberId of [...new Set(memberIds.filter(Boolean))].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${memberId}`}))`;
  }
}
