import {
  EMAIL_AUDIT_DEFAULTS,
  type EmailAuditTemplateName,
} from "@/lib/email-message-audit-defaults";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  adminSplitSettlementUnpaidLeadParagraph,
  duplicateCaptureRefundOutcomeParagraph,
  splitGuestPortionOwnBookingLine,
} from "@/lib/email-message-notes";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";

type EmailTemplateAudience = "member" | "admin" | "system";
export type NotificationDeliveryModeValue = "always" | "content_only" | "disabled";

export interface EmailTemplateDefinition {
  key: EmailAuditTemplateName;
  label: string;
  audience: EmailTemplateAudience;
  defaultSubject: string;
  defaultBody: string;
  allowedTokens: string[];
  requiredTokens: string[];
  // #2267: per required token, the other tokens an override may use instead
  // and still satisfy the requirement (see REQUIRED_TOKEN_ALTERNATIVES).
  requiredTokenAlternatives: Record<string, string[]>;
  sampleData: Record<string, string>;
  triggerSummary: string;
  frequency: string;
  deliveryEditable: boolean;
  defaultDeliveryMode: NotificationDeliveryModeValue;
}

const ADMIN_SYSTEM_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-membership-application-pending",
  "admin-minors-review",
  "admin-owner-substitution",
  "admin-partner-share-swept",
  "admin-new-booking",
  "admin-payment-failure",
  // #1992/#2007: duplicate-capture auto-refund alert. Ships via sendToAdmins, so
  // it classifies as an admin alert. Deliberately NOT delivery-locked — the
  // #1994 adjudication: muting causes no direct money loss because the refund
  // already happened inline or is durably queued for the recovery cron. Still
  // gated by the adminPaymentFailure notification preference at send time, like
  // its siblings.
  "admin-duplicate-capture-refund",
  "admin-pending-deadline",
  "admin-booking-bumped",
  "admin-capacity-warning",
  "admin-daily-digest",
  "admin-xero-sync-error",
  "admin-xero-repeated-failure",
  "admin-xero-reconciliation-report",
  "admin-refund-request",
  "admin-booking-change-request",
  "admin-issue-report",
  "admin-membership-cancellation-request",
  "admin-account-deletion-requested",
  "admin-member-archive-requested",
  "admin-member-delete-requested",
  "admin-member-delete-approved",
  "admin-member-delete-rejected",
  "admin-waitlist-offer",
  "admin-family-group-request",
  "admin-email-failure",
  "website-contact",
  "admin-booking-request-pending",
  "admin-booking-request-hold-expired",
  // #2012: terminal one-off notice when a request-origin booking is
  // auto-cancelled past check-in (its held beds released). Its own registry
  // entry (not a variant of the recurring hold-expired alert) so an admin
  // override of the recurring alert cannot rewrite this terminal notice, and
  // muting the recurring alert does not mute this one. Same admin-alert
  // plumbing: sendToAdmins, adminBookingRequest gating, NOT delivery-locked.
  "admin-booking-request-hold-cancelled",
  "admin-school-manual-invoice",
  // #1967/#1994: split non-member guest portion unpaid at hold expiry (no card
  // on file). Ships via sendToAdmins, so it classifies as an admin alert.
  // Deliberately NOT in LOCKED_DELIVERY_TEMPLATE_NAMES — it is an operational
  // nudge (the member already has their payment link; no money is lost if an
  // admin mutes it), so admins keep full delivery-mode control. Still gated by
  // the adminPaymentFailure notification preference at send time (#1422).
  "admin-split-settlement-unpaid",
  // #1993 Part A: terminal one-off notice when that guest portion is
  // auto-cancelled past check-in. Its own registry entry (not a variant of the
  // recurring alert) so an admin override of the noisy recurring alert cannot
  // rewrite this terminal notice, and muting the recurring alert does not mute
  // this one. Same admin-alert plumbing: sendToAdmins, adminPaymentFailure
  // gating, NOT delivery-locked.
  "admin-split-settlement-cancelled",
]);

// Admin/system templates whose delivery mode admins must NOT be able to change.
// admin-school-manual-invoice (#1797) is admin-facing so it classifies as an
// admin alert, but disabling it would let an approved school booking go
// un-invoiced — a money risk — so it is locked to always-send like
// admin-email-failure, matching the pre-#1797 hardcoded behaviour.
const LOCKED_DELIVERY_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-email-failure",
  "admin-school-manual-invoice",
]);

const CONTENT_ONLY_DEFAULT_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-daily-digest",
  "admin-xero-reconciliation-report",
]);

const GLOBAL_EMAIL_TEMPLATE_TOKENS = [
  "BASE_URL",
  "CLUB_BOOKINGS_NAME",
  "CLUB_EMAIL_FROM_NAME",
  "CLUB_LODGE_NAME",
  "CLUB_LODGE_TRAVEL_NOTE",
  "CLUB_NAME",
  "CONTACT_EMAIL",
  "LODGE_CAPACITY",
  "SUPPORT_EMAIL",
] as const;

