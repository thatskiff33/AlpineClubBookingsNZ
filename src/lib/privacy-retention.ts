import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPrivacyRetentionSettings } from "@/lib/privacy-retention-settings";
import {
  privacyRetentionSelection, selectFormerMemberBatch, RETENTION_BATCH_SIZE,
} from "@/lib/privacy-retention-selection";

export type RetentionPreviewRow = { id: string; date: Date | null; reasons?: string[] };
type PreviewGroup = { count: number; rows: RetentionPreviewRow[] };

/** Read-only: switches control execution, never hide the proposed selection. */
export async function getPrivacyRetentionPreview({
  page = 1, pageSize = 25, now = new Date(), includeMembers = true, db = prisma,
}: { page?: number; pageSize?: number; now?: Date; includeMembers?: boolean; db?: Prisma.TransactionClient } = {}) {
  const settings = await getPrivacyRetentionSettings(db);
  const selection = await privacyRetentionSelection(settings, now);
  const take = Math.max(1, Math.min(100, Math.floor(pageSize)));
  const skip = (Math.max(1, Math.floor(page)) - 1) * take;
  const [emailCount, emailRows, applicationCount, applicationRows] = await Promise.all([
    db.emailLog.count({ where: selection.emailLogs }),
    db.emailLog.findMany({ where: selection.emailLogs, select: { id: true, createdAt: true }, orderBy: { id: "asc" }, take, skip }),
    includeMembers ? db.memberApplication.count({ where: selection.rejectedApplications }) : Promise.resolve(0),
    includeMembers ? db.memberApplication.findMany({ where: selection.rejectedApplications, select: { id: true, reviewedAt: true }, orderBy: { id: "asc" }, take, skip }) : Promise.resolve([]),
  ]);
  const formerMembers: PreviewGroup = { count: 0, rows: [] };
  const blockedMembers: PreviewGroup = { count: 0, rows: [] };
  const undatedMembers: PreviewGroup = { count: 0, rows: [] };
  if (includeMembers) {
    let afterId: string | undefined;
    for (;;) {
      const batch = await selectFormerMemberBatch(db, selection.formerMembers, afterId);
      for (const row of batch) {
        const group = row.reasons.length ? blockedMembers : formerMembers;
        if (group.count >= skip && group.rows.length < take) group.rows.push(row);
        group.count++;
      }
      if (batch.length < RETENTION_BATCH_SIZE) break;
      afterId = batch[batch.length - 1].id;
    }
    const [count, rows] = await Promise.all([
      db.member.count({ where: selection.undatedMembers }),
      db.member.findMany({ where: selection.undatedMembers, select: { id: true }, orderBy: { id: "asc" }, take, skip }),
    ]);
    undatedMembers.count = count;
    undatedMembers.rows = rows.map(({ id }) => ({ id, date: null }));
  }
  return {
    emailLogs: { count: emailCount, rows: emailRows.map(row => ({ id: row.id, date: row.createdAt })) },
    rejectedApplications: { count: applicationCount, rows: applicationRows.map(row => ({ id: row.id, date: row.reviewedAt })) },
    formerMembers, blockedMembers, undatedMembers,
  };
}
