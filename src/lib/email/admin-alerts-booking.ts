import {
  adminBookingBumpedTemplate,
  adminBookingChangeRequestTemplate,
  adminBookingRequestHoldCancelledTemplate,
  adminBookingRequestHoldExpiredTemplate,
  adminBookingRequestPendingTemplate,
  adminCapacityWarningTemplate,
  adminMinorsReviewRequiredTemplate,
  adminNewBookingTemplate,
  adminOwnerSubstitutionTemplate,
  adminPartnerShareSweptTemplate,
  adminPendingDeadlineTemplate,
  adminSchoolManualInvoiceTemplate,
  adminSplitSettlementCancelledTemplate,
  adminSplitSettlementUnpaidTemplate,
  adminWaitlistOfferTemplate,
  adminWholeLodgeManualInvoiceTemplate,
} from "@/lib/email-templates/admin-booking";
import {
  wholeLodgeManualInvoiceAmountCents,
} from "@/lib/booking-money-lines";
import {
  adminSplitSettlementCancelledLeadParagraph,
  adminSplitSettlementUnpaidLeadParagraph,
  composeOptionalEmailLine,
} from "../email-message-notes";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { buildBookingRequestsHref } from "@/lib/admin-booking-requests-path";
import { sendToAdmins } from "./admin-alerts-shared";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";

// N-02: Admin alert - new booking
export async function sendAdminNewBookingAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  status: string;
  reviewReason?: string | null;
  memberJustification?: string | null;
}) {
  await sendToAdmins({
    subject: data.reviewReason
      ? `Booking Review Required: ${data.memberName}`
      : `New Booking: ${data.memberName} (${data.status})`,
    html: await renderEmailHtml(() => adminNewBookingTemplate(data)),
    templateName: "admin-new-booking",
    templateData: {
      ...data,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      total: formatMoneyCents(data.totalCents),
      reviewReason: data.reviewReason ?? "",
      // #2268: pre-composed optional line — the flat body has no conditional
      // syntax, so a routine booking must not print an empty review paragraph.
      reviewReasonNote: composeOptionalEmailLine(null, data.reviewReason),
      memberJustification: data.memberJustification ?? "",
    },
    preferenceKey: "adminNewBooking",
  });
}

// F27 / #1372: Admin alert - paid booking edited into a minors-only (no-adult)
// composition. The booking KEEPS its PAID status (Option A) but is blocked from
// lodge check-in until an admin clears the review, so admins need a nudge that a
// silent flag was set. #1422: this fires on its own "Booking review required"
// preference category so muting routine new-booking alerts does not silence a
// review-required alert.
export async function sendAdminMinorsOnlyReviewAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  reviewReason: string;
}) {
  await sendToAdmins({
    subject: `Review required: booking has only under-18 guests (${data.memberName})`,
    html: await renderEmailHtml(() => adminMinorsReviewRequiredTemplate(data)),
    templateName: "admin-minors-review",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      guestCount: data.guestCount,
      reviewReason: data.reviewReason,
    },
    preferenceKey: "adminBookingReviewRequired",
  });
}

// #1756: Admin alert - a partner pair's future shared double-bed placements
// were swept (partner link dissolved, member deactivated, or member no longer
// an adult). The second occupant is back in the awaiting-allocation queue, so
// the board needs a human look — fired on the existing "Booking review
// required" preference (#1422 precedent: reuse a category rather than mint a
// new NotificationPreference column for a rare event).
export async function sendAdminPartnerShareSweptAlert(data: {
  memberName: string;
  partnerName: string;
  reason: string;
  nights: Date[];
}) {
  await sendToAdmins({
    subject: `Review required: shared double-bed placements removed (${data.memberName})`,
    html: await renderEmailHtml(() => adminPartnerShareSweptTemplate(data)),
    templateName: "admin-partner-share-swept",
    templateData: {
      memberName: data.memberName,
      partnerName: data.partnerName,
      reason: data.reason,
      count: data.nights.length,
      s: data.nights.length === 1 ? "" : "s",
      date: data.nights.map((night) => emailCalendarDay(night)).join(", "),
    },
    preferenceKey: "adminBookingReviewRequired",
  });
}

