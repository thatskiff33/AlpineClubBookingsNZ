import {
  EMAIL_AUDIT_DEFAULTS,
  type EmailAuditTemplateName,
} from "@/lib/email-message-audit-defaults";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  adminSplitSettlementCancelledLeadParagraph,
  adminSplitSettlementUnpaidLeadParagraph,
  bookingPaymentDueNote,
  checkoutDayChoreNote,
  duplicateCaptureRefundOutcomeParagraph,
  lateCaptureAutoRefundLeadParagraph,
  lateCaptureHandBackConflictOutcomeParagraph,
  lateCaptureHandBackConflictSubjectLabel,
  splitGuestPortionOwnBookingLine,
  wholeLodgeGuestNamesUrgencyNote,
} from "@/lib/email-message-notes";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { BOOKING_URL_TEMPLATE_NAMES } from "@/lib/booking-email-template-contract";

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
  // #2774: tokens an override may not drop from the SUBJECT. Separate from
  // requiredTokens, which is body-only by design — see
  // REQUIRED_SUBJECT_TEMPLATE_TOKENS for why one template needs this.
  requiredSubjectTokens: string[];
  // #2774: wording an override may not ADD to the subject, because it states a
  // direction the token already fills in — see FORBIDDEN_SUBJECT_PHRASES.
  forbiddenSubjectPhrases: string[];
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
  // B5 (#2262): the reciprocal fence's conflict alert and the cash-cancellation
  // hand-back task alert. Both ship via sendToAdmins, so admin audience, and
  // both are operator nudges rather than money movers — the conflict alert
  // reports a state the pipeline deliberately refused to act on, and the
  // hand-back task is durable in the database whether or not the mail lands —
  // so neither is delivery-locked. Both are gated by the adminPaymentFailure
  // notification preference at send time, like their siblings.
  "admin-manual-settlement-conflict",
  "admin-manual-refund-task",
  // #2761: the alert for an automatically refunded late capture on a cancelled
  // booking. Ships to admins, so admin audience — but through the unmuteable
  // sender rather than sendToAdmins, because it reports an automatic MONEY
  // MOVEMENT. It is delivery-locked below, and its send path reads no per-member
  // notification preference at all. It REPLACES the generic payment-failure mail
  // this path used to send; it is not a second notification (`INV-ADDPAY-037`).
  "admin-late-capture-auto-refund",
  // #2774: the sibling notice for the same event class when the capture collides
  // with a hand-back an operator had already made - either the automatic refund
  // was withheld to stop a second payment, or it went out anyway inside the
  // fence's blind window and the member may have been paid twice. Same admin
  // audience and the same unmuteable sender, and delivery-locked below: this is
  // the one mail on the path that says money may have left the club twice.
  "admin-late-capture-hand-back-conflict",
  "admin-pending-deadline",
  "admin-booking-bumped",
  "admin-capacity-warning",
  "admin-daily-digest",
  "admin-xero-sync-error",
  "admin-xero-repeated-failure",
  "admin-xero-reconciliation-report",
  // #2501: the credit-sync checker's drift warning. Ships via sendToAdmins, so
  // admin audience. NOT delivery-locked (an operator nudge — the drift is
  // durable in the ledger and re-detected each pass, so muting loses no money),
  // and content-only by default so it only mails when a real drift exists.
  "admin-credit-sync-drift",
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
  // #2263: the same money-critical alert for an approved MEMBER whole-lodge
  // request converted while the Xero module is off. Its own registry entry
  // rather than a variant of the school one — the wording names a member, not a
  // school — and delivery-locked on the same grounds (see below).
  "admin-whole-lodge-manual-invoice",
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
  // #2263: same money risk, same lock — disabling it would let an approved
  // member whole-lodge booking go un-invoiced while the member has been told an
  // invoice is coming.
  "admin-whole-lodge-manual-invoice",
  // #2761 (owner decision 10 Aug 2026): an automatic money movement must not be
  // silenceable. This alert is the moment-of-event notice for a late capture the
  // webhook refunded on its own, and the club's only other trace is a row on a
  // card and an audit entry — so muting it club-wide is exactly the state the
  // owner ruled out. Locked here AND sent off the per-member preference, because
  // those are two separate mute vectors and the decision closed both.
  "admin-late-capture-auto-refund",
  // #2774 (the orchestrator's call on the Recommended option; the owner has not
  // ruled — `INV-ADDPAY-039`): the same lock, for a stronger reason.
  // This alert reports either a refund the system deliberately did NOT send or a
  // capture that may have been paid back twice; in both directions it is the only
  // thing that pulls a person to reconcile real money, so it must not be
  // silenceable club-wide any more than its sibling.
  "admin-late-capture-hand-back-conflict",
]);

