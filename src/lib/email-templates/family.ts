/**
 * Family-group and partner-link emails: invitations, join and create requests,
 * child requests, and the link outcomes.
 *
 * The family boundary is `src/lib/email/family.ts`.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  button,
  heading,
  layout,
  muted,
  paragraph,
  supportContactMuted,
} from "./layout";
import { emailClubDateTime } from "@/lib/email-templates-club-time";

/** Sent to an adult member when they're invited to join a family group */
export function familyGroupInvitationTemplate(
  inviterName: string,
  groupName: string,
  profileUrl: string
): string {
  return layout(`
    ${heading("Family Group Invitation")}
    ${paragraph("<strong>" + escapeHtml(inviterName) + "</strong> has invited you to join the family group <strong>" + escapeHtml(groupName) + "</strong>.")}
    ${paragraph("You can accept or decline this invitation from your profile page.")}
    ${button("View Invitation", profileUrl)}
    ${muted("If you weren't expecting this invitation, you can safely ignore it.")}
  `);
}

/** Sent to the inviter when their invitation is accepted */
export function familyGroupInviteAcceptedTemplate(
  inviteeName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Invitation Accepted")}
    ${paragraph("<strong>" + escapeHtml(inviteeName) + "</strong> has accepted your invitation and joined <strong>" + escapeHtml(groupName) + "</strong>.")}
    ${alertBox("Your family group has been updated.", "success")}
    ${supportContactMuted()}
  `);
}

/** Sent to parent when their infant/child/youth request is submitted (confirmation) */
export function childRequestSubmittedTemplate(
  parentName: string,
  childName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Infant/Child/Youth Request Submitted")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("Your request to add <strong>" + escapeHtml(childName) + "</strong> to the family group <strong>" + escapeHtml(groupName) + "</strong> has been submitted.")}
    ${alertBox("An administrator will review your request and link the member to your family group. You'll be notified once it's been processed.", "info")}
    ${supportContactMuted()}
  `);
}

/** Sent to parent when their infant/child/youth request is approved by admin */
export function childRequestApprovedTemplate(
  parentName: string,
  childName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Infant/Child/Youth Added to Family Group")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("<strong>" + escapeHtml(childName) + "</strong> has been added to your family group <strong>" + escapeHtml(groupName) + "</strong>.")}
    ${alertBox("You can now include them when making bookings.", "success")}
    ${supportContactMuted()}
  `);
}

/** Sent to parent when their infant/child/youth request is rejected by admin */
export function childRequestRejectedTemplate(
  parentName: string,
  childName: string,
  reason?: string
): string {
  const reasonHtml = reason
    ? `${alertBox("Admin note: " + escapeHtml(reason), "warning")}`
    : "";
  return layout(`
    ${heading("Infant/Child/Youth Request Update")}
    ${paragraph("Hi " + escapeHtml(parentName) + ",")}
    ${paragraph("Your request to add <strong>" + escapeHtml(childName) + "</strong> to your family group was not approved.")}
    ${reasonHtml}
    ${paragraph("If you have questions, please contact the club.")}
    ${supportContactMuted()}
  `);
}

/** Confirmation email sent to the requester when they submit a join request */
export function joinRequestConfirmationTemplate(
  requesterName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Join Request Submitted")}
    ${paragraph("Hi " + escapeHtml(requesterName) + ",")}
    ${paragraph("Your request to join the family group <strong>" + escapeHtml(groupName) + "</strong> has been submitted.")}
    ${alertBox("An administrator will review your request. You'll be notified once it's been processed.", "info")}
    ${supportContactMuted()}
  `);
}

/** Confirmation email sent to the requester when they submit a group creation request (#1681) */
export function groupCreateRequestConfirmationTemplate(
  requesterName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Family Group Request Submitted")}
    ${paragraph("Hi " + escapeHtml(requesterName) + ",")}
    ${paragraph("Your request to create the family group <strong>" + escapeHtml(groupName) + "</strong> has been submitted.")}
    ${alertBox("An administrator will review your request. You'll be notified once it's been processed.", "info")}
    ${supportContactMuted()}
  `);
}

/** Sent to the requester when their group creation request is approved by admin */
export function groupCreateApprovedTemplate(
  requesterName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Family Group Created")}
    ${paragraph("Hi " + escapeHtml(requesterName) + ",")}
    ${paragraph("Your family group <strong>" + escapeHtml(groupName) + "</strong> has been approved and created. You are the group admin.")}
    ${alertBox("Any partner invitation has been sent for them to accept from their profile, and any infant/child/youth requests you included are reviewed separately by an administrator.", "success")}
    ${supportContactMuted()}
  `);
}

