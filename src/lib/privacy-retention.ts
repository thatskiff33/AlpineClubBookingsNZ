import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPrivacyRetentionSettings } from "@/lib/privacy-retention-settings";
import {
  privacyRetentionSelection, selectFormerMemberBatch,
} from "@/lib/privacy-retention-selection";

export type RetentionPreviewRow = { id: string; date: Date | null; reasons?: string[] };
type PreviewGroup = { count: number; rows: RetentionPreviewRow[] };

/** Read-only: switches control execution, never hide the proposed selection. */
export async function getPrivacyRetentionPreview({
  page = 1, pageSize = 25, now = new Date(), includeMembers = true, memberAfter, db = prisma,
}: { page?: number; pageSize?: number; now?: Date; includeMembers?: boolean; memberAfter?: string; db?: Prisma.TransactionClient } = {}) {
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
  let formerMemberCandidateCount = 0;
  let memberHasMore = false;
  let memberNextCursor: string | null = null;
  if (includeMembers) {
    const [candidateCount, batch] = await Promise.all([
      db.member.count({ where: selection.formerMembers }),
      selectFormerMemberBatch(db, selection.formerMembers, memberAfter, take + 1),
    ]);
    formerMemberCandidateCount = candidateCount;
    memberHasMore = batch.length > take;
    const memberRows = batch.slice(0, take);
    memberNextCursor = memberRows.at(-1)?.id ?? memberAfter ?? null;
    for (const row of memberRows) {
      const group = row.reasons.length ? blockedMembers : formerMembers;
      group.rows.push(row);
      group.count++;
    }
    const [count, rows] = await Promise.all([
      db.member.count({ where: selection.undatedMembers }),
      db.member.findMany({ where: selection.undatedMembers, select: { id: true }, orderBy: { id: "asc" }, take, skip }),
    ]);
    undatedMembers.count = count;
    undatedMembers.rows = rows.map(({ id }) => ({ id, date: null }));
  }
  return {
    settings,
    emailLogs: { count: emailCount, rows: emailRows.map(row => ({ id: row.id, date: row.createdAt })) },
    rejectedApplications: { count: applicationCount, rows: applicationRows.map(row => ({ id: row.id, date: row.reviewedAt })) },
    formerMembers, blockedMembers, undatedMembers,
    formerMemberCandidateCount, memberHasMore, memberNextCursor,
  };
}