const CONTENT_ONLY_DEFAULT_TEMPLATE_NAMES = new Set<EmailAuditTemplateName>([
  "admin-daily-digest",
  "admin-xero-reconciliation-report",
  // #2501: only mail when a drift was actually detected.
  "admin-credit-sync-drift",
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
  // #2269 review: {{guestFirstName}}/{{guestLastName}} are STILL SUPPLIED by
  // sendCheckinReminderEmail (src/lib/email/booking.ts) precisely so a club
  // holding a pre-#2307 override keeps rendering a correct guest list. They
  // left the default body when #2307 moved to a one-guest-per-line
  // {{guestName}}, and without them here `allowedTokens` omits them: the
  // editor then reported "uses {{guestFirstName}}, {{guestLastName}}, which
  // this template no longer supplies" — both clauses false — and, because
  // disallowed_token makes the validation invalid, that club could not re-save
  // its template at all. The only remedy offered was Restore Default, which
  // destroys the wording the back-compatibility exists to protect.
  "checkin-reminder": [
    "choreName",
    "choreDescription",
    "guestFirstName",
    "guestLastName",
  ],
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
  // #2526: the raw values behind the two pre-composed lines, so an override may
  // reference either form. `paymentNote` renders nothing for a booking that owes
  // nothing; `adminNotesLine` renders nothing when the officer left no note.
  "booking-policy-exception-approved": ["amount", "adminNotes"],
  // #2562 review: the raw officer explanation behind the composed {{reasonLine}},
  // so an override may reference either form. A refusal always carries one — the
  // decision route refuses to record a refusal without it.
  "booking-policy-exception-refused": ["adminNotes"],
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
  // #2328: {{creditNote}} is pre-composed and already carried inside
  // {{paymentOutcome}}, which the shipped default body renders — so it is
  // declared here, not written into the body a second time. It stays supplied
  // and allowed so an override that builds its own money lines can explain a
  // card charge smaller than the total.
  "booking-confirmed": [
    "creditNote",
    "discount",
    "doorCode",
    "doorCodeNote",
    // #2263: the paid/unpaid money story is the pre-composed {{paymentOutcome}}
    // in the default body; the per-piece tokens stay allowed so an override can
    // build its own money lines (and so an override saved from the pre-#2267
    // default, which wrote "Total Paid: {{totalPaid}}", keeps validating).
    "paymentDueNote",
    "paymentOutcome",
    "paymentReference",
    "promoAdjustment",
    "promoCode",
    "promoSummary",
    "provisionalGuestsNote",
    "subtotal",
    "totalDue",
    "totalPaid",
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
  "booking-confirmed": {
    doorCodeNote: ["doorCode"],
    // #2267 (owner decision): the promo explanation is required content on a
    // payment confirmation — an override that drops it leaves a member who was
    // charged a promo price with a total and no reason for it. What must stay
    // is the ADJUSTMENT itself, in whichever token form the override uses:
    // the pre-composed {{promoSummary}} block, the signed {{promoAdjustment}}
    // value, or the legacy {{discount}} (which the pre-#2267 default body
    // wrote as "Discount ({{promoCode}}): -{{discount}}", so every override
    // saved from that default keeps validating and re-saving).
    //
    // {{subtotal}} is deliberately NOT an alternative: a subtotal with no
    // adjustment line beside it is the incident shape #2267 fixed — two
    // amounts that differ with nothing in between to say why.
    promoSummary: ["promoAdjustment", "discount"],
  },
  // #2268: the same door-code swap on the pre-arrival reminder.
  "pre-arrival-reminder": { doorCodeNote: ["doorCode"] },
};

const REQUIRED_TEMPLATE_TOKENS: Partial<Record<EmailAuditTemplateName, string[]>> = {
  "booking-confirmed": [
    "CLUB_LODGE_TRAVEL_NOTE",
    "doorCodeNote",
    // Satisfied by any of the promo-adjustment tokens above.
    "promoSummary",
  ],
  // #2268: pre-arrival-reminder gets the same treatment #2267 gave
  // booking-confirmed — the door-code line is composed by the sender, so the
  // body carries {{doorCodeNote}} instead of a bare "Door code:" heading that
  // printed even for a lodge with no code. An override written before the
  // change still satisfies this through REQUIRED_TOKEN_ALTERNATIVES.
  //
  // #2350: {{outstandingAdditionalNote}} is the only place a pre-arrival
  // reminder says money is still owed on the booking. Dropping it in an override
  // would silence that for every booking, so it is pinned like the travel note.
  "pre-arrival-reminder": [
    "CLUB_LODGE_TRAVEL_NOTE",
    "doorCodeNote",
    "outstandingAdditionalNote",
  ],
  // #2350: this email exists to ask for money, so the amount, the date it was
  // raised and the stay it belongs to are all load-bearing — an override that
  // drops any of them leaves a demand a member cannot act on or check.
  "additional-payment-reminder": [
    "additionalAmount",
    "requestedOn",
    "checkIn",
    "checkOut",
  ],
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
  // #2526: the stay this approval created is the load-bearing content — an
  // override that drops the dates leaves the member with "approved" and nothing
  // to act on. No bearer token, so NOT sensitive-log.
  "booking-policy-exception-approved": ["firstName", "checkIn", "checkOut"],
  // #1992/#2007: memberName identifies the affected member and reviewUrl is the
  // admin action link (the payments board), mirroring the other admin alerts.
  "admin-duplicate-capture-refund": ["memberName", "reviewUrl"],
  // B5 (#2262): memberName identifies the affected member and reviewUrl is the
  // admin action link (the payments board), mirroring the other admin alerts.
  "admin-manual-settlement-conflict": ["memberName", "reviewUrl"],
  "admin-manual-refund-task": ["memberName", "reviewUrl"],
  // #2761: memberName and reviewUrl as its siblings, plus the two tokens that
  // carry WHICH of the two populations this was. An override that drops
  // {{bookingStateLabel}} or {{refundOutcomeNote}} leaves an operator unable to
  // tell "the booking was deleted, remake it and charge again" from "the booking
  // was cancelled, this is normal" — the whole reason the owner asked for wording
  // covering both cases.
  // #2773 adds {{lateCaptureLeadNote}}: BOTH late-capture handlers send this
  // alert now, and that token is the only thing in the body that says WHICH
  // payment was captured (the booking's own, or one for a change to it) and what
  // became of the Xero paperwork - which differs between them. An override that
  // drops it leaves an operator unable to tell the two apart, and the shipped
  // default used to assert the booking-change wording for both.
  "admin-late-capture-auto-refund": [
    "memberName",
    "reviewUrl",
    "bookingStateLabel",
    "refundOutcomeNote",
    "lateCaptureLeadNote",
  ],
  // #2774: {{handBackConflictNote}} is the whole message - it is the sentence
  // that says whether the money went out or was withheld. An override that drops
  // it turns a reconciliation notice into an unexplained mention of a booking, on
  // the one alert that may be reporting a double payment.
  "admin-late-capture-hand-back-conflict": [
    "memberName",
    "reviewUrl",
    "handBackConflictNote",
  ],
  "admin-split-settlement-unpaid": ["memberName", "reviewUrl"],
  // #1993 Part A: terminal notice — memberName identifies the member and
  // reviewUrl is the admin action link, mirroring the recurring alert.
  "admin-split-settlement-cancelled": ["memberName", "reviewUrl"],
  // #1993 Part A: member-facing terminal notice. No bearer token (so NOT
  // sensitive-log); firstName + the stay dates are the load-bearing content.
  "split-guest-portion-cancelled": ["firstName", "checkIn", "checkOut"],
  "admin-partner-share-swept": ["memberName", "partnerName", "reason"],
  // The authenticated detail link is optional and centrally authorized
  // (#2362), so neither its old raw id nor bookingUrl can be required.
  "booking-review-approved": [],
  "induction-sign-off-request": ["inductionUrl"],
  "school-attendee-confirmation": ["token"],
  // #2550: the whole point of the message is the ask and the count it is about,
  // and the one sentence whose urgency escalates as check-in approaches. An
  // override that drops any of the three leaves a member with a nudge that does
  // not say what to do or how much of their party is still unnamed.
  "whole-lodge-guest-names-reminder": [
    "unnamedGuestCount",
    "namingUrgencyNote",
  ],
  "group-booking-join-verification": ["token"],
  // #2260: who it is for and which season it covers are the load-bearing
  // content of a manual-payment receipt. The amount is deliberately NOT
  // required — it is omitted whenever the club has no recorded fee amount for
  // the season, so requiring it would force an override to promise a figure the
  // send cannot always supply.
  "membership-payment-recorded": ["firstName", "seasonYear"],
  // #2307 (epic #2305, MG2) and #2309 (MG4). The six member-guest emails. What each override
  // may NOT drop is the part of the message that would otherwise leave the
  // member unable to act:
  //   - the ask itself, the deadline, and the link to answer on;
  //   - the one sentence that says WHY somebody is on a booking they never
  //     agreed to, and the honest statement of whether they can come off it
  //     (owner decision D-14 — the ordinary self-removal blockers apply, so this
  //     sentence is the only thing standing between the member and a control
  //     the server would refuse);
  //   - for the booking's owner, the outcome and what it did to their booking
  //     and their money (D-15 settles an expired place as account credit).
  // `consentUrl` is required in the BODY and separately banned from subjects
  // (SENSITIVE_EMAIL_SUBJECT_TOKENS below).
  "member-guest-consent-request": [
    "askHeading",
    "askContextNote",
    "consentExpiresAt",
    "consentUrl",
  ],
  "member-guest-added": ["addedHeading", "addedContextNote", "removalNote"],
  "member-guest-consent-outcome": [
    "outcomeHeading",
    "outcomeSentence",
    "consequenceNote",
  ],
  "member-guest-consent-answered": [
    "answeredHeading",
    "answeredSentence",
    "answeredNote",
  ],
  "member-guest-consent-expired": ["bookerName", "checkIn", "checkOut"],
  // MG4 (#2309). Both tokens are required because between them they are the
  // entire message: the heading says WHAT happened and the context note says
  // WHY and WHO — an override that dropped either would leave a member holding
  // a stay's dates with no statement that they are no longer on it.
  "member-guest-request-withdrawn": [
    "withdrawnHeading",
    "withdrawnContextNote",
  ],
  // #2553: the courtesy notice when a bed-holding policy-exception request runs
  // out of time. The stay dates say WHICH request lapsed (a member can have had
  // several over one booking) and the deadline says WHY it closed — an override
  // that dropped it would tell a member their request is gone with no reason,
  // which is the whole gap this notice exists to close.
  "policy-exception-request-expired": ["checkIn", "checkOut", "expiresAt"],
  // #2576: the loss-of-cover notice. All three tokens are load-bearing and an
  // override that dropped any of them would leave a member unable to act. The
  // stay dates say WHICH booking (a member can hold several at one lodge), and
  // {{uncoveredNights}} says exactly which nights need an adult member — without
  // it the message is "something is wrong with your booking", which is the alarm
  // without the instruction.
  "hosting-coverage-lost": ["checkIn", "checkOut", "uncoveredNights"],
};

/**
 * Tokens an override may not drop from the SUBJECT LINE (#2774).
 *
 * WHY THIS TABLE HAS TO EXIST AT ALL, AND WHY IT IS SEPARATE FROM
 * `REQUIRED_TEMPLATE_TOKENS`. That table is deliberately body-only, and says so:
 * required tokens are body CONTENT (a door code, a pay link), and a token sitting
 * in the subject was never allowed to satisfy the requirement. That is right for
 * content — but it left a real hole for a template whose subject has to state
 * WHICH WAY something went, because `prepareEmailMessage` replaces the sender's
 * computed subject with a stored override unconditionally and nothing checked what
 * the override said.
 *
 * The `admin-late-capture-hand-back-conflict` alert is the case that forced it. It
 * is sent in two opposite directions — a refund the system WITHHELD, or one that
 * may have paid a member TWICE — and the subject is the triage surface: an operator
 * who files by subject files a suspected double payment as "nothing to do". With a
 * direction written into `defaultSubject` as literal text, every double-payment
 * notice would have arrived titled "Automatic refund withheld" from the moment any
 * admin pressed Save on the Email Messages form, untouched. The direction therefore
 * rides in the subject as `{{handBackConflictLabel}}`, and this table is what stops
 * an admin editing it back out. The body's own `{{handBackConflictNote}}` requirement
 * is unchanged and independent — the two fields are protected separately because
 * either one alone can be read as the whole message.
 *
 * KEEP THIS TABLE SMALL. A subject token is a poor place for content, so the bar is
 * the one this entry meets: the mail is sent in more than one direction from ONE
 * template, and a subject asserting the wrong direction would be read as a
 * statement about money. Anything less belongs in `REQUIRED_TEMPLATE_TOKENS`.
 */
const REQUIRED_SUBJECT_TEMPLATE_TOKENS: Partial<
  Record<EmailAuditTemplateName, string[]>
> = {
  "admin-late-capture-hand-back-conflict": ["handBackConflictLabel"],
};

/**
 * Wording an override may not put IN the subject of a template whose subject has to
 * state which way money went (#2774, second half).
 *
 * WHY REQUIRING THE TOKEN WAS NOT ENOUGH. `REQUIRED_SUBJECT_TEMPLATE_TOKENS` above
 * refuses a subject that DROPS `{{handBackConflictLabel}}`. It says nothing about a
 * subject that KEEPS it and types a direction beside it — "Automatic refund withheld
 * - {{handBackConflictLabel}}: {{memberName}}" satisfied every check and renders, on
 * the double-payment arm, as "Automatic refund withheld - Payment may have been
 * refunded TWICE - reconcile: Alice Example". The leading words are the ones an inbox
 * truncates to, so the mail that says money may have gone out twice arrives titled as
 * one that did not go out at all. Prepending a phrase to a pre-populated subject is an
 * ordinary admin edit, and the obvious phrase to reach for is the wording of the last
 * such email they received.
 *
 * DERIVED FROM THE LABELS, NOT RE-TYPED. The clauses come from
 * `lateCaptureHandBackConflictSubjectLabel` itself, split on its em dash, so rewording
 * an arm moves this table with it and the two cannot drift. Single-word clauses are
 * dropped ("reconcile" is a topic, not a claim, and an admin may legitimately write
 * "Reconcile a late capture"), and the two decisive direction WORDS are added back
 * explicitly because "Refund withheld - {{handBackConflictLabel}}" is the same defect
 * in fewer words. `email-message-notes.ts` is the single source for both, and
 * `admin-late-capture-hand-back-conflict-alert.test.ts` pins every phrase here to
 * exactly one arm, so a phrase that stops being one arm's wording fails there.
 *
 * SCOPE, STATED HONESTLY: this catches the shipped wordings and their obvious short
 * forms, not every possible paraphrase. A free-text subject cannot be made
 * paraphrase-proof; the guarantee that does not depend on the admin's wording is the
 * BODY, which states the direction four times over required tokens of its own.
 */
const DECISIVE_SUBJECT_DIRECTION_WORDS = ["withheld", "twice"] as const;

function handBackConflictSubjectDirectionPhrases(): string[] {
  const clauses = [true, false]
    .map((refundSent) => lateCaptureHandBackConflictSubjectLabel(refundSent))
    .flatMap((label) => label.split(/\s*[–—]\s*/))
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/).length > 1);
  return Array.from(
    new Set([...clauses, ...DECISIVE_SUBJECT_DIRECTION_WORDS]),
  );
}