// Tokens a send site supplies that are NOT written into the default body, so
// an admin override may still reference them. #2268 added a second population
// here: the raw values behind every pre-composed `...Note` / `...Line` token.
// The default bodies now carry only the composed token (the sender builds the
// whole line, or nothing at all, because the render path has no conditional
// syntax), but the raw value stays supplied so an override written before
// #2268 keeps rendering and keeps re-saving.
// Exported as a test seam (#2268): the supplied-token approval guard reads it.
export const EXTRA_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  // Lodge the warning is about; empty for single-lodge clubs (ADR-002).
  "admin-capacity-warning": ["lodgeName"],
  // #2268 raw values behind the pre-composed lines (see the note above).
  "checkin-reminder": ["choreName", "choreDescription"],
  "pre-arrival-reminder": ["doorCode", "expectedArrivalTime"],
  "chore-roster": ["choreName", "choreDescription", "choreLink"],
  "membership-application-rejected": ["adminNotes"],
  "child-request-rejected": ["reason"],
  "family-group-create-rejected": ["reason"],
  "account-deletion-rejected": ["adminNote"],
  "admin-new-booking": ["reviewReason"],
  "admin-duplicate-capture-refund": ["errorMessage"],
  "admin-refund-request": ["requestedAmount"],
  "admin-booking-change-request": ["reason"],
  "booking-request-declined": ["reason"],
  "booking-review-approved": ["adminNotes"],
  "booking-review-rejected": ["adminNotes"],
  "split-guest-portion-cancelled": ["bookingReference"],
  "membership-payment-recorded": ["amount"],
  // Split-booking parent (#738): a pre-composed sentence describing the
  // provisional non-member portion; empty for a non-split confirmation.
  // #2267: the legacy per-piece promo and door-code tokens left the default
  // body when it moved to the pre-composed {{promoSummary}} and
  // {{doorCodeNote}} blocks, but the send still supplies them, so an existing
  // saved override that references them stays valid and re-savable.
  // {{promoAdjustment}} is the signed value ("-$12.00" / "+$1,370.00");
  // {{discount}} can only express a price cut. The pre-composed tokens are
  // listed here too (belt and braces): they are allowed for an override even
  // if a later default-body rewrite stops using one of them.
  "booking-confirmed": [
    "discount",
    "doorCode",
    "doorCodeNote",
    "promoAdjustment",
    "promoCode",
    "promoSummary",
    "provisionalGuestsNote",
    "subtotal",
  ],
  // #2267: since the ragged "[only when …]" lines were removed, the default
  // body leans on the pre-composed {{changeSummary}} (which rows changed) and
  // {{paymentNote}} (the additional-payment story). Every per-piece token the
  // old body built its rows from stays allowed — and supplied — so an override
  // saved before this change keeps rendering and re-saving. The pre-composed
  // tokens are listed too, so a later default-body rewrite cannot silently
  // withdraw permission to use them in an override.
  "booking-modified": [
    "additionalPaymentMethod",
    "changeFee",
    "changeSummary",
    "newCheckIn",
    "newCheckOut",
    "newGuestCount",
    "newTotal",
    "oldCheckIn",
    "oldCheckOut",
    "oldGuestCount",
    "oldTotal",
    "paymentNote",
    "paymentReference",
    "xeroInvoiceNumber",
  ],
  "password-reset": ["resetUrl"],
  "admin-password-reset": ["resetUrl"],
  "member-setup-invite": ["resetUrl"],
  "magic-link-login": ["loginUrl"],
  "email-verification": ["verifyUrl"],
  "email-change-verification": ["verifyUrl"],
  "nomination-request": ["reviewUrl"],
  "membership-application-approved": ["resetUrl", "adminNotes"],
  "admin-membership-application-pending": ["reviewUrl"],
  "family-group-invitation": ["profileUrl"],
  "partner-link-request": ["profileUrl"],
  "membership-cancellation-submitted": [
    "participantSummary",
    "reason",
    "reviewUrl",
  ],
  "membership-cancellation-confirmation": ["confirmationUrl"],
  "membership-cancellation-approved": [
    "adminNote",
    "participantName",
    "reason",
    "rejoinProcessText",
  ],
  "membership-cancellation-rejected": [
    "adminNote",
    "participantName",
    "reason",
  ],
  "admin-membership-cancellation-request": [
    "participantSummary",
    "reason",
    "reviewUrl",
  ],
  "admin-account-deletion-requested": ["reason", "requestId", "reviewUrl"],
  "admin-member-archive-requested": ["memberName", "reason", "reviewUrl"],
  "member-archive-approved": ["reason", "reviewNote"],
  "member-archive-rejected": ["reason", "reviewNote"],
  "admin-member-delete-requested": ["memberName", "reason", "reviewUrl"],
  "admin-member-delete-approved": ["memberName", "reason", "reviewNote"],
  "admin-member-delete-rejected": [
    "memberName",
    "reason",
    "reviewNote",
    "reviewUrl",
  ],
  "admin-xero-repeated-failure": [
    "localUrl",
    "xeroObjectUrl",
    "localModel",
    "localId",
    "latestErrorMessage",
  ],
  "refund-request-approved": ["adminNotes"],
  "refund-request-declined": ["adminNotes"],
  "age-up-invitation": ["resetUrl", "targetAgeTier", "targetAgeTierMinAge"],
  "age-up-parent-email-handoff": ["targetAgeTier", "targetAgeTierMinAge"],
  "booking-request-verification": ["verifyUrl"],
  "booking-request-approved": ["payUrl"],
  // #1967/#1994: the send passes a pre-built {{payUrl}} alongside the raw
  // {{token}}, so allow admins to reference it in an override (mirrors
  // booking-request-approved).
  "split-guest-payment-link": ["payUrl"],
  "booking-request-quote": ["respondUrl"],
};

// #2267: tokens an override may use INSTEAD of a required token and still
// satisfy the requirement. The requirement is "this information must stay in
// the body", not "this exact token" — the booking-confirmed body now carries
// the pre-composed {{doorCodeNote}} line (which renders nothing when the club
// has no door code), but an override saved before that change writes its own
// "Door code: {{doorCode}}" line and must keep validating and re-saving.
const REQUIRED_TOKEN_ALTERNATIVES: Partial<
  Record<EmailAuditTemplateName, Record<string, string[]>>
