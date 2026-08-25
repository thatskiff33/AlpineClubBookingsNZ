import {
  ageUpInvitationTemplate,
  ageUpParentEmailHandoffTemplate,
  inductionSignOffRequestTemplate,
  memberArchiveApprovedTemplate,
  memberArchiveRejectedTemplate,
  membershipApplicationApprovedTemplate,
  membershipApplicationRejectedTemplate,
  membershipCancellationApprovedTemplate,
  membershipCancellationConfirmationTemplate,
  membershipCancellationRejectedTemplate,
  membershipCancellationSubmittedTemplate,
  membershipPaymentRecordedTemplate,
  nominationRequestTemplate,
} from "@/lib/email-templates/membership";
import {
  composeOptionalEmailLine,
} from "../email-message-notes";
import {
  CLUB_BOOKINGS_NAME,
  CLUB_NAME,
} from "@/config/club-identity";
import { formatNZDate, formatNZDateTime } from "../nzst-date";
import { formatCents } from "@/lib/utils";
import { sendEmail, type EmailSendOutcome } from "./core";
import { renderEmailHtml } from "@/lib/email-theme";

export async function sendNominationRequestEmail(params: {
  email: string;
  nominatorName: string;
  applicantName: string;
  token: string;
  familyMemberCount: number;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/nominations/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Nomination request for ${params.applicantName} — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => nominationRequestTemplate({
      nominatorName: params.nominatorName,
      applicantName: params.applicantName,
      reviewUrl,
      familyMemberCount: params.familyMemberCount,
      expiresAt: params.expiresAt,
    })),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "nomination-request",
    templateData: {
      nominatorName: params.nominatorName,
      applicantName: params.applicantName,
      token: params.token,
      reviewUrl,
      familyMemberCount: params.familyMemberCount,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

/**
 * #2260 — receipt for a membership subscription payment an admin recorded by
 * hand. Sent only when the admin picks "Mark paid and email member" on the
 * manual mark-paid dialog; never on the reversal to unpaid.
 *
 * `amountCents` is null whenever the caller cannot attribute an amount to this
 * one member's subscription (no active charge coverage, a no-invoice fee, or a
 * charge that covers a whole family), and the amount line is then omitted
 * rather than guessed.
 */
export async function sendMembershipPaymentRecordedEmail(params: {
  email: string;
  firstName: string;
  seasonYear: number;
  amountCents: number | null;
  recordedAt: Date;
}): Promise<EmailSendOutcome> {
  // The outcome is returned, not swallowed: the admin who chose "email member"
  // is told what actually happened, and a suppressed or placeholder recipient
  // never reads back as "the member has been emailed".
  return sendEmail({
    to: params.email,
    subject: `Your ${params.seasonYear} membership payment has been recorded — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => membershipPaymentRecordedTemplate({
      firstName: params.firstName,
      seasonYear: params.seasonYear,
      amountCents: params.amountCents,
      recordedAt: params.recordedAt,
    })),
    // A membership subscription is not a booking, so there is no booking whose
    // "No emails" switch could apply here (#2258): bookingContext is "none" and
    // the per-booking gate short-circuits. The admin's own per-send choice on
    // the mark-paid dialog is what decides whether this sender is called at all.
    bookingContext: "none",
    templateName: "membership-payment-recorded",
    templateData: {
      firstName: params.firstName,
      seasonYear: String(params.seasonYear),
      // Integer cents rendered through the repo's one money formatter; empty
      // when no fee amount is recorded, so an override's {{amount}} renders to
      // nothing instead of a made-up figure.
      amount: params.amountCents !== null ? formatCents(params.amountCents) : "",
      // #2268: pre-composed optional line — the whole "Amount recorded: $x"
      // line, or nothing when no amount can be attributed to this member.
      amountRecordedNote: composeOptionalEmailLine(
        "Amount recorded",
        params.amountCents !== null ? formatCents(params.amountCents) : null,
        { trailing: "\n" },
      ),
      date: formatNZDate(params.recordedAt),
    },
  });
}

export async function sendInductionSignOffRequestEmail(params: {
  email: string;
  signerName: string;
  inducteeName: string;
  signerRoleLabel: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const inductionUrl = `${baseUrl}/induction`;

  await sendEmail({
    to: params.email,
    subject: `Lodge induction sign-off for ${params.inducteeName} — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => inductionSignOffRequestTemplate({
      signerName: params.signerName,
      inducteeName: params.inducteeName,
      signerRoleLabel: params.signerRoleLabel,
      inductionUrl,
    })),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "induction-sign-off-request",
    templateData: {
      signerName: params.signerName,
      inducteeName: params.inducteeName,
      signerRoleLabel: params.signerRoleLabel,
      inductionUrl,
    },
  });
}

export async function sendMembershipApplicationApprovedEmail(params: {
  email: string;
  firstName: string;
  token: string;
  adminNotes?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Your ${CLUB_NAME} membership has been approved`,
    html: await renderEmailHtml(() => membershipApplicationApprovedTemplate(
      params.firstName,
      resetUrl,
      params.adminNotes,
    )),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "membership-application-approved",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      resetUrl,
      adminNotes: params.adminNotes ?? "",
      // #2268: pre-composed optional line — the flat body has no conditional
      // syntax, so "Committee note:" must not print without a note.
      committeeNote: composeOptionalEmailLine(
        "Committee note",
        params.adminNotes,
      ),
    },
  });
}

export async function sendMembershipApplicationRejectedEmail(params: {
  email: string;
  firstName: string;
  adminNotes?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Update on your ${CLUB_NAME} membership application`,
    html: await renderEmailHtml(() => membershipApplicationRejectedTemplate(
      params.firstName,
      params.adminNotes,
    )),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "membership-application-rejected",
    templateData: {
      firstName: params.firstName,
      adminNotes: params.adminNotes ?? "",
      // #2268: pre-composed optional line (see the approved sender).
      committeeNote: composeOptionalEmailLine(
        "Committee note",
        params.adminNotes,
      ),
    },
  });
}

