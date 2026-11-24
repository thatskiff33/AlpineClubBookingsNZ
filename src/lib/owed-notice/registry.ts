/**
 * #5433: every kind of owed notice this release can deliver, and every place
 * its markers can be. A kind added here is swept by both jobs that run the
 * drain; a kind not listed is left alone (`./drain.ts`). The kinds a marker may
 * be written with are `OWED_NOTICE_KINDS` (`./kinds.ts`), and
 * `owed-notice-registry.test.ts` holds that list and this one equal.
 *
 * Built on first use, never at import: a deliverer's module may import the
 * drain (the confirm-pending job does), the drain imports this module, and this
 * module imports the deliverers. Reading their exports only when a drain runs,
 * after every module has loaded, keeps that cycle harmless whatever order the
 * modules load in.
 */
import { BUMP_NOTICE_DELIVERERS, legacyBumpMarkerSource } from "@/lib/booking-bump-notice-owed";
import { owedNoticeTableSource, type OwedNoticeDeliverer, type OwedNoticeSource } from "@/lib/owed-notice/deliver";
import { WAITLIST_LAPSE_NOTICE_DELIVERERS } from "@/lib/waitlist-offer-expired-notice";
import { WAITLIST_OFFER_NOTICE_DELIVERERS } from "@/lib/waitlist-offer-notices";

export interface OwedNoticeRegistry {
  deliverers: readonly OwedNoticeDeliverer[];
  /**
   * The `OwedNotice` table, and the bump markers a release before #5433 wrote
   * to `AlertCooldown` (it may still be running beside this one, and its
   * markers outlive the deploy). The legacy source goes once two minor
   * releases have shipped with the table (`docs/UPGRADING.md`, principle 5;
   * #5433's last pull request).
   */
  sources: readonly OwedNoticeSource[];
}

let registry: OwedNoticeRegistry | null = null;

export function owedNoticeRegistry(): OwedNoticeRegistry {
  registry ??= {
    deliverers: [...BUMP_NOTICE_DELIVERERS, ...WAITLIST_OFFER_NOTICE_DELIVERERS, ...WAITLIST_LAPSE_NOTICE_DELIVERERS],
    sources: [owedNoticeTableSource, legacyBumpMarkerSource],
  };
  return registry;
}