> = {
  "booking-confirmed": { doorCodeNote: ["doorCode"] },
  // #2268: the same swap on the pre-arrival reminder.
  "pre-arrival-reminder": { doorCodeNote: ["doorCode"] },
};

const REQUIRED_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  "booking-confirmed": ["CLUB_LODGE_TRAVEL_NOTE", "doorCodeNote"],
  // #2268: pre-arrival-reminder gets the same treatment #2267 gave
  // booking-confirmed — the door-code line is composed by the sender, so the
  // body carries {{doorCodeNote}} instead of a bare "Door code:" heading that
  // printed even for a lodge with no code. An override written before the
  // change still satisfies this through REQUIRED_TOKEN_ALTERNATIVES.
  "pre-arrival-reminder": ["CLUB_LODGE_TRAVEL_NOTE", "doorCodeNote"],
  "password-reset": ["token"],
  "admin-password-reset": ["token"],
  "member-setup-invite": ["token"],
  // #2034: the tokenised /login/magic?token=<token> link is the essential body
  // content — the required "token" blocks an override that drops the sign-in
  // link. Sensitive-log redaction is driven separately by
  // SENSITIVE_EMAIL_LOG_TEMPLATES in src/lib/email/internal.ts.
  "magic-link-login": ["token"],
  "email-verification": ["token"],
  "email-change-verification": ["newEmail", "token"],
  "email-change-notification": ["newEmail"],
  "nomination-request": ["applicantName", "token"],
  "partner-invite": ["inviterName", "token"],
  "partner-invite-claimed": ["firstName", "groupName"],
  "partner-link-request": ["requesterName"],
  "partner-link-confirmed": ["partnerName"],
  "partner-link-removed": ["partnerName"],
  "membership-application-approved": ["token"],
  "membership-cancellation-confirmation": [
    "participantName",
    "requesterName",
    "token",
  ],
  "membership-cancellation-submitted": ["participantSummary", "reviewUrl"],
  "membership-cancellation-approved": ["participantName"],
  "membership-cancellation-rejected": ["participantName"],
  "admin-membership-cancellation-request": [
    "participantSummary",
    "requesterName",
    "reviewUrl",
  ],
  "admin-account-deletion-requested": [
    "memberEmail",
    "memberName",
    "reviewUrl",
  ],
  "admin-member-archive-requested": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "member-archive-approved": ["firstName", "reason"],
  "member-archive-rejected": ["firstName", "reason"],
  "admin-member-delete-requested": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "admin-member-delete-approved": ["memberName", "requesterName", "reason"],
  "admin-member-delete-rejected": [
    "memberName",
    "requesterName",
    "reason",
    "reviewUrl",
  ],
  "age-up-invitation": ["token"],
  "age-up-parent-email-handoff": ["memberName"],
  "website-contact": ["name", "email", "message"],
  "admin-email-failure": [
    "originalRecipient",
    "originalTemplateName",
    "attemptCount",
  ],
  "bulk-communication": ["adminEnteredBody"],
  "booking-request-verification": ["token"],
  "booking-request-approved": ["token"],
  // #1967/#1994: the tokenised /pay/<token> bearer link is the essential body
  // content — the required "token" blocks an override that drops the pay link.
  // Sensitive-log redaction is driven separately by SENSITIVE_EMAIL_LOG_TEMPLATES
  // in src/lib/email/internal.ts, which already contains this template.
  "split-guest-payment-link": ["token"],
  "booking-request-quote": ["token"],
  "admin-booking-request-pending": ["requesterName", "reviewUrl"],
  "admin-booking-request-hold-expired": ["requesterName", "reviewUrl"],
  // #2012: terminal notice — requesterName identifies the requester and
  // reviewUrl is the admin action link, mirroring the recurring alert.
  "admin-booking-request-hold-cancelled": ["requesterName", "reviewUrl"],
  // #2012: member-facing terminal notice. No bearer token (so NOT
  // sensitive-log); firstName + the stay dates are the load-bearing content.
  "booking-request-payment-expired": ["firstName", "checkIn", "checkOut"],
  // #1992/#2007: memberName identifies the affected member and reviewUrl is the
  // admin action link (the payments board), mirroring the other admin alerts.
  "admin-duplicate-capture-refund": ["memberName", "reviewUrl"],
  "admin-split-settlement-unpaid": ["memberName", "reviewUrl"],
  // #1993 Part A: terminal notice — memberName identifies the member and
  // reviewUrl is the admin action link, mirroring the recurring alert.
  "admin-split-settlement-cancelled": ["memberName", "reviewUrl"],
  // #1993 Part A: member-facing terminal notice. No bearer token (so NOT
  // sensitive-log); firstName + the stay dates are the load-bearing content.
  "split-guest-portion-cancelled": ["firstName", "checkIn", "checkOut"],
  "admin-partner-share-swept": ["memberName", "partnerName", "reason"],
  "booking-review-approved": ["bookingId"],
  "induction-sign-off-request": ["inductionUrl"],
  "school-attendee-confirmation": ["token"],
  "group-booking-join-verification": ["token"],
  // #2260: who it is for and which season it covers are the load-bearing
  // content of a manual-payment receipt. The amount is deliberately NOT
  // required — it is omitted whenever the club has no recorded fee amount for
  // the season, so requiring it would force an override to promise a figure the
  // send cannot always supply.
  "membership-payment-recorded": ["firstName", "seasonYear"],
};

const TEMPLATE_TRIGGER_METADATA: Partial<
  Record<EmailAuditTemplateName, { triggerSummary: string; frequency: string }>