const FORBIDDEN_SUBJECT_PHRASES: Partial<
  Record<EmailAuditTemplateName, string[]>
> = {
  "admin-late-capture-hand-back-conflict":
    handBackConflictSubjectDirectionPhrases(),
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
  "admin-credit-sync-drift": {
    triggerSummary:
      "BookingApp's stamped applied credit drifted from Xero's live invoice allocation",
    frequency: "When the Xero credit-sync checker runs (throttled to ~daily)",
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
  "admin-manual-settlement-conflict": {
    triggerSummary:
      "Xero reported a booking's invoice PAID for a booking this system had already recorded as settled in cash or by an off-Xero bank transfer, so the club may be holding the same money twice",
    frequency:
      "On the inbound reciprocal fence firing — rare; throttled per payment and invoice by a cross-instance cooldown so webhook replays do not re-send",
  },
  "admin-manual-refund-task": {
    triggerSummary:
      "A booking settled in cash (or by an off-Xero bank transfer) was cancelled with a refund owing, so a hand-back task was raised for an admin to pay the member back",
    frequency: "On cancellation of a cash-settled booking with a non-zero refund",
  },
  "admin-late-capture-auto-refund": {
    // #2773: BOTH handlers send this now, so the summary may not say
    // "booking-change payment" — this is the Email Messages list's one-line
    // description of when the mail goes out, and naming one of the two payments
    // would tell an admin the other kind sends nothing.
    triggerSummary:
      "Stripe captured a payment after the booking had already been cancelled (deleted or not) - either the booking's own payment or one for a change to it - so the capture was refunded in full automatically and recorded on the payments board",
    // The frequency sentence used to claim "webhook redeliveries do not
    // re-send", and that was not true. The record write is idempotent on the
    // payment intent; this mail is not. A Stripe redelivery re-enters the
    // handler whenever the first attempt failed AFTER the alert — the COMPLETED
    // stamp or the webhook log throwing sends the request to the outer catch,
    // which deletes the lease claim and answers 500 — and a lease takeover after
    // expiry does the same (`stripe-webhook-service.ts` says outright that a
    // handler may legitimately run more than once for one event).
    //
    // The honest wording is shipped rather than the send being deduped, and that
    // is a deliberate choice on a money notification: the alert is the event's
    // ONE notification (`INV-ADDPAY-037`), it is fire-and-forget with a `.catch`
    // that only logs, and gating it on the record writer's `alreadyRecorded`
    // outcome would mean a redelivery after a FAILED send is silent — trading a
    // rare duplicate for a rare silence, on the path where the owner's #2761
    // decision was that this must not be silenceable. A duplicate says the same
    // true thing twice; a silence says nothing about money that moved.
    frequency:
      "On each late capture the webhook refunds automatically — rare; once per payment intent per delivery, and a Stripe redelivery of the same event can re-send it",
  },
  "admin-late-capture-hand-back-conflict": {
    triggerSummary:
      "A late capture on a cancelled booking collided with a hand-back an operator had already recorded as paid: either the automatic refund was withheld so the member is not paid twice (#2774), or it had already gone out and may have paid them twice",
    // Same honest wording as its sibling above, and for the same reason: the fence
    // read and the record write are idempotent on the payment intent, this mail is
    // not, and a Stripe redelivery re-enters the handler whenever the first attempt
    // failed after the alert. Deduping it would make a redelivery after a FAILED
    // send silent on money that may have moved twice.
    frequency:
      "Only when an operator's hand-back and the automatic refund claim the same capture - rare; once per delivery, and a Stripe redelivery of the same event can re-send it",
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
  "additional-payment-reminder": {
    triggerSummary:
      "A booking change increased the total and the extra amount is still uncollected",
    frequency:
      "Twice per outstanding amount at most — a few days after the change, and once more shortly before check-in — plus any manual re-send an admin triggers from the booking page. The chase stops when the money arrives or the stay ends",
  },
  "booking-policy-exception-approved": {
    triggerSummary:
      "An admin approved a booking-policy exception request and the booking was created",
    frequency:
      "Once per approved NEW-booking exception request. A change to an existing booking is announced by the ordinary booking-modified email instead, so this never doubles up",
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
  "whole-lodge-guest-names-reminder": {
    triggerSummary:
      "A member whole-lodge booking is approaching check-in with its party still listed as placeholder 'Guest 1..N' names (#2550)",
    frequency:
      "Every attendeeConfirmationReminderDays inside the lead window, escalating to daily from two days before check-in, until every guest is named; the final reminder still goes out on the arrival morning and never blocks the stay",
  },
  "admin-school-manual-invoice": {
    triggerSummary:
      "Approved school booking-request converted while the Xero module is off, so no invoice was raised",
    frequency:
      "Once per conversion, to admins opted into public booking-request alerts",
  },
  "admin-whole-lodge-manual-invoice": {
    triggerSummary:
      "Approved member whole-lodge request converted while the Xero module is off, so no invoice was raised for the confirmed booking",
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
  // #2307 (epic #2305, MG2). Owner decision D-16 is stated in every one of these
  // four summaries rather than only in the code, because the admin editing the
  // wording is the person most likely to assume these follow the member's
  // notification preferences — and they deliberately do not.
  "member-guest-consent-request": {
    triggerSummary:
      "A member was added as a guest on somebody else's booking under the ask-first policy (D-3, the shipped default), so the member — or a family delegate answering for a member with no login (D-9) — is asked to agree",
    frequency:
      "Once per member-guest row that needs consent. Ignores the per-action 'notify the member' tick and the member's own notification preferences (D-16): being asked is not a mutable preference, and a muted member would silently expire off the booking instead. Still withheld by the per-booking 'No emails' switch",
  },
  "member-guest-added": {
    triggerSummary:
      "A member was added as a guest on somebody else's booking WITHOUT being asked — the club runs notify-only (D-3 opt-down), an admin added them, or the row came from an approved booking request (MG4-D-a). One template for all three; the composed opening sentence says which",
    frequency:
      "Once per member-guest row that was not asked about. Ignores the per-action notify tick and the member's notification preferences (D-16); still withheld by the per-booking 'No emails' switch",
  },
  "member-guest-consent-outcome": {
    triggerSummary:
      "A member-guest consent request was answered or lapsed, so the person who made the booking is told. Covers approved, declined, lapsed-and-removed, and lapsed-but-still-on-the-booking (the D-15 exception case an admin has to resolve)",
    frequency:
      "Once per resolved request, to the booking's owner. Ignores the per-action notify tick and notification preferences (D-16); still withheld by the per-booking 'No emails' switch",
  },
  "member-guest-consent-answered": {
    triggerSummary:
      "A family delegate answered a member-guest consent request on somebody else's behalf (D-5/D-10), so the member it was answered for — and the other adults who were sent the same request — are told who answered and what they said",
    frequency:
      "Once per request answered by a delegate rather than by the member themselves, to the member and to the other adults who were asked. Ignores the per-action notify tick and notification preferences (D-16); still withheld by the per-booking 'No emails' switch",
  },
  "member-guest-consent-expired": {
    triggerSummary:
      "A member-guest consent request lapsed with no answer, so the member who was asked is told the held bed was released",
    frequency:
      "Once per lapsed request, and ONLY where a request email was actually sent — nobody is told a request lapsed that they never received. Ignores the per-action notify tick and notification preferences (D-16); still withheld by the per-booking 'No emails' switch",
  },
  // MG4 (#2309). The counterpart to member-guest-added: MG2 told a member they
  // had a bed, and three things can take that back.
  "member-guest-request-withdrawn": {
    triggerSummary:
      "A member guest came OFF a booking somebody else made — a consent request nobody had answered yet was called off, a settled member guest was taken off, or the booking-request pipeline swapped them out at approval (MG4-D-b). One template for all three; the composed opening sentence says which. NOT sent when a request simply lapses on its own — that is member-guest-consent-expired",
    frequency:
      "Once per member guest removed from a booking they had been told about. Ignores the per-action notify tick and the member's notification preferences (D-16); still withheld by the per-booking 'No emails' switch",
  },
  "hosting-coverage-lost": {
    triggerSummary:
      "A CONFIRMED booking at an enforcing lodge lost the adult-member cover the club requires, because an officer deliberately overrode the refusal or an authoritative change removed the cover (a membership lapsing, an administrative cancellation, a lifecycle transition). The booking is NOT cancelled and keeps its beds and payments (#2576)",
    frequency:
      "Once per materially distinct uncovered state, sent AFTER the causing change has committed and claimed against the incident so a repeated reconciliation of the same unchanged problem sends nothing. Not gated on a personal notification preference — it reports something done to the member's booking that they have no other signal of; still withheld by the per-booking 'No emails' switch",
  },
  "booking-policy-exception-refused": {
    triggerSummary:
      "A Booking Officer refused a member's booking-policy exception request (#2562). Carries the officer's member-facing explanation, which is mandatory on a refusal precisely so the member can act on it",
    frequency:
      "Once per refusal, sent AFTER the terminal claim has committed so a mail failure can never turn a recorded refusal into an error the officer sees. Not gated on a personal notification preference — it reports a decision the club made about something the member asked for, and there is no other signal; a refused CHANGE request carries its booking id, so the per-booking 'No emails' switch still withholds it, while a refused NEW-booking request has no booking to silence",
  },
  "policy-exception-request-expired": {
    triggerSummary:
      "A member's policy-exception request was holding real beds and nobody decided it before its hold deadline, so the hold-reaper cron released the beds and closed the request as Expired (#2553)",
    frequency:
      "Once per lapsed request, sent AFTER the release has committed so a mail failure can never roll back or repeat a capacity release. Not gated on a personal notification preference — it reports something the club's own job did to the member's request, and the member has no other signal that it happened; still withheld by the per-booking 'No emails' switch",
  },
  // #2649. Declared rather than left to the generic fallback because this
  // template's trigger is the one thing an admin cannot guess from its name: it
  // is NOT the ordinary waitlist lifecycle. Its sibling `waitlist-offer-expired`
  // needs no entry — its name states its trigger — but an admin editing this one
  // has to know it only ever goes out on a repair, or they will write it as
  // routine copy.
  "waitlist-place-restored": {
    triggerSummary:
      "An admin used the stranded-confirm repair (#2649) to return a booking to the waitlist after the member's FREE waitlist confirmation was left in PAYMENT_PENDING by a failure in our own code. The member's offer did NOT expire — they confirmed in time — so this is deliberately a separate template from waitlist-offer-expired, whose wording would tell them the opposite of what happened",
    frequency:
      "Rare — once per repair, and only when an admin runs one. Not gated on a personal notification preference (it reports something the club did to the member's booking, and #2648 has already told them their confirmation was stuck); still withheld by the per-booking 'No emails' switch",
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
  if (token === "bookingUrl") {
    return "https://bookings.example.org/bookings/bkg_example";
  }
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
  // ---------------------------------------------------------------------
  // #2307 (epic #2305, MG2) — the member-guest emails.
  //
  // Every one of these is a PRE-COMPOSED token: the sender emits the whole
  // sentence or block, because renderTemplateString has no conditional and no
  // loop. So the preview sample cannot be a placeholder word — it has to be the
  // real composed text, or the admin previewing an override sees a shape their
  // members will never receive and lays the body out for it.
  //
  // These sit ABOVE the generic `endsWith("Url")` / name-shaped fallbacks below
  // on purpose, so consentUrl previews as a real consent link rather than as the
  // generic admin URL.
  //
  // Every value here is the exact output of the matching composer in
  // src/lib/member-guest-email-notes.ts for ONE documented fixture — Dave Ngata
  // adding Priya Kaur to 8–10 Aug 2026 at the sample lodge, nights 8 and 9 Aug,
  // NZ$48.00 of credit — and a test in member-guest-email-notes.test.ts calls
  // those composers and asserts equality, so a wording change cannot leave a
  // stale sample behind. Note there is no money in the request/added samples:
  // owner decision MG2-D-a keeps money out of those emails entirely.
  // ---------------------------------------------------------------------
  // #2562 review — the refusal notice's two pre-composed pieces. Same rule as the
  // member-guest block below: the sender emits whole clauses/lines, so the preview
  // has to show the real composed text or an admin lays an override out for a shape
  // no member ever receives.
  if (token === "askDescription") {
    return "your request to be let past a booking rule for a new stay";
  }
  if (token === "reasonLine") {
    return "Why the Booking Officer said no: that weekend is fully committed every year.";
  }
  if (token === "bookerName") return "Dave Ngata";
  if (token === "askHeading") return "Can Dave Ngata add you to this booking?";
  if (token === "askContextNote") {
    return (
      "Dave Ngata has put you down as a guest on a lodge booking. " +
      "Nothing is settled until you answer - a bed is held for you in the meantime."
    );
  }
  if (token === "addedHeading") return "You have been added to a lodge booking";
  if (token === "addedContextNote") {
    return (
      "Dave Ngata has added you as a guest on a lodge booking. Your place is " +
      "already held — this club does not ask first for member guests."
    );
  }
  if (token === "withdrawnHeading") return "You are no longer on that lodge booking";
  if (token === "withdrawnContextNote") {
    return "you have been taken off Dave Ngata's lodge booking, so you no longer have a place on it.";
  }
  if (token === "removalNote") {
    return "If you would rather not go, you can take yourself off the booking from your account.";
  }
  if (token === "partyListNote") {
    return "Everyone on this booking:\n- Dave Ngata\n- Marama Ngata\n- Ari Ngata\n- Priya Kaur";
  }
  if (token === "guestNightsLabel") return "8 Aug 2026, 9 Aug 2026 (2 nights)";
  if (token === "outcomeHeading") return "Priya Kaur has accepted";
  if (token === "outcomeSentence") {
    return "Priya Kaur has accepted your invitation and is confirmed on your booking at Example Mountain Club Lodge, 8 Aug 2026 - 10 Aug 2026.";
  }
  if (token === "consequenceNote") {
    return "Nothing has changed on your booking — the bed that was being held for Priya is now theirs.";
  }
  if (token === "consentUrl") {
    return "https://bookings.example.org/bookings/bkg_example#consent";
  }
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
  // #2430: previewed as the MEMBER wording, which is what the shipped default
  // has always rendered; the non-login contact variant is the sender's other
  // branch of bookingBumpedRebookAction.
  if (token === "rebookLabel") return "Book Again";
  if (token === "rebookPath") return "/book";
  if (token === "refundOutcomeNote") {
    return duplicateCaptureRefundOutcomeParagraph(false);
  }
  // #2773: previewed as the booking-CHANGE arm, which is what the shipped default
  // has always rendered and the commoner of the two captures; the primary arm is
  // the sender's other branch of lateCaptureAutoRefundLeadParagraph.
  if (token === "lateCaptureLeadNote") {
    return lateCaptureAutoRefundLeadParagraph("modification");
  }
  // #2774: previewed as the WITHHELD arm, matching the shipped default subject.
  // That is deliberately the arm an operator is likelier to receive - the fence
  // fires whenever the hand-completion had already committed - and the
  // refund-went-out-anyway arm is the sender's other branch.
  if (token === "handBackConflictNote") {
    return lateCaptureHandBackConflictOutcomeParagraph(false);
  }
  // #2774: previewed as the WITHHELD arm to match {{handBackConflictNote}} above,
  // so the preview reads as one coherent mail rather than a subject and a body that
  // disagree. The refund-went-out-anyway arm is the sender's other branch.
  if (token === "handBackConflictLabel") {
    return lateCaptureHandBackConflictSubjectLabel(false);
  }
  if (token === "settlementActionNote") {
    return adminSplitSettlementUnpaidLeadParagraph(false);
  }
  if (token === "ownBookingNote") {
    return splitGuestPortionOwnBookingLine(true);
  }
  // #2350: pre-composed like {{doorCodeNote}} above — the whole sentence as the
  // send builds it, so the preview reads as a member reads it instead of
  // printing the token's own name mid-paragraph. Empty on a live send when
  // nothing is owed. The amount reconciles with the sample below.
  if (token === "outstandingAdditionalNote") {
    return "There is still $123.45 to pay on this booking after a change to your stay. Please pay it from your booking page before you arrive.";
  }
  // #2350: the day the outstanding extra was raised. Named like a date but
  // matching none of the generic date rules below, so it would otherwise
  // preview as the literal word "requestedOn" where a date belongs.
  if (token === "requestedOn") return "1 Jul 2026";
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
  // #2263: the paid variant of the pre-composed money outcome, reconciling
  // with the promo sample above ($153.45 − $30.00 = $123.45) so the preview's
  // arithmetic adds up. The unpaid variant (Total Due + the owing sentence)
  // only ever renders from a live send that really is unpaid.
  if (token === "paymentOutcome") {
    return "Total Paid: $123.45\n\nPayment has been processed successfully.";
  }
  // #2328: previewed in its NON-empty shape, like every other pre-composed
  // block, and reconciling with the same $123.45 total the money tokens above
  // fall through to: $23.45 of account credit plus $100.00 on the card.
  //
  // Deliberately absent from the {{paymentOutcome}} sample above, even though a
  // live send with credit carries it inside that block: the paid sample already
  // shows only one of three money outcomes, and the ordinary confirmation — the
  // one an admin is nearly always editing — has no credit lines at all. An
  // admin who writes both tokens previews the pair once from each, which is
  // exactly what a live send would give them.
  if (token === "creditNote") {
    return "Account credit applied: -$23.45\nPaid by card: $100.00\n";
  }
  // #2444: the UNPAID confirmation's whole paragraph, composed by the very
  // function the send uses, so the preview cannot drift from the message and
  // an admin who puts {{paymentDueNote}} on a line of its own sees the money
  // advice a member reads instead of the bare word "paymentDueNote" (which is
  // what the fallthrough at the bottom of this function returned before #2444,
  // in breach of the pre-composed-token rule stated above).
  //
  // It names the same $123.45 the money tokens fall through to and the same
  // reference {{paymentReference}} previews, so an override that builds its own
  // unpaid lines previews one coherent booking. `invoiceEmailed: true` is the
  // shape a club running the Xero module gets; the manual-invoice club differs
  // only in one sentence.
  //
  // Like {{creditNote}} above, this is a mutually exclusive sibling of the
  // {{paymentOutcome}} sample: a body carrying both previews the paid outcome
  // and the unpaid one together, which no single send produces. That is the
  // price of previewing every pre-composed token in its non-empty shape, and it
  // is the same trade #2263 and #2328 already made for {{totalPaid}}/
  // {{totalDue}} and for the credit pair.
  //
  // #2483 gives this token THREE MORE SHAPES the preview does not show, and
  // one of them closes with the opposite instruction to the sample below (see
  // the note beside "paymentDueNote" in APPROVED_EMAIL_TEMPLATE_TOKENS, and
  // docs/guides/email-messages.md). The sample deliberately stays the
  // no-credit shape: it is what every member on today's one live unpaid path
  // receives, and previewing the rare netted shape as though it were the norm
  // would mislead in the other direction. The consequence to be aware of is
  // that an admin cannot preview the netted copy, so surrounding copy must not
  // assume the sample's "follow your invoice" ending.
  if (token === "paymentDueNote") {
    return bookingPaymentDueNote({
      amount: "$123.45",
      reference: "BOOKING-1234",
      invoiceEmailed: true,
    });
  }
  // #2550: the whole-lodge guest-name reminder's one escalating sentence,
  // composed by the very function the send uses so the preview cannot drift
  // from the message. Without this it fell through to the bottom of this
  // function and previewed as the bare word "namingUrgencyNote", in breach of
  // the pre-composed-token rule stated above. The FIRST stage is the sample:
  // it is the one every chased member receives, and previewing the "last
  // chance" wording as though it were the norm would mislead an admin writing
  // surrounding copy.
  if (token === "namingUrgencyNote") {
    return wholeLodgeGuestNamesUrgencyNote("first");
  }
  // #2621: the checkout-day chore sentence, previewed from its own composer so
  // the wording cannot drift from what a member receives. The sample is the
  // CHORES-ENABLED wording, not the empty one: an admin previewing this body
  // needs to see the sentence they are laying out around, and guard 4 already
  // proves the body reads correctly when the club has no chore roster and the
  // sender supplies "". The trailing blank line mirrors what the sender
  // composes (the {{expectedArrivalNote}} treatment above), so the preview shows
  // the paragraph break a real send produces rather than inventing one.
  if (token === "checkoutChoreNote") return `${checkoutDayChoreNote(true)}\n\n`;
  // #2444: the internet-banking reference an unpaid member must quote. It fell
  // through to the literal word "paymentReference", which contradicted the
  // composed paragraph above (and previewed the admin manual-invoice alert's
  // "Payment reference:" line as a token name).
  if (token === "paymentReference") return "BOOKING-1234";
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

// #2320 review (LOW-4): per-template overrides of the global sampleValue()
// fallthrough, for the few tokens whose sample must differ by template because
// their SENDERS compose different text for the same token name. The editor
// preview is the admin's only picture of what a member reads, so a preview
// that contradicts its own template (the UNPAID lead paragraph under a
// cancelled heading) or shows a label the sender never writes ("Notes:" where
// the send composes "Note from admin:") teaches an admin to distrust it.
const TEMPLATE_SAMPLE_VALUE_OVERRIDES: Partial<
  Record<EmailAuditTemplateName, Record<string, string>>
> = {
  // The terminal cancellation alert previews the CANCELLED lead paragraph —
  // the recurring unpaid alert keeps the global sample (the unpaid paragraph).
  "admin-split-settlement-cancelled": {
    settlementActionNote: adminSplitSettlementCancelledLeadParagraph(false),
  },
  // These two senders compose their own labels around the shared
  // {{adminNotesLine}} token (src/lib/email/booking.ts), so the preview mirrors
  // each real send instead of the refund-appeal templates' "Notes:" label.
  "booking-review-approved": {
    adminNotesLine: "Note from admin: Reviewed by the committee.\n\n",
  },
  "booking-review-rejected": {
    adminNotesLine: "Reason from admin: No adult guest is listed.\n\n",
  },
  // #2269 second review. {{guestLastName}} is now an allowed token again (the
  // sender still supplies the pre-#2307 pair so an old saved override keeps
  // naming its guests), and an allowed token gets a preview sample. Left to
  // sampleValue that sample would be a plausible surname — so an admin who
  // NEWLY typed {{guestLastName}} would see a name in Preview and get an empty
  // string on every real send, because sendCheckinReminderEmail supplies it
  // DELIBERATELY EMPTY (a bare list of surnames cannot be shown truthfully; see
  // src/lib/email/booking.ts). The preview shows what the send does.
  "checkin-reminder": {
    guestLastName: "",
  },
};

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
    ...(BOOKING_URL_TEMPLATE_NAMES.has(key) ? ["bookingUrl"] : []),
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
    requiredSubjectTokens: REQUIRED_SUBJECT_TEMPLATE_TOKENS[key] ?? [],
    forbiddenSubjectPhrases: FORBIDDEN_SUBJECT_PHRASES[key] ?? [],
    requiredTokenAlternatives: REQUIRED_TOKEN_ALTERNATIVES[key] ?? {},
    sampleData: Object.fromEntries(
      allowedTokens.map((token) => [
        token,
        TEMPLATE_SAMPLE_VALUE_OVERRIDES[key]?.[token] ?? sampleValue(token),
      ]),
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
  // #2307: the one composed sentence that tells notify-only, an admin add and a
  // pipeline add apart in the single member-guest-added template.
  "addedContextNote",
  // #2307: the added notice's heading, composed because it names the GUEST rather
  // than the reader when a family delegate is the one being told (D-9).
  "addedHeading",
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
  // #2307: the delegate-answered notice's three composed blocks — the heading
  // names who answered and who they answered for, the sentence says what they
  // said, and the note says what to do if that is not what the reader expected.
  "answeredHeading",
  "answeredNote",
  "answeredSentence",
  "applicantEmail",
  "applicantName",
  // #2307: what is being asked, of whom, and why them — composed because the
  // reader may be the member being added OR a family delegate answering for a
  // member with no login (D-9), and the template language has no conditional.
  "askContextNote",
  // #2307: the consent request's heading, composed for the same reason.
  "askHeading",
  // #2562 review: the refusal notice's opening clause ("your request to be let past
  // a booking rule for a new stay" / "... for a change to your booking").
  // Pre-composed for the same reason as the pair above: the render path has no
  // conditional, so the two flavours arrive as whole clauses.
  "askDescription",
  "attemptCount",
  "availableBeds",
  // #2307: the member who made the booking and put this member down as a guest.
  "bookerName",
  "bookingId",
  // #2761: "already deleted" / "already cancelled" — which population an
  // automatically refunded late capture belonged to. Composed by the sender
  // because the render path has no conditional syntax, and it appears in the
  // subject as well as the body: the whole point of the new alert is that its
  // subject says what happened.
  "bookingStateLabel",
  "bookingReference",
  "bookingUrl",
  "bookingReferenceNote",
  "bumpedMemberName",
  "changeFee",
  // #2267: pre-composed block of the booking-modification rows that actually
  // changed (Previous/New pairs only where something moved).
  "changeSummary",
  "checkIn",
  "checkOut",
  // #2621 (owner decision D-M5): the pre-arrival reminder's checkout-day chore
  // sentence, pre-composed by `checkoutDayChoreNote` and EMPTY for a club whose
  // chores module is off — which is the default. Declared in
  // OPTIONAL_TEMPLATE_TOKENS because it IS in the shipped default body.
  "checkoutChoreNote",
  "childName",
  "confirmationUrl",
  "choreDescription",
  "choreLink",
  "choreLinkNote",
  "choreListNote",
  "choreName",
  "committeeNote",
  // #2307: when a pending member-guest consent request lapses (the answer-by
  // date the member is given, and the date the sweep works to).
  "consentExpiresAt",
  // #2307: the deep link to the consent surface. Subject-sensitive — see
  // SENSITIVE_EMAIL_SUBJECT_TOKENS.
  "consentUrl",
  // #2307: what the outcome means for the owner's booking and their money —
  // the repricing plus D-15's account credit, or the honest "they are still on
  // the booking because only the club can change it".
  "consequenceNote",
  "contactEmail",
  "correlationKey",
  "count",
  // #2328: pre-composed "Account credit applied: -$120.00" + "Paid by card:
  // $180.00" pair on a booking confirmation (empty when no account credit paid
  // for any of the stay); the {{promoSummary}} convention. Reconciles against
  // the {{totalPaid}} figure above it, which stays the booking's FULL price.
  // The credit value carries its own minus sign — never type one in front.
  "creditNote",
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
  // #2307: which nights THIS guest is down for, human-readable.
  "guestNightsLabel",
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
  // #2550: the one escalating sentence of the whole-lodge guest-name reminder,
  // composed by the sender (wholeLodgeGuestNamesUrgencyNote) so the hand-built
  // HTML and an admin override cannot say different things about how urgent it
  // is. Never empty — every stage has a sentence.
  "namingUrgencyNote",
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
  // #2350: pre-composed "there is still $X to pay on this booking" sentence for
  // the pre-arrival reminder; empty when nothing is owed, so the body never
  // carries a dangling claim (the {{doorCodeNote}} convention).
  "outstandingAdditionalNote",
  "organiserName",
  "originalRecipient",
  "originalTemplateName",
  // #2307: the consent outcome's heading and its opening sentence. One template
  // covers approved, declined, lapsed-and-removed and lapsed-but-stuck, so both
  // are composed server-side.
  "outcomeHeading",
  "outcomeSentence",
  "pageTitle",
  "pageUrl",
  "paidAmount",
  "parentName",
  "partnerName",
  // #2307: the whole "Everyone on this booking" block, heading included (owner
  // decision MG2-D-a). ONE token because the template language cannot render a
  // list — see the note in docs/guides/email-messages.md: an override may move
  // or omit the block but cannot reformat it guest by guest.
  "partyListNote",
  "payUrl",
  "paymentIntentId",
  "paymentReference",
  "paymentNote",
  // #2263 × #2267: the booking-confirmed money story as ONE pre-composed block
  // (the {{promoSummary}} convention) — "Total Paid + processed" for a paid
  // booking, "Total Due + the owing sentence" for a confirmed-but-unpaid one,
  // and (#2397) "Booking Total / Paid / Still Owing + the balance sentence"
  // for one settled in cash for less than it is worth — so the default body
  // can never claim money moved when it did not.
  "paymentOutcome",
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
  // #2562 review: the officer's member-facing refusal explanation, as a WHOLE
  // composed line ("Why the Booking Officer said no: ..."), so an override that
  // drops it drops a labelled paragraph rather than leaving a dangling label. The
  // raw {{adminNotes}} behind it stays available for an override that wants to
  // phrase the label itself.
  "reasonLine",
  "reasonNote",
  "recipientLabel",
  // #2430: the bumped notice's way back in, split into the caption and the
  // path so the line stays "{{rebookLabel}}: {{BASE_URL}}{{rebookPath}}" and
  // keeps resolving the club's own configured public URL. A club MEMBER gets
  // "Book Again" + "/book"; a non-login NON_MEMBER/SCHOOL contact, who cannot
  // complete the login /book sits behind, gets "Contact the Club" + "/contact".
  "rebookLabel",
  "rebookPath",
  "refundAmount",
  "refundOutcomeNote",
  // #2773 / #2774: pre-composed whole paragraphs, the {{refundOutcomeNote}}
  // precedent - the flat admin-editable body has no conditional syntax, so the
  // sender supplies the finished sentence rather than the facts behind it.
  "lateCaptureLeadNote",
  "handBackConflictNote",
  // #2774: the same direction as a SUBJECT-length phrase, so the withheld and
  // paid-twice arms cannot collapse into one claim when an admin saves the template
  // — the {{bookingStateLabel}} construction (#2761), plus the subject requirement
  // in REQUIRED_SUBJECT_TEMPLATE_TOKENS above.
  "handBackConflictLabel",
  "refundMessage",
  "refundedAmount",
  "remainingAmount",
  "remainingCredit",
  // #2307: whether the member can take themselves off, or the real remedy if
  // they cannot. Composed from the SHARED evaluateGuestSelfRemoval predicate so
  // the email never offers a control the server would refuse (D-14).
  "removalNote",
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
  // #2350: the day the uncollected additional payment was raised, so the
  // reminder can say how long it has been outstanding.
  "requestedOn",
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
  // #2263: the two halves of an UNPAID confirmation. `totalDue` replaces
  // `totalPaid` (exactly one of the pair carries a figure), and
  // `paymentDueNote` is the pre-composed paragraph naming the amount owing and
  // the internet-banking reference — and, since #2444, telling the member to
  // transfer whatever the club's invoice asks for if that differs from the
  // figure above it.
  //
  // #2483 makes BOTH of those conditional, and an override author needs to
  // know it. Where the club's own ledger shows account credit against the
  // booking, `totalDue` is the NETTED figure (it has always meant "what is
  // still owed") and `paymentDueNote` states the arithmetic and asks for that
  // netted figure instead — reversing the deferral above, because the invoice
  // may not have been reduced yet. Where the ledger contradicts the price
  // (more credit applied than the booking costs) `totalDue` is EMPTY and the
  // paragraph asks for nothing at all. The preview sample above shows only the
  // first, non-netted shape — the one every member on today's live path
  // receives — so do NOT write surrounding copy that assumes it ("always pay
  // what your invoice shows" contradicts the netted paragraph beneath it).
  // docs/guides/email-messages.md describes all three.
  //
  // #2397 adds a third, PARTLY paid state — a cash settlement the admin said
  // did not cover an uncollected price increase — in which BOTH carry a
  // figure, because both are true: `totalPaid` is what the club actually has
  // and `totalDue` is only the balance, never the whole price. `paymentDueNote`
  // stays empty there (there is no internet-banking reference to quote); the
  // whole story is in `paymentOutcome`.
  "totalDue",
  "paymentDueNote",
  "totalPaid",
  "triggeringMemberName",
  // #2550: how many of the party still carry a generated placeholder name.
  "unnamedGuestCount",
  // #2576: the NZ lodge-nights on which a booking's non-member guests have no
  // qualifying adult member staying. A comma-separated list, formatted by the
  // sender, so a club's override can put it wherever the sentence reads best.
  "uncoveredNights",
  "verifyUrl",
  "windowHours",
  // MG4 (#2309): the withdrawal notice's two composed blocks — what happened,
  // and why plus who. Same pre-composed shape as the added notice's pair.
  "withdrawnHeading",
  "withdrawnContextNote",
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
  // #2268: the composed chore-roster line carries the 48-hour bearer link
  // itself, so it is subject-forbidden exactly like the bare {{choreLink}}
  // value (the {{doorCodeNote}}/{{doorCode}} treatment).
  "choreLinkNote",
  "claimUrl",
  "confirmUrl",
  "confirmationUrl",
  // #2307: the member-guest consent deep link. Not a bearer credential — both
  // consent surfaces require the reader to be signed in — but it is a per-guest
  // URL identifying who was asked about which booking, and EmailLog persists
  // subjects for every template while mail headers travel in the clear. Same
  // class as respondUrl, and restricted the same way.
  "consentUrl",
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
