import {
  adminMembershipApplicationPendingTemplate,
  adminFamilyGroupRequestTemplate,
  adminMembershipCancellationRequestTemplate,
  adminAccountDeletionRequestedTemplate,
  adminMemberArchiveRequestedTemplate,
  adminMemberDeleteRequestedTemplate,
  adminMemberDeleteApprovedTemplate,
  adminMemberDeleteRejectedTemplate,
} from "../email-templates";
import { sendEmail } from "./core";
import {
  sendToAdmins,
  shouldSendDirectAdminSystemEmail,
} from "./admin-alerts-shared";

export async function sendAdminMembershipApplicationPendingEmail(data: {
  applicationId: string;
  applicantName: string;
  applicantEmail: string;
  familyMemberCount: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/member-applications`;

  await sendToAdmins({
    subject: `Membership application ready: ${data.applicantName}`,
    html: adminMembershipApplicationPendingTemplate({
      applicantName: data.applicantName,
      applicantEmail: data.applicantEmail,
      familyMemberCount: data.familyMemberCount,
      reviewUrl,
    }),
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
    html: adminFamilyGroupRequestTemplate(data),
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
  const reviewUrl = `${baseUrl}/admin/membership-cancellations`;

  await sendToAdmins({
    subject: `Membership cancellation ready: ${params.requesterName}`,
    html: adminMembershipCancellationRequestTemplate({
      requesterName: params.requesterName,
      participantSummary: params.participantSummary,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-membership-cancellation-request",
    templateData: {
      requesterName: params.requesterName,
      participantSummary: params.participantSummary,
      reason: params.reason ?? "",
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
  const reviewUrl = `${baseUrl}/admin/deletion-requests?status=PENDING`;

  await sendToAdmins({
    subject: `Account deletion requested: ${params.memberName}`,
    html: adminAccountDeletionRequestedTemplate({
      memberName: params.memberName,
      memberEmail: params.memberEmail,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-account-deletion-requested",
    templateData: {
      requestId: params.requestId,
      memberName: params.memberName,
      memberEmail: params.memberEmail,
      reason: params.reason ?? "",
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
  const reviewUrl = `${baseUrl}/admin/membership-cancellations`;

  await sendToAdmins({
    subject: `Member archive requested: ${params.memberName}`,
    html: adminMemberArchiveRequestedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    }),
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
  const reviewUrl = `${baseUrl}/admin/members/${encodeURIComponent(params.memberId)}`;

  await sendToAdmins({
    subject: `Member delete requested: ${params.memberName}`,
    html: adminMemberDeleteRequestedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    }),
    templateName: "admin-member-delete-requested",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewUrl,
    },
    preferenceKey: "adminFamilyGroupRequest",
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
    html: adminMemberDeleteApprovedTemplate(params),
    templateName: "admin-member-delete-approved",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
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
  const reviewUrl = `${baseUrl}/admin/members/${encodeURIComponent(params.memberId)}`;

  if (
    !(await shouldSendDirectAdminSystemEmail("admin-member-delete-rejected"))
  ) {
    return;
  }

  await sendEmail({
    to: params.email,
    subject: `Member delete rejected: ${params.memberName}`,
    html: adminMemberDeleteRejectedTemplate({
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote,
      reviewUrl,
    }),
    templateName: "admin-member-delete-rejected",
    templateData: {
      requesterName: params.requesterName,
      memberName: params.memberName,
      reason: params.reason,
      reviewNote: params.reviewNote ?? "",
      reviewUrl,
    },
  });
}
