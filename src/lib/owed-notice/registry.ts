/**
 * #5433: every kind of owed notice this release can deliver, and every place
 * its markers can be. A kind added here is swept by both jobs that run the
 * drain; a kind not listed is left alone (`./drain.ts`).
 */
import { owedNoticeTableSource, type OwedNoticeDeliverer, type OwedNoticeSource } from "@/lib/owed-notice/deliver";

export const OWED_NOTICE_DELIVERERS: readonly OwedNoticeDeliverer[] = [];

export const OWED_NOTICE_SOURCES: readonly OwedNoticeSource[] = [owedNoticeTableSource];
