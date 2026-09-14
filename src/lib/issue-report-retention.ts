import { prisma } from "@/lib/prisma";

const ISSUE_REPORT_SENSITIVE_DATA_RETENTION_DAYS = 30;

/**
 * The `screenshotDeleteReason` the sweep below stamps on a screenshot it
 * redacts. Exported because a reader has to tell an EXPIRY apart from an
 * administrator's manual deletion, and comparing against a second copy of the
 * literal is how the two drift (#2703, INV-SSOT).
 */
export const ISSUE_REPORT_RETENTION_DELETE_REASON = "retention_expired";

type IssueReportRetentionClient = Pick<typeof prisma, "issueReport">;

export function getIssueReportSensitiveDataExpiresAt(
  createdAt: Date = new Date()
) {
  return new Date(
    createdAt.getTime() +
      ISSUE_REPORT_SENSITIVE_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
}

export async function redactExpiredIssueReportSensitiveData(
  now: Date = new Date(),
  db: IssueReportRetentionClient = prisma
) {
  const [screenshots, browserInfo] = await Promise.all([
    db.issueReport.updateMany({
      where: {
        screenshotDataUrl: { not: null },
        screenshotExpiresAt: { lte: now },
      },
      data: {
        screenshotDataUrl: null,
        screenshotDeletedAt: now,
        screenshotDeletedById: null,
        screenshotDeleteReason: ISSUE_REPORT_RETENTION_DELETE_REASON,
      },
    }),
    db.issueReport.updateMany({
      where: {
        browserInfo: { not: null },
        browserInfoExpiresAt: { lte: now },
      },
      data: {
        browserInfo: null,
        browserInfoDeletedAt: now,
      },
    }),
  ]);

  return {
    screenshotsRedacted: screenshots.count,
    browserInfoRedacted: browserInfo.count,
  };
}
