import {
  adminAccountDeletionRequestedTemplate,
  adminFamilyGroupRequestTemplate,
  adminMemberArchiveRequestedTemplate,
  adminMemberDeleteApprovedTemplate,
  adminMemberDeleteRejectedTemplate,
  adminMemberDeleteRequestedTemplate,
  adminMembershipApplicationPendingTemplate,
  adminMembershipCancellationRequestTemplate,
} from "@/lib/email-templates/admin-membership";
import {
  composeOptionalEmailLine,
} from "../email-message-notes";
import { sendEmail } from "./core";
import {
  sendToAdmins,
  shouldSendDirectAdminSystemEmail,
} from "./admin-alerts-shared";
import { renderEmailHtml } from "@/lib/email-theme";

import { adminHref } from "@/lib/admin-hubs";
export async function sendAdminMembershipApplicationPendingEmail(data: {
  applicationId: string;
  applicantName: string;
  applicantEmail: string;
  familyMemberCount: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${adminHref("member-applications")}`;

  await sendToAdmins({
    subject: `Membership application ready: ${data.applicantName}`,
    html: await renderEmailHtml(() => adminMembershipApplicationPendingTemplate({
      applicantName: data.applicantName,
      applicantEmail: data.applicantEmail,
      familyMemberCount: data.familyMemberCount,
      reviewUrl,
    })),
    templateName: "admin-membership-application-pending",
    templateData: {
      applicantName: data.applicantName,
      applicantEmail: data.applicantEmail,
      familyMemberCount: data.familyMemberCount,
      reviewUrl,
    },
    // Shared request-alert category: membership applications + family-group requests.
    preferenceKey: "adminFamilyGroupRequest",
  });
}

// Shared request-alert category for family-group requests and membership applications.
export async function sendAdminFamilyGroupRequestAlert(data: {
  requestType: string;
  requesterName: string;
  groupName: string;
  details: string;
}) {
  await sendToAdmins({
    subject: `Family Group Request: ${data.requesterName} (${data.requestType})`,
    html: await renderEmailHtml(() => adminFamilyGroupRequestTemplate(data)),
    templateName: "admin-family-group-request",
    templateData: data,
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminMembershipCancellationRequestAlert(params: {
  requesterName: string;
  participantSummary: string;
  reason?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${adminHref("membership-cancellations")}`;

  await sendToAdmins({
    subject: `Membership cancellation ready: ${params.requesterName}`,
    html: await renderEmailHtml(() => adminMembershipCancellationRequestTemplate({
      requesterName: params.requesterName,
      participantSummary: params.participantSummary,
      reason: params.reason,
      reviewUrl,
    })),
    templateName: "admin-membership-cancellation-request",
    templateData: {
      requesterName: params.requesterName,
      participantSummary: params.participantSummary,
      reason: params.reason ?? "",
      // #2268: pre-composed optional line — no dangling "Reason:".
      reasonNote: composeOptionalEmailLine("Reason", params.reason),
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminAccountDeletionRequestedAlert(params: {
  requestId: string;
  memberName: string;
  memberEmail: string;
  reason?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${adminHref("deletion-requests")}?status=PENDING`;

  await sendToAdmins({
    subject: `Account deletion requested: ${params.memberName}`,
    html: await renderEmailHtml(() => adminAccountDeletionRequestedTemplate({
      memberName: params.memberName,
      memberEmail: params.memberEmail,
      reason: params.reason,
      reviewUrl,
    })),
    templateName: "admin-account-deletion-requested",
    templateData: {
      requestId: params.requestId,
      memberName: params.memberName,
      memberEmail: params.memberEmail,
      reason: params.reason ?? "",
      // #2268: pre-composed optional line — the whole "Reason: …" block, or
      // nothing at all when the member gave no reason.
      reasonNote: composeOptionalEmailLine("Reason", params.reason),
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminMemberArchiveRequestedAlert(params: {
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${adminHref("membership-cancellations")}`;

  await sendToAdmins({
    subject: `Member archive requested: ${params.memberName}`,
    html: await renderEmailHtml(() => adminMemberArchiveRequestedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    })),
    templateName: "admin-member-archive-requested",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
  });
}

export async function sendAdminMemberDeleteRequestedAlert(params: {
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  // #1938: deep-link to the review queue (the admin-initiated deletion section
  // on /admin/deletion-requests) rather than the member record, so a second
  // admin can approve/reject without having to know where to look. `memberId`
  // is retained on the params/templateData for audit continuity.
  const reviewUrl = `${baseUrl}${adminHref("deletion-requests")}`;

  await sendToAdmins({
    subject: `Member delete requested: ${params.memberName}`,
    html: await renderEmailHtml(() => adminMemberDeleteRequestedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    })),
    templateName: "admin-member-delete-requested",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    },
    // #1938: dedicated preference key so muting the shared "Member requests"
    // (adminFamilyGroupRequest) category no longer also silences delete-request
    // review alerts. Additive, default on.
    preferenceKey: "adminMemberDeleteRequest",
  });
}

export async function sendAdminMemberDeleteApprovedEmail(params: {
  email: string;
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  if (
    !(await shouldSendDirectAdminSystemEmail("admin-member-delete-approved"))
  ) {
    return;
  }

  await sendEmail({
    to: params.email,
    subject: `Member delete approved: ${params.memberName}`,
    html: await renderEmailHtml(() => adminMemberDeleteApprovedTemplate(params)),
    // Admin-audience alert: never booking-scoped and never withheld (#2258).
    bookingContext: "none",
    templateName: "admin-member-delete-approved",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
      // #2268: pre-composed optional line — no dangling "Review note:".
      reviewNoteLine: composeOptionalEmailLine(
        "Review note",
        params.reviewNote,
      ),
    },
  });
}

export async function sendAdminMemberDeleteRejectedEmail(params: {
  email: string;
  requesterName: string;
  memberId: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${adminHref("member-detail", { id: params.memberId })}`;

  if (
    !(await shouldSendDirectAdminSystemEmail("admin-member-delete-rejected"))
  ) {
    return;
  }

  await sendEmail({
    to: params.email,
    subject: `Member delete rejected: ${params.memberName}`,
    html: await renderEmailHtml(() => adminMemberDeleteRejectedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote,
      reviewUrl,
    })),
    // Admin-audience alert: never booking-scoped and never withheld (#2258).
    bookingContext: "none",
    templateName: "admin-member-delete-rejected",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
      // #2268: pre-composed optional line — no dangling "Review note:".
      reviewNoteLine: composeOptionalEmailLine(
        "Review note",
        params.reviewNote,
      ),
      reviewUrl,
    },
  });
}