// F20 / #1377: Admin alert - a held booking-request owner failed re-validation
// at conversion, so a fresh non-login contact was minted and the invoice will
// bill THAT contact instead of the intended owner. Routed to the Xero-sync-error
// audience (finance/Xero admins) because the remedy is a Xero contact
// reconciliation, reusing the existing `adminXeroSyncError` preference key so a
// rare event needs no new NotificationPreference column.
export async function sendAdminOwnerSubstitutionAlert(data: {
  requestId: string;
  bookingId: string;
  intendedMemberId: string;
  intendedMemberName?: string | null;
  substituteMemberId: string;
  substituteMemberName?: string | null;
  reason: string;
  requesterName: string;
  requesterEmail: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendToAdmins({
    subject: `Owner substitution — reconcile Xero contact for booking request ${data.requestId}`,
    html: await renderEmailHtml(() => adminOwnerSubstitutionTemplate(data)),
    templateName: "admin-owner-substitution",
    templateData: {
      requestId: data.requestId,
      bookingId: data.bookingId,
      intendedMemberId: data.intendedMemberId,
      intendedMemberName: data.intendedMemberName ?? "",
      substituteMemberId: data.substituteMemberId,
      substituteMemberName: data.substituteMemberName ?? "",
      reason: data.reason,
      requesterName: data.requesterName,
      memberEmail: data.requesterEmail,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
    },
    preferenceKey: "adminXeroSyncError",
  });
}

// N-06: Admin alert - pending approaching deadline (digest)
export async function sendAdminPendingDeadlineAlert(
  bookings: Array<{
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    guestCount: number;
    deadline: Date;
    hoursRemaining: number;
  }>,
) {
  await sendToAdmins({
    subject: `${bookings.length} Pending Booking${bookings.length > 1 ? "s" : ""} Approaching Deadline`,
    html: await renderEmailHtml(() => adminPendingDeadlineTemplate(bookings)),
    templateName: "admin-pending-deadline",
    templateData: {
      count: bookings.length,
      s: bookings.length === 1 ? "" : "s",
      memberName: bookings.map((booking) => booking.memberName).join(", "),
      checkIn: bookings
        .map((booking) => emailCalendarDay(booking.checkIn))
        .join(", "),
      checkOut: bookings
        .map((booking) => emailCalendarDay(booking.checkOut))
        .join(", "),
      guestCount: bookings.map((booking) => booking.guestCount).join(", "),
      deadline: bookings
        .map((booking) => emailClubDateTime(booking.deadline))
        .join(", "),
      hoursRemaining: bookings
        .map((booking) => Math.round(booking.hoursRemaining))
        .join(", "),
    },
    preferenceKey: "adminPendingDeadline",
  });
}

// test seam
// N-07: Admin alert - booking bumped
export async function sendAdminBookingBumpedAlert(data: {
  bumpedMemberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  triggeringMemberName: string;
}) {
  await sendToAdmins({
    subject: `Booking Bumped: ${data.bumpedMemberName}`,
    html: await renderEmailHtml(() => adminBookingBumpedTemplate(data)),
    templateName: "admin-booking-bumped",
    templateData: {
      ...data,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
    },
    preferenceKey: "adminBookingBumped",
  });
}

// N-03: Admin alert - capacity warning
export async function sendAdminCapacityWarningAlert(
  days: Array<{
    date: Date;
    occupiedBeds: number;
    availableBeds: number;
  }>,
  lodgeCapacity: number,
  // Lodge the warning is about; null for single-lodge clubs (ADR-002),
  // which keeps the pre-multi-lodge subject and body unchanged.
  lodgeName?: string | null,
) {
  await sendToAdmins({
    subject: `Capacity Warning: ${days.length} high-occupancy day${days.length > 1 ? "s" : ""} ahead${lodgeName ? ` at ${lodgeName}` : ""}`,
    html: await renderEmailHtml(() => adminCapacityWarningTemplate(days, lodgeCapacity, lodgeName)),
    templateName: "admin-capacity-warning",
    templateData: {
      count: days.length,
      s: days.length === 1 ? "" : "s",
      lodgeName: lodgeName ?? "",
      date: days.map((day) => emailCalendarDay(day.date)).join(", "),
      occupiedBeds: days.map((day) => day.occupiedBeds).join(", "),
      availableBeds: days.map((day) => day.availableBeds).join(", "),
      percent: days
        .map((day) =>
          lodgeCapacity > 0
            ? String(Math.round((day.occupiedBeds / lodgeCapacity) * 100))
            : "0",
        )
        .join(", "),
    },
    preferenceKey: "adminCapacityWarning",
  });
}

export async function sendAdminWaitlistOfferAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  position: number;
}) {
  await sendToAdmins({
    subject: `Waitlist Offer: ${data.memberName}`,
    html: await renderEmailHtml(() => adminWaitlistOfferTemplate(data)),
    templateName: "admin-waitlist-offer",
    templateData: {
      ...data,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
    },
    preferenceKey: "adminWaitlistOffer",
  });
}