> = {
  "admin-daily-digest": {
    triggerSummary: "Scheduled admin alert summary",
    frequency: "Daily at the configured cron time",
  },
  "admin-xero-reconciliation-report": {
    triggerSummary: "Scheduled Xero reconciliation report",
    frequency: "When the Xero reconciliation cron runs",
  },
  "admin-email-failure": {
    triggerSummary: "Exhausted retry alert",
    frequency: "When a retryable email permanently fails",
  },
  "admin-booking-change-request": {
    triggerSummary: "Locked booking change request submitted",
    frequency: "Per member/admin request submission",
  },
  // #2321: split from the combined refund-request-resolved template so a
  // declined member can never receive approval wording.
  "refund-request-approved": {
    triggerSummary:
      "An admin approved a member's refund appeal (and chose to notify them)",
    frequency: "Per approved refund appeal",
  },
  "refund-request-declined": {
    triggerSummary:
      "An admin declined a member's refund appeal (and chose to notify them)",
    frequency: "Per declined refund appeal",
  },
  "admin-duplicate-capture-refund": {
    triggerSummary:
      "A second, distinct Stripe capture arrived on an already-settled booking, so the duplicate charge was auto-refunded (inline in full, or a durable retry queued when the inline refund could not complete)",
    frequency:
      "On duplicate-capture adjudication — rare; once per distinct duplicate capture that is auto-refunded",
  },
  "admin-minors-review": {
    triggerSummary:
      "Paid booking edited into a minors-only (no-adult) composition",
    frequency: "Once when a guest removal or batch edit newly trips the flag",
  },
  "admin-owner-substitution": {
    triggerSummary:
      "Held booking-request owner failed re-validation at conversion; a fresh contact was substituted and the invoice will bill it instead of the intended owner",
    frequency: "Once per conversion where the held owner is no longer mappable",
  },
  "admin-partner-share-swept": {
    triggerSummary:
      "A partner pair's future shared double-bed placements were swept after their link dissolved or a member stopped being an eligible sharer (#1756)",
    frequency:
      "Once per dissolve/deactivation/tier-change event that removed at least one placement",
  },
  "family-group-create-request-confirmation": {
    triggerSummary: "Member-initiated family group creation request submitted",
    frequency: "Per group creation request",
  },
  "family-group-create-approved": {
    triggerSummary: "Family group creation request approved by admin",
    frequency: "Per group creation approval",
  },
  "family-group-create-rejected": {
    triggerSummary: "Family group creation request rejected by admin",
    frequency: "Per group creation rejection",
  },
  "partner-invite": {
    triggerSummary: "Partner without an account invited to a family group",
    frequency: "Per partner invitation minted",
  },
  "partner-invite-claimed": {
    triggerSummary: "Invited partner registered and claimed their invitation",
    frequency: "Per partner invitation claimed",
  },
  "partner-link-request": {
    triggerSummary: "Member asked another member to confirm a partner relationship",
    frequency: "Per partner link request",
  },
  "partner-link-confirmed": {
    triggerSummary: "Partner relationship confirmed (accepted, claimed, or admin-recorded)",
    frequency: "Per partner link confirmation",
  },
  "partner-link-removed": {
    triggerSummary: "Confirmed partner relationship removed",
    frequency: "Per partner link removal",
  },
  "membership-cancellation-submitted": {
    triggerSummary: "Membership cancellation request submitted",
    frequency: "Per requester submission",
  },
  "admin-membership-cancellation-request": {
    triggerSummary: "Membership cancellation ready for admin review",
    frequency: "Per request when at least one participant is reviewable",
  },
  "admin-member-archive-requested": {
    triggerSummary: "Member archive request submitted",
    frequency: "Per archive request",
  },
  "member-archive-approved": {
    triggerSummary: "Member archive request approved",
    frequency: "Per archive approval",
  },
  "member-archive-rejected": {
    triggerSummary: "Member archive request rejected",
    frequency: "Per archive rejection",
  },
  "admin-member-delete-requested": {
    triggerSummary: "Member hard-delete request submitted",
    frequency: "Per delete request",
  },
  "admin-account-deletion-requested": {
    triggerSummary: "Self-service account deletion request submitted",
    frequency: "Per member deletion request",
  },
  "admin-member-delete-approved": {
    triggerSummary: "Member hard-delete request approved",
    frequency: "Per delete approval",
  },
  "admin-member-delete-rejected": {
    triggerSummary: "Member hard-delete request rejected",
    frequency: "Per delete rejection",
  },
  "bulk-communication": {
    triggerSummary: "Admin bulk communication send",
    frequency: "Per admin send action",
  },
  "website-contact": {
    triggerSummary: "Website contact form submission",
    frequency: "Per contact form submission",
  },
  "pre-arrival-reminder": {
    triggerSummary: "Pre-arrival reminder with current lodge access details",
    frequency: "Once per confirmed or paid booking in the reminder window",
  },
  "booking-request-verification": {
    triggerSummary: "Public booking request submitted",
    frequency: "Per booking request submission (and resend requests)",
  },
  "booking-request-approved": {
    triggerSummary: "Public booking request approved and priced by admin",
    frequency: "Per booking request approval",
  },
  "booking-request-quote": {
    triggerSummary: "Public booking request quote sent by admin",
    frequency: "Per booking request quote version sent",
  },
  "booking-request-declined": {
    triggerSummary: "Public booking request declined by admin",
    frequency: "Per booking request decline",
  },
  "admin-booking-request-pending": {
    triggerSummary: "Public booking request verified and ready for pricing",
    frequency: "Per verified booking request",
  },
  "admin-booking-request-hold-expired": {
    triggerSummary: "Request-origin booking unpaid at hold expiry",
    frequency:
      "On a capped cadence while the request booking stays unpaid: the first three hold extensions, then every seventh. A terminal cancellation past the check-in day ends the series and sends the separate 'admin-booking-request-hold-cancelled' notice instead",
  },
  "admin-booking-request-hold-cancelled": {
    triggerSummary:
      "A booking created from a public booking request was still unpaid with no card on file at the end of its check-in day, so it was automatically cancelled and its held beds released",
    frequency:
      "Once per request booking, when it is auto-cancelled past check-in; ends the recurring 'admin-booking-request-hold-expired' alert series",
  },
  "booking-request-payment-expired": {
    triggerSummary:
      "The booking created from the member's approved public booking request was released because it stayed unpaid up to the check-in day (nothing was ever charged)",
    frequency: "Once per request booking auto-cancelled past check-in",
  },
  "admin-split-settlement-unpaid": {
    triggerSummary:
      "Split booking's non-member guest portion reached its hold deadline with no card on file (member paid their own place by internet banking, or their own place is also unpaid)",
    frequency:
      "On a capped cadence while the guest portion stays unpaid: the first three hold extensions, then every seventh. A terminal cancellation past the check-in day ends the series and sends the separate 'admin-split-settlement-cancelled' notice instead",
  },
  "admin-split-settlement-cancelled": {
    triggerSummary:
      "Split booking's non-member guest portion was still unpaid with no card on file at the end of its check-in day, so the provisional guest booking was automatically cancelled",
    frequency:
      "Once per split guest portion, when it is auto-cancelled past check-in; ends the recurring 'admin-split-settlement-unpaid' alert series",
  },
  "split-guest-portion-cancelled": {
    triggerSummary:
      "The member's provisional non-member guest portion was auto-cancelled because it stayed unpaid up to the check-in day (nothing was ever charged)",
    frequency: "Once per split guest portion auto-cancelled past check-in",
  },
  "split-guest-payment-link": {
    triggerSummary:
      "Split booking's guest portion needs settling with no saved card, so the member is emailed a secure /pay/<token> link",
    frequency:
      "Once per fresh payment-link mint (idempotent across cron re-runs); also on the on-demand booking-detail issue action",
  },
  "booking-review-approved": {
    triggerSummary:
      "Admin approved a booking held for minors review, releasing it for payment",
    frequency:
      "Once per approval decision, to the owner, unless the admin opts out of notifying (#1790)",
  },
  "booking-review-rejected": {
    triggerSummary:
      "Admin declined a booking held for minors review; the booking is cancelled",
    frequency:
      "Once per rejection decision, to the owner (suppressible #1790; the always-notify cancellation email still sends)",
  },
  "induction-sign-off-request": {
    triggerSummary:
      "Induction sign-off signer assigned (admin assignment or membership-application approval)",
    frequency: "One email per assigned signer who has an email address",
  },
  "school-attendee-confirmation": {
    triggerSummary:
      "School contact prompted to confirm placeholder attendees (cron sweep or admin resend)",
    frequency:
      "Per send to the school contact; flagged a reminder after the first, token rotated each send",
  },
  "admin-school-manual-invoice": {
    triggerSummary:
      "Approved school booking-request converted while the Xero module is off, so no invoice was raised",
    frequency:
      "Once per conversion, to admins opted into public booking-request alerts",
  },
  "group-booking-join-verification": {
    triggerSummary:
      "Non-member used a join code to claim a group-booking spot and must confirm their email",
    frequency: "One email per join attempt; link expires after 48 hours",
  },
  "group-settlement-receipt": {
    triggerSummary: "Organiser-pays combined group payment settled successfully",
    frequency: "One receipt to the organiser per settlement",
  },
  "group-join-settled": {
    triggerSummary:
      "Organiser settled a joiner's spot as part of a combined group payment",
    frequency: "One email per joiner booking covered by the settled payment",
  },
  "group-settlement-expired": {
    triggerSummary:
      "Organiser's started combined group payment expired before completion; held beds released",
    frequency: "One email to the organiser per expired settlement",
  },
  "group-join-released": {
    triggerSummary:
      "A joiner's held bed was released when the organiser's combined payment expired",
    frequency: "One email per joiner whose held bed was released",
  },
  "group-join-cancelled": {
    triggerSummary:
      "Reaped organiser-pays place was never retried, so the joiner's pending booking was cancelled (#1094)",
    frequency: "One email per cancelled joiner booking",
  },
  "membership-payment-recorded": {
    triggerSummary:
      "An admin manually marked a member's subscription paid (cash, cheque or internet banking, with no Xero invoice) and chose to notify the member",
    frequency:
      "Once per manual mark-paid where the admin picks 'Mark paid and email member'; never on a reversal to unpaid",
  },
};

