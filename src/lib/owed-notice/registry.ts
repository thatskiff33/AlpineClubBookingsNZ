/**
 * #5433: every kind of owed notice this release can deliver, and every place
 * its markers can be. A kind added here is swept by both jobs that run the
 * drain; a kind not listed is left alone (`./drain.ts`).
 */
import { BUMP_NOTICE_DELIVERERS, legacyBumpMarkerSource } from "@/lib/booking-bump-notice-owed";
import { owedNoticeTableSource, type OwedNoticeDeliverer, type OwedNoticeSource } from "@/lib/owed-notice/deliver";

export const OWED_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer[] = [...BUMP_NOTICE_DELIVERERS];

/**
 * The `OwedNotice` table, and the bump markers a release before #5433 wrote to
 * `AlertCooldown` (it may still be running beside this one, and its markers
 * outlive the deploy). The legacy source goes once two releases have shipped
 * with the table (#5433's last pull request).
 */
export const OWED_NOTICE_SOURCES: readonly OwedNoticeSource[] = [owedNoticeTableSource, legacyBumpMarkerSource];
