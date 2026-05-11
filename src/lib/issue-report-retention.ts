import { prisma } from "@/lib/prisma";

export const ISSUE_REPORT_SENSITIVE_DATA_RETENTION_DAYS = 30;

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
        screenshotDeleteReason: "retention_expired",
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
