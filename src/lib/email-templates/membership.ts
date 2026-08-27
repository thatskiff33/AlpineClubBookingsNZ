/**
 * Membership lifecycle emails: nomination, application outcome, induction
 * sign-off, cancellation, archive, age-up handover and payment receipts.
 *
 * The family boundary is `src/lib/email/membership.ts`.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  button,
  formatCents,
  heading,
  infoTable,
  layout,
  multilineBlock,
  muted,
  paragraph,
  supportContactMuted,
  supportContactSentence,
} from "./layout";
import { CLUB_NAME } from "@/config/club-identity";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite";
import { emailClubDate, emailClubDateTime } from "@/lib/email-templates-club-time";

export function nominationRequestTemplate(params: {
  nominatorName: string;
  applicantName: string;
  reviewUrl: string;
  familyMemberCount: number;
  expiresAt: Date;
}): string {
  const dependentLine =
    params.familyMemberCount > 0
      ? `${paragraph("This application also includes " + String(params.familyMemberCount) + " dependent family member" + (params.familyMemberCount === 1 ? "" : "s") + ".")}`
      : "";

  return layout(`
    ${heading("Membership Nomination Request")}
    ${paragraph("Hi " + escapeHtml(params.nominatorName) + ",")}
    ${paragraph(
      "<strong>" +
        escapeHtml(params.applicantName) +
        `</strong> has listed you as one of their ${escapeHtml(CLUB_NAME)} nominators.`
    )}
    ${dependentLine}
    ${paragraph("Please review the application and confirm whether you agree to nominate this person for membership.")}
    ${alertBox("You will need to sign in before you can confirm the nomination.", "info")}
    ${button("Review Application", params.reviewUrl)}
    ${muted("This link expires on " + escapeHtml(emailClubDateTime(params.expiresAt)) + ".")}
  `);
}

export function inductionSignOffRequestTemplate(params: {
  signerName: string;
  inducteeName: string;
  signerRoleLabel: string;
  inductionUrl: string;
}): string {
  return layout(`
    ${heading("Lodge Induction Sign-Off Request")}
    ${paragraph("Hi " + escapeHtml(params.signerName) + ",")}
    ${paragraph(
      "<strong>" +
        escapeHtml(params.inducteeName) +
        `</strong> needs their ${escapeHtml(CLUB_NAME)} lodge induction signed off, and you can do this as their ` +
        escapeHtml(params.signerRoleLabel.toLowerCase()) +
        "."
    )}
    ${paragraph("Once you have taken them through the lodge induction checklist and you are satisfied they are competent, please sign in and confirm the sign-off on your induction page.")}
    ${alertBox("You will need to sign in before you can complete the sign-off.", "info")}
    ${button("Open My Induction Page", params.inductionUrl)}
  `);
}

export function membershipCancellationSubmittedTemplate(params: {
  firstName: string;
  participantSummary: string;
  reason?: string | null;
  reviewUrl: string;
}): string {
  const reasonHtml = params.reason
    ? paragraph("Reason: <strong>" + escapeHtml(params.reason) + "</strong>")
    : "";

  return layout(`
    ${heading("Membership Cancellation Request Submitted")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph("Your membership cancellation request has been submitted for admin review.")}
    ${infoTable([
      { label: "Included memberships", value: escapeHtml(params.participantSummary) },
    ])}
    ${reasonHtml}
    ${alertBox(
      "Memberships remain active until an administrator approves the request. Any included login-capable adult must confirm before an administrator can process their cancellation.",
      "info"
    )}
    ${button("View Request", params.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function membershipCancellationConfirmationTemplate(params: {
  firstName: string;
  requesterName: string;
  participantName: string;
  confirmationUrl: string;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Confirm Membership Cancellation")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(
      "<strong>" +
        escapeHtml(params.requesterName) +
        "</strong> has included <strong>" +
        escapeHtml(params.participantName) +
        "</strong> in a membership cancellation request."
    )}
    ${alertBox(
      "Your membership will remain active unless you sign in and confirm that you want to be included. This confirmation does not approve or process the cancellation; an administrator still needs to review the request.",
      "warning"
    )}
    ${paragraph(
      "This link expires on <strong>" +
        escapeHtml(emailClubDateTime(params.expiresAt)) +
        "</strong>."
    )}
    ${button("Review Cancellation Request", params.confirmationUrl, { sameOrigin: true })}
    ${muted("If you do not want to be included, use the link and choose Decline. If you were not expecting this request, you can ignore this email or contact the club.")}
  `);
}

export function memberArchiveApprovedTemplate(data: {
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "info")
    : "";

  return layout(`
    ${heading("Membership Archive Completed")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${paragraph("Your cancelled membership record has been archived.")}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${alertBox(
      "Archive preserves booking, payment, Xero, and audit history while removing the record from default operational lists.",
      "info"
    )}
    ${supportContactMuted()}
  `);
}

export function memberArchiveRejectedTemplate(data: {
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "warning")
    : "";

  return layout(`
    ${heading("Membership Archive Request Update")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${paragraph("The archive request for your cancelled membership was not approved at this time.")}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${supportContactMuted()}
  `);
}

export function membershipCancellationApprovedTemplate(params: {
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
  rejoinProcessText?: string | null;
}): string {
  const reasonHtml = params.reason
    ? `${paragraph(
        "Request reason: <strong>" + escapeHtml(params.reason) + "</strong>"
      )}`
    : "";
  const adminNoteHtml = params.adminNote
    ? `${alertBox("Admin note: " + escapeHtml(params.adminNote), "info")}`
    : "";
  const rejoinHtml = params.rejoinProcessText
    ? `${alertBox(escapeHtml(params.rejoinProcessText), "warning")}`
    : "";

  return layout(`
    ${heading("Membership Cancellation Approved")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(
      "The membership cancellation for <strong>" +
        escapeHtml(params.participantName) +
        "</strong> has been approved and processed."
    )}
    ${reasonHtml}
    ${alertBox(
      "This membership is now inactive and the booking login has been disabled. Booking, payment, and audit history has been retained.",
      "info"
    )}
    ${adminNoteHtml}
    ${rejoinHtml}
    ${supportContactMuted()}
  `);
}

export function membershipCancellationRejectedTemplate(params: {
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
}): string {
  const reasonHtml = params.reason
    ? `${paragraph(
        "Request reason: <strong>" + escapeHtml(params.reason) + "</strong>"
      )}`
    : "";
  const adminNoteHtml = params.adminNote
    ? `${alertBox("Admin note: " + escapeHtml(params.adminNote), "warning")}`
    : "";

  return layout(`
    ${heading("Membership Cancellation Request Update")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(
      "The membership cancellation request for <strong>" +
        escapeHtml(params.participantName) +
        "</strong> was not approved at this time."
    )}
    ${reasonHtml}
    ${adminNoteHtml}
    ${paragraph("This membership remains active.")}
    ${supportContactMuted()}
  `);
}

export function membershipApplicationApprovedTemplate(
  firstName: string,
  resetUrl: string,
  adminNotes?: string | null
): string {
  const notes = adminNotes
    ? `${alertBox("Committee note: " + escapeHtml(adminNotes), "info")}`
    : "";

  return layout(`
    ${heading("Membership Approved")}
    ${paragraph(`Hi ${escapeHtml(firstName)}, your ${escapeHtml(CLUB_NAME)} membership application has been approved.`)}
    ${paragraph("Your account is ready. Use the button below to set your password and access the bookings system.")}
    ${button("Set Up My Account", resetUrl)}
    ${notes}
    ${paragraph("Your joining fee and any membership charges will be managed separately through the club's normal process.")}
    ${muted("This setup link expires in " + String(MEMBER_SETUP_INVITE_TTL_DAYS) + " days.")}
  `);
}

export function membershipApplicationRejectedTemplate(
  firstName: string,
  adminNotes?: string | null
): string {
  const notes = adminNotes
    ? `${alertBox("Committee note: " + escapeHtml(adminNotes), "warning")}`
    : "";

  return layout(`
    ${heading("Membership Application Update")}
    ${paragraph(`Hi ${escapeHtml(firstName)}, your ${escapeHtml(CLUB_NAME)} membership application has been reviewed.`)}
    ${paragraph("The committee has decided not to approve the application at this time.")}
    ${notes}
    ${paragraph("If you would like more information, please contact the club directly.")}
    ${supportContactMuted()}
  `);
}

export interface AgeUpInvitationTemplateOptions {
  targetAgeTierLabel?: string;
}

/** Age-up invitation — sent when a youth/child reaches the ADULT age tier and gets their own login */
export function ageUpInvitationTemplate(
  firstName: string,
  resetUrl: string,
  options: AgeUpInvitationTemplateOptions = {}
): string {
  const name = escapeHtml(firstName);
  const targetAgeTierLabel = options.targetAgeTierLabel?.trim() || "Adult (18+)";
  return layout(`
    ${heading("Welcome to Your Own Account, " + name + "!")}
    ${paragraph(`Congratulations — you've reached the ${escapeHtml(targetAgeTierLabel)} age tier. You can now log in and book stays at the lodge yourself.`)}
    ${paragraph(
      "Click the button below to set up your password and activate your account. This link expires in <strong>" +
        String(MEMBER_SETUP_INVITE_TTL_DAYS) +
        " days</strong>."
    )}
    ${button("Set Up My Password", resetUrl)}
    ${alertBox("Once you set your password, you can log in at any time to book stays, view your bookings, and manage your profile.", "info")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

export interface AgeUpParentEmailHandoffTemplateOptions {
  recipientName: string;
  memberFirstName: string;
  memberLastName: string;
  targetAgeTierLabel?: string;
}

/** Age-up handoff — sent to the parent/source login holder when a member still shares an email */
export function ageUpParentEmailHandoffTemplate({
  recipientName,
  memberFirstName,
  memberLastName,
  targetAgeTierLabel,
}: AgeUpParentEmailHandoffTemplateOptions): string {
  const safeRecipientName = escapeHtml(recipientName.trim() || "there");
  const memberName = escapeHtml(
    [memberFirstName, memberLastName].filter(Boolean).join(" ").trim() ||
      memberFirstName
  );
  const safeTargetAgeTierLabel = escapeHtml(
    targetAgeTierLabel?.trim() || "Adult (18+)"
  );

  return layout(`
    ${heading("Email Address Needed for " + memberName)}
    ${paragraph(`Hi ${safeRecipientName},`)}
    ${paragraph(`${memberName} has reached the ${safeTargetAgeTierLabel} age tier. Before we can activate their own booking login, they need a unique email address on their member record.`)}
    ${paragraph("They are currently using or inheriting another member's login email, so we have not enabled their login yet.")}
    ${paragraph(`Please contact the club with ${memberName}'s preferred email address. Once it is updated, their booking login can be activated.`)}
    ${supportContactSentence("Contact the club at ")}
  `);
}

/**
 * #2260 — member-facing receipt for a membership subscription payment an admin
 * recorded by hand (cash, cheque, internet banking), sent only when the admin
 * chooses to email on mark-paid. Manual mark-paid only exists for subscriptions
 * with NO Xero invoice, so this deliberately mentions no invoice, no payment
 * link and no Xero reference — there is nothing left for the member to do.
 *
 * `amountCents` is null whenever no amount can be attributed to this one
 * member's subscription — no active charge coverage, a no-invoice fee, or a
 * charge that covers a whole family — in which case the amount line is omitted
 * rather than guessed: a manual payment is cash the app never saw, and a
 * family total printed as one member's receipt would be a false one.
 */
export function membershipPaymentRecordedTemplate(data: {
  firstName: string;
  seasonYear: number;
  amountCents: number | null;
  recordedAt: Date;
}): string {
  return layout(`
    ${heading("Membership Payment Recorded")}
    ${paragraph(
      `Hi ${escapeHtml(data.firstName)}, thank you — ${escapeHtml(CLUB_NAME)} has recorded your membership subscription payment for the ${escapeHtml(String(data.seasonYear))} season.`,
    )}
    ${infoTable([
      { label: "Season", value: escapeHtml(String(data.seasonYear)) },
      ...(data.amountCents !== null
        ? [{ label: "Amount recorded", value: formatCents(data.amountCents) }]
        : []),
      { label: "Date recorded", value: emailClubDate(data.recordedAt) },
    ])}
    ${paragraph("Your membership is now marked paid for the season, so there is nothing further for you to pay.")}
    ${supportContactSentence("If anything looks wrong, contact the club at ")}
  `);
}

// ---------------------------------------------------------------------------
// Member guests (epic #2305, MG2 #2307) — the four emails
// ---------------------------------------------------------------------------
/**
 * Every one of these four takes its variable copy ALREADY COMPOSED, from
 * src/lib/member-guest-email-notes.ts. That is deliberate and it is the reason
 * the HTML and the editable flat body cannot drift: the sender composes each
 * sentence once and hands the same string to this template and to the
 * `templateData` the flat default body renders from. A template that composed
 * its own wording would be a second copy of the copy.
 *
 * The party listing arrives as an already-escaped `MemberGuestPartyList` and is
 * embedded verbatim — running it through `escapeHtml` again would print the
 * markup to the member. Everything else IS escaped here, because names, lodge
 * names and composed sentences all carry member-supplied text.
 */