/** Sent to the requester when their group creation request is rejected by admin */
export function groupCreateRejectedTemplate(
  requesterName: string,
  groupName: string,
  reason?: string
): string {
  const reasonHtml = reason
    ? `${alertBox("Admin note: " + escapeHtml(reason), "warning")}`
    : "";
  return layout(`
    ${heading("Family Group Request Update")}
    ${paragraph("Hi " + escapeHtml(requesterName) + ",")}
    ${paragraph("Your request to create the family group <strong>" + escapeHtml(groupName) + "</strong> was not approved.")}
    ${reasonHtml}
    ${paragraph("If you have questions, please contact the club.")}
    ${supportContactMuted()}
  `);
}

/**
 * Sent to a partner who has no account yet, inviting them to join a family
 * group (#1682). The claim link carries a single-use bearer token; the claim
 * page routes an unregistered recipient through the membership application
 * first, then lets them accept once their login is active.
 */
export function partnerInviteTemplate(params: {
  inviterName: string;
  groupName: string;
  claimUrl: string;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Family Group Invitation")}
    ${paragraph("<strong>" + escapeHtml(params.inviterName) + "</strong> has invited you to join the family group <strong>" + escapeHtml(params.groupName) + "</strong>.")}
    ${paragraph("Use the button below to get started. If you don't have a member account yet, you'll be guided through joining first, then you can accept this invitation once your login is active.")}
    ${button("Accept Invitation", params.claimUrl, { sameOrigin: true })}
    ${paragraph("This link expires on <strong>" + escapeHtml(emailClubDateTime(params.expiresAt)) + "</strong>.")}
    ${muted("If you weren't expecting this invitation, you can safely ignore it.")}
  `);
}

/** Sent to the newly-registered partner once they claim their invitation. */
export function partnerInviteClaimedTemplate(
  firstName: string,
  groupName: string
): string {
  return layout(`
    ${heading("Family Group Joined")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph("You've joined the family group <strong>" + escapeHtml(groupName) + "</strong>.")}
    ${alertBox("You can now be included when your family makes bookings. Manage your family group from your profile page.", "success")}
    ${supportContactMuted()}
  `);
}

// ---- Partner link (declared Partner/Husband/Wife relationship, #1742) ----

/** Sent to the member being asked to confirm a partner relationship. */
export function partnerLinkRequestTemplate(
  requesterName: string,
  profileUrl: string
): string {
  return layout(`
    ${heading("Partner Confirmation Request")}
    ${paragraph("<strong>" + escapeHtml(requesterName) + "</strong> has asked to record you as their partner (husband, wife, or partner).")}
    ${paragraph("Confirming records the relationship with the club. You can confirm or decline from your profile page.")}
    ${button("Respond to Request", profileUrl)}
    ${muted("If you weren't expecting this request, you can decline it or safely ignore this email.")}
  `);
}

/** Sent when a partner relationship is confirmed (accepted or admin-recorded). */
export function partnerLinkConfirmedTemplate(partnerName: string): string {
  return layout(`
    ${heading("Partner Relationship Recorded")}
    ${paragraph("Your partner relationship with <strong>" + escapeHtml(partnerName) + "</strong> has been recorded with the club.")}
    ${alertBox("You can view or remove this relationship from your profile page.", "info")}
    ${supportContactMuted()}
  `);
}

/** Sent to the other partner when a confirmed relationship is removed. */
export function partnerLinkRemovedTemplate(partnerName: string): string {
  return layout(`
    ${heading("Partner Relationship Removed")}
    ${paragraph("Your recorded partner relationship with <strong>" + escapeHtml(partnerName) + "</strong> has been removed.")}
    ${paragraph("If you weren't expecting this change, please contact the club.")}
    ${supportContactMuted()}
  `);
}