export async function sendMembershipCancellationSubmittedEmail(params: {
  email: string;
  firstName: string;
  participantSummary: string;
  reason?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/profile`;

  await sendEmail({
    to: params.email,
    subject: `Membership cancellation request submitted — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => membershipCancellationSubmittedTemplate({
      firstName: params.firstName,
      participantSummary: params.participantSummary,
      reason: params.reason,
      reviewUrl,
    })),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "membership-cancellation-submitted",
    templateData: {
      firstName: params.firstName,
      participantSummary: params.participantSummary,
      reason: params.reason ?? "",
      // #2268: pre-composed optional line — no dangling "Reason:".
      reasonNote: composeOptionalEmailLine("Reason", params.reason),
      reviewUrl,
    },
  });
}

export async function sendMembershipCancellationConfirmationEmail(params: {
  email: string;
  firstName: string;
  requesterName: string;
  participantName: string;
  token: string;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const confirmationUrl = `${baseUrl}/membership-cancellation/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Confirm membership cancellation request — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => membershipCancellationConfirmationTemplate({
      firstName: params.firstName,
      requesterName: params.requesterName,
      participantName: params.participantName,
      confirmationUrl,
      expiresAt: params.expiresAt,
    })),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "membership-cancellation-confirmation",
    templateData: {
      firstName: params.firstName,
      requesterName: params.requesterName,
      participantName: params.participantName,
      token: params.token,
      confirmationUrl,
      expiresAt: formatNZDateTime(params.expiresAt),
    },
  });
}

export async function sendMembershipCancellationApprovedEmail(params: {
  email: string;
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
  rejoinProcessText?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership cancellation approved — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => membershipCancellationApprovedTemplate(params)),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "membership-cancellation-approved",
    templateData: {
      firstName: params.firstName,
      participantName: params.participantName,
      reason: params.reason ?? "",
      adminNote: params.adminNote ?? "",
      rejoinProcessText: params.rejoinProcessText ?? "",
      // #2268: pre-composed optional lines — the flat body carries only these
      // tokens, so nothing prints when a value is absent.
      reasonNote: composeOptionalEmailLine("Request reason", params.reason),
      adminNoteLine: composeOptionalEmailLine("Admin note", params.adminNote),
      rejoinProcessNote: composeOptionalEmailLine(
        null,
        params.rejoinProcessText,
      ),
    },
  });
}

export async function sendMemberArchiveApprovedEmail(params: {
  email: string;
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership archive completed — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => memberArchiveApprovedTemplate(params)),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "member-archive-approved",
    templateData: {
      firstName: params.firstName,
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

export async function sendMemberArchiveRejectedEmail(params: {
  email: string;
  firstName: string;
  reason: string;
  reviewNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership archive request update — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => memberArchiveRejectedTemplate(params)),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "member-archive-rejected",
    templateData: {
      firstName: params.firstName,
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

export async function sendMembershipCancellationRejectedEmail(params: {
  email: string;
  firstName: string;
  participantName: string;
  reason?: string | null;
  adminNote?: string | null;
}) {
  await sendEmail({
    to: params.email,
    subject: `Membership cancellation update — ${CLUB_BOOKINGS_NAME}`,
    html: await renderEmailHtml(() => membershipCancellationRejectedTemplate(params)),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "membership-cancellation-rejected",
    templateData: {
      firstName: params.firstName,
      participantName: params.participantName,
      reason: params.reason ?? "",
      adminNote: params.adminNote ?? "",
      // #2268: pre-composed optional lines (see the approved sender).
      reasonNote: composeOptionalEmailLine("Request reason", params.reason),
      adminNoteLine: composeOptionalEmailLine("Admin note", params.adminNote),
    },
  });
}

export interface AgeUpInvitationEmailContext {
  targetAgeTier?: string;
  targetAgeTierLabel?: string;
  targetAgeTierMinAge?: number;
}

// Age-up invitation email (sent when youth reaches the ADULT age tier)
export async function sendAgeUpInvitationEmail(
  email: string,
  firstName: string,
  token: string,
  context: AgeUpInvitationEmailContext = {},
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;
  const targetAgeTier = context.targetAgeTier ?? "ADULT";
  const targetAgeTierLabel =
    context.targetAgeTierLabel?.trim() || "Adult (18+)";
  const targetAgeTierMinAge = context.targetAgeTierMinAge ?? 18;

  // RETURNS the mailer's outcome (#3035). The age-up cron has already flipped the
  // tier and minted the invitation token by the time it calls this, and a withheld
  // send does not throw — so swallowing the outcome left a member an adult with a
  // login and no invitation, permanently, because the cron's own re-check then
  // skips them for good.
  return sendEmail({
    to: email,
    subject: `You're now ${targetAgeTierLabel} — set up your ${CLUB_NAME} account`,
    html: await renderEmailHtml(() => ageUpInvitationTemplate(firstName, resetUrl, {
      targetAgeTierLabel,
    })),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "age-up-invitation",
    templateData: {
      firstName,
      token,
      resetUrl,
      targetAgeTier,
      targetAgeTierLabel,
      targetAgeTierMinAge,
    },
  });
}