export async function sendAdminBookingChangeRequestAlert(data: {
  memberName: string;
  memberEmail: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  requestedSummary: string;
  reason: string | null;
  requestId: string;
}) {
  const reviewUrl = `${process.env.NEXTAUTH_URL || "http://localhost:3000"}${buildBookingRequestsHref(
    "changes",
    { requestId: data.requestId },
  )}`;

  await sendToAdmins({
    subject: `Booking Change Request: ${data.memberName}`,
    html: await renderEmailHtml(() => adminBookingChangeRequestTemplate({
      memberName: data.memberName,
      memberEmail: data.memberEmail,
      bookingId: data.bookingId,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      requestedSummary: data.requestedSummary,
      reason: data.reason,
      reviewUrl,
    })),
    templateName: "admin-booking-change-request",
    templateData: {
      ...data,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      reason: data.reason ?? "",
      // #2268: pre-composed optional line — no dangling "Reason:".
      reasonNote: composeOptionalEmailLine("Reason", data.reason),
      reviewUrl,
    },
    preferenceKey: "adminBookingChangeRequest",
  });
}

export async function sendAdminBookingRequestPendingEmail(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${buildBookingRequestsHref("public", {})}`;

  await sendToAdmins({
    subject: `Booking request ready for review: ${data.requesterName}`,
    html: await renderEmailHtml(() => adminBookingRequestPendingTemplate({
      requesterName: data.requesterName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      reviewUrl,
    })),
    templateName: "admin-booking-request-pending",
    templateData: {
      requesterName: data.requesterName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      guestCount: data.guestCount,
      reviewUrl,
    },
    preferenceKey: "adminBookingRequest",
  });
}

export async function sendAdminBookingRequestHoldExpiredEmail(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  holdUntil: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/bookings`;

  await sendToAdmins({
    subject: `Request booking unpaid at hold expiry: ${data.requesterName}`,
    html: await renderEmailHtml(() => adminBookingRequestHoldExpiredTemplate({
      requesterName: data.requesterName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      holdUntil: data.holdUntil,
      reviewUrl,
    })),
    templateName: "admin-booking-request-hold-expired",
    templateData: {
      requesterName: data.requesterName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      guestCount: data.guestCount,
      total: formatMoneyCents(data.totalCents),
      holdUntil: emailClubDateTime(data.holdUntil),
      reviewUrl,
    },
    preferenceKey: "adminBookingRequest",
  });
}

