import type { Prisma } from "@prisma/client";

/**
 * Single-flight configuration import and lodge-identity mutation lock. Lodge
 * create/rename shares this key so an import's bundle-slug to lodge-id mapping
 * cannot change after affected lodge locks are selected. The Xero account
 * mapping save (`saveXeroAccountMappings`, #5391) takes it too, alone, so its
 * Opening Credits shared-account check and its writes cannot interleave with
 * another save or with an import's Xero category.
 */
export async function acquireConfigImportLock(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('config-transfer-import'))`;
}
