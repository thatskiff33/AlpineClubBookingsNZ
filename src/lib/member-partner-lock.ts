import type { Prisma } from "@prisma/client";
import { compareMemberIds } from "@/lib/member-partner-link-shared";

/** Acquire canonical partner-link locks in deterministic member-id order. */
export async function acquireMemberPartnerLinkLocks(
  tx: Prisma.TransactionClient,
  memberIds: readonly string[],
): Promise<void> {
  for (const memberId of [
    ...new Set(memberIds.filter(Boolean)),
  ].sort(compareMemberIds)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-partner-link:${memberId}`}))`;
  }
}