function titleCaseTemplateKey(key: string): string {
  return key
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function audienceForTemplate(key: EmailAuditTemplateName): EmailTemplateAudience {
  if (key === "admin-email-failure") return "system";
  if (ADMIN_SYSTEM_TEMPLATE_NAMES.has(key)) return "admin";
  return "member";
}

function extractTokensFromDefaults(...values: string[]): string[] {
  return values.flatMap((value) =>
    Array.from(value.matchAll(/\{\{([^{}]+)\}\}/g), (match) =>
      match[1].trim(),
    ).filter(Boolean),
  );
}

function uniqueSortedTokens(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

// Exported as a test seam (#2268): the dangling-line guard renders every
// shipped default from the same preview values the admin editor shows.
export function sampleValue(token: string): string {
  if (token === "BASE_URL") return "https://bookings.example.org";
  if (token === "CLUB_NAME") return "Example Mountain Club";
  if (token === "CLUB_BOOKINGS_NAME") return "Example Mountain Club - Bookings";
  if (token === "CLUB_LODGE_NAME") return "Example Mountain Club Lodge";
  if (token === "CLUB_EMAIL_FROM_NAME") {
    return "Example Mountain Club - Online Booking System";
  }
  if (token === "CLUB_LODGE_TRAVEL_NOTE") {
    return "Please allow adequate travel time.";
  }
  if (token === "SUPPORT_EMAIL" || token === "CONTACT_EMAIL") {
    return "support@example.org";
  }
  if (token === "LODGE_CAPACITY") return String(FALLBACK_LODGE_CAPACITY);
  if (token === "doorCode") return "1234";
  // #2267: the whole pre-composed line, exactly as the send builds it, so the
  // preview shows what a member reads (and shows nothing extra when a club has
  // no door code — the live send renders this token empty).
  if (token === "doorCodeNote") return "Door code: 1234";
  if (token === "expectedArrivalTime") return "16:30";
  // #2268 pre-composed line tokens. Each preview mirrors exactly what its
  // sender composes, so the admin editor shows the shape a member will read
  // and a value that is absent previews as nothing at all rather than as a
  // dangling label. ({{doorCodeNote}} is previewed above, with #2267.)
  if (token === "expectedArrivalNote") return "Expected arrival: 16:30\n";
  // Shared by checkin-reminder and chore-roster. The chore-roster body
  // already writes its own lead-in line, so the preview is the chore lines
  // alone; the check-in reminder's real value prefixes its own heading.
  if (token === "choreListNote") {
    return "Wood run: Restock the woodshed\nDishes\n\n";
  }
  if (token === "choreLinkNote") {
    return (
      "Mark Chores Complete: https://bookings.example.org/chores/sample-token\n\n" +
      "Use this link to mark your chores as done from your phone. Link expires in 48 hours.\n\n"
    );
  }
  if (token === "committeeNote") return "Committee note: Welcome aboard.\n\n";
  if (token === "adminNoteLine") {
    return "Admin note: Reviewed by the committee.\n\n";
  }
  if (token === "adminNotesLine") {
    return "Notes: Reviewed by the committee.\n\n";
  }
  if (token === "reasonNote") return "Reason: Moving overseas.\n\n";
  if (token === "rejoinProcessNote") {
    return "To rejoin later, submit a new membership application.\n\n";
  }
  if (token === "reviewNoteLine") {
    return "Review note: Approved on review.\n\n";
  }
  if (token === "reviewReasonNote") {
    return "This booking needs review: no adult guest is listed.\n\n";
  }
  if (token === "requestedAmountNote") return "Requested: $123.45\n";
  if (token === "amountRecordedNote") return "Amount recorded: $123.45\n";
  if (token === "bookingReferenceNote") {
    return "Your booking reference: BK-1234\n";
  }
  if (token === "localRecordNote") return "Local Record: Booking bk_1234\n";
  if (token === "latestErrorNote") {
    return "Latest Error: Rate limit exceeded\n";
  }
  if (token === "xeroLinksNote") {
    // #2283: the Xero half is built by the one URL builder rather than spelled
    // out, so this preview shows the organisation-scoped link an operator will
    // actually receive — and the xero-links guard stays honest.
    return (
      "Open local record: https://bookings.example.org/admin/bookings/bk_1234\n" +
      `Open Xero object: ${buildXeroInvoiceUrl("sample-invoice-id")}\n`
    );
  }
  if (token === "refundOutcomeNote") {
    return duplicateCaptureRefundOutcomeParagraph(false);
  }
  if (token === "settlementActionNote") {
    return adminSplitSettlementUnpaidLeadParagraph(false);
  }
  if (token === "ownBookingNote") {
    return splitGuestPortionOwnBookingLine(true);
  }
  // #2267: mirror what sendBookingConfirmedEmail composes — each row carries
  // its own trailing newline so the default body's
  // "{{promoSummary}}Total Paid: …" previews as a contiguous block.
  //
  // The promo money samples deliberately reconcile against the generic
  // "$123.45" that every *total* token falls through to below: $153.45 subtotal
  // minus a $30.00 promo is $123.45 paid. A preview whose own arithmetic does
  // not add up teaches an admin to distrust the preview.
  if (token === "promoSummary") {
    return "Subtotal: $153.45\nPromo adjustment (PROMO2026): -$30.00\n";
  }
  // #2267: one coherent booking-modified sample — a 2-guest stay whose dates
  // moved from 1–3 Jul to 8–10 Jul and whose price rose from $123.45 to
  // $150.00 with no change fee, leaving $26.55 to pay. Every token below tells
  // that same story, including the per-piece ones a legacy override uses, so
  // an admin's preview reconciles instead of mixing three unrelated amounts.
  if (token === "modificationTypeLabel") return "Dates Changed";
  if (token === "paymentNote") {
    return "An additional payment of $26.55 is required.";
  }
  if (token === "changeSummary") {
    return "Previous Dates: 1 Jul 2026 – 3 Jul 2026\nNew Dates: 8 Jul 2026 – 10 Jul 2026\nGuests: 2\nPrevious Total: $123.45\nNew Total: $150.00\n";
  }
  if (token === "oldCheckIn") return "1 Jul 2026";
  if (token === "oldCheckOut") return "3 Jul 2026";
  if (token === "newCheckIn") return "8 Jul 2026";
  if (token === "newCheckOut") return "10 Jul 2026";
  if (token === "oldTotal") return "$123.45";
  if (token === "newTotal") return "$150.00";
  if (token === "changeFee") return "$0.00";
  if (token === "promoAdjustment") return "-$30.00";
  if (token === "promoCode") return "PROMO2026";
  if (token === "discount") return "$30.00";
  if (token === "subtotal") return "$153.45";
  if (token.endsWith("Email") || token === "email") return "member@example.org";
  if (token.endsWith("Url") || token.endsWith("URL")) {
    return "https://bookings.example.org/admin";
  }
  if (token.toLowerCase().includes("amount") || token.includes("total")) {
    return "$123.45";
  }
  if (token.toLowerCase().includes("count")) return "2";
  if (token.toLowerCase().includes("date") || token.endsWith("At")) {
    // Matches what the senders actually produce: formatNZDate renders the
    // medium NZ style ("1 Jul 2026"), so an admin previewing an override sees
    // the shape their members will read, not a longer one it never emits.
    return "1 Jul 2026";
  }
  if (token === "s") return "s";
  if (token === "token") return "sample-token";
  if (token === "recipientName") return "Sam Parent";
  if (token === "lodgeName") return "Example Mountain Club Lodge";
  if (token === "seasonYear") return "2026";
  if (token === "targetAgeTier") return "ADULT";
  if (token === "targetAgeTierLabel") return "Adult (18+)";
  if (token === "targetAgeTierMinAge") return "18";
  return token.replace(/[|]/g, " ");
}

export const EMAIL_TEMPLATE_DEFINITIONS: EmailTemplateDefinition[] = (
  Object.entries(EMAIL_AUDIT_DEFAULTS) as Array<
    [
      EmailAuditTemplateName,
      { defaultSubject: string; defaultBody: string },
    ]
  >
).map(([key, defaults]) => {
  const allowedTokens = uniqueSortedTokens([
    ...GLOBAL_EMAIL_TEMPLATE_TOKENS,
    ...extractTokensFromDefaults(defaults.defaultSubject, defaults.defaultBody),
    ...(EXTRA_TEMPLATE_TOKENS[key] ?? []),
    // An accepted alternative to a required token is by definition allowed.
    ...Object.values(REQUIRED_TOKEN_ALTERNATIVES[key] ?? {}).flat(),
  ]);
  const metadata = TEMPLATE_TRIGGER_METADATA[key] ?? {
    triggerSummary: "Audited application email",
    frequency: "Per trigger",
  };

  return {
    key,
    label: titleCaseTemplateKey(key),
    audience: audienceForTemplate(key),
    defaultSubject: defaults.defaultSubject,
    defaultBody: defaults.defaultBody,
    allowedTokens,
    requiredTokens: REQUIRED_TEMPLATE_TOKENS[key] ?? [],
    requiredTokenAlternatives: REQUIRED_TOKEN_ALTERNATIVES[key] ?? {},
    sampleData: Object.fromEntries(
      allowedTokens.map((token) => [token, sampleValue(token)]),
    ),
    triggerSummary: metadata.triggerSummary,
    frequency: metadata.frequency,
    deliveryEditable:
      ADMIN_SYSTEM_TEMPLATE_NAMES.has(key) &&
      !LOCKED_DELIVERY_TEMPLATE_NAMES.has(key),
    defaultDeliveryMode: CONTENT_ONLY_DEFAULT_TEMPLATE_NAMES.has(key)
      ? "content_only"
      : "always",
  };
});

const EMAIL_TEMPLATE_KEYS = EMAIL_TEMPLATE_DEFINITIONS.map(
  (definition) => definition.key,
);

export const EMAIL_TEMPLATE_KEY_SET = new Set<string>(EMAIL_TEMPLATE_KEYS);

const APPROVED_EMAIL_TEMPLATE_TOKENS = [
  "BASE_URL",
  "CLUB_BOOKINGS_NAME",
  "CLUB_EMAIL_FROM_NAME",
  "CLUB_LODGE_NAME",
  "CLUB_LODGE_TRAVEL_NOTE",
  "CLUB_NAME",
  "CONTACT_EMAIL",
  "LODGE_CAPACITY",
  "SUPPORT_EMAIL",
  "additionalAmount",
  "additionalPaymentMethod",
  "adminEnteredBody",
  "adminEnteredSubject",
  "adminNote",
  // #2268: pre-composed optional lines. The senders build the whole line
  // (or nothing at all) because the render path has no conditional syntax;
  // the raw values stay approved so overrides written before #2268 keep
  // rendering and keep re-saving.
  "adminNoteLine",
  "adminNotes",
  "adminNotesLine",
  "amountRecordedNote",
  "amount",
  "applicantEmail",
  "applicantName",
  "attemptCount",
  "availableBeds",
  "bookingId",
  "bookingReference",
  "bookingReferenceNote",
  "bumpedMemberName",
  "changeFee",
  // #2267: pre-composed block of the booking-modification rows that actually
  // changed (Previous/New pairs only where something moved).
  "changeSummary",
  "checkIn",
  "checkOut",
  "childName",
  "confirmationUrl",
  "choreDescription",
  "choreLink",
  "choreLinkNote",
  "choreListNote",
  "choreName",
  "committeeNote",
  "contactEmail",
  "correlationKey",
  "count",
  "creditRestored",
  "creditRestoredMessage",
  "creditUsed",
  "date",
  "deadline",
  "description",
  "details",
  "discount",
  "doorCode",
  // #2267: pre-composed "Door code: 1234" line; empty when the lodge has no
  // door code recorded, so the body never carries a dangling label.
  "doorCodeNote",
  "email",
  "endDate",
  "entityType",
  "errorMessage",
  "errorType",
  "expectedArrivalNote",
  "expectedArrivalTime",
  "expiresAt",
  "expiryLabel",
  "failureCount",
  "familyMemberCount",
  "firstName",
  "formattedDate",
  "generatedAt",
  "groupName",
  "guestCount",
  "guestFirstName",
  "guestLastName",
  "guestName",
  "holdUntil",
  "hoursRemaining",
  "inducteeName",
  "inductionUrl",
  "intendedMemberId",
  "intendedMemberName",
  "inviteeName",
  "inviterName",
  "issueCategoryCount",
  "issueReportUrl",
  "issueTotalCount",
  "joinerCount",
  "latestErrorMessage",
  "latestErrorNote",
  "localId",
  "localRecordNote",
  "localModel",
  "loginUrl",
  // #2268: supplied by sendAdminCapacityWarningAlert and allowed for that
  // template, but never approved — so the editor rejected it as an unknown
  // token and no admin could use it. Same shape as {{promoAdjustment}}.
  "lodgeName",
  "lookbackHours",
  "memberEmail",
  "memberName",
  "message",
  "modificationTypeLabel",
  "name",
  "newCheckIn",
  "newCheckOut",
  "newEmail",
  "newGuestCount",
  "newTotal",
  "nominatorName",
  "noticeTitle",
  "noticeUrl",
  "occupiedBeds",
  "ownBookingNote",
  "oldCheckIn",
  "oldCheckOut",
  "oldGuestCount",
  "oldTotal",
  "operation",
  "operationType",
  "organiserName",
  "originalRecipient",
  "originalTemplateName",
  "pageTitle",
  "pageUrl",
  "paidAmount",
  "parentName",
  "partnerName",
  "payUrl",
  "paymentIntentId",
  "paymentReference",
  "paymentNote",
  "price",
  "percent",
  "participantName",
  "participantSummary",
  "pin",
  "position",
  // #2267: signed promo value ("-$12.00" discount, "+$1,370.00" for a
  // price-raising FIXED_NIGHTLY/SET_PRICE promo). Unusable by admins before
  // #2267 even though the send supplied it — the one token that could explain
  // a surcharge promo.
  "promoAdjustment",
  "promoCode",
  // #2267: pre-composed multi-line Subtotal + signed Promo adjustment block
  // (empty without a promo); the provisionalGuestsNote precedent.
  "promoSummary",
  "provisionalGuestsNote",
  "quoteOptions",
  "reason",
  "reasonNote",
  "recipientLabel",
  "refundAmount",
  "refundOutcomeNote",
  "refundMessage",
  "refundedAmount",
  "remainingAmount",
  "remainingCredit",
  "recipientName",
  "profileUrl",
  "requestId",
  "requestType",
  "requestedSummary",
  "requestedAmount",
  // #2268: the booking-request quote response link, supplied and allowed but
  // never approved (see lodgeName). Stays subject-sensitive.
  "respondUrl",
  "requestedAmountNote",
  "requesterName",
  "rejoinProcessNote",
  "rejoinProcessText",
  "resetUrl",
  "reviewNote",
  "reviewNoteLine",
  "reviewReason",
  "reviewReasonNote",
  "reviewUrl",
  "localUrl",
  "s",
  "schoolName",
  // #2260: the membership season a manual subscription payment was recorded
  // against (the club's Apr–Mar season year).
  "seasonYear",
  "settlementActionNote",
  "severityLabel",
  "signerName",
  "signerRoleLabel",
  "stalePendingMinutes",
  "startDate",
  "status",
  "substituteMemberId",
  "substituteMemberName",
  "subtotal",
  "targetAgeTier",
  "targetAgeTierLabel",
  "targetAgeTierMinAge",
  "timestamp",
  "token",
  "total",
  "totalAlerts",
  "totalPaid",
  "triggeringMemberName",
  "verifyUrl",
  "windowHours",
  "xeroLinksNote",
  "xeroObjectUrl",
  "xeroInvoiceNumber",
  "y|ies",
] as const;

export const APPROVED_EMAIL_TEMPLATE_TOKEN_SET = new Set<string>(
  APPROVED_EMAIL_TEMPLATE_TOKENS,
);

// Tokens whose rendered values must never appear in an email subject line.
// Subjects are persisted in EmailLog for every template (including the
// sensitive ones whose HTML bodies are deliberately not retained) and travel
// in clear mail headers, so secret values are restricted to message bodies.
const SENSITIVE_EMAIL_SUBJECT_TOKENS = [
  "choreLink",
  "claimUrl",
  "confirmUrl",
  "confirmationUrl",
  "doorCode",
  // #2267: carries the door code itself, so it is subject-forbidden exactly
  // like the bare value.
  "doorCodeNote",
  "loginUrl",
  "payUrl",
  "pin",
  "resetUrl",
  "respondUrl",
  "token",
  "verifyUrl",
] as const;

export const SENSITIVE_EMAIL_SUBJECT_TOKEN_SET = new Set<string>(
  SENSITIVE_EMAIL_SUBJECT_TOKENS,
);

const TEMPLATE_SENSITIVE_EMAIL_SUBJECT_TOKENS: Partial<
  Record<EmailAuditTemplateName, readonly string[]>
> = {
  // Most reviewUrl values are authenticated admin/profile navigation. This
  // one is the nomination's public bearer link, so scope the restriction to
  // its template instead of disabling harmless review URLs globally.
  "nomination-request": ["reviewUrl"],
};

export function getSensitiveEmailSubjectTokens(
  templateName?: string,
): ReadonlySet<string> {
  return new Set([
    ...SENSITIVE_EMAIL_SUBJECT_TOKEN_SET,
    ...(TEMPLATE_SENSITIVE_EMAIL_SUBJECT_TOKENS[
      templateName as EmailAuditTemplateName
    ] ?? []),
  ]);
}

export function getEmailTemplateDefinition(templateName: string) {
  return EMAIL_TEMPLATE_DEFINITIONS.find(
    (definition) => definition.key === templateName,
  );
}

export function isAdminSystemTemplate(templateName: string): boolean {
  return ADMIN_SYSTEM_TEMPLATE_NAMES.has(templateName as EmailAuditTemplateName);
}

export function getDefaultDeliveryMode(
  templateName: string,
): NotificationDeliveryModeValue {
  return getEmailTemplateDefinition(templateName)?.defaultDeliveryMode ?? "always";
}
