/**
 * HOW FRESH is the local Xero contact cache — asked in one place (#3058).
 *
 * Two screens now depend on the answer and they must not disagree about it.
 * The missing-contact census (`INV-INT-022`) refuses to run at all while the
 * cache has never been refreshed, because every member then looks like "no
 * contact in Xero" — the one answer that produces duplicates. The erased-member
 * contact review (`INV-INT-024`) uses it for the weaker but related reason that
 * a stale cache can report a contact as still active in Xero after a treasurer
 * archived it.
 *
 * They read the SAME cursor row against the SAME threshold, so the cursor's
 * identity and the threshold are one fact and live here (`INV-SSOT`). Before
 * this module the census held the read inline; a second inline copy would have
 * let one screen call the cache a week old and the other call it current.
 *
 * Deliberately a LEAF next to `prisma`: it does not reach
 * `xero-contact-cache.ts`, which is where the cursor is written but which also
 * pulls in `xero-node` and the API client. A caller that only wants to know how
 * old a table is should not drag the provider SDK into its module graph.
 */

import { prisma } from "./prisma";
import {
  CONTACT_SYNC_CURSOR_RESOURCE,
  DEFAULT_XERO_SYNC_SCOPE,
} from "./xero-inbound/constants";
import { CONTACT_CACHE_STALE_AFTER_MS } from "./xero-missing-contact-seeding-shape";

export interface XeroContactCacheFreshness {
  /**
   * When the contact sync last completed, ISO, or `null` when it never has.
   * `null` is not "fresh" and not "stale" — it is "there is no cache", which
   * each caller answers for itself.
   */
  lastRefreshedAt: string | null;
  /** Whole hours since then, or `null` alongside a `null` timestamp. */
  ageHours: number | null;
  /** Old enough to mislead. Always `false` when there is no cache at all. */
  stale: boolean;
}

export async function readXeroContactCacheFreshness(): Promise<XeroContactCacheFreshness> {
  const cursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
      },
    },
    select: { lastSuccessfulSyncAt: true },
  });
  const lastRefreshedAt = cursor?.lastSuccessfulSyncAt?.toISOString() ?? null;
  if (!lastRefreshedAt) {
    return { lastRefreshedAt: null, ageHours: null, stale: false };
  }
  const ageMs = Date.now() - new Date(lastRefreshedAt).getTime();
  return {
    lastRefreshedAt,
    ageHours: Math.max(0, Math.floor(ageMs / 3_600_000)),
    stale: ageMs > CONTACT_CACHE_STALE_AFTER_MS,
  };
}
