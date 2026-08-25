import {
  childRequestApprovedTemplate,
  childRequestRejectedTemplate,
  childRequestSubmittedTemplate,
  familyGroupInvitationTemplate,
  familyGroupInviteAcceptedTemplate,
  groupCreateApprovedTemplate,
  groupCreateRejectedTemplate,
  groupCreateRequestConfirmationTemplate,
  joinRequestConfirmationTemplate,
  partnerInviteClaimedTemplate,
  partnerInviteTemplate,
  partnerLinkConfirmedTemplate,
  partnerLinkRemovedTemplate,
  partnerLinkRequestTemplate,
} from "@/lib/email-templates/family";
import {
  composeOptionalEmailLine,
} from "../email-message-notes";
import { CLUB_BOOKINGS_NAME } from "@/config/club-identity";
import { sendEmail } from "./core";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailClubDateTime } from "@/lib/email-templates-club-time";

// ---- Family group emails ----

export async function sendFamilyGroupInvitationEmail(
  email: string,
  inviterName: string,
  groupName: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const profileUrl = `${baseUrl}/profile`;

  await sendEmail({
    to: email,
    subject: `${inviterName} invited you to join ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => familyGroupInvitationTemplate(inviterName, groupName, profileUrl)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "family-group-invitation",
    templateData: { inviterName, groupName, profileUrl },
  });
}

export async function sendFamilyGroupInviteAcceptedEmail(
  email: string,
  inviteeName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `${inviteeName} has joined ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => familyGroupInviteAcceptedTemplate(inviteeName, groupName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "family-group-invite-accepted",
    templateData: { inviteeName, groupName },
  });
}

export async function sendChildRequestSubmittedEmail(
  email: string,
  parentName: string,
  childName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `Infant/Child/Youth request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => childRequestSubmittedTemplate(parentName, childName, groupName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "child-request-submitted",
    templateData: { parentName, childName, groupName },
  });
}

export async function sendChildRequestApprovedEmail(
  email: string,
  parentName: string,
  childName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `${childName} has been added to ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => childRequestApprovedTemplate(parentName, childName, groupName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "child-request-approved",
    templateData: { parentName, childName, groupName },
  });
}

export async function sendChildRequestRejectedEmail(
  email: string,
  parentName: string,
  childName: string,
  reason?: string,
) {
  await sendEmail({
    to: email,
    subject: `Infant/Child/Youth request update — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => childRequestRejectedTemplate(parentName, childName, reason)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "child-request-rejected",
    templateData: {
      parentName,
      childName,
      reason: reason ?? "",
      // #2268: pre-composed optional line — the flat body has no conditional
      // syntax, so "Admin note:" must not print without a note.
      adminNoteLine: composeOptionalEmailLine("Admin note", reason),
    },
  });
}

// P3.4: Confirmation email to requester on join request
export async function sendJoinRequestConfirmationEmail(
  email: string,
  requesterName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `Join request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => joinRequestConfirmationTemplate(requesterName, groupName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "join-request-confirmation",
    templateData: { requesterName, groupName },
  });
}

// ---- Member-initiated "create group from scratch" flow (#1681) ----

export async function sendGroupCreateRequestConfirmationEmail(
  email: string,
  requesterName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `Family group request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => groupCreateRequestConfirmationTemplate(requesterName, groupName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "family-group-create-request-confirmation",
    templateData: { requesterName, groupName },
  });
}

export async function sendGroupCreateApprovedEmail(
  email: string,
  requesterName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `Your family group ${groupName} has been created — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => groupCreateApprovedTemplate(requesterName, groupName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "family-group-create-approved",
    templateData: { requesterName, groupName },
  });
}

export async function sendGroupCreateRejectedEmail(
  email: string,
  requesterName: string,
  groupName: string,
  reason?: string,
) {
  await sendEmail({
    to: email,
    subject: `Family group request update — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => groupCreateRejectedTemplate(requesterName, groupName, reason)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "family-group-create-rejected",
    templateData: {
      requesterName,
      groupName,
      reason: reason ?? "",
      // #2268: pre-composed optional line (see sendChildRequestRejectedEmail).
      adminNoteLine: composeOptionalEmailLine("Admin note", reason),
    },
  });
}

// ---- Partner-invite token flow for unregistered partners (#1682) ----

export async function sendPartnerInviteEmail(params: {
  email: string;
  inviterName: string;
  groupName: string;
  token: string;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const claimUrl = `${baseUrl}/family-invite/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `${params.inviterName} invited you to join ${params.groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => partnerInviteTemplate({
      inviterName: params.inviterName,
      groupName: params.groupName,
      claimUrl,
      expiresAt: params.expiresAt,
    })),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "partner-invite",
    templateData: {
      inviterName: params.inviterName,
      groupName: params.groupName,
      token: params.token,
      claimUrl,
      expiresAt: emailClubDateTime(params.expiresAt),
    },
  });
}

export async function sendPartnerInviteClaimedEmail(
  email: string,
  firstName: string,
  groupName: string,
) {
  await sendEmail({
    to: email,
    subject: `You've joined ${groupName} — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => partnerInviteClaimedTemplate(firstName, groupName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "partner-invite-claimed",
    templateData: { firstName, groupName },
  });
}

// ---- Partner link (declared Partner/Husband/Wife relationship, #1742) ----

export async function sendPartnerLinkRequestEmail(
  email: string,
  requesterName: string,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const profileUrl = `${baseUrl}/profile`;

  await sendEmail({
    to: email,
    subject: `${requesterName} asked to record you as their partner — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => partnerLinkRequestTemplate(requesterName, profileUrl)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "partner-link-request",
    templateData: { requesterName, profileUrl },
  });
}

export async function sendPartnerLinkConfirmedEmail(
  email: string,
  partnerName: string,
) {
  await sendEmail({
    to: email,
    subject: `Your partner relationship with ${partnerName} has been recorded — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => partnerLinkConfirmedTemplate(partnerName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "partner-link-confirmed",
    templateData: { partnerName },
  });
}

export async function sendPartnerLinkRemovedEmail(
  email: string,
  partnerName: string,
) {
  await sendEmail({
    to: email,
    subject: `Your partner relationship with ${partnerName} has been removed — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => partnerLinkRemovedTemplate(partnerName)),
    // Family-group membership mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "partner-link-removed",
    templateData: { partnerName },
  });
}
