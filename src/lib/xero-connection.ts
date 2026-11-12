/**
 * Where every reader asks "is Xero connected, to which tenant, until when"
 * (#3806). The token store still decides whether the stored tokens are usable
 * (`getXeroTokenReadability`).
 *
 * Since #3806 the connection's non-secret facts live in `XeroConnection`, a
 * one-row table with no token, ciphertext or key in it. Every reader that used to
 * pick a `XeroToken` row for its `tenantId` or `expiresAt` — the token store's
 * `isXeroConnected`, the health check, the setup provider test, setup readiness,
 * the stored financial-year resolution, config transfer's tenant stamp and the
 * admin cache's tenant key — reads it here, so they cannot disagree.
 *
 * Dependency-free on purpose: none of those readers should pull in the token
 * store, its credential store or its crypto to learn a tenant id. It takes a
 * client so a caller inside a bounded read-only transaction reads inside that
 * transaction's snapshot and statement timeout.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma";

/** The id of the one `XeroConnection` row (a CHECK constraint in the migration). */
export const XERO_CONNECTION_ID = "default";

/** The facts a reader may have. Never a token. */
export interface XeroConnectionFacts {
  /** The connected Xero organisation, or null if the grant named none. */
  tenantId: string | null;
  /** When the stored access token expires (it is refreshed shortly before). */
  expiresAt: Date;
}

/** The delegate this module reads, so a `Prisma.TransactionClient` satisfies it. */
export type XeroConnectionReadDb = Pick<PrismaClient, "xeroConnection">;

/**
 * The connection, or `null` when Xero is not connected. Selects only the two
 * non-secret facts; there is nothing else in the row a reader could leak.
 */
export async function readXeroConnection(
  db: XeroConnectionReadDb = prisma,
): Promise<XeroConnectionFacts | null> {
  return db.xeroConnection.findUnique({
    where: { id: XERO_CONNECTION_ID },
    select: { tenantId: true, expiresAt: true },
  });
}

/** Connected means a connection row that names a tenant. */
export function isConnectedTenant(
  facts: XeroConnectionFacts | null,
): facts is XeroConnectionFacts & { tenantId: string } {
  return facts !== null && facts.tenantId !== null;
}