// #2012: terminal one-off admin notice — a booking created from an approved
// public booking request (#707) was still unpaid (no saved card) at the end of
// its check-in day, so it was automatically cancelled and its held beds were
// released. A DEDICATED registered template (`admin-booking-request-hold-cancelled`),
// not a variant of the recurring adminBookingRequestHoldExpired alert, so an
// admin override of the recurring alert cannot rewrite this terminal notice and
// muting the recurring one does not mute this. Same admin-alert plumbing and
// adminBookingRequest gating as the recurring alert. Symmetric twin of
// sendAdminSplitSettlementCancelledAlert.
export async function sendAdminBookingRequestHoldCancelledEmail(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/bookings`;

  await sendToAdmins({
    subject: `Request booking auto-cancelled — unpaid past check-in: ${data.requesterName}`,
    html: await renderEmailHtml(() => adminBookingRequestHoldCancelledTemplate({
      requesterName: data.requesterName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      reviewUrl,
    })),
    templateName: "admin-booking-request-hold-cancelled",
    templateData: {
      requesterName: data.requesterName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      guestCount: data.guestCount,
      total: formatMoneyCents(data.totalCents),
      reviewUrl,
    },
    preferenceKey: "adminBookingRequest",
  });
}

// #1967: Admin alert — a split booking's non-member guest portion reached its
// hold deadline with no saved card to charge. Fired while the child remains
// unsettled, on the #1993 Part B capped cadence (hold extension windows 1, 2, 3,
// then every 7th; the extension claim is the dedupe across the 15-minute cron
// cadence). `parentUnpaid` selects the wording: false = the member paid their
// own place by Internet Banking and a payment link has been emailed to them;
// true = the member's own parent booking is unpaid too, so NO link was sent and
// a human must chase the whole booking. Routed to the existing payment-failure
// audience so a rare event needs no new NotificationPreference column (#1422
// precedent). The terminal auto-cancel past check-in is a SEPARATE template —
// see sendAdminSplitSettlementCancelledAlert.
export async function sendAdminSplitSettlementUnpaidAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  holdUntil: Date;
  parentUnpaid: boolean;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/bookings`;

  await sendToAdmins({
    subject: `Split booking guest portion unpaid — no card on file: ${data.memberName}`,
    html: await renderEmailHtml(() => adminSplitSettlementUnpaidTemplate({
      memberName: data.memberName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      holdUntil: data.holdUntil,
      reviewUrl,
      parentUnpaid: data.parentUnpaid,
    })),
    templateName: "admin-split-settlement-unpaid",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      guestCount: data.guestCount,
      total: formatMoneyCents(data.totalCents),
      holdUntil: emailClubDateTime(data.holdUntil),
      // #2268: the outcome-dependent lead paragraph, built from the same
      // helper as the hand-built HTML. The flat body used to assert that a
      // payment link had been emailed even when none was sent.
      settlementActionNote: adminSplitSettlementUnpaidLeadParagraph(
        data.parentUnpaid,
      ),
      reviewUrl,
      parentUnpaid: data.parentUnpaid,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

// #1993 Part A: terminal one-off admin notice — a split booking's non-member
// guest portion was still unpaid (no saved card) at the end of its check-in day,
// so the provisional guest booking was automatically cancelled. A DEDICATED
// registered template (`admin-split-settlement-cancelled`), not a variant of the
// recurring alert, so an admin override of the noisy recurring alert cannot
// rewrite this terminal notice and muting the recurring one does not mute this.
// Same admin-alert plumbing and adminPaymentFailure gating as the recurring
// alert. `parentUnpaid` only selects wording (see the template).
export async function sendAdminSplitSettlementCancelledAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  parentUnpaid: boolean;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/bookings`;

  await sendToAdmins({
    subject: `Split booking guest portion auto-cancelled — unpaid past check-in: ${data.memberName}`,
    html: await renderEmailHtml(() => adminSplitSettlementCancelledTemplate({
      memberName: data.memberName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      reviewUrl,
      parentUnpaid: data.parentUnpaid,
    })),
    templateName: "admin-split-settlement-cancelled",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      guestCount: data.guestCount,
      total: formatMoneyCents(data.totalCents),
      // #2268: the outcome-dependent lead paragraph, built from the same
      // helper as the hand-built HTML. The flat body used to assert that the
      // member's own linked booking was settled and unaffected even when it
      // was not.
      settlementActionNote: adminSplitSettlementCancelledLeadParagraph(
        data.parentUnpaid,
      ),
      reviewUrl,
      parentUnpaid: data.parentUnpaid,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

export async function sendAdminSchoolManualInvoiceEmail(data: {
  schoolName: string;
  contactEmail: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${buildBookingRequestsHref("public", {})}`;

  await sendToAdmins({
    subject: `School booking needs a manual invoice: ${data.schoolName}`,
    html: await renderEmailHtml(() => adminSchoolManualInvoiceTemplate({
      schoolName: data.schoolName,
      contactEmail: data.contactEmail,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      reviewUrl,
    })),
    templateName: "admin-school-manual-invoice",
    templateData: {
      schoolName: data.schoolName,
      contactEmail: data.contactEmail,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      amount: formatMoneyCents(data.totalCents),
      reviewUrl,
    },
    preferenceKey: "adminBookingRequest",
  });
}

/**
 * #2263 — approved MEMBER whole-lodge request confirmed with an unpaid Internet
 * Banking receivable while the Xero module is off. Sibling of
 * sendAdminSchoolManualInvoiceEmail with member-appropriate wording (the owner
 * is a real signed-in member, not a non-login school contact) and carrying the
 * payment reference the member was told to quote, so the hand-written invoice
 * matches what they will pay against.
 *
 * #2483 extends "matches what they will pay against" to the FIGURE: the amount
 * is netted against the club's own applied-credit ledger by the same resolver
 * the member's confirmation uses, so this branch — which has no Xero invoice
 * and no allocation op to reconcile the two afterwards — cannot ask the admin
 * for one number and the member for another. See
 * `adminWholeLodgeManualInvoiceTemplate`.
 */
export async function sendAdminWholeLodgeManualInvoiceEmail(data: {
  memberName: string;
  contactEmail: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  /**
   * #2483 — account credit the club's ledger has applied to this booking.
   * Zero (or omitted) is every send on today's live path and renders the
   * pre-#2483 email byte-for-byte.
   */
  appliedCreditCents?: number;
  paymentReference: string;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${buildBookingRequestsHref("public", {})}`;

  await sendToAdmins({
    subject: `Whole-lodge booking needs a manual invoice: ${data.memberName}`,
    html: await renderEmailHtml(() => adminWholeLodgeManualInvoiceTemplate({
      memberName: data.memberName,
      contactEmail: data.contactEmail,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      guestCount: data.guestCount,
      totalCents: data.totalCents,
      appliedCreditCents: data.appliedCreditCents ?? 0,
      paymentReference: data.paymentReference,
      reviewUrl,
    })),
    templateName: "admin-whole-lodge-manual-invoice",
    templateData: {
      memberName: data.memberName,
      contactEmail: data.contactEmail,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      guestCount: data.guestCount,
      // #2483: the amount to INVOICE, from the shared resolver the hand-built
      // HTML above and the member's own confirmation both use — so an admin
      // override of this body cannot ask for a different figure either.
      amount: formatMoneyCents(
        wholeLodgeManualInvoiceAmountCents(
          data.totalCents,
          data.appliedCreditCents ?? 0,
        ),
      ),
      paymentReference: data.paymentReference,
      reviewUrl,
    },
    preferenceKey: "adminBookingRequest",
  });
}
