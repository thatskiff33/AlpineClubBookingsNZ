import type { MaintenanceReportSource } from "@prisma/client";

import { adminHref } from "@/lib/admin-hubs";
import { getAppBaseUrl } from "@/lib/app-url";
import { prisma } from "@/lib/prisma";

/**
 * Builds the officer-alert payload for a report that has already been stored
 * (#2780).
 *
 * WHY THE ANSWERS ARE RE-READ RATHER THAN PASSED IN. The email must show what is
 * IN the report, not what the request claimed. Reading the stored answer rows
 * means the officer sees exactly the snapshot the admin queue will show them —
 * including the discarded ones being absent, which is the whole point of the
 * question set being authoritative over the submission.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE SENDER. Both doors need the identical
 * payload, and the QR door must not be able to shape it differently: the reporter
 * label, the source wording and the photo wording are decided here from stored
 * facts, so an anonymous submitter cannot make the email say "Reported by" a
 * member. The self-declared name on the QR path is rendered by the caller as a
 * clearly-labelled, escaped value and never as an identity.
 */

const SOURCE_LABELS: Record<MaintenanceReportSource, string> = {
  MEMBER_PORTAL: "From the members' portal",
  LODGE_QR: "From the QR code in the lodge (not signed in)",
};

export type MaintenanceAlertInput = {
  reportId: string;
  lodgeName: string;
  /**
   * Who to name. On the member path this is the member's name; on the QR path it
   * is the self-declared name if one was given, or a plain statement that nobody
   * identified themselves. The caller decides, because only the caller knows
   * which door it is — but neither door may invent a member name, and the QR
   * caller must never pass one it did not receive as free text.
   */
  reportedBy: string;
  source: MaintenanceReportSource;
  hasPhoto: boolean;
  /** Used only to recover an origin when NEXTAUTH_URL is unset. */
  request?: { nextUrl: { origin: string } };
};

export type MaintenanceAlertPayload = {
  lodgeName: string;
  reportedBy: string;
  sourceLabel: string;
  photoLabel: string;
  summary: string;
  answers: Array<{ label: string; value: string }>;
  maintenanceReportUrl: string;
};

export async function resolveMaintenanceAlertPayload(
  input: MaintenanceAlertInput,
): Promise<MaintenanceAlertPayload> {
  const report = await prisma.maintenanceReport.findUnique({
    where: { id: input.reportId },
    select: {
      summary: true,
      answers: {
        orderBy: { sortOrder: "asc" },
        select: { questionLabel: true, answerText: true },
      },
    },
  });

  const baseUrl = getAppBaseUrl(input.request?.nextUrl.origin);

  return {
    lodgeName: input.lodgeName,
    reportedBy: input.reportedBy,
    sourceLabel: SOURCE_LABELS[input.source],
    photoLabel: input.hasPhoto
      ? "A photo is attached — open the report to see it"
      : "No photo was attached",
    summary: report?.summary ?? "",
    answers: (report?.answers ?? []).map((answer) => ({
      label: answer.questionLabel,
      value: answer.answerText,
    })),
    // Built from our own origin and the report id only. A reporter cannot put a
    // link of their choosing in front of an officer, which is why the template
    // renders this with `sameOrigin: true`.
    maintenanceReportUrl: `${baseUrl}${adminHref("maintenance-reports")}?report=${encodeURIComponent(
      input.reportId,
    )}`,
  };
}
