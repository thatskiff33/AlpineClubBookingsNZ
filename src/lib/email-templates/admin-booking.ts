/**
 * Admin alerts about bookings and lodge capacity.
 *
 * The family boundary is `src/lib/email/admin-alerts-booking.ts`. The
 * manual-invoice figures come from `@/lib/booking-money-lines`, the same resolver the
 * member's own confirmation uses, so the two cannot state different amounts.
 */
import { wholeLodgeManualInvoiceAmountCents } from "@/lib/booking-money-lines";
import { escapeHtml } from "./escape";
import {
  alertBox,
  BASE_URL,
  button,
  formatCents,
  heading,
  infoTable,
  layout,
  muted,
  paragraph,
} from "./layout";
import {
  adminSplitSettlementCancelledLeadParagraph,
  adminSplitSettlementUnpaidLeadParagraph,
} from "@/lib/email-message-notes";
import { emailPalette } from "@/lib/email-theme";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";

// ---- N-02: Admin Alert — New Booking ----

export function adminNewBookingTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  status: string;
  reviewReason?: string | null;
  memberJustification?: string | null;
}): string {
  const rows = [
    { label: "Member", value: escapeHtml(data.memberName) },
    { label: "Check-in", value: emailCalendarDay(data.checkIn) },
    { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    { label: "Guests", value: String(data.guestCount) },
    { label: "Total", value: formatCents(data.totalCents) },
    { label: "Status", value: escapeHtml(data.status) },
  ];
  if (data.memberJustification) {
    rows.push({ label: "Member reason", value: escapeHtml(data.memberJustification) });
  }
  return layout(`
    ${heading("New Booking Created")}
    ${paragraph("A new booking has been created.")}
    ${data.reviewReason ? alertBox(escapeHtml(data.reviewReason), "warning") : ""}
    ${infoTable(rows)}
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- F27 / #1372: Admin Alert — booking left with only under-18 guests ----

export function adminMinorsReviewRequiredTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  reviewReason: string;
}): string {
  return layout(`
    ${heading("Booking Review Required")}
    ${paragraph(
      "A paid booking was edited and now has only under-18 guests. It is blocked from lodge check-in until an admin reviews it.",
    )}
    ${alertBox(escapeHtml(data.reviewReason), "warning")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${button("Review Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- #1756: Admin Alert — stale partner-share swept from the board ----
// A partner link dissolved (or a member was deactivated / re-tiered off ADULT)
// while the pair still held future shared double-bed placements; the second
// occupant was returned to the awaiting-allocation queue and the board may
// need re-planning.

export function adminPartnerShareSweptTemplate(data: {
  memberName: string;
  partnerName: string;
  reason: string;
  nights: Date[];
}): string {
  return layout(`
    ${heading("Shared Double-Bed Placements Removed")}
    ${paragraph(
      "A partner pair no longer qualifies for double-bed sharing, so their future shared placements were removed. The affected guest nights are back in the awaiting-allocation queue and may need re-planning on the allocation board.",
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Partner", value: escapeHtml(data.partnerName) },
      { label: "Reason", value: escapeHtml(data.reason) },
      {
        label: `Removed night${data.nights.length === 1 ? "" : "s"}`,
        value: data.nights.map((night) => emailCalendarDay(night)).join(", "),
      },
    ])}
    ${button("Review Bed Allocation", BASE_URL + "/admin/bed-allocation")}
  `);
}

// ---- F20 / #1377: Admin Alert — booking-request owner substitution ----
// A held owner failed re-validation at conversion, so a fresh non-login contact
// was minted and the invoice will bill THAT contact instead of the intended
// owner. Gated on the Xero-sync-error preference because the remedy is a Xero
// contact reconciliation (repoint the invoice's contact to the intended org).

export function adminOwnerSubstitutionTemplate(data: {
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
}): string {
  const describeMember = (id: string, name?: string | null): string => {
    const trimmed = (name ?? "").trim();
    return trimmed
      ? `${escapeHtml(trimmed)} (${escapeHtml(id)})`
      : escapeHtml(id);
  };
  return layout(`
    ${heading("Owner Substitution — Xero Reconciliation Required")}
    ${paragraph(
      "An owner substitution occurred while converting a booking request. The booking (and its Xero invoice) will bill a newly-created contact instead of the intended owner.",
    )}
    ${alertBox(
      "Action required: reconcile the invoice's contact in Xero — repoint it from the newly-created contact to the intended organisation.",
      "warning",
    )}
    ${infoTable([
      { label: "Booking request", value: escapeHtml(data.requestId) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      {
        label: "Intended owner (should be billed)",
        value: describeMember(data.intendedMemberId, data.intendedMemberName),
      },
      {
        label: "Substituted contact (currently billed)",
        value: describeMember(
          data.substituteMemberId,
          data.substituteMemberName,
        ),
      },
      { label: "Reason", value: escapeHtml(data.reason) },
      {
        label: "Requester",
        value: `${escapeHtml(data.requesterName)} (${escapeHtml(data.requesterEmail)})`,
      },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${button("Review Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-06: Admin Alert — Pending Approaching Deadline ----

export function adminPendingDeadlineTemplate(bookings: Array<{
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  deadline: Date;
  hoursRemaining: number;
}>): string {
  const p = emailPalette();
  const tableRowsHtml = bookings
    .map(
      (b) => `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(b.memberName)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${emailCalendarDay(b.checkIn)} – ${emailCalendarDay(b.checkOut)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${b.guestCount}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${emailClubDateTime(b.deadline)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${b.hoursRemaining <= 24 ? "#dc2626" : p.deep}; font-weight: ${b.hoursRemaining <= 24 ? "700" : "400"};">${Math.round(b.hoursRemaining)}h</td>
    </tr>`
    )
    .join("");

  return layout(`
    ${heading("Pending Bookings Approaching Deadline")}
    ${alertBox(bookings.length + " pending booking" + (bookings.length > 1 ? "s" : "") + " will reach their hold deadline within 48 hours.", "warning")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Member</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Dates</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Guests</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Deadline</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Remaining</th>
      </tr>
      ${tableRowsHtml}
    </table>
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-07: Admin Alert — Booking Bumped ----

export function adminBookingBumpedTemplate(data: {
  bumpedMemberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  triggeringMemberName: string;
}): string {
  return layout(`
    ${heading("Booking Bumped")}
    ${alertBox("A pending booking has been bumped due to a member booking.", "warning")}
    ${infoTable([
      { label: "Bumped Member", value: escapeHtml(data.bumpedMemberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Triggered By", value: escapeHtml(data.triggeringMemberName) },
    ])}
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-03: Admin Alert — Capacity Warning ----

export function adminCapacityWarningTemplate(days: Array<{
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
}>, lodgeCapacity = FALLBACK_LODGE_CAPACITY, lodgeName?: string | null): string {
  const p = emailPalette();
  const tableRowsHtml = days
    .map((d) => {
      const pct =
        lodgeCapacity > 0
          ? Math.round((d.occupiedBeds / lodgeCapacity) * 100)
          : 0;
      const color = d.availableBeds <= 2 ? "#dc2626" : d.availableBeds <= 5 ? "#d97706" : p.deep;
      return `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${emailCalendarDay(d.date)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${d.occupiedBeds}/${lodgeCapacity}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${color}; font-weight: 700;">${d.availableBeds}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${color}; font-weight: 700;">${pct}%</td>
    </tr>`;
    })
    .join("");

  return layout(`
    ${heading(lodgeName ? `Capacity Warning — ${escapeHtml(lodgeName)}` : "Capacity Warning")}
    ${alertBox(days.length + " day" + (days.length > 1 ? "s" : "") + " in the next 14 days have high occupancy.", "warning")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Date</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Occupied</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Available</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Occupancy</th>
      </tr>
      ${tableRowsHtml}
    </table>
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

export function adminWaitlistOfferTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  position: number;
}): string {
  return layout(`
    ${heading("Waitlist Offer Made")}
    ${paragraph("A waitlist offer has been sent to " + escapeHtml(data.memberName) + ".")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Queue Position", value: "#" + String(data.position) },
    ])}
    ${paragraph("The member has 48 hours to confirm their booking.")}
    ${button("View Waitlist", BASE_URL + "/admin/waitlist")}
  `);
}

export function adminBookingChangeRequestTemplate(data: {
  memberName: string;
  memberEmail: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  requestedSummary: string;
  reason: string | null;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Booking Change Request Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has requested an admin-reviewed booking change for a locked same-day or past-night period.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Current check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Current check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Requested change", value: escapeHtml(data.requestedSummary) },
    ])}
    ${data.reason ? alertBox(escapeHtml(data.reason), "info") : ""}
    ${button("Review Request", data.reviewUrl)}
  `);
}

export function adminBookingRequestPendingTemplate(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Booking Request Ready for Review")}
    ${paragraph("A public booking request has verified their email address and is ready for pricing and review.")}
    ${infoTable([
      { label: "Requester", value: escapeHtml(data.requesterName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${button("Review Booking Requests", data.reviewUrl, { sameOrigin: true })}
  `);
}

export function adminSchoolManualInvoiceTemplate(data: {
  schoolName: string;
  contactEmail: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("School Booking Needs a Manual Invoice")}
    ${paragraph("A school group booking has been approved and confirmed. The Xero module is currently off, so no invoice was raised automatically. Please invoice the school manually and record payment through the usual paths.")}
    ${infoTable([
      { label: "School", value: escapeHtml(data.schoolName) },
      { label: "Contact email", value: escapeHtml(data.contactEmail) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount", value: formatCents(data.totalCents) },
    ])}
    ${button("View Booking Requests", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * #2263 — an approved MEMBER whole-lodge request was converted into a CONFIRMED
 * booking with a PENDING Internet Banking receivable while the Xero module is
 * off, so nothing raised the invoice. Its own registered template rather than a
 * reuse of `adminSchoolManualInvoiceTemplate`: that one names a school and
 * addresses a non-login school contact, and this booking is owned by a real
 * signed-in member. Same money-critical class, so it is delivery-locked on the
 * same grounds — muting it would let a confirmed whole-lodge stay go
 * un-invoiced.
 */
/**
 * #2263 × #2483 — the admin's instruction to raise a whole-lodge invoice BY
 * HAND, because the Xero module is off.
 *
 * `Amount` is the amount to INVOICE, and it is the same figure the member's own
 * confirmation asks them to transfer — both come from
 * `resolveUnpaidCreditNetting` over the same two inputs. That is the whole
 * point of `appliedCreditCents` being here (#2483 review, 2 Aug 2026): on this
 * branch there is no Xero invoice and no allocation op, so nothing downstream
 * would ever reconcile an admin who invoiced the booking's gross price against
 * a member who was told to transfer the netted one. The club would chase a
 * shortfall its own ledger says does not exist, holding an email that told the
 * member not to pay it.
 *
 * `"unreconciled"` (more credit applied than the booking costs) keeps the gross
 * price here. The member is asked for nothing on that outcome and told to wait
 * for the club, so there is no figure to agree with, and the contradiction is
 * already put in front of an admin by the send-time warning in
 * `sendBookingConfirmedEmail`.
 *
 * Zero applied credit — which is every send on today's live path, because the
 * conversion mints a brand-new booking and writes no `MemberCredit` row — is
 * byte-for-byte the pre-#2483 email.
 */
export function adminWholeLodgeManualInvoiceTemplate(data: {
  memberName: string;
  contactEmail: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  /** #2483 — account credit the club's ledger has applied to this booking. */
  appliedCreditCents?: number;
  paymentReference: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Whole-Lodge Booking Needs a Manual Invoice")}
    ${paragraph("A member's whole-lodge request has been approved and the booking is confirmed with the whole lodge held for their group. The Xero module is currently off, so no invoice was raised automatically. Please invoice the member manually and record the payment through the usual paths.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Contact email", value: escapeHtml(data.contactEmail) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      {
        label: "Amount",
        value: formatCents(
          wholeLodgeManualInvoiceAmountCents(
            data.totalCents,
            data.appliedCreditCents ?? 0,
          ),
        ),
      },
      { label: "Payment reference", value: escapeHtml(data.paymentReference) },
    ])}
    ${paragraph("The member has been told the booking is confirmed, that this amount is still owing, and that the club will send them an invoice — so please send one.")}
    ${button("View Booking Requests", data.reviewUrl, { sameOrigin: true })}
  `);
}

export function adminBookingRequestHoldExpiredTemplate(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  holdUntil: Date;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Request Booking Unpaid at Hold Expiry")}
    ${paragraph("A booking created from a public booking request reached its hold deadline without payment. There is no saved card to charge, so the hold has been extended and the booking still holds member-priority status.")}
    ${infoTable([
      { label: "Requester", value: escapeHtml(data.requesterName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Total", value: formatCents(data.totalCents) },
      { label: "Hold extended to", value: emailClubDateTime(data.holdUntil) },
    ])}
    ${paragraph("Consider following up with the requester or cancelling the booking if payment is not expected.")}
    ${muted("This alert repeats on a capped cadence (the first three hold extensions, then every seventh) while the request booking stays unpaid; a terminal cancellation past the check-in day ends the series with a separate final notice.")}
    ${button("View Bookings", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * #2012 — terminal one-off admin notice: a booking created from an approved
 * public booking request (#707) was still unpaid at the end of its check-in day
 * with no saved card to charge, so it was automatically cancelled and its held
 * capacity released. A DEDICATED registered template
 * (`admin-booking-request-hold-cancelled`), not a variant of the recurring
 * adminBookingRequestHoldExpiredTemplate, so an admin override of the noisy
 * recurring alert cannot rewrite this terminal notice and muting the recurring
 * one does not mute this. Symmetric twin of adminSplitSettlementCancelledTemplate,
 * but this booking DID hold real beds, so the copy states the release explicitly.
 */
export function adminBookingRequestHoldCancelledTemplate(data: {
  requesterName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Request Booking Auto-Cancelled — Unpaid Past Check-in")}
    ${paragraph("A booking created from a public booking request was still unpaid at the end of its check-in day, with no saved card to charge. The provisional booking has now been automatically cancelled and the beds it was holding have been released back to availability. No payment was taken. The requester has been notified.")}
    ${infoTable([
      { label: "Requester", value: escapeHtml(data.requesterName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount (unpaid)", value: formatCents(data.totalCents) },
    ])}
    ${paragraph("No further action is required. If the requester still intends to come and pay, ask them to submit a new booking request.")}
    ${muted("This is a one-off notice — it ends the capped hold-extension alert series for this request booking.")}
    ${button("View Bookings", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * Split-booking guest portion unpaid at hold expiry, no card on file (#1967).
 * Admin alert fired while a split non-member child remains unsettled with no
 * saved card. #1993 Part B caps the previously-every-run cadence to hold
 * extension windows 1, 2, 3, then every 7th; the terminal auto-cancel past
 * check-in ends the series with a separate one-off notice
 * (adminSplitSettlementCancelledTemplate). Two variants:
 * - parent settled (member paid their own place by internet banking): a
 *   payment link has been emailed to the member;
 * - parent unpaid (e.g. an abandoned card payment): NO link was sent — the
 *   guest portion must not settle ahead of the member's own place, so a human
 *   needs to chase the whole booking.
 */

export function adminSplitSettlementUnpaidTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  holdUntil: Date;
  reviewUrl: string;
  parentUnpaid: boolean;
}): string {
  return layout(`
    ${heading("Split Booking Guest Portion Unpaid — No Card on File")}
    ${paragraph(adminSplitSettlementUnpaidLeadParagraph(data.parentUnpaid))}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount due", value: formatCents(data.totalCents) },
      { label: "Hold extended to", value: emailClubDateTime(data.holdUntil) },
    ])}
    ${paragraph("No beds are held for these guests until payment is received. Follow up with the member or cancel the guest portion if payment is not expected.")}
    ${muted("This alert repeats on a capped cadence (the first three hold extensions, then every seventh) while the guest portion stays unpaid; a terminal cancellation past the check-in day ends the series with a separate final notice.")}
    ${button("View Bookings", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * #1993 Part A — terminal one-off admin notice: a split non-member guest
 * portion was still unpaid (no saved card) at the end of its check-in day, so
 * the provisional guest booking was automatically cancelled. Distinct from the
 * recurring adminSplitSettlementUnpaidTemplate: there is no hold to extend and
 * no repeating cadence, and it ends the capped alert series. `parentUnpaid`
 * only selects wording — it reports the member's own linked booking as either
 * settled-and-unaffected (internet-banking parent) or not-settled (an unpaid or
 * already-cancelled parent that a human should review), never a false "also
 * unpaid" for a parent that is in fact cancelled or bumped.
 */

export function adminSplitSettlementCancelledTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalCents: number;
  reviewUrl: string;
  parentUnpaid: boolean;
}): string {
  return layout(`
    ${heading("Split Booking Guest Portion Auto-Cancelled — Unpaid Past Check-in")}
    ${paragraph(adminSplitSettlementCancelledLeadParagraph(data.parentUnpaid))}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount (unpaid)", value: formatCents(data.totalCents) },
    ])}
    ${paragraph("No further action is required for the guest portion. If these guests are in fact coming and the member intends to pay, create a new booking for them.")}
    ${muted("This is a one-off notice — it ends the capped hold-extension alert series for this guest portion.")}
    ${button("View Bookings", data.reviewUrl, { sameOrigin: true })}
  `);
}
