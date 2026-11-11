import { adminHref } from "@/lib/admin-hubs";
/**
 * Admin alerts about membership and member records: applications, cancellation
 * and archive requests, deletion decisions, and family-group requests.
 *
 * The family boundary is `src/lib/email/admin-alerts-membership.ts`.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  button,
  heading,
  infoTable,
  layout,
  multilineBlock,
  muted,
  paragraph,
  supportContactMuted,
} from "./layout";

/** Admin alert: family group request created */
export function adminFamilyGroupRequestTemplate(data: {
  requestType: string;
  requesterName: string;
  groupName: string;
  details: string;
}): string {
  return layout(`
    ${heading("Family Group Request")}
    ${paragraph("A new <strong>" + escapeHtml(data.requestType) + "</strong> request has been submitted.")}
    ${paragraph("<strong>Requester:</strong> " + escapeHtml(data.requesterName))}
    ${paragraph("<strong>Group:</strong> " + escapeHtml(data.groupName))}
    ${multilineBlock(escapeHtml(data.details))}
    ${button("Review Requests", (process.env.NEXTAUTH_URL || "http://localhost:3000") + adminHref("family-groups"))}
    ${supportContactMuted()}
  `);
}

export function adminMembershipCancellationRequestTemplate(data: {
  requesterName: string;
  participantSummary: string;
  reason?: string | null;
  reviewUrl: string;
}): string {
  const reasonHtml = data.reason
    ? paragraph("Reason: <strong>" + escapeHtml(data.reason) + "</strong>")
    : "";

  return layout(`
    ${heading("Membership Cancellation Ready for Review")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> submitted a membership cancellation request with at least one participant ready for admin review."
    )}
    ${infoTable([
      { label: "Requester", value: escapeHtml(data.requesterName) },
      { label: "Included memberships", value: escapeHtml(data.participantSummary) },
    ])}
    ${reasonHtml}
    ${button("Review Cancellation Requests", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function adminMemberArchiveRequestedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Member Archive Requested")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> requested archive review for <strong>" +
        escapeHtml(data.memberName) +
        "</strong>."
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Requested by", value: escapeHtml(data.requesterName) },
    ])}
    ${multilineBlock(escapeHtml(data.reason))}
    ${button("Review Archive Requests", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function adminMemberDeleteRequestedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Member Delete Requested")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> requested hard-delete review for <strong>" +
        escapeHtml(data.memberName) +
        "</strong>."
    )}
    ${alertBox(
      "Hard delete is only for records added in error with no meaningful booking, financial, lodge, Xero, or audit history.",
      "warning"
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Requested by", value: escapeHtml(data.requesterName) },
    ])}
    ${multilineBlock(escapeHtml(data.reason))}
    ${button("Review Member", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function adminMemberDeleteApprovedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "info")
    : "";

  return layout(`
    ${heading("Member Delete Approved")}
    ${paragraph("Hi " + escapeHtml(data.requesterName) + ",")}
    ${paragraph(
      "The hard-delete request for <strong>" +
        escapeHtml(data.memberName) +
        "</strong> was approved and processed."
    )}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${alertBox(
      "A request snapshot was retained before the member record was deleted.",
      "info"
    )}
    ${supportContactMuted()}
  `);
}

export function adminMemberDeleteRejectedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
  reviewUrl: string;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "warning")
    : "";

  return layout(`
    ${heading("Member Delete Request Rejected")}
    ${paragraph("Hi " + escapeHtml(data.requesterName) + ",")}
    ${paragraph(
      "The hard-delete request for <strong>" +
        escapeHtml(data.memberName) +
        "</strong> was not approved."
    )}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${button("Open Member", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function adminMembershipApplicationPendingTemplate(data: {
  applicantName: string;
  applicantEmail: string;
  familyMemberCount: number;
  reviewUrl: string;
}): string {
  const dependentSummary =
    data.familyMemberCount > 0
      ? `${paragraph(
          "This application includes " +
            String(data.familyMemberCount) +
            " dependent family member" +
            (data.familyMemberCount === 1 ? "" : "s") +
            "."
        )}`
      : "";

  return layout(`
    ${heading("Membership Application Ready for Review")}
    ${paragraph("Both nominators have now confirmed a new membership application.")}
    ${infoTable([
      { label: "Applicant", value: escapeHtml(data.applicantName) },
      { label: "Email", value: escapeHtml(data.applicantEmail) },
    ])}
    ${dependentSummary}
    ${button("Review Application", data.reviewUrl)}
    ${supportContactMuted()}
  `);
}

export function adminAccountDeletionRequestedTemplate(data: {
  memberName: string;
  memberEmail: string;
  reason?: string | null;
  reviewUrl: string;
}): string {
  const reasonHtml = data.reason
    ? multilineBlock(escapeHtml(data.reason))
    : muted("No reason was provided.");

  return layout(`
    ${heading("Account Deletion Request Submitted")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.memberName) +
        "</strong> submitted an account deletion request."
    )}
    ${alertBox(
      "Review privacy requests promptly and record the decision from the deletion requests queue.",
      "warning"
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
    ])}
    ${reasonHtml}
    ${button("Review Deletion Requests", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}