export interface AgeUpParentEmailHandoffEmailContext {
  recipientName: string;
  memberFirstName: string;
  memberLastName: string;
  targetAgeTier?: string;
  targetAgeTierLabel?: string;
  targetAgeTierMinAge?: number;
}

// Age-up parent handoff email (sent when the ageing-up member still shares a login email)
export async function sendAgeUpParentEmailHandoffEmail(
  email: string,
  context: AgeUpParentEmailHandoffEmailContext,
) {
  const targetAgeTier = context.targetAgeTier ?? "ADULT";
  const targetAgeTierLabel =
    context.targetAgeTierLabel?.trim() || "Adult (18+)";
  const targetAgeTierMinAge = context.targetAgeTierMinAge ?? 18;
  const memberName = [context.memberFirstName, context.memberLastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  // RETURNS the mailer's outcome (#3035), for the same reason as the invitation
  // above: its caller writes a "handoff sent" audit row that permanently stops the
  // handoff being attempted again.
  return sendEmail({
    to: email,
    subject: `Email address needed for ${memberName}'s ${CLUB_NAME} login`,
    html: await renderEmailHtml(() => ageUpParentEmailHandoffTemplate({
      recipientName: context.recipientName,
      memberFirstName: context.memberFirstName,
      memberLastName: context.memberLastName,
      targetAgeTierLabel,
    })),
    // Membership/subscription mail is not about any booking (#2258).
    bookingContext: "none",
    templateName: "age-up-parent-email-handoff",
    templateData: {
      recipientName: context.recipientName,
      memberName,
      firstName: context.memberFirstName,
      targetAgeTier,
      targetAgeTierLabel,
      targetAgeTierMinAge,
    },
  });
}
