/**
 * HTML email templates for club emails.
 * All templates use inline CSS for maximum email client compatibility.
 */

import { getAppBaseUrl, sanitizeEmailHref } from "./app-url";
import {
  CLUB_HUT_LEADER_LABEL,
  CLUB_LODGE_TRAVEL_NOTE,
  CLUB_NAME,
} from "@/config/club-identity";
// Search key (C6 #1985): the `<title>` bakes the config-derived default from-name,
// which applyEmailMessageSettingsToHtml swaps for the DB-first
// EmailMessageSetting.emailFromName at send time. Must NOT come from the severed
// club-identity export (now safe-default-derived) or the replacement would no-op.
import { EMAIL_DEFAULT_FROM_NAME } from "@/lib/email-message-settings";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { SUPPORT_EMAIL } from "./email-sender";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "./member-setup-invite";
import { formatNZDate, formatNZDateTime } from "./nzst-date";
import { emailPalette } from "./email-theme";
// TYPE-ONLY, and it has to stay that way: member-guest-email-notes.ts imports
// `escapeHtml` from THIS module, so a value import here would close a runtime
// cycle. A type import is erased at compile time, and the four member-guest
// templates only ever receive the composed strings — they never compose.
import type { MemberGuestPartyList } from "@/lib/member-guest-email-notes";
// #2268: the optional/outcome-dependent line composers live in a leaf module
// so the senders and the template registry can build the same copy without
// pulling in this whole file.
import {
  adminSplitSettlementCancelledLeadParagraph,
  adminSplitSettlementUnpaidLeadParagraph,
  bookingBumpedRebookAction,
  bookingPaymentDueNote,
  duplicateCaptureRefundOutcomeParagraph,
  lateCaptureAutoRefundLeadParagraph,
  lateCaptureAutoRefundOutcomeParagraph,
  lateCaptureHandBackConflictOutcomeParagraph,
  lateCapturePaymentLabel,
  splitGuestPortionOwnBookingLine,
  type BookingPaymentDueCredit,
} from "./email-message-notes";

const BASE_URL = getAppBaseUrl();

/** Escape HTML special characters to prevent injection in email templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Brand colours are pulled per-render from the club (Site Style) theme via
// `emailPalette()` (see email-theme.ts) so emails match the live site. Each
// helper/template reads `const p = emailPalette()` once and uses p.gold,
// p.charcoal, p.deep, p.mist, p.snow, p.ridge. These two are not brand roles
// and stay fixed.
const BRAND_LOGO_URL = `${BASE_URL}/branding/logo.png`;
const WHITE = "#ffffff";

function layout(content: string): string {
  const p = emailPalette();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(EMAIL_DEFAULT_FROM_NAME)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${p.snow}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${p.snow};">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="background-color: ${p.charcoal}; padding: 28px 32px 24px; border-top: 4px solid ${p.gold}; border-radius: 8px 8px 0 0; text-align: center;">
              <img
                src="${BRAND_LOGO_URL}"
                alt="${escapeHtml(CLUB_NAME)}"
                width="176"
                style="display: block; margin: 0 auto 14px; width: 176px; max-width: 100%; height: auto;"
              />
              <p style="margin: 0; color: ${WHITE}; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;">
                Online Booking System
              </p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color: ${WHITE}; padding: 32px; border-left: 1px solid ${p.mist}; border-right: 1px solid ${p.mist};">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: ${WHITE}; padding: 20px 32px; border-top: 1px solid ${p.mist}; border-radius: 0 0 8px 8px; border-left: 1px solid ${p.mist}; border-right: 1px solid ${p.mist}; border-bottom: 1px solid ${p.mist};">
              <p style="margin: 0; color: ${p.ridge}; font-size: 12px; text-align: center;">
                ${escapeHtml(CLUB_NAME)} &bull; Online Booking System<br>
                <a href="${BASE_URL}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: none;">${BASE_URL.replace(/^https?:\/\//, "")}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function supportEmailLink(): string {
  const p = emailPalette();
  const address = escapeHtml(SUPPORT_EMAIL);
  return `<a href="mailto:${address}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: none;">${address}</a>`;
}

function supportContactMuted(): string {
  return muted(`${escapeHtml(CLUB_NAME)} — ${supportEmailLink()}`);
}

function supportContactSentence(prefix: string): string {
  return muted(`${prefix}${supportEmailLink()}.`);
}

function button(
  text: string,
  url: string,
  options?: { sameOrigin?: boolean }
): string {
  const p = emailPalette();
  const safeUrl = sanitizeEmailHref(url, {
    baseUrl: BASE_URL,
    sameOrigin: options?.sameOrigin,
  });

  return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
  <tr>
    <td style="background-color: ${p.gold}; border-radius: 6px;">
      <a href="${escapeHtml(safeUrl)}" target="_blank" style="display: inline-block; padding: 12px 28px; color: ${p.charcoal}; text-decoration: none; font-weight: 700; font-size: 14px;">
        ${text}
      </a>
    </td>
  </tr>
</table>`;
}

function infoTable(rows: Array<{ label: string; value: string }>): string {
  const p = emailPalette();
  const rowsHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding: 8px 12px; font-weight: 600; color: ${p.deep}; font-size: 14px; border-bottom: 1px solid ${p.mist}; white-space: nowrap;">${r.label}</td>
      <td style="padding: 8px 12px; color: ${p.deep}; font-size: 14px; border-bottom: 1px solid ${p.mist};">${r.value}</td>
    </tr>`
    )
    .join("");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
  ${rowsHtml}
</table>`;
}

function heading(text: string): string {
  const p = emailPalette();
  return `<h2 style="margin: 0 0 16px 0; color: ${p.deep}; font-size: 22px; font-weight: 700;">${text}</h2>`;
}

function paragraph(text: string): string {
  const p = emailPalette();
  return `<p style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 15px; line-height: 1.6;">${text}</p>`;
}

export function plainTextEmailTemplate(bodyText: string): string {
  const blocks = bodyText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const [firstBlock, ...rest] = blocks;
  const headingHtml = firstBlock ? heading(escapeHtml(firstBlock)) : "";
  const bodyHtml = rest.length > 0
    ? rest
        .map((block) => multilineBlock(escapeHtml(block)))
        .join("")
    : "";

  return layout(`
    ${headingHtml}
    ${bodyHtml}
  `);
}

function multilineBlock(text: string): string {
  const p = emailPalette();
  return `<div style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${text}</div>`;
}

function muted(text: string): string {
  const p = emailPalette();
  return `<p style="margin: 0 0 8px 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">${text}</p>`;
}

function alertBox(
  text: string,
  type: "info" | "warning" | "success" = "info"
): string {
  const p = emailPalette();
  const colors = {
    info: { bg: "#fff7d6", border: p.gold, text: p.deep },
    warning: { bg: "#fef3c7", border: "#fcd34d", text: "#92400e" },
    success: { bg: "#dcfce7", border: "#86efac", text: "#166534" },
  };
  const c = colors[type];
  return `
<div style="background-color: ${c.bg}; border: 1px solid ${c.border}; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
  <p style="margin: 0; color: ${c.text}; font-size: 14px; font-weight: 600; white-space: pre-wrap;">${text}</p>
</div>`;
}

function arrivalInstructionsSection({
  travelNote,
  doorCode,
}: {
  travelNote: string;
  doorCode?: string | null;
}): string {
  const safeTravelNote = travelNote.trim();
  const safeDoorCode = doorCode?.trim() || null;
  const doorCodeTable = safeDoorCode
    ? infoTable([
        {
          label: "Door code",
          value: `<strong style="font-size: 18px; letter-spacing: 1px;">${escapeHtml(safeDoorCode)}</strong>`,
        },
      ])
    : "";

  return `
    ${paragraph("<strong>How to get to the lodge</strong>")}
    ${safeTravelNote ? multilineBlock(escapeHtml(safeTravelNote)) : ""}
    ${doorCodeTable}
    ${safeDoorCode ? muted("Please keep the door code private and use the current code when you arrive.") : ""}
  `;
}

// ---- Exported template functions ----

function formatCents(cents: number): string {
  return formatMoneyCents(cents);
}

export function passwordResetTemplate(resetUrl: string): string {
  return layout(`
    ${heading("Password Reset")}
    ${paragraph(`You requested a password reset for your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph("Click the button below to set a new password. This link expires in <strong>1 hour</strong>.")}
    ${button("Reset Password", resetUrl)}
    ${muted("If you didn't request this, you can safely ignore this email. Your password will remain unchanged.")}
  `);
}

export function magicLinkLoginTemplate(loginUrl: string): string {
  return layout(`
    ${heading("Sign In")}
    ${paragraph(`You asked to sign in to your ${escapeHtml(CLUB_NAME)} booking account with an email link.`)}
    ${paragraph("Click the button below to sign in. This link can be used once and expires shortly.")}
    ${button("Sign In", loginUrl)}
    ${muted("If you didn't request this, you can safely ignore this email — your account stays secure and you can still sign in with your password.")}
  `);
}

export function adminPasswordResetTemplate(
  resetUrl: string,
  expiryLabel = "1 hour"
): string {
  return layout(`
    ${heading("Password Reset")}
    ${paragraph(`An administrator has requested a password reset for your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph("Click the button below to set a new password. This link expires in <strong>" + escapeHtml(expiryLabel) + "</strong>.")}
    ${button("Reset Password", resetUrl)}
    ${muted("If you believe this was sent in error, please contact the club administrator.")}
  `);
}

export function memberSetupInviteTemplate(
  firstName: string,
  resetUrl: string
): string {
  return layout(`
    ${heading("Set Up Your Account")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph(`An administrator has created your ${escapeHtml(CLUB_NAME)} booking account.`)}
    ${paragraph(
      "Use the button below to set your password and activate your login. This link expires in <strong>" +
        String(MEMBER_SETUP_INVITE_TTL_DAYS) +
        " days</strong>."
    )}
    ${button("Set Up My Password", resetUrl)}
    ${muted("If you were not expecting this invite, you can safely ignore it or contact the club.")}
  `);
}

export function twoFactorCodeTemplate(params: {
  firstName: string;
  code: string;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Two-factor code")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ",")}
    ${paragraph(`Use this code to finish signing in to your ${escapeHtml(CLUB_NAME)} booking account:`)}
    ${paragraph(
      `<strong style="display: inline-block; font-size: 28px; letter-spacing: 0.16em; padding: 8px 0;">${escapeHtml(params.code)}</strong>`,
    )}
    ${muted("This code expires on " + escapeHtml(formatNZDateTime(params.expiresAt)) + ". If you did not try to sign in, change your password and contact the club.")}
  `);
}

/**
 * #2267: the single source of truth for the signed promo adjustment behind a
 * booking's price, shared by the hand-built HTML confirmation and the send that
 * fills the admin-editable body so the two can never derive it differently.
 *
 * `promoAdjustmentCents` (the pricing policy's signed `priceAdjustmentCents`)
 * wins when present; older bookings only carry `discountCents`, which can only
 * ever describe a price cut, so it becomes a negative adjustment.
 */
export function resolvePromoAdjustmentCents(options?: {
  discountCents?: number;
  promoAdjustmentCents?: number;
}): number {
  return (
    options?.promoAdjustmentCents ??
    (options?.discountCents && options.discountCents > 0
      ? -options.discountCents
      : 0)
  );
}

/**
 * #2267: the single source of truth for how a promo shows on money emails —
 * shared by the hand-built HTML confirmation (bookingConfirmedTemplate) and the
 * flat {{promoSummary}} token the admin-editable body renders, so the two
 * paths cannot drift apart again (the 31651e00 failure mode).
 *
 * `promoAdjustmentCents` is the signed pricing-policy adjustment
 * (priceAdjustmentCents): negative for a discount, positive for a
 * FIXED_NIGHTLY/SET_PRICE promo that raises the price. Empty when zero — no
 * promo means no rows at all, never ragged "Subtotal:"/"Promo adjustment ():"
 * lines. Values are unescaped plain text; the HTML path escapes at the edge.
 */
export function promoAdjustmentSummaryRows(
  totalCents: number,
  promoAdjustmentCents: number,
  promoCode?: string,
): Array<{ label: string; value: string }> {
  if (promoAdjustmentCents === 0) return [];
  const subtotalCents = totalCents - promoAdjustmentCents;
  const adjustmentPrefix = promoAdjustmentCents > 0 ? "+" : "-";
  return [
    { label: "Subtotal", value: formatMoneyCents(subtotalCents) },
    {
      label: promoCode ? `Promo adjustment (${promoCode})` : "Promo adjustment",
      value: `${adjustmentPrefix}${formatMoneyCents(Math.abs(promoAdjustmentCents))}`,
    },
  ];
}

/**
 * #2328: how the money that was NOT taken from the member's card was settled.
 *
 * Only ever used to label the second line of the applied-credit pair, so the
 * confirmation never tells a member who bank-transferred that their card was
 * charged. Mirrors the `refundMethod` parameter `sendBookingCancelledEmail`
 * has always carried. Resolved from the booking's PERSISTED Payment row
 * (`loadBookingAppliedCredit`), never from a policy re-computation.
 */
export type ConfirmationSettlementMethod = "card" | "bank_transfer" | "manual";

/**
 * #2328: the applied-account-credit facts a booking confirmation needs, read
 * off the booking's own persisted records.
 */
export interface AppliedCreditSummary {
  /**
   * Account credit applied to this booking, as a POSITIVE integer-cents
   * amount (the ledger's `|Σ BOOKING_APPLIED|`). Zero for the overwhelming
   * majority of bookings, which renders no credit lines at all.
   */
  amountCents: number;
  /** How the remainder was settled; labels the "Paid by …" line. */
  settlementMethod: ConfirmationSettlementMethod;
}

const SETTLED_LINE_LABELS: Record<ConfirmationSettlementMethod, string> = {
  card: "Paid by card",
  bank_transfer: "Paid by bank transfer",
  manual: "Paid by cash or bank transfer",
};

/**
 * #2328 (review): the label used when the settled figure is EXACTLY $0.00 —
 * account credit covered the whole stay and no money changed hands by any
 * method.
 *
 * Method-NEUTRAL on purpose, because at $0.00 there is no evidence for a
 * method claim. A fully-credit-covered booking is settled by writing a Payment
 * row with `amountCents: 0` and NO `source`
 * (`src/lib/booking-create.ts`, the `isZeroDollarConfirmed` branch; and the
 * `paid_zero` upsert in
 * `src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts`), so the
 * row takes the schema default `PaymentSource.STRIPE` whatever the member
 * actually elected — and the branch itself is payment-method agnostic. A
 * method-bearing label therefore tells an Internet-Banking member with no card
 * on file "Paid by card: $0.00", which is a claim the records do not support.
 *
 * The line is NOT dropped: `total − credit = $0.00` is exactly the arithmetic
 * the pair exists to complete, and it is the case where "Total Paid: $300.00"
 * alone was at its most misleading. Only the method word goes. Non-zero
 * settlements keep the method-aware labels above, which ARE evidence-backed —
 * a real card charge or bank transfer writes its own source.
 */
const NOTHING_SETTLED_LABEL = "Nothing more to pay";

/**
 * #2328 × #2483: the one label under which account credit appears on a booking
 * confirmation, whether the booking is settled (the pair below) or still owing
 * (the netting rows further down). Shared so the two money outcomes cannot end
 * up naming the same thing differently.
 */
const APPLIED_CREDIT_LABEL = "Account credit applied";

/**
 * #2328: the single source of truth for how APPLIED ACCOUNT CREDIT shows on a
 * booking confirmation — shared by the hand-built HTML confirmation
 * (`bookingConfirmedTemplate`) and the flat `{{creditNote}}` token the
 * admin-editable body renders, exactly as `promoAdjustmentSummaryRows` is
 * shared for promos, so the two paths cannot drift.
 *
 * The bug it fixes: a member who paid $300.00 partly from account credit read
 * "Total Paid: $300.00" while their card statement said $180.00, with nothing
 * in the email to explain the gap. The pair below reconciles the two —
 * "Total Paid" stays the booking's FULL price (that is what the stay cost, and
 * the credit really did pay for part of it), and these rows say where the money
 * came from, so `total − credit = card` adds up on the page.
 *
 * `settledCents` is what the club took by card/bank/cash for this booking,
 * i.e. the settled amount MINUS the applied credit. Empty (no rows at all,
 * never a ragged label) when no credit was applied — the byte-for-byte
 * unchanged case — and also when `settledCents` is negative, which happens on
 * a send that reports money as NOT yet taken (no "paid by" story to tell, and
 * it must not invent one) or when more credit was consumed than the booking is
 * now worth. Both of those suppressions are logged by the SENDER rather than
 * here, where the booking id is in hand and the warning fires exactly once per
 * send — see `sendBookingConfirmedEmail` in `src/lib/email/booking.ts`, which
 * is the only caller of this module's confirmation template.
 *
 * At EXACTLY $0.00 settled the second line loses its method word (see
 * `NOTHING_SETTLED_LABEL`) but stays, because the arithmetic is the point.
 * Money is integer cents throughout; values are unescaped plain text, and the
 * HTML path escapes at its own edge.
 */
export function appliedCreditSummaryRows(
  appliedCreditCents: number,
  settledCents: number,
  settlementMethod: ConfirmationSettlementMethod = "card",
): Array<{ label: string; value: string }> {
  if (appliedCreditCents <= 0 || settledCents < 0) return [];
  return [
    {
      label: APPLIED_CREDIT_LABEL,
      value: `-${formatMoneyCents(appliedCreditCents)}`,
    },
    {
      // #2328 (review): a $0.00 settlement has no method to name — the Payment
      // row behind it is written without a source and takes the schema default.
      label:
        settledCents === 0
          ? NOTHING_SETTLED_LABEL
          : SETTLED_LINE_LABELS[settlementMethod],
      value: formatMoneyCents(settledCents),
    },
  ];
}

/**
 * #2328: the settled-by-non-credit figure the pair above reports, for whichever
 * of the confirmation's three money outcomes this send is.
 *
 * Kept beside the row builder, and used by BOTH the HTML template and the
 * sender, because getting this wrong is how the two paths would disagree about
 * the same booking:
 *  - unpaid (`paymentDue`): nothing has been settled at all, so there is no
 *    "paid by" figure — returns a negative sentinel that suppresses the rows.
 *
 *    That suppression is about the SETTLEMENT half of the pair only, and it is
 *    unconditionally right: no money has moved, so there is no "Paid by card"
 *    line to write. It does NOT mean an unpaid confirmation stays silent about
 *    credit. Since #2483 the unpaid branch states the netting in its own shape
 *    — booking total, credit applied, amount to transfer — built by
 *    `unpaidMoneySummaryRows` below. Before #2483 the whole subject was
 *    suppressed here, which was defensible only while no send site could pair
 *    `paymentDue` with applied credit;
 *
 *    A #2444 DRAFT claimed the invoice for this booking has the member's
 *    floating credit notes ALLOCATED against it under #1620, because the send
 *    site enqueues an allocation op a few lines above the send. That is WRONG
 *    as a statement about TODAY'S path and is retracted (re-verified 1 Aug
 *    2026): `enqueueXeroAppliedCreditAllocationOperation` only queues anything
 *    when the booking already carries `BOOKING_APPLIED` ledger rows, and the
 *    one live `paymentDue` path writes none, so it always returns
 *    `{ queueOperationId: null }` and the invoice stands at the FULL amount.
 *    #2483 nets that branch LOCALLY because `deriveBookingAppliedCreditCents`
 *    is the club's own amount-owing law, not a guess at Xero — see
 *    `resolveUnpaidCreditNetting` below, which also states precisely where the
 *    email's read and the allocation gate's read can come apart (the gate sees
 *    only the `xeroCreditNoteId: null` subset) and what #2501 has to catch;
 *  - partly paid (`outstandingBalance`, #2397): the settled slice is the
 *    booking's price minus what is still owing, and the credit comes out of
 *    THAT, not out of the full price;
 *  - paid in full: the whole price, minus the credit.
 *
 * Can return a NEGATIVE for a settled booking when more credit was consumed
 * than the booking is now worth. Unreachable today — the #1887 reprice clamp
 * refunds the over-consumed slice as a positive `BOOKING_APPLIED` offset on
 * every repriceable path, so the derived sum never exceeds the price — and the
 * rows are suppressed if it ever happens, which is why the sender logs it.
 */
export function settledByPaymentCents({
  totalCents,
  appliedCreditCents,
  unpaid,
  outstandingCents,
}: {
  totalCents: number;
  appliedCreditCents: number;
  unpaid: boolean;
  outstandingCents: number;
}): number {
  if (unpaid) return -1;
  return totalCents - outstandingCents - appliedCreditCents;
}

/**
 * #2483: what a confirmed-but-UNPAID booking is really asking the member for,
 * once the club's own account-credit ledger has been consulted.
 *
 * The bug. An unpaid confirmation states the booking's full price as
 * "Total Due" and asks the member to transfer it. Where account credit has been
 * applied to that booking app-side, the club's Xero invoice is reduced by
 * exactly that credit (#1620 "allocate-existing" — the allocation is gated on
 * the booking's `BOOKING_APPLIED` ledger rows), so the invoice asks for less
 * than the email does and a member who follows the email OVERPAYS.
 *
 * Why the figure is computed HERE and not read back from Xero (owner decision,
 * 2 Aug 2026). The allocation is asynchronous — queued on the Xero outbox and
 * processed afterwards — so waiting for it would either delay a member-facing
 * confirmation behind a provider operation or make the email's content depend
 * on outbox timing. The owner's direction is that the email uses the booking
 * app's OWN known credits, with no delay and an itemised amount, and that a
 * SEPARATE reconciliation checker (#2501) warns admins whenever the club's
 * ledger and Xero disagree. That split keeps the provider off the send path and
 * puts drift in front of an admin instead of in front of a member.
 *
 * Why that local figure is trustworthy — stated precisely, because an earlier
 * draft of this docblock overstated it (#2483 review, 2 Aug 2026).
 * `deriveBookingAppliedCreditCents` is the club's OWN amount-owing law: it is
 * the same figure `prepareManualSettlement` computes an effective price from
 * (`payment-reconciliation.ts`, `finalPriceCents − derive`), the same figure the
 * card-capture amount guard accepts, and the same `desiredAppliedCents` the Xero
 * deallocation engine converges an invoice to. So the netted figure the member
 * is asked for is exactly what the club would accept as full settlement — which
 * is the property that matters here.
 *
 * What it is NOT is the same predicate the allocation gate reads.
 * `enqueueXeroAppliedCreditAllocationOperation` aggregates only the
 * `xeroCreditNoteId: null` UNALLOCATED subset — a work-remaining filter over the
 * rows this sums — so the two agree only while a stamped row really does mean
 * the credit is already off the LIVE invoice. Three things can break that, and
 * all three are #2501's to surface, not the email's:
 *  - a hand edit to the credit note or invoice in Xero afterwards;
 *  - an allocation op that FAILED or was never processed, leaving the invoice at
 *    the full price with the queued work stalled;
 *  - a stamp that outlived the invoice it recorded (an invoice unlinked and
 *    re-raised), after which the gate finds no unallocated rows and queues
 *    nothing at all.
 * #2501's checker should therefore compare Σ STAMPED `BOOKING_APPLIED` against
 * the live invoice's own allocations, not merely club credits against Xero
 * credits.
 *
 * THE FOUR OUTCOMES. Money is integer cents throughout and the only arithmetic
 * is one subtraction, so no rounding is possible:
 *  - `"none"` — no credit applied (the overwhelming majority, and every send on
 *    today's one live `paymentDue` path), or a non-positive price. Renders the
 *    #2444 message byte-for-byte.
 *  - `"netted"` — credit smaller than the price. States the reconciling trio and
 *    asks for the difference.
 *  - `"covered"` — credit EQUALS the price. Not a contradiction: it is the
 *    documented steady state of the #1887 reprice clamp, and the state the
 *    club's own settle path calls "nothing owing". Folding it into a refusal
 *    that printed the full price would ask a member to pay 100% of a booking
 *    they owe nothing on — so it states `Total Due: $0.00` and asks for nothing.
 *  - `"unreconciled"` — MORE credit applied than the booking costs. The ledger
 *    contradicts the price, so no figure derived from the pair may be shown and
 *    no payment may be asked for. The email states the booking's price as a fact
 *    and nothing as an instruction; the sender logs it for an admin.
 */
export type UnpaidCreditNettingOutcome =
  | "none"
  | "netted"
  | "covered"
  | "unreconciled";

export interface UnpaidCreditNetting {
  /** Which of the four shapes above this send is. */
  outcome: UnpaidCreditNettingOutcome;
  /**
   * Account credit the club's own ledger has applied to this booking, in
   * integer cents. ZERO on `"none"` (none is applied) and on `"unreconciled"`
   * (the figures contradict each other, so none may be stated).
   */
  creditCents: number;
  /**
   * What the member must transfer: the booking's price less `creditCents`.
   * Equals the booking's price on `"none"`, is zero on `"covered"`, and is zero
   * on `"unreconciled"` — where nothing may be asked for at all, so no caller
   * can accidentally render a figure from it.
   */
  toTransferCents: number;
}

export function resolveUnpaidCreditNetting({
  totalCents,
  appliedCreditCents,
}: {
  totalCents: number;
  appliedCreditCents: number;
}): UnpaidCreditNetting {
  const creditCents = Math.max(0, appliedCreditCents);
  if (creditCents === 0 || totalCents <= 0) {
    return { outcome: "none", creditCents: 0, toTransferCents: totalCents };
  }
  if (creditCents > totalCents) {
    return { outcome: "unreconciled", creditCents: 0, toTransferCents: 0 };
  }
  return {
    outcome: creditCents === totalCents ? "covered" : "netted",
    creditCents,
    toTransferCents: totalCents - creditCents,
  };
}

/**
 * #2483: the `accountCredit` argument `bookingPaymentDueNote` takes, derived
 * from one netting by BOTH renderers so neither can pick a different paragraph
 * shape than the money rows beside it. `format` is the caller's own money
 * formatter, which is the only thing the two renderers differ in.
 */
export function unpaidCreditNoteInput(
  totalCents: number,
  netting: UnpaidCreditNetting,
  format: (cents: number) => string,
): BookingPaymentDueCredit | undefined {
  if (netting.outcome === "none") return undefined;
  if (netting.outcome === "unreconciled") return { outcome: "unreconciled" };
  return {
    outcome: netting.outcome,
    bookingTotal: format(totalCents),
    creditApplied: format(netting.creditCents),
  };
}

/**
 * #2483: the amount an admin must invoice BY HAND for a member whole-lodge
 * booking when the Xero module is off — the same figure, from the same
 * resolver, that the member's own confirmation asks them to transfer.
 * See `adminWholeLodgeManualInvoiceTemplate` for why the two must agree and why
 * `"unreconciled"` keeps the gross price.
 */
export function wholeLodgeManualInvoiceAmountCents(
  totalCents: number,
  appliedCreditCents: number,
): number {
  const netting = resolveUnpaidCreditNetting({ totalCents, appliedCreditCents });
  return netting.outcome === "unreconciled"
    ? totalCents
    : netting.toTransferCents;
}

/**
 * #2483: the money rows of an UNPAID confirmation — the single source of truth
 * for them, shared by the hand-built HTML confirmation and the pre-composed
 * `{{paymentOutcome}}` block an admin-editable body renders, exactly as
 * `appliedCreditSummaryRows` is shared for a settled booking.
 *
 * Without netting it is the one "Total Due" line #2263 shipped, so an unpaid
 * confirmation for a member holding no applicable credit is unchanged. With
 * netting it is the reconciling trio #2328 established for a settled booking,
 * in the tense an unpaid one needs: what the stay costs, what the club has
 * already put towards it, and what is left to transfer. "Total Due" keeps its
 * label — it is what the member owes, which is the point of the line — so a
 * saved override built on `{{totalDue}}` states the netted figure with no edit.
 * On `"covered"` that trio still reconciles and lands on `Total Due: $0.00`,
 * which is the honest figure.
 *
 * `"unreconciled"` states the booking's price as `Booking Total` and stops.
 * Calling a figure "Total Due" is an instruction to pay it, and the whole point
 * of that outcome is that no figure derived from a contradictory ledger may be
 * asked for; the paragraph beside these rows says the club will confirm what,
 * if anything, is left.
 *
 * Values are unescaped plain text; the HTML path escapes at its own edge.
 */
export function unpaidMoneySummaryRows(
  totalCents: number,
  netting: UnpaidCreditNetting,
): Array<{ label: string; value: string }> {
  if (netting.outcome === "none") {
    return [{ label: "Total Due", value: formatMoneyCents(totalCents) }];
  }
  if (netting.outcome === "unreconciled") {
    return [{ label: "Booking Total", value: formatMoneyCents(totalCents) }];
  }
  return [
    { label: "Booking Total", value: formatMoneyCents(totalCents) },
    {
      label: APPLIED_CREDIT_LABEL,
      value: `-${formatMoneyCents(netting.creditCents)}`,
    },
    { label: "Total Due", value: formatMoneyCents(netting.toTransferCents) },
  ];
}

export function bookingConfirmedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: {
    discountCents?: number;
    promoAdjustmentCents?: number;
    promoCode?: string;
    // #2328: account credit applied to this booking, read off the ledger by
    // the sender and threaded through unchanged. Absent/zero renders no credit
    // lines and leaves the message byte-for-byte as it was.
    appliedCredit?: AppliedCreditSummary;
    lodgeTravelNote?: string;
    doorCode?: string | null;
    // Split-booking parent (#738): the non-member places on this party are held
    // as a provisional linked booking, charged separately around the hold
    // deadline. Present only when this confirmation is a split parent.
    provisionalGuests?: {
      guestCount: number;
      holdUntil: Date;
    };
    // #2263: a confirmation for a booking that is CONFIRMED but NOT yet paid —
    // the member whole-lodge approval creates a PENDING Internet Banking
    // receivable, so "Total Paid" and "Payment has been processed successfully"
    // would both be false. When present, the money row states what is OWING and
    // the alert box says how to pay it. Same template (and therefore the same
    // operator override) as the paid confirmation, exactly as the split-parent
    // `provisionalGuests` variant is (#738).
    paymentDue?: {
      /** Internet-banking reference the member must quote (never a bearer token). */
      reference: string;
      /** True once the club's accounting system actually emails the invoice. */
      invoiceEmailed: boolean;
    };
    // #2397: the booking is settled but NOT in full — an admin recorded a cash
    // / off-Xero payment and said it did not cover an uncollected price
    // increase, so the club took less than the booking is worth and will go on
    // asking for the rest. "Total Paid: <whole price>" and "Payment has been
    // processed successfully" would both be false, and would contradict the
    // admin's own receipt. The money rows split into paid vs still owing and
    // the alert box says what happens next. `paymentDue` (nothing paid at all)
    // takes precedence if both are somehow supplied — it is the stronger
    // statement, and the two are mutually exclusive by construction.
    outstandingBalance?: {
      /** Still owed, in integer cents. Always < totalCents. */
      amountCents: number;
      /**
       * True when the member still holds a live card instrument for it (the
       * addition's own payment intent, deliberately spared by the settlement),
       * so their booking page can actually take the money. False means the
       * only route is the club contacting them, and the copy must say so
       * rather than sending them to a door that does not open.
       */
      payableOnline: boolean;
    };
  }
): string {
  const promoAdjustmentCents = resolvePromoAdjustmentCents(options);
  const provisional = options?.provisionalGuests;
  const provisionalSection =
    provisional && provisional.guestCount > 0
      ? alertBox(
          `Your ${provisional.guestCount} non-member guest${
            provisional.guestCount === 1 ? "" : "s"
          } ${
            provisional.guestCount === 1 ? "is" : "are"
          } held provisionally as a linked booking — no bed is reserved for them yet, and the payment above covers only your member places. If beds remain around ${formatNZDateTime(
            provisional.holdUntil,
          )}, we'll automatically take that guest portion from your saved payment method and your guests are confirmed. If we can't take payment, we'll contact you to arrange it. If the lodge fills with member bookings first, that portion is not charged and those guests are bumped.`,
          "warning",
        )
      : "";
  const rows: Array<{ label: string; value: string }> = [
    { label: "Check-in", value: formatNZDate(checkIn) },
    { label: "Check-out", value: formatNZDate(checkOut) },
    { label: "Guests", value: String(guestCount) },
  ];

  for (const row of promoAdjustmentSummaryRows(
    totalCents,
    promoAdjustmentCents,
    options?.promoCode,
  )) {
    // The shared rows are unescaped plain text (the flat token path needs them
    // raw); the promo code inside the label is club-entered data, so escape at
    // this HTML edge.
    rows.push({ label: escapeHtml(row.label), value: escapeHtml(row.value) });
  }

  const paymentDue = options?.paymentDue;
  // #2397: only when nothing is due in full — the two states are exclusive.
  const outstandingBalance = paymentDue ? undefined : options?.outstandingBalance;
  // #2328: the applied-credit pair, from the SHARED row builder the flat
  // {{creditNote}} token uses, so the HTML table and an admin-editable body
  // tell one story. Empty for every booking that used no credit, which is why
  // those confirmations are byte-for-byte unchanged.
  const appliedCreditCents = Math.max(0, options?.appliedCredit?.amountCents ?? 0);
  const creditRows = appliedCreditSummaryRows(
    appliedCreditCents,
    settledByPaymentCents({
      totalCents,
      appliedCreditCents,
      unpaid: Boolean(paymentDue),
      outstandingCents: outstandingBalance?.amountCents ?? 0,
    }),
    options?.appliedCredit?.settlementMethod ?? "card",
  ).map((row) => ({
    // Labels and formatted money only — no club- or member-entered data — but
    // escaped at this HTML edge on the same principle as the promo rows above.
    label: escapeHtml(row.label),
    value: escapeHtml(row.value),
  }));
  // #2483: what an unpaid member is really being asked for, netted from the
  // club's own credit ledger by the SHARED resolver the sender uses, so the
  // table and the {{paymentOutcome}} block cannot disagree about the figure.
  const unpaidNetting = resolveUnpaidCreditNetting({
    totalCents,
    appliedCreditCents,
  });
  if (paymentDue) {
    // One "Total Due" row when no credit applies (byte-for-byte the pre-#2483
    // email), the reconciling trio when it does, and a bare "Booking Total"
    // when the ledger contradicts the price — from the shared builder, escaped
    // at this HTML edge on the same principle as the rows above.
    for (const row of unpaidMoneySummaryRows(totalCents, unpaidNetting)) {
      rows.push({ label: escapeHtml(row.label), value: escapeHtml(row.value) });
    }
  } else if (outstandingBalance) {
    rows.push(
      { label: "Booking Total", value: formatCents(totalCents) },
      {
        label: "Paid",
        value: formatCents(totalCents - outstandingBalance.amountCents),
      },
      // Between "Paid" and "Still Owing": the credit pair breaks down the
      // amount immediately above it, and the balance still owing stays last.
      ...creditRows,
      { label: "Still Owing", value: formatCents(outstandingBalance.amountCents) },
    );
  } else {
    rows.push({ label: "Total Paid", value: formatCents(totalCents) }, ...creditRows);
  }

  // One composed paragraph, from the SHARED composer the {{paymentDueNote}}
  // token in sendBookingConfirmedEmail is built from, so an operator override
  // tells the same story — including the #2444 account-credit sentence, which
  // must never appear on one renderer and not the other. The reference is
  // club-entered data, so it is escaped at this HTML edge (the composer takes
  // it already escaped, on the same principle as the shared money rows above).
  // #2483: the amount is what the member must TRANSFER, so it is netted; the
  // arithmetic behind it goes in the paragraph in words, for a body that
  // renders {{paymentDueNote}} without the money table beside it. The paragraph
  // shape comes from the SAME netting the rows above were built from, via the
  // shared adapter, so the table and the prose can never disagree about whether
  // this member is being asked for money at all.
  const paymentDueNote = paymentDue
    ? bookingPaymentDueNote({
        amount: formatCents(unpaidNetting.toTransferCents),
        reference: escapeHtml(paymentDue.reference),
        invoiceEmailed: paymentDue.invoiceEmailed,
        accountCredit: unpaidCreditNoteInput(
          totalCents,
          unpaidNetting,
          formatCents,
        ),
      })
    : "";
  // #2397, same convention: one composed sentence shared with the token path.
  const outstandingBalanceNote = outstandingBalance
    ? `Your payment of ${formatCents(totalCents - outstandingBalance.amountCents)} has been recorded and your booking is confirmed. ${formatCents(outstandingBalance.amountCents)} is still owing from a later change to this booking.` +
      (outstandingBalance.payableOnline
        ? " You can pay it from your booking page."
        : " The club will be in touch to arrange it.")
    : "";

  return layout(`
    ${heading("Booking Confirmed")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been confirmed!")}
    ${infoTable(rows)}
    ${
      paymentDue
        ? alertBox(paymentDueNote, "warning")
        : outstandingBalance
          ? alertBox(outstandingBalanceNote, "warning")
          : alertBox("Payment has been processed successfully.", "success")
    }
    ${provisionalSection}
    ${arrivalInstructionsSection({
      travelNote: options?.lodgeTravelNote ?? CLUB_LODGE_TRAVEL_NOTE,
      doorCode: options?.doorCode ?? null,
    })}
    ${paragraph("You can view your booking details and manage your stay from your account.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function bookingPendingTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date
): string {
  return layout(`
    ${heading("Booking Pending")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been received and is currently pending.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
      { label: "Hold Until", value: formatNZDateTime(holdUntil) },
    ])}
    ${alertBox("Your booking includes non-member guests and will be held as pending until " + formatNZDateTime(holdUntil) + ".", "warning")}
    ${paragraph("During this time, club members have priority. If the lodge fills up with member bookings, your booking may be bumped. <strong>Your card will only be charged when the booking is confirmed.</strong>")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/**
 * A member's booking-policy exception request was approved and the booking now
 * exists (#2526).
 *
 * Why this template has to exist at all: an approved NEW-booking exception
 * normally lands on PAYMENT_PENDING, and the canonical create service emails only
 * a $0 confirmation or a non-member hold notice — a member using the wizard learns
 * what to pay because they are standing in it and get redirected to checkout.
 * Nobody is standing in anything here: the member asked days ago and an officer
 * decided while they were elsewhere. Without this notice the member is never told
 * they have a booking, never sees what to pay, and PAYMENT_PENDING holds no beds,
 * so the stay can be lost without them ever knowing they had it.
 */
export function bookingPolicyExceptionApprovedTemplate(args: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  paymentNote: string;
  adminNotesLine: string;
}): string {
  return layout(`
    ${heading("Your Request Was Approved")}
    ${paragraph("Hi " + escapeHtml(args.firstName) + ", an administrator has approved your request and your booking is now in place.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(args.checkIn) },
      { label: "Check-out", value: formatNZDate(args.checkOut) },
      { label: "Guests", value: String(args.guestCount) },
    ])}
    ${args.paymentNote ? alertBox(escapeHtml(args.paymentNote), "warning") : ""}
    ${args.adminNotesLine ? paragraph(escapeHtml(args.adminNotesLine)) : ""}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/**
 * "Your request was not approved" — the refusal notice (#2562 review).
 *
 * THE GAP THIS CLOSES. The refusal branch recorded the officer's member-facing
 * explanation, wrote the audit row, released any held beds — and told the member
 * nothing. No email, no notification: this app has no in-app notification centre,
 * so their only signal was a badge on My Bookings they would have to go looking
 * for. The predictable next act is the telephone call the whole workflow exists to
 * remove, or a duplicate request raised in ignorance days later.
 *
 * THE EXPLANATION IS THE POINT. `adminNotes` is mandatory on a refusal precisely
 * so the member can act on it, and a mandatory explanation nobody delivers is a
 * refusal with no reason attached. It arrives as a pre-composed line because the
 * render path has no conditional syntax.
 *
 * NO BOOKING BUTTON, deliberately. The canonical authorized booking-detail link is
 * gated on `ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES`, whose contract is that every
 * sender of a member template hands over a real booking id — and a refused
 * NEW-booking request has no booking at all, so this template cannot honestly join
 * that set. Claiming membership to win a button would make the set's own statement
 * false and would stop the retry cron replaying a failed new-booking refusal. So
 * the notice names where to look instead, which is the same place for both
 * flavours.
 *
 * NO MONEY, because none moved, and NO APOLOGY: an officer exercised the
 * discretion the member was told about when they asked.
 */
export function bookingPolicyExceptionRefusedTemplate(args: {
  firstName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  /** The officer's member-facing explanation, as a whole composed line. */
  reasonLine: string;
  /** What the request had been asking for, in one clause. */
  askDescription: string;
}): string {
  return layout(`
    ${heading("Your request was not approved")}
    ${paragraph("Hi " + escapeHtml(args.firstName) + ", a Booking Officer has looked at " + escapeHtml(args.askDescription) + " at " + escapeHtml(args.lodgeName) + " and decided not to allow it this time.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(args.checkIn) },
      { label: "Check-out", value: formatNZDate(args.checkOut) },
    ])}
    ${args.reasonLine ? alertBox(escapeHtml(args.reasonLine), "info") : ""}
    ${paragraph("Nothing was booked and nothing was changed. Any beds this request was holding have gone back into the pool.")}
    ${paragraph("You can ask again with different dates or a different party. Your requests are listed under My booking-rule requests on your My Bookings page.")}
    ${supportContactSentence("If you would like to talk it through, contact the club at ")}
  `);
}

export function bookingBumpedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  // #2430: whether this recipient can actually use the member booking flow.
  // A non-login NON_MEMBER/SCHOOL contact (a converted public booking request,
  // or an admin booking on their behalf) is pointed at the club contact page
  // instead of a login they can never complete. REQUIRED, with no default: the
  // leaky value is `true`, so a new send site that forgot this argument would
  // silently mail a login-less contact a members-only link (#2430 review).
  recipientCanBookOnline: boolean
): string {
  const rebook = bookingBumpedRebookAction(recipientCanBookOnline);
  return layout(`
    ${heading("Booking Update")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", unfortunately your pending lodge booking has been bumped due to member demand.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
    ])}
    ${alertBox("Your card has not been charged.", "info")}
    ${paragraph("As a non-member booking, priority is given to club members when the lodge reaches capacity. You're welcome to rebook for different dates where availability exists.")}
    ${button(rebook.label, BASE_URL + rebook.path)}
    ${supportContactSentence("If you have any questions, contact the club at ")}
    ${muted("We apologise for the inconvenience.")}
  `);
}

export function bookingCancelledTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  refundCents: number,
  // B5 (#2262): "manual" is a cash / off-Xero settlement being handed back by a
  // person. It must NEVER read as "on its way to your card" (no card was
  // charged) nor as account credit (none was minted — a hand-back task was
  // raised instead), so it gets its own honest copy.
  refundMethod: "card" | "credit" | "manual" = "card",
  creditRestoredCents: number = 0
): string {
  let refundInfo: string;
  if (refundCents > 0 && refundMethod === "manual") {
    refundInfo = alertBox(
      "You paid for this booking in cash or by bank transfer, so there is no card payment to reverse. The club will arrange your refund of " +
        formatCents(refundCents) +
        " directly and will be in touch.",
      "info"
    );
  } else if (refundCents > 0 && refundMethod === "credit") {
    refundInfo = alertBox(
      "A credit of " + formatCents(refundCents) + " has been added to your account for future bookings.",
      "success"
    );
  } else if (refundCents > 0) {
    refundInfo = alertBox(
      "A refund of " + formatCents(refundCents) + " has been processed to your original payment method.",
      "success"
    );
  } else {
    refundInfo = alertBox("No refund was applicable based on the cancellation policy.", "info");
  }

  // #1164 / D7: the account credit originally applied to this booking is now
  // restored subject to the same cancellation policy as the card slice, so a
  // late cancellation may restore less than the full amount applied.
  const creditRestoredInfo =
    creditRestoredCents > 0
      ? alertBox(
          formatCents(creditRestoredCents) +
            " of previously applied account credit has been restored to your account (per the cancellation policy).",
          "success"
        )
      : "";

  return layout(`
    ${heading("Booking Cancelled")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge booking has been cancelled.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${refundInfo}
    ${creditRestoredInfo}
    ${paragraph("You can make a new booking at any time from your account.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}

export function bookingGuestsCancelledTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date
): string {
  return layout(`
    ${heading("Booking Cancelled")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", you asked us to cancel your whole booking if your non-member guests couldn't come. The lodge filled up with member bookings, so we've cancelled it.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${alertBox("Your card has not been charged.", "info")}
    ${paragraph("You're welcome to rebook for different dates where availability exists.")}
    ${button("Book Again", BASE_URL + "/book")}
  `);
}

export function bookingReviewApprovedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  adminNotes: string,
  bookingId: string,
): string {
  return layout(`
    ${heading("Booking Approved")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", an admin has approved your booking. You can now complete payment to confirm it.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${adminNotes ? alertBox("Note from admin: " + escapeHtml(adminNotes), "info") : ""}
    ${button("Complete Payment", BASE_URL + "/bookings/" + bookingId)}
  `);
}

export function bookingReviewRejectedTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  adminNotes: string,
): string {
  return layout(`
    ${heading("Booking Declined")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", an admin has reviewed your booking and was not able to approve it. The booking has been cancelled — no payment was taken.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
    ])}
    ${adminNotes ? alertBox("Reason from admin: " + escapeHtml(adminNotes), "warning") : ""}
    ${paragraph("You are welcome to make a new booking that includes an adult guest, or contact the club to discuss.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}

export function emailVerificationTemplate(
  firstName: string,
  verifyUrl: string,
  expiresAt: Date
): string {
  const name = escapeHtml(firstName);
  return layout(`
    ${heading("Verify Your Email")}
    ${paragraph(`Hi ${name}, thanks for creating your ${escapeHtml(CLUB_NAME)} booking account!`)}
    ${paragraph("Please verify your email address by clicking the button below.")}
    ${button("Verify Email", verifyUrl)}
    ${muted("This link expires on " + escapeHtml(formatNZDateTime(expiresAt)) + ". If you did not create this account, please ignore this email.")}
  `);
}

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
    ${muted("This link expires on " + escapeHtml(formatNZDateTime(params.expiresAt)) + ".")}
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

export function emailChangeVerificationTemplate(
  newEmail: string,
  verifyUrl: string,
  expiresAt: Date
): string {
  return layout(`
    ${heading("Confirm Your New Email")}
    ${paragraph(`You requested to change the email address on your ${escapeHtml(CLUB_NAME)} account to <strong>${escapeHtml(newEmail)}</strong>.`)}
    ${paragraph("Click the button below to confirm this change.")}
    ${button("Confirm Email Change", verifyUrl)}
    ${muted("This link expires on " + escapeHtml(formatNZDateTime(expiresAt)) + ". If you did not request this change, please ignore this email.")}
  `);
}

export function emailChangeNotificationTemplate(newEmail: string): string {
  return layout(`
    ${heading("Email Change Requested")}
    ${paragraph(`Someone requested to change the email address on your ${escapeHtml(CLUB_NAME)} account to <strong>${escapeHtml(newEmail)}</strong>.`)}
    ${alertBox("If this wasn't you, please contact the club immediately.", "warning")}
    ${muted("If you made this request, you can safely ignore this email. The change will only take effect after verification.")}
  `);
}

/**
 * Chore-roster date: the deliberate long-weekday form ("Thursday, 16 April
 * 2026") the roster emails have always used, NOT the house `formatNZDate`
 * medium form. `date` is a lodge-night date-only string; parsing it with the
 * `T00:00:00` suffix pins it to local midnight, which round-trips back to the
 * same calendar date when formatted without a `timeZone` override. Do not
 * change the format — subject line and body must stay identical, which is why
 * this lives here and is shared with `src/lib/email/chores.ts` (#2256).
 */
export function formatChoreRosterDate(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString(
    "en-NZ",
    { weekday: "long", year: "numeric", month: "long", day: "numeric" }
  );
}

export function choreRosterTemplate(
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string
): string {
  const formattedDate = formatChoreRosterDate(date);

  const choreRows = chores.map((c) => ({
    label: escapeHtml(c.name),
    value: c.description ? escapeHtml(c.description) : "",
  }));

  const linkSection = choreLink
    ? `${button("Mark Chores Complete", choreLink)}${muted("Use this link to mark your chores as done from your phone. Link expires in 48 hours.")}`
    : "";

  return layout(`
    ${heading("Chore Roster")}
    ${paragraph("Hi " + escapeHtml(guestName) + ",")}
    ${paragraph("Here are your assigned chores for <strong>" + escapeHtml(formattedDate) + "</strong> at the lodge:")}
    ${infoTable(choreRows)}
    ${linkSection}
    ${alertBox("Last person to bed: Check heaters and fire are safe and doors are secure.", "warning")}
    ${muted("Thanks for helping keep the lodge running smoothly!")}
  `);
}

export function hutLeaderAssignmentTemplate(params: {
  firstName: string;
  startDate: Date;
  endDate: Date;
  pin: string;
  assignmentId: string;
}): string {
  const p = emailPalette();
  return layout(`
    ${heading(`${CLUB_HUT_LEADER_LABEL} Assignment`)}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", thanks for taking on " + CLUB_HUT_LEADER_LABEL.toLowerCase() + " duties for the lodge.")}
    ${infoTable([
      { label: "Start date", value: formatNZDate(params.startDate) },
      { label: "End date", value: formatNZDate(params.endDate) },
      { label: "Kiosk PIN", value: `<strong style="font-size: 18px; letter-spacing: 2px;">${escapeHtml(params.pin)}</strong>` },
    ])}
    ${paragraph(`When you arrive, open the lodge kiosk and use this PIN to unlock ${CLUB_HUT_LEADER_LABEL.toLowerCase()} controls for arrivals, departures, and roster management.`)}
    ${alertBox(`Please keep this PIN private and share it only with the assigned ${CLUB_HUT_LEADER_LABEL.toLowerCase()} team for these dates.`, "warning")}
    ${paragraph("Responsibilities include checking the lodge list, helping guests settle in, marking arrivals and departures, and making sure the daily chore roster is set up and completed.")}
    ${paragraph(`Before your stay, please read the <a href="${escapeHtml(BASE_URL + "/hut-leader-instructions?a=" + encodeURIComponent(params.assignmentId))}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: underline;">lodge instructions</a> covering opening, closing, and day-to-day running of the lodge — open the link and enter your kiosk PIN above to view them (no login needed).`)}
    ${button("Open Lodge View", BASE_URL + "/lodge")}
    ${muted("If you have any issues accessing the kiosk, please contact a club administrator.")}
  `);
}

// ---- N-01: Check-in Reminder ----

export function checkinReminderTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guests: Array<{ firstName: string; lastName: string }>,
  chores: Array<{ name: string; description: string | null }>
): string {
  const p = emailPalette();
  const guestListHtml = guests
    .map((g) => `<li style="padding: 4px 0; color: ${p.deep}; font-size: 14px;">${escapeHtml(g.firstName)} ${escapeHtml(g.lastName)}</li>`)
    .join("");

  const choreSection = chores.length > 0
    ? `${paragraph("<strong>Your arrival day chores:</strong>")}${infoTable(chores.map((c) => ({ label: escapeHtml(c.name), value: c.description ? escapeHtml(c.description) : "" })))}`
    : "";

  return layout(`
    ${heading("Check-in Reminder")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your lodge stay begins <strong>tomorrow</strong>!")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guests.length) },
    ])}
    ${paragraph("<strong>Guest list:</strong>")}
    <ul style="margin: 0 0 16px 0; padding-left: 20px;">${guestListHtml}</ul>
    ${choreSection}
    ${alertBox("Please ensure you arrive prepared for alpine conditions. Check the weather forecast before departing.", "info")}
    ${paragraph(CLUB_LODGE_TRAVEL_NOTE)}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

export function preArrivalReminderTemplate(params: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expectedArrivalTime?: string | null;
  lodgeTravelNote: string;
  doorCode?: string | null;
  // #2350: extra still owing on this booking after an upward change, when the
  // stay is about to start and it has not been collected. Zero/absent for the
  // ordinary case, which renders exactly as before.
  outstandingAdditionalAmountCents?: number;
  // #2621 (owner decision D-M5): the checkout-day chore sentence, composed by
  // the sender with `checkoutDayChoreNote` and EMPTY for a club that does not
  // run a chore roster — the chores module defaults OFF. Handed in rather than
  // written here so this HTML and the admin-editable body's
  // {{checkoutChoreNote}} cannot say different things (the
  // {{namingUrgencyNote}} convention). Omitted reads as empty, which is the
  // fail-quiet direction: a member never sees a roster instruction the club may
  // not mean.
  checkoutChoreNote?: string;
}): string {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Check-in", value: formatNZDate(params.checkIn) },
    { label: "Check-out", value: formatNZDate(params.checkOut) },
    { label: "Guests", value: String(params.guestCount) },
  ];

  if (params.expectedArrivalTime) {
    rows.push({
      label: "Expected arrival",
      value: escapeHtml(params.expectedArrivalTime),
    });
  }

  return layout(`
    ${heading("Upcoming Lodge Stay")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", your lodge stay is coming up.")}
    ${infoTable(rows)}
    ${params.checkoutChoreNote ? paragraph(escapeHtml(params.checkoutChoreNote)) : ""}
    ${outstandingAdditionalPaymentNote(params.outstandingAdditionalAmountCents)}
    ${arrivalInstructionsSection({
      travelNote: params.lodgeTravelNote,
      doorCode: params.doorCode,
    })}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/**
 * The one-line "there is still money owing on this booking" block (#2350),
 * shared by the pre-arrival reminder and the standalone additional-payment
 * reminder so both say the same thing in the same words. Empty for a booking
 * with nothing outstanding, so the surrounding template is unchanged.
 */
function outstandingAdditionalPaymentNote(amountCents: number | undefined): string {
  if (!amountCents || amountCents <= 0) return "";
  return alertBox(
    `There is still ${formatCents(amountCents)} to pay on this booking after a change to your stay. Please pay it from your booking page before you arrive.`,
    "warning",
  );
}

/**
 * F-#2350: standalone reminder that an additional payment raised by a booking
 * change has not been collected. Sent automatically a few days after the change
 * and again shortly before check-in, and by an admin on demand from the booking
 * page. Carries no token or link secret, so its rendered body is retained
 * normally.
 */
export function additionalPaymentReminderTemplate(params: {
  firstName: string;
  additionalAmountCents: number;
  checkIn: Date;
  checkOut: Date;
  requestedOn: Date;
}): string {
  return layout(`
    ${heading("Payment Still Needed")}
    ${paragraph("Hi " + escapeHtml(params.firstName) + ", a change to your lodge booking increased the total, and the extra amount has not been paid yet.")}
    ${infoTable([
      { label: "Amount still to pay", value: formatCents(params.additionalAmountCents) },
      { label: "Requested on", value: formatNZDate(params.requestedOn) },
      { label: "Check-in", value: formatNZDate(params.checkIn) },
      { label: "Check-out", value: formatNZDate(params.checkOut) },
    ])}
    ${alertBox(
      "Open your booking and complete the outstanding payment. If you have already paid, or you think this is wrong, please contact the club.",
      "warning",
    )}
    ${button("Pay Now", BASE_URL + "/bookings")}
  `);
}

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
    { label: "Check-in", value: formatNZDate(data.checkIn) },
    { label: "Check-out", value: formatNZDate(data.checkOut) },
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
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
        value: data.nights.map((night) => formatNZDate(night)).join(", "),
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
    ])}
    ${button("Review Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-04: Admin Alert — Payment Failure ----

export function adminPaymentFailureTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  errorMessage: string;
  /**
   * The searchable identifier for whatever raised this alert. USUALLY a Stripe
   * payment intent id — but this template is the club's general payment-anomaly
   * alert and its senders also pass a Xero invoice id, or (on the cash /
   * off-Xero mark-paid, which has neither by definition) the booking id. The
   * row is therefore labelled "Reference", not "Stripe PI": a label that names
   * the wrong system sends an officer hunting in Stripe for something that was
   * never there. The parameter keeps its historical name because every caller
   * uses it.
   */
  paymentIntentId: string;
}): string {
  return layout(`
    ${heading("Payment Failed")}
    ${alertBox("A payment has failed and may require manual attention.", "warning")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Amount", value: formatCents(data.amountCents) },
      { label: "Error", value: escapeHtml(data.errorMessage) },
      { label: "Reference", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("View Payments", BASE_URL + "/admin/payments")}
  `);
}

/**
 * #1992 / #2007 — dedicated admin alert for the duplicate-capture auto-refund.
 * A SECOND, distinct Stripe capture arrived on a booking already settled by a
 * different intent (the residual #1967 split-child window), so the duplicate
 * charge is auto-refunded. This replaces the generic payment-anomaly template on
 * both outcomes so the copy states the real situation instead of reading as a
 * payment failure. `refundFailed` selects the variant (one-template-with-boolean
 * precedent, like adminSplitSettlementUnpaidTemplate's parentUnpaid):
 * - false: the duplicate charge was refunded in full inline — no action needed;
 * - true: the inline refund could not complete, a durable recovery operation is
 *   queued and the recovery cron will retry it — watch the recovery queue.
 * No bearer token, so this is not sensitive-log material.
 */

export function adminDuplicateCaptureRefundTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  settledPaymentIntentId: string | null;
  operationReference: string;
  errorMessage?: string | null;
  reviewUrl: string;
  refundFailed: boolean;
}): string {
  const settledBy = data.settledPaymentIntentId
    ? escapeHtml(data.settledPaymentIntentId)
    : "another capture";
  return layout(`
    ${heading(
      data.refundFailed
        ? "Duplicate Capture Auto-Refund Failed — Retry Queued"
        : "Duplicate Card Capture Auto-Refunded"
    )}
    ${
      data.refundFailed
        ? alertBox(
            "A duplicate card charge could not be automatically refunded. A durable retry is queued — watch the recovery queue and confirm the refund lands.",
            "warning"
          )
        : alertBox(
            "A duplicate card charge was automatically refunded in full — no action is needed.",
            "success"
          )
    }
    ${
      // Static developer-authored copy (no member data), so it is emitted raw
      // exactly as before — the shared helper only removes the duplication.
      paragraph(duplicateCaptureRefundOutcomeParagraph(data.refundFailed))
    }
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      {
        label: data.refundFailed ? "Amount to refund" : "Amount refunded",
        value: formatCents(data.amountCents),
      },
      { label: "Duplicate Stripe PI", value: escapeHtml(data.paymentIntentId) },
      { label: "Settled by", value: settledBy },
      {
        label: "Recovery operation",
        value: escapeHtml(data.operationReference),
      },
      ...(data.refundFailed && data.errorMessage
        ? [{ label: "Failure detail", value: escapeHtml(data.errorMessage) }]
        : []),
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * #2761 — the admin alert for an automatically refunded late capture.
 *
 * WHY IT IS NOT `adminPaymentFailureTemplate`. That template's heading is
 * "Payment Failed" and its alert box says a payment "has failed and may require
 * manual attention". Neither is true here: Stripe captured a booking-change
 * payment after the booking was already cancelled, and the money went straight
 * back to the member. An operator who filters or skims "Payment Failed" mail
 * triages this as noise, which is exactly what #2761 was filed about.
 *
 * IT NAMES WHICH POPULATION IT IS, because the two need different follow-up. On a
 * DELETED booking, deleting it may have been the mistake, and putting that right
 * means remaking the booking and charging the member again — the refund has gone.
 * On a booking that is merely cancelled, the refund is normally the expected
 * outcome and there is usually nothing to do at all. `bookingDeleted` selects the
 * wording (the one-template-with-boolean precedent used by
 * `adminDuplicateCaptureRefundTemplate`), so there is still exactly ONE
 * notification for this event (`INV-ADDPAY-037`).
 *
 * No bearer token and no member address, so this is not sensitive-log material.
 */
export function adminLateCaptureAutoRefundTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  bookingId: string;
  bookingDeleted: boolean;
  /**
   * #2773: which capture this was. The copy used to hard-code "a booking-change
   * payment" and "the supplementary Xero invoice", which are both false about a
   * booking's OWN payment — so routing the second late-capture handler through
   * this template unchanged would have misdescribed the event.
   */
  captureKind: "modification" | "primary";
  reviewUrl: string;
}): string {
  // #2773: sentence-initial, so the shared label is capitalised here and nowhere
  // else — the label itself stays a bare noun phrase for mid-sentence use.
  const paymentLabel = lateCapturePaymentLabel(data.captureKind);
  const capitalisedPaymentLabel =
    paymentLabel.charAt(0).toUpperCase() + paymentLabel.slice(1);
  return layout(`
    ${heading(
      data.bookingDeleted
        ? "Payment Refunded Automatically — Booking Already Deleted"
        : "Payment Refunded Automatically — Booking Already Cancelled"
    )}
    ${alertBox(
      `${capitalisedPaymentLabel} was captured after the booking had already been ${
        data.bookingDeleted ? "deleted" : "cancelled"
      }. It has been refunded in full automatically — there is nothing to pay back.`,
      "success"
    )}
    ${
      // The SAME paragraph the {{lateCaptureLeadNote}} token renders, so an
      // admin's saved default cannot describe a different capture — or a
      // different Xero consequence — from the mail (#2268 convention, #2773).
      paragraph(lateCaptureAutoRefundLeadParagraph(data.captureKind))
    }
    ${
      // The SAME sentence the {{refundOutcomeNote}} token renders in the
      // admin-editable body (#2268 convention): one source, so the hand-built
      // HTML and an admin's default can never say different things about which
      // population this was. Developer-authored copy with no member data in it,
      // so it is emitted raw exactly like its duplicate-capture sibling.
      paragraph(lateCaptureAutoRefundOutcomeParagraph(data.bookingDeleted))
    }
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Amount refunded", value: formatCents(data.amountCents) },
      {
        label: "Booking status",
        value: data.bookingDeleted
          ? "Cancelled and deleted"
          : "Cancelled, still on file",
      },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Stripe PI", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * #2774 — the alert for a late capture that collided with a hand-back an operator
 * had already made. Two directions, one template.
 *
 * WHY IT IS NOT `adminLateCaptureAutoRefundTemplate` WITH A FLAG. That template's
 * heading is "Payment Refunded Automatically" and its alert box says the money has
 * gone back and there is nothing to pay back. On the withheld arm every one of
 * those statements is false, and on the double-payment arm "there is nothing to pay
 * back" is the opposite of the truth. A boolean that has to rewrite the heading,
 * the alert box, the lead paragraph and the subject is not a variant — it is a
 * different mail wearing the same registry key, which would also mean one
 * admin-editable body having to be correct about a refund that happened AND one
 * that did not. Its own entry, for the same reason `admin-late-capture-auto-refund`
 * is not a variant of `admin-payment-failure` (`INV-ADDPAY-038`).
 *
 * WHY THE TWO DIRECTIONS *DO* SHARE ONE TEMPLATE. They are one situation — an
 * operator's hand-back and an automatic refund both claiming the same capture — and
 * the reader's job is the same on both: reconcile this capture against that
 * hand-back. `refundSent` selects the sentence that says which way the money went,
 * composed once in `lateCaptureHandBackConflictOutcomeParagraph` and shared with
 * the `{{handBackConflictNote}}` token. That is the
 * `adminDuplicateCaptureRefundTemplate` / `refundFailed` precedent applied exactly.
 *
 * `warning` on both arms rather than a new `error` colour: the shared `alertBox`
 * primitive offers info/warning/success, and adding a fourth colour for one
 * template would change a primitive every other mail depends on to carry a
 * distinction the heading, the box's own words and the outcome paragraph already
 * state in full.
 *
 * No bearer token and no member address, so this is not sensitive-log material.
 */
export function adminLateCaptureHandBackConflictTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  paymentIntentId: string;
  bookingId: string;
  bookingDeleted: boolean;
  captureKind: "modification" | "primary";
  /**
   * The amount the operator's own hand-back task recorded, in integer cents, when
   * it is known. Printed so a reader can see whether the hand-back covered the
   * whole capture — nothing here refunds a difference. `null` on the
   * double-payment arm, which is detected from the record writer's outcome after
   * the refund and does not re-read the row.
   */
  handBackAmountCents: number | null;
  refundSent: boolean;
  reviewUrl: string;
}): string {
  const paymentLabel = lateCapturePaymentLabel(data.captureKind);
  return layout(`
    ${heading(
      data.refundSent
        ? "Payment May Have Been Refunded Twice — Reconcile By Hand"
        : "Automatic Refund Withheld — Already Paid Back By Hand"
    )}
    ${alertBox(
      data.refundSent
        ? `${paymentLabel.charAt(0).toUpperCase() + paymentLabel.slice(1)} was refunded automatically at the same moment an operator recorded paying it back by hand. The member may have been paid twice — please reconcile.`
        : `${paymentLabel.charAt(0).toUpperCase() + paymentLabel.slice(1)} was captured after the booking had already been ${
            data.bookingDeleted ? "deleted" : "cancelled"
          }, and an operator had already paid it back by hand. The automatic refund was NOT sent — please confirm the hand-back.`,
      "warning"
    )}
    ${
      // The SAME sentence the {{handBackConflictNote}} token renders, so an
      // admin's saved default cannot tell an operator the money went out when it
      // did not, or the reverse (#2268 convention).
      paragraph(lateCaptureHandBackConflictOutcomeParagraph(data.refundSent))
    }
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Amount captured", value: formatCents(data.amountCents) },
      ...(data.handBackAmountCents === null
        ? []
        : [
            {
              label: "Recorded as paid back by hand",
              value: formatCents(data.handBackAmountCents),
            },
          ]),
      {
        label: "Automatic refund sent",
        value: data.refundSent ? "Yes — on top of the hand-back" : "No",
      },
      {
        label: "Booking status",
        value: data.bookingDeleted
          ? "Cancelled and deleted"
          : "Cancelled, still on file",
      },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Stripe PI", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

// ---- B5 (#2262): Admin Alert — manual settlement vs inbound Xero PAID ----
//
// The reciprocal fence. The club appears to hold BOTH a cash settlement this
// system recorded and a bank transfer Xero reports against the same booking.
// This is money that must be reconciled by a human — the pipeline deliberately
// writes nothing further, so the alert is the whole remediation path.
export function adminManualSettlementConflictTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  bookingId: string;
  bookingStatus: string;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Cash Settlement vs Xero Payment — Reconcile By Hand")}
    ${alertBox(
      "This booking looks paid TWICE: once as a cash / off-Xero settlement recorded here, and again by a payment Xero now reports against its invoice. Nothing further has been written — please reconcile.",
      "warning"
    )}
    ${paragraph(
      "An admin recorded this booking's payment manually (cash, or a bank transfer that never reached Xero). Xero has since reported the booking's invoice as PAID. The system stopped rather than settling it a second time or minting member credit, so the two records now disagree and only a person can decide which money is real."
    )}
    ${paragraph(
      "Check whether the Xero payment is genuinely separate funds — a second payment that needs refunding — or the same money reaching Xero late. Reverse the manual settlement, or refund the duplicate, whichever is true."
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Booking status", value: escapeHtml(data.bookingStatus) },
      { label: "Amount recorded as cash", value: formatCents(data.amountCents) },
      {
        label: "Xero invoice",
        value: data.xeroInvoiceNumber
          ? escapeHtml(data.xeroInvoiceNumber)
          : "unknown",
      },
    ])}
    ${
      data.xeroInvoiceUrl
        ? button("Open the invoice in Xero", data.xeroInvoiceUrl)
        : ""
    }
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}

// ---- B5 (#2262): Admin Alert — manual refund task raised ----
//
// A cash-settled booking was cancelled. There is no card to refund and no Xero
// credit note to raise, so the money has to be handed back by a person. The
// task is durable; this alert is the nudge, not the record.
export function adminManualRefundTaskTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  refundAmountCents: number;
  bookingId: string;
  reason: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Manual Refund Needed — Cash Booking Cancelled")}
    ${alertBox(
      "A booking settled in cash (or by an off-Xero bank transfer) has been cancelled. The refund has to be paid back by hand — nothing was refunded automatically.",
      "warning"
    )}
    ${paragraph(
      "The member's cancellation refund has been worked out under the club's normal policy, but there is no card charge to reverse and no Xero invoice to credit, so the system has raised a hand-back task instead of pretending money moved. The member has been told the club will arrange the refund."
    )}
    ${paragraph(
      "Pay the member back, then mark the task complete on the payments board so the ledger records the refund. If the member declines it, or it was settled another way, dismiss the task with a note."
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Amount to refund", value: formatCents(data.refundAmountCents) },
      { label: "Reason", value: escapeHtml(data.reason) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
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
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatNZDate(b.checkIn)} – ${formatNZDate(b.checkOut)}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${b.guestCount}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatNZDateTime(b.deadline)}</td>
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Triggered By", value: escapeHtml(data.triggeringMemberName) },
    ])}
    ${button("View Bookings", BASE_URL + "/admin/bookings")}
  `);
}

// ---- N-05: Admin Alert — Xero Sync Error ----

export function adminXeroSyncErrorTemplate(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
  timestamp: Date;
}): string {
  return layout(`
    ${heading("Xero Sync Error")}
    ${alertBox("A Xero integration error occurred and may require attention.", "warning")}
    ${infoTable([
      { label: "Error Type", value: escapeHtml(data.errorType) },
      { label: "Operation", value: escapeHtml(data.operation) },
      { label: "Error Message", value: escapeHtml(data.errorMessage) },
      { label: "Timestamp", value: formatNZDateTime(data.timestamp) },
    ])}
    ${button("View Xero Status", BASE_URL + "/admin/xero")}
  `);
}

export function adminXeroRepeatedFailureTemplate(data: {
  correlationKey: string;
  failureCount: number;
  windowHours: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectUrl: string | null;
  latestErrorMessage: string | null;
  timestamp: Date;
}): string {
  const p = emailPalette();
  const infoRows = [
    { label: "Correlation Key", value: escapeHtml(data.correlationKey) },
    {
      label: "Failures in Window",
      value: `${data.failureCount} in the last ${data.windowHours} hour${data.windowHours === 1 ? "" : "s"}`,
    },
    { label: "Entity", value: escapeHtml(data.entityType) },
    { label: "Operation", value: escapeHtml(data.operationType) },
    {
      label: "Local Record",
      value:
        data.localModel && data.localId
          ? escapeHtml(`${data.localModel} ${data.localId}`)
          : "Unavailable",
    },
    {
      label: "Latest Error",
      value: escapeHtml(data.latestErrorMessage ?? "Unavailable"),
    },
    {
      label: "Timestamp",
      value: formatNZDateTime(data.timestamp),
    },
  ];

  const links: string[] = [];
  if (data.localUrl) {
    links.push(`<a href="${escapeHtml(BASE_URL + data.localUrl)}" style="color: ${p.gold}; text-decoration: underline;">Open local record</a>`);
  }
  if (data.xeroObjectUrl) {
    links.push(`<a href="${escapeHtml(data.xeroObjectUrl)}" style="color: ${p.gold}; text-decoration: underline;">Open Xero object</a>`);
  }

  return layout(`
    ${heading("Repeated Xero Failures")}
    ${alertBox("The same Xero sync correlation key has failed repeatedly and now needs operator attention.", "warning")}
    ${infoTable(infoRows)}
    ${links.length > 0 ? paragraph(links.join(" &nbsp;|&nbsp; ")) : ""}
    ${button("Open Xero Admin", BASE_URL + "/admin/xero")}
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
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatNZDate(d.date)}</td>
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

// ---- N-09: Bulk Member Communication ----

export function bulkCommunicationTemplate(
  subject: string,
  body: string
): string {
  const p = emailPalette();
  return layout(`
    ${heading(escapeHtml(subject))}
    <div style="color: ${p.deep}; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(body)}</div>
    ${muted(`This email was sent to you by the ${escapeHtml(CLUB_NAME)} administration. You can update your email preferences in your account settings.`)}
    ${button("Manage Preferences", BASE_URL + "/profile")}
  `);
}

// ---- Member notice published ----

export function noticePublishedTemplate(
  firstName: string,
  noticeTitle: string,
  noticeUrl: string
): string {
  const p = emailPalette();
  return layout(`
    ${heading("New notice from the committee")}
    <p style="color: ${p.deep}; font-size: 15px; line-height: 1.6;">Hi ${escapeHtml(firstName)},</p>
    <p style="color: ${p.deep}; font-size: 15px; line-height: 1.6;">The ${escapeHtml(CLUB_NAME)} committee has posted a new notice:</p>
    <p style="color: ${p.deep}; font-size: 17px; font-weight: 600; line-height: 1.5;">${escapeHtml(noticeTitle)}</p>
    ${button("Read the notice", noticeUrl)}
    ${muted(`You are receiving this because you opted in to club communications. You can update your email preferences in your account settings.`)}
    ${button("Manage Preferences", BASE_URL + "/profile")}
  `);
}

// ---- N-13: Admin Daily Digest ----

export function adminDailyDigestTemplate(sections: {
  newBookings: number;
  paymentFailures: number;
  capacityWarnings: number;
  bookingsBumped: number;
  pendingDeadlines: number;
  xeroErrors: number;
  totalAlerts: number;
}): string {
  const p = emailPalette();
  const rows: Array<{ label: string; value: string; link: string }> = [];

  if (sections.newBookings > 0) rows.push({ label: "New Bookings", value: String(sections.newBookings), link: "/admin/bookings" });
  if (sections.paymentFailures > 0) rows.push({ label: "Payment Failures", value: String(sections.paymentFailures), link: "/admin/payments" });
  if (sections.capacityWarnings > 0) rows.push({ label: "Capacity Warnings", value: String(sections.capacityWarnings), link: "/admin/bookings" });
  if (sections.bookingsBumped > 0) rows.push({ label: "Bookings Bumped", value: String(sections.bookingsBumped), link: "/admin/bookings" });
  if (sections.pendingDeadlines > 0) rows.push({ label: "Pending Deadlines", value: String(sections.pendingDeadlines), link: "/admin/bookings" });
  if (sections.xeroErrors > 0) rows.push({ label: "Xero Errors", value: String(sections.xeroErrors), link: "/admin/xero" });

  const tableRowsHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${r.label}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist}; color: ${p.deep}; font-weight: 700;">${r.value}</td>
      <td style="padding: 8px 12px; font-size: 14px; border-bottom: 1px solid ${p.mist};"><a href="${BASE_URL}${r.link}" style="color: ${p.gold}; text-decoration: none;">View</a></td>
    </tr>`
    )
    .join("");

  const noAlerts = rows.length === 0
    ? paragraph("No alerts were triggered in the past 24 hours. All systems running normally.")
    : "";

  return layout(`
    ${heading("Admin Daily Digest")}
    ${paragraph("Summary of admin alerts from the past 24 hours.")}
    ${noAlerts}
    ${rows.length > 0 ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Alert Type</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Count</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Action</th>
      </tr>
      ${tableRowsHtml}
    </table>` : ""}
    ${paragraph("<strong>Total alerts:</strong> " + sections.totalAlerts)}
    ${button("Open Admin Dashboard", BASE_URL + "/admin/dashboard")}
  `);
}

type XeroReconciliationIssueSeverityEmail = "critical" | "warning" | "info";

interface XeroReconciliationIssueItemEmail {
  label: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  operationId: string | null;
  operationStatus: string | null;
  operationType: string | null;
  correlationKey: string | null;
  detail: string | null;
  latestErrorMessage: string | null;
  createdAt: Date | null;
}

interface XeroReconciliationIssueSectionEmail {
  id: string;
  title: string;
  severity: XeroReconciliationIssueSeverityEmail;
  count: number;
  whatWentWrong: string;
  howToFix: string;
  items: XeroReconciliationIssueItemEmail[];
}

export interface XeroReconciliationReportEmail {
  generatedAt: Date;
  lookbackHours: number;
  stalePendingMinutes: number;
  summary: {
    missingMemberContactLinks: number;
    missingPaymentInvoiceLinks: number;
    missingPaymentRefundCreditNoteLinks: number;
    missingSubscriptionInvoiceLinks: number;
    mismatchedCanonicalLinks: number;
    staleCanonicalLinks: number;
    duplicateActiveCanonicalLinks: number;
    stalePendingOperations: number;
    recentFailedOperations: number;
    recentPartialOperations: number;
    unsupportedPartialOperations: number;
    repeatedFailureCorrelations: number;
    failedInboundEvents: number;
    issueCategoryCount: number;
    issueTotalCount: number;
  };
  issueSections?: XeroReconciliationIssueSectionEmail[];
  repeatedFailures: Array<{
    correlationKey: string;
    failureCount: number;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    latestErrorMessage: string | null;
    latestOperationId?: string;
    latestOperationStatus?: string;
    latestOperationCreatedAt?: Date;
    xeroObjectType?: string | null;
    xeroObjectId?: string | null;
    xeroObjectNumber?: string | null;
    xeroObjectUrl?: string | null;
  }>;
  unsupportedPartials: Array<{
    operationId: string;
    entityType: string;
    operationType: string;
    localModel: string | null;
    localId: string | null;
    localUrl: string | null;
    xeroObjectType?: string | null;
    xeroObjectId?: string | null;
    xeroObjectNumber?: string | null;
    xeroObjectUrl?: string | null;
    reason: string;
    createdAt: Date;
  }>;
}

function formatEmailDateTime(value: Date | null): string {
  if (!value) {
    return "";
  }

  return formatNZDateTime(value);
}

function formatXeroObjectLabel(item: {
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
}): string | null {
  if (!item.xeroObjectId) {
    return null;
  }

  return `${item.xeroObjectType ?? "Xero"} ${item.xeroObjectNumber ?? item.xeroObjectId}`;
}

function issueSeverityStyle(severity: XeroReconciliationIssueSeverityEmail) {
  const p = emailPalette();
  switch (severity) {
    case "critical":
      return { bg: "#fef2f2", border: "#fecaca", text: "#991b1b", label: "Action needed" };
    case "warning":
      return { bg: "#fffbeb", border: "#fcd34d", text: "#92400e", label: "Review" };
    case "info":
      return { bg: "#eff6ff", border: "#bfdbfe", text: "#1e40af", label: "Context" };
    default:
      return { bg: "#f8fafc", border: p.mist, text: p.deep, label: "Review" };
  }
}

function issueLink(text: string, url: string, sameOrigin = false): string {
  const p = emailPalette();
  const safeUrl = sanitizeEmailHref(url, {
    baseUrl: BASE_URL,
    sameOrigin,
  });

  return `<a href="${escapeHtml(safeUrl)}" target="_blank" style="color: ${p.charcoal}; font-weight: 700; text-decoration: underline;">${escapeHtml(text)}</a>`;
}

function renderIssueItem(item: XeroReconciliationIssueItemEmail): string {
  const p = emailPalette();
  const recordLink = item.localUrl
    ? issueLink("Open booking record", item.localUrl, true)
    : null;
  const xeroLabel = formatXeroObjectLabel(item);
  const xeroLink = item.xeroObjectUrl
    ? issueLink(xeroLabel ?? "Open Xero", item.xeroObjectUrl)
    : null;
  const links = [recordLink, xeroLink].filter((value): value is string => Boolean(value));
  const metadata = [
    item.operationId ? `Operation ${item.operationId}` : null,
    item.operationStatus ? `Status ${item.operationStatus}` : null,
    item.operationType,
    item.correlationKey ? `Correlation ${item.correlationKey}` : null,
    formatEmailDateTime(item.createdAt),
  ].filter((value): value is string => Boolean(value));
  const detailRows = [
    item.detail,
    item.latestErrorMessage ? `Latest error: ${item.latestErrorMessage}` : null,
  ].filter((value): value is string => Boolean(value));

  return `
    <div style="border: 1px solid ${p.mist}; border-radius: 6px; padding: 12px; margin: 10px 0; background-color: ${WHITE};">
      <p style="margin: 0 0 6px 0; color: ${p.deep}; font-size: 14px; font-weight: 700;">${escapeHtml(item.label)}</p>
      ${
        metadata.length > 0
          ? `<p style="margin: 0 0 6px 0; color: ${p.ridge}; font-size: 12px; line-height: 1.5;">${metadata.map(escapeHtml).join(" &bull; ")}</p>`
          : ""
      }
      ${
        detailRows.length > 0
          ? `<p style="margin: 0 0 8px 0; color: ${p.deep}; font-size: 13px; line-height: 1.5;">${detailRows.map(escapeHtml).join("<br>")}</p>`
          : ""
      }
      ${
        links.length > 0
          ? `<p style="margin: 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">${links.join(" &nbsp; ")}</p>`
          : ""
      }
    </div>`;
}

function renderIssueSection(section: XeroReconciliationIssueSectionEmail): string {
  const p = emailPalette();
  const style = issueSeverityStyle(section.severity);
  const itemHtml = section.items.length > 0
    ? section.items.map(renderIssueItem).join("")
    : `<p style="margin: 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">Open the Xero admin area to review the affected records.</p>`;

  return `
    <div style="background-color: ${style.bg}; border: 1px solid ${style.border}; border-radius: 8px; padding: 16px; margin: 18px 0;">
      <p style="margin: 0 0 8px 0; color: ${style.text}; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;">${escapeHtml(style.label)} &bull; ${section.count}</p>
      <h3 style="margin: 0 0 10px 0; color: ${p.deep}; font-size: 17px; line-height: 1.35;">${escapeHtml(section.title)}</h3>
      <p style="margin: 0 0 8px 0; color: ${p.deep}; font-size: 14px; line-height: 1.5;"><strong>What went wrong:</strong> ${escapeHtml(section.whatWentWrong)}</p>
      <p style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 14px; line-height: 1.5;"><strong>How to fix:</strong> ${escapeHtml(section.howToFix)}</p>
      ${itemHtml}
    </div>`;
}

export function adminXeroReconciliationReportTemplate(report: XeroReconciliationReportEmail): string {
  const p = emailPalette();
  const summaryRows = [
    { label: "Generated", value: formatNZDateTime(report.generatedAt) },
    { label: "Lookback Window", value: `${report.lookbackHours} hour${report.lookbackHours === 1 ? "" : "s"}` },
    { label: "Stale Pending Threshold", value: `${report.stalePendingMinutes} minute${report.stalePendingMinutes === 1 ? "" : "s"}` },
    { label: "Issue Categories", value: String(report.summary.issueCategoryCount) },
    { label: "Total Issue Count", value: String(report.summary.issueTotalCount) },
  ];

  const categoryRows = [
    { label: "Missing member contact links", value: String(report.summary.missingMemberContactLinks) },
    { label: "Missing payment invoice links", value: String(report.summary.missingPaymentInvoiceLinks) },
    { label: "Missing refund credit note links", value: String(report.summary.missingPaymentRefundCreditNoteLinks) },
    { label: "Missing subscription invoice links", value: String(report.summary.missingSubscriptionInvoiceLinks) },
    { label: "Mismatched canonical links", value: String(report.summary.mismatchedCanonicalLinks) },
    { label: "Stale canonical links", value: String(report.summary.staleCanonicalLinks) },
    { label: "Duplicate active canonical links", value: String(report.summary.duplicateActiveCanonicalLinks) },
    { label: "Stale pending/running operations", value: String(report.summary.stalePendingOperations) },
    { label: "Recent failed operations", value: String(report.summary.recentFailedOperations) },
    { label: "Recent partial operations", value: String(report.summary.recentPartialOperations) },
    { label: "Unsupported partial operations", value: String(report.summary.unsupportedPartialOperations) },
    { label: "Repeated-failure correlations", value: String(report.summary.repeatedFailureCorrelations) },
    { label: "Persistently failing inbound events", value: String(report.summary.failedInboundEvents) },
  ];

  const issueSections = report.issueSections ?? [];
  const issueSectionHtml = issueSections.map(renderIssueSection).join("");
  const repeatedFailureRows = report.repeatedFailures
    .map((failure) => `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(failure.correlationKey)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${failure.failureCount}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(failure.entityType)} ${escapeHtml(failure.operationType)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${
          failure.localModel && failure.localId
            ? escapeHtml(`${failure.localModel} ${failure.localId}`)
            : "Unavailable"
        }</td>
      </tr>`)
    .join("");

  const unsupportedPartialRows = report.unsupportedPartials
    .map((partial) => `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.operationId)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.entityType)} ${escapeHtml(partial.operationType)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${
          partial.localModel && partial.localId
            ? escapeHtml(`${partial.localModel} ${partial.localId}`)
            : "Unavailable"
        }</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(partial.reason)}</td>
      </tr>`)
    .join("");

  return layout(`
    ${heading("Xero Reconciliation Report")}
    ${
      report.summary.issueCategoryCount === 0
        ? alertBox("No open reconciliation gaps were detected in this report window.", "success")
        : alertBox("Reconciliation gaps were detected. Start with the action sections below, then use the diagnostic totals for context.", "warning")
    }
    ${infoTable(summaryRows)}
    ${
      issueSections.length > 0
        ? issueSectionHtml
        : ""
    }
    ${
      issueSections.length === 0 && report.repeatedFailures.length > 0
        ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Correlation Key</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Failures</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Local Record</th>
      </tr>
      ${repeatedFailureRows}
    </table>`
        : ""
    }
    ${
      issueSections.length === 0 && report.unsupportedPartials.length > 0
        ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation ID</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Operation</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Local Record</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Repair Gap</th>
      </tr>
      ${unsupportedPartialRows}
    </table>`
        : ""
    }
    ${
      report.summary.issueCategoryCount > 0
        ? `${paragraph("Diagnostic totals")}${infoTable(categoryRows)}`
        : ""
    }
    ${button("Open Xero Admin", BASE_URL + "/admin/xero")}
  `);
}

// ---- #2501: Admin Alert — Xero credit-sync drift ----

/**
 * One booking whose BookingApp stamped applied credit does not match Xero's
 * live invoice allocation. `localCents` is BookingApp's known credit (the net
 * `BOOKING_APPLIED` sum), `xeroCents` is Xero's live allocation of the member's
 * OWN stamped credit notes to the invoice (the sum of those notes'
 * `appliedAmount` — NOT `invoice.amountCredited`, which folds in other
 * credit-note classes such as modification reprice notes), and `deltaCents` is
 * the exact (positive) drift between them. `notes` lists exactly those stamped
 * member credit notes, so their applied amounts reconcile to `xeroCents`.
 */
export interface CreditSyncDriftItemEmail {
  kind: "missing_in_xero" | "excess_in_xero" | "no_invoice";
  bookingId: string;
  memberName: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** Org-agnostic Xero invoice URL (the sender stamps the club org onto it). */
  invoiceUrl: string | null;
  localCents: number;
  xeroCents: number;
  deltaCents: number;
  notes: Array<{
    creditNoteId: string | null;
    creditNoteNumber: string | null;
    appliedCents: number;
  }>;
}

export interface CreditSyncDriftReportEmail {
  generatedAt: Date;
  scannedBookings: number;
  checkedBookings: number;
  deferredBookings: number;
  totalDriftCents: number;
  drifts: CreditSyncDriftItemEmail[];
}

function creditSyncDriftDirectionLabel(kind: CreditSyncDriftItemEmail["kind"]): string {
  switch (kind) {
    case "missing_in_xero":
      return "Applied in BookingApp, not fully allocated in Xero";
    case "excess_in_xero":
      return "Xero has more credit allocated than BookingApp recorded";
    case "no_invoice":
      return "Applied credit stamped, but no linked Xero invoice";
  }
}

export function adminCreditSyncDriftTemplate(report: CreditSyncDriftReportEmail): string {
  const p = emailPalette();
  const driftCount = report.drifts.length;

  const summaryRows = [
    { label: "Generated", value: formatNZDateTime(report.generatedAt) },
    { label: "Bookings scanned", value: String(report.scannedBookings) },
    { label: "Bookings checked", value: String(report.checkedBookings) },
    { label: "Bookings deferred", value: String(report.deferredBookings) },
    { label: "Bookings with drift", value: String(driftCount) },
    { label: "Total drift", value: formatMoneyCents(report.totalDriftCents) },
  ];

  const driftRows = report.drifts
    .map((drift) => {
      const noteDetail =
        drift.notes.length > 0
          ? drift.notes
              .map(
                (note) =>
                  `${escapeHtml(note.creditNoteNumber ?? "credit note")}: ${formatMoneyCents(note.appliedCents)}`
              )
              .join("; ")
          : "None allocated";
      const invoiceCell = drift.invoiceUrl
        ? `<a href="${escapeHtml(drift.invoiceUrl)}" style="color: ${p.gold}; text-decoration: underline;">${escapeHtml(drift.invoiceNumber ?? "Invoice")}</a>`
        : escapeHtml(drift.invoiceNumber ?? "No invoice");
      return `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(drift.memberName)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(drift.bookingId.slice(0, 8))}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${escapeHtml(creditSyncDriftDirectionLabel(drift.kind))}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatMoneyCents(drift.localCents)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${formatMoneyCents(drift.xeroCents)}</td>
        <td style="padding: 8px 12px; font-size: 13px; font-weight: 700; border-bottom: 1px solid ${p.mist}; color: #dc2626;">${formatMoneyCents(drift.deltaCents)}</td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid ${p.mist}; color: ${p.deep};">${invoiceCell}<br><span style="color: ${p.ridge}; font-size: 12px;">${noteDetail}</span></td>
      </tr>`;
    })
    .join("");

  return layout(`
    ${heading("Xero Credit Sync Drift")}
    ${alertBox(
      `${driftCount} booking${driftCount === 1 ? "" : "s"} have applied account credit that does not match Xero's live invoice allocation (total drift ${formatMoneyCents(report.totalDriftCents)}). BookingApp uses its own known credit to net member emails (#2483); each row below shows exactly where its ledger and Xero disagree. Nothing has been changed — review and reconcile in Xero.`,
      "warning"
    )}
    ${infoTable(summaryRows)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Member</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Booking</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Drift type</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">BookingApp credit</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Xero credit</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Drift</th>
        <th style="padding: 8px 12px; font-size: 13px; text-align: left; background-color: ${p.mist}; color: ${p.deep}; border-bottom: 2px solid ${p.mist};">Invoice / Xero notes</th>
      </tr>
      ${driftRows}
    </table>
    ${button("Open Xero Admin", BASE_URL + "/admin/xero")}
  `);
}

/**
 * #2267: the single source of truth for WHICH change rows a booking-modified
 * email shows — shared by the hand-built HTML email (bookingModifiedTemplate)
 * and the flat {{changeSummary}} token the admin-editable body renders, so the
 * two paths cannot tell different stories about the same modification.
 *
 * Only what actually changed is shown as a Previous/New pair; anything
 * unchanged is stated once ("Dates", "Guests", "Total"), and a change fee only
 * appears when one was charged. The flat body used to hardcode every
 * Previous/New row unconditionally, so a guest-only change emailed a member
 * "Previous Dates" and "New Dates" that were identical and a "Change Fee:
 * $0.00" for a booking that was never charged one.
 *
 * Values are unescaped plain text; the HTML path escapes at its edge.
 */
export function bookingModificationSummaryRows(params: {
  oldCheckIn: Date;
  oldCheckOut: Date;
  newCheckIn: Date;
  newCheckOut: Date;
  oldGuestCount: number;
  newGuestCount: number;
  oldFinalPriceCents: number;
  newFinalPriceCents: number;
  changeFeeCents: number;
  // #2390: present only when a promotion's usage cap stopped it reaching
  // somebody this edit added. Added as a row here, rather than as a new
  // template token, so the hand-built HTML email and the admin-editable flat
  // body cannot end up telling different stories about the same split — the
  // whole reason this helper exists.
  promoCoverageNote?: string | null;
}): Array<{ label: string; value: string }> {
  const dateRange = (from: Date, to: Date) =>
    `${formatNZDate(from)} – ${formatNZDate(to)}`;
  const rows: Array<{ label: string; value: string }> = [];

  const datesChanged =
    params.oldCheckIn.getTime() !== params.newCheckIn.getTime() ||
    params.oldCheckOut.getTime() !== params.newCheckOut.getTime();
  if (datesChanged) {
    rows.push({
      label: "Previous Dates",
      value: dateRange(params.oldCheckIn, params.oldCheckOut),
    });
    rows.push({
      label: "New Dates",
      value: dateRange(params.newCheckIn, params.newCheckOut),
    });
  } else {
    rows.push({
      label: "Dates",
      value: dateRange(params.newCheckIn, params.newCheckOut),
    });
  }

  if (params.oldGuestCount !== params.newGuestCount) {
    rows.push({ label: "Previous Guests", value: String(params.oldGuestCount) });
    rows.push({ label: "New Guests", value: String(params.newGuestCount) });
  } else {
    rows.push({ label: "Guests", value: String(params.newGuestCount) });
  }

  if (params.oldFinalPriceCents !== params.newFinalPriceCents) {
    rows.push({
      label: "Previous Total",
      value: formatMoneyCents(params.oldFinalPriceCents),
    });
    rows.push({
      label: "New Total",
      value: formatMoneyCents(params.newFinalPriceCents),
    });
  } else {
    rows.push({
      label: "Total",
      value: formatMoneyCents(params.newFinalPriceCents),
    });
  }

  if (params.changeFeeCents > 0) {
    rows.push({
      label: "Change Fee",
      value: formatMoneyCents(params.changeFeeCents),
    });
  }

  // Last, deliberately: it explains the New Total above it.
  if (params.promoCoverageNote && params.promoCoverageNote.trim().length > 0) {
    rows.push({ label: "Promo coverage", value: params.promoCoverageNote });
  }

  return rows;
}

/**
 * #2267: member-facing wording for a booking modification type, shared by the
 * hand-built HTML email and the flat {{modificationTypeLabel}} token the
 * admin-editable body renders. Before this, the flat body passed the raw enum
 * word through, so an override-using club emailed members "DATE_CHANGE", and
 * even the HTML path had no wording for BATCH_MODIFY (emitted by the admin
 * batch edit in booking-batch-modification-service) and emailed "BATCH_MODIFY".
 *
 * The wording matches the booking history timeline's labels
 * (MODIFICATION_LABELS in booking-history.ts) so a member reading the email and
 * an admin reading the timeline see the same words. Unknown values fall back to
 * the raw string rather than hiding the change.
 */
export function bookingModificationTypeLabel(modificationType: string): string {
  const labels: Record<string, string> = {
    DATE_CHANGE: "Dates Changed",
    GUEST_ADD: "Guests Added",
    GUEST_REMOVE: "Guest Removed",
    EXTEND_STAY: "Stay Extended",
    BATCH_MODIFY: "Booking Modified",
  };
  return labels[modificationType] ?? modificationType;
}

export function bookingModifiedTemplate(params: {
  firstName: string;
  modificationType: string;
  oldCheckIn: Date;
  oldCheckOut: Date;
  newCheckIn: Date;
  newCheckOut: Date;
  oldGuestCount: number;
  newGuestCount: number;
  oldFinalPriceCents: number;
  newFinalPriceCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  accountCreditAmountCents?: number;
  additionalAmountCents: number;
  additionalPaymentMethod?: "STRIPE" | "INTERNET_BANKING";
  paymentReference?: string | null;
  xeroInvoiceNumber?: string | null;
  // #2390: see bookingModificationSummaryRows — it renders as one more change
  // row, so the HTML and the flat body stay identical.
  promoCoverageNote?: string | null;
}): string {
  const {
    firstName,
    modificationType,
    oldCheckIn,
    oldCheckOut,
    newCheckIn,
    newCheckOut,
    oldGuestCount,
    newGuestCount,
    oldFinalPriceCents,
    newFinalPriceCents,
    changeFeeCents,
    refundAmountCents,
    accountCreditAmountCents = 0,
    additionalAmountCents,
    additionalPaymentMethod,
    paymentReference,
    xeroInvoiceNumber,
    promoCoverageNote,
  } = params;

  // The change rows come from the shared helper the flat {{changeSummary}}
  // token also uses, so both paths always show the same rows (#2267). The
  // shared rows are plain text, so escape at this HTML edge.
  const rows = bookingModificationSummaryRows({
    oldCheckIn,
    oldCheckOut,
    newCheckIn,
    newCheckOut,
    oldGuestCount,
    newGuestCount,
    oldFinalPriceCents,
    newFinalPriceCents,
    changeFeeCents,
    promoCoverageNote,
  }).map((row) => ({
    label: escapeHtml(row.label),
    value: escapeHtml(row.value),
  }));

  let paymentNote = "";
  if (refundAmountCents > 0) {
    paymentNote = alertBox(
      `A refund of ${formatCents(refundAmountCents)} has been processed to your original payment method.`,
      "success"
    );
  } else if (accountCreditAmountCents > 0) {
    paymentNote = alertBox(
      `Account credit of ${formatCents(accountCreditAmountCents)} has been added for future bookings.`,
      "success"
    );
  } else if (additionalAmountCents > 0) {
    if (additionalPaymentMethod === "INTERNET_BANKING") {
      const invoiceContext = xeroInvoiceNumber
        ? ` Xero invoice ${escapeHtml(xeroInvoiceNumber)} will be used for payment.`
        : " A Xero invoice and payment reference will be used for payment.";
      const referenceContext = paymentReference
        ? ` Payment reference: ${escapeHtml(paymentReference)}.`
        : "";
      paymentNote = alertBox(
        `An additional Internet Banking payment of ${formatCents(additionalAmountCents)} is required.${invoiceContext}${referenceContext} Xero reconciliation confirms the payment before it is treated as paid.`,
        "warning"
      );
    } else {
      paymentNote = alertBox(
        `An additional payment of ${formatCents(additionalAmountCents)} is required.`,
        "warning"
      );
    }
  }

  return layout(`
    ${heading("Booking Modified")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your booking has been updated.")}
    ${alertBox(escapeHtml(bookingModificationTypeLabel(modificationType)), "info")}
    ${infoTable(rows)}
    ${paymentNote}
    ${paragraph("You can view your updated booking details from your account.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/** F-COMP-04: Account deletion approved — sent before anonymisation */
export function accountDeletionApprovedTemplate(firstName: string): string {
  return layout(`
    ${heading("Account Deletion Confirmed")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph("We have processed your account deletion request. Your personal data has been anonymised in accordance with our Privacy Policy.")}
    ${alertBox("Your account is now deactivated and you will no longer be able to log in. Booking history has been retained for financial and audit purposes with your personal details removed.", "info")}
    ${paragraph("If you have any questions, please contact the club.")}
    ${supportContactMuted()}
  `);
}

// ---- Family group email templates ----

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

/** Admin alert: family group request created */
export function adminFamilyGroupRequestTemplate(data: {
  requestType: string;
  requesterName: string;
  groupName: string;
  details: string;
}): string {
  return layout(`
    ${heading("Family Group Request")}
    ${paragraph("A new <strong>" + escapeHtml(data.requestType) + "</strong> request has been submitted.")}
    ${paragraph("<strong>Requester:</strong> " + escapeHtml(data.requesterName))}
    ${paragraph("<strong>Group:</strong> " + escapeHtml(data.groupName))}
    ${multilineBlock(escapeHtml(data.details))}
    ${button("Review Requests", (process.env.NEXTAUTH_URL || "http://localhost:3000") + "/admin/family-groups")}
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
    ${paragraph("This link expires on <strong>" + escapeHtml(formatNZDateTime(params.expiresAt)) + "</strong>.")}
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
        escapeHtml(formatNZDateTime(params.expiresAt)) +
        "</strong>."
    )}
    ${button("Review Cancellation Request", params.confirmationUrl, { sameOrigin: true })}
    ${muted("If you do not want to be included, use the link and choose Decline. If you were not expecting this request, you can ignore this email or contact the club.")}
  `);
}

export function adminMembershipCancellationRequestTemplate(data: {
  requesterName: string;
  participantSummary: string;
  reason?: string | null;
  reviewUrl: string;
}): string {
  const reasonHtml = data.reason
    ? paragraph("Reason: <strong>" + escapeHtml(data.reason) + "</strong>")
    : "";

  return layout(`
    ${heading("Membership Cancellation Ready for Review")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> submitted a membership cancellation request with at least one participant ready for admin review."
    )}
    ${infoTable([
      { label: "Requester", value: escapeHtml(data.requesterName) },
      { label: "Included memberships", value: escapeHtml(data.participantSummary) },
    ])}
    ${reasonHtml}
    ${button("Review Cancellation Requests", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function adminMemberArchiveRequestedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Member Archive Requested")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> requested archive review for <strong>" +
        escapeHtml(data.memberName) +
        "</strong>."
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Requested by", value: escapeHtml(data.requesterName) },
    ])}
    ${multilineBlock(escapeHtml(data.reason))}
    ${button("Review Archive Requests", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
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

export function adminMemberDeleteRequestedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Member Delete Requested")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.requesterName) +
        "</strong> requested hard-delete review for <strong>" +
        escapeHtml(data.memberName) +
        "</strong>."
    )}
    ${alertBox(
      "Hard delete is only for records added in error with no meaningful booking, financial, lodge, Xero, or audit history.",
      "warning"
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Requested by", value: escapeHtml(data.requesterName) },
    ])}
    ${multilineBlock(escapeHtml(data.reason))}
    ${button("Review Member", data.reviewUrl, { sameOrigin: true })}
    ${supportContactMuted()}
  `);
}

export function adminMemberDeleteApprovedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "info")
    : "";

  return layout(`
    ${heading("Member Delete Approved")}
    ${paragraph("Hi " + escapeHtml(data.requesterName) + ",")}
    ${paragraph(
      "The hard-delete request for <strong>" +
        escapeHtml(data.memberName) +
        "</strong> was approved and processed."
    )}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${alertBox(
      "A request snapshot was retained before the member record was deleted.",
      "info"
    )}
    ${supportContactMuted()}
  `);
}

export function adminMemberDeleteRejectedTemplate(data: {
  requesterName: string;
  memberName: string;
  reason: string;
  reviewNote?: string | null;
  reviewUrl: string;
}): string {
  const reviewNoteHtml = data.reviewNote
    ? alertBox("Review note: " + escapeHtml(data.reviewNote), "warning")
    : "";

  return layout(`
    ${heading("Member Delete Request Rejected")}
    ${paragraph("Hi " + escapeHtml(data.requesterName) + ",")}
    ${paragraph(
      "The hard-delete request for <strong>" +
        escapeHtml(data.memberName) +
        "</strong> was not approved."
    )}
    ${multilineBlock(escapeHtml(data.reason))}
    ${reviewNoteHtml}
    ${button("Open Member", data.reviewUrl, { sameOrigin: true })}
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

export function adminMembershipApplicationPendingTemplate(data: {
  applicantName: string;
  applicantEmail: string;
  familyMemberCount: number;
  reviewUrl: string;
}): string {
  const dependentSummary =
    data.familyMemberCount > 0
      ? `${paragraph(
          "This application includes " +
            String(data.familyMemberCount) +
            " dependent family member" +
            (data.familyMemberCount === 1 ? "" : "s") +
            "."
        )}`
      : "";

  return layout(`
    ${heading("Membership Application Ready for Review")}
    ${paragraph("Both nominators have now confirmed a new membership application.")}
    ${infoTable([
      { label: "Applicant", value: escapeHtml(data.applicantName) },
      { label: "Email", value: escapeHtml(data.applicantEmail) },
    ])}
    ${dependentSummary}
    ${button("Review Application", data.reviewUrl)}
    ${supportContactMuted()}
  `);
}

export function adminAccountDeletionRequestedTemplate(data: {
  memberName: string;
  memberEmail: string;
  reason?: string | null;
  reviewUrl: string;
}): string {
  const reasonHtml = data.reason
    ? multilineBlock(escapeHtml(data.reason))
    : muted("No reason was provided.");

  return layout(`
    ${heading("Account Deletion Request Submitted")}
    ${paragraph(
      "<strong>" +
        escapeHtml(data.memberName) +
        "</strong> submitted an account deletion request."
    )}
    ${alertBox(
      "Review privacy requests promptly and record the decision from the deletion requests queue.",
      "warning"
    )}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
    ])}
    ${reasonHtml}
    ${button("Review Deletion Requests", data.reviewUrl, { sameOrigin: true })}
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

/** F-COMP-04: Account deletion rejected — sent to member with admin note */
export function accountDeletionRejectedTemplate(
  firstName: string,
  adminNote: string
): string {
  const noteHtml = adminNote
    ? `${alertBox("Admin note: " + escapeHtml(adminNote), "warning")}`
    : "";
  return layout(`
    ${heading("Account Deletion Request Update")}
    ${paragraph("Hi " + escapeHtml(firstName) + ",")}
    ${paragraph("Your account deletion request has been reviewed and was not approved at this time.")}
    ${noteHtml}
    ${paragraph("If you have questions about this decision, please contact the club directly.")}
    ${supportContactMuted()}
  `);
}

// ---- Waitlist templates ----

export function waitlistConfirmationTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  position: number
): string {
  return layout(`
    ${heading("You're on the Waitlist")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", the lodge is currently fully booked for your requested dates, but you've been added to the waitlist.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
      { label: "Waitlist Position", value: "#" + String(position) },
    ])}
    ${alertBox("We'll email you as soon as a spot opens up. You'll have 48 hours to confirm your booking.", "info")}
    ${button("View Booking", BASE_URL + "/bookings")}
    ${muted("You can cancel your waitlist entry at any time from your booking page.")}
  `);
}

export function waitlistOfferTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  expiresAt: Date,
  bookingId: string,
  // Price the member pays on confirmation (repriced at offer time, #1035;
  // the offered lodge's quote for cross-lodge offers).
  priceCents: number,
  // Cross-lodge offer (ADR-004): names the alternate lodge; the member
  // confirms lodge and price explicitly. Null renders same-lodge offers.
  crossLodgeOffer?: { lodgeName: string | null } | null,
  // #2543: why the Price row reads what it reads, when somebody on this booking
  // is priced as a non-member for an unpaid season subscription. Rendered
  // verbatim from the shared policy sentence — it names nobody and no amount, so
  // it is safe in an email a family member may open. Null renders exactly as
  // before.
  subscriptionMemberRateNotice?: string | null
): string {
  const lodgeLabel = crossLodgeOffer?.lodgeName ?? "another of our lodges";
  return layout(`
    ${heading("A Spot Has Opened Up!")}
    ${
      crossLodgeOffer
        ? paragraph(
            "Hi " +
              escapeHtml(firstName) +
              ", great news — a spot has become available at " +
              escapeHtml(lodgeLabel) +
              ", one of the alternate lodges you said you'd accept for your waitlisted booking."
          )
        : paragraph("Hi " + escapeHtml(firstName) + ", great news — a spot has become available for your waitlisted booking.")
    }
    ${infoTable([
      ...(crossLodgeOffer && crossLodgeOffer.lodgeName
        ? [{ label: "Lodge", value: escapeHtml(crossLodgeOffer.lodgeName) }]
        : []),
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "Guests", value: String(guestCount) },
      {
        label: crossLodgeOffer ? "Price at this lodge" : "Price",
        value: formatCents(priceCents),
      },
    ])}
    ${
      crossLodgeOffer
        ? paragraph(
            "This lodge's price differs from the one you originally waitlisted for, so nothing is booked until you review and confirm this price on your booking page."
          )
        : ""
    }
    ${
      subscriptionMemberRateNotice
        ? paragraph(escapeHtml(subscriptionMemberRateNotice))
        : ""
    }
    ${alertBox("This offer expires on " + formatNZDateTime(expiresAt) + ". If you don't confirm in time, the spot will be offered to the next person in line.", "warning")}
    ${button("Confirm Booking", BASE_URL + "/bookings/" + bookingId)}
    ${muted("If you no longer need this booking, you can decline from your booking page.")}
  `);
}

export function waitlistOfferExpiredTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number
): string {
  return layout(`
    ${heading("Waitlist Offer Expired")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your waitlist offer for the dates below has expired.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "New Position", value: "#" + String(position) },
    ])}
    ${paragraph("You've been returned to the waitlist. We'll notify you again if another spot opens up.")}
    ${button("View Booking", BASE_URL + "/bookings")}
  `);
}

/**
 * The RESTORED sibling of `waitlistOfferExpiredTemplate` (#2649).
 *
 * Same shape, same arguments, same rows — the only difference is the copy, and
 * the copy is the whole point. A member whose free waitlist confirmation got
 * stranded in PAYMENT_PENDING did NOT let their offer lapse: they confirmed
 * inside the window and the club's own code failed to finish the job. Sending
 * them the expiry notice states the opposite of what happened, and it
 * contradicts the "your confirmation is stuck, please don't retry" message
 * (#2648) they were already sent. So this template says what is true — their
 * place is back, nothing they did caused it, and they need do nothing.
 */
export function waitlistPlaceRestoredTemplate(
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  position: number
): string {
  return layout(`
    ${heading("Your Waitlist Place Is Back")}
    ${paragraph("Hi " + escapeHtml(firstName) + ", your booking for the dates below could not be finished, so we have put you back on the waitlist. This was not something you did wrong, and your offer did not run out — you confirmed in time and our system could not complete it.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(checkIn) },
      { label: "Check-out", value: formatNZDate(checkOut) },
      { label: "New Position", value: "#" + String(position) },
    ])}
    ${paragraph("You do not need to do anything. We will email you again as soon as a spot opens up for these nights.")}
    ${button("View Booking", BASE_URL + "/bookings")}
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Queue Position", value: "#" + String(data.position) },
    ])}
    ${paragraph("The member has 48 hours to confirm their booking.")}
    ${button("View Waitlist", BASE_URL + "/admin/waitlist")}
  `);
}

export function setupIntentFailedTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  // #2256: these had the right locale but no `timeZone`, so they rendered in
  // whatever zone the sending process happened to run in — a 2026-04-15T23:30Z
  // check-in reads as 15 April from a UTC worker and 16 April in New Zealand.
  // formatNZDate pins both the zone and the house "16 Apr 2026" format.
  const dates = `${formatNZDate(data.checkIn)} – ${formatNZDate(data.checkOut)}`;
  return layout(`
    ${heading("Card Setup Failed")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${alertBox("We were unable to save your card details for your upcoming booking (" + dates + "). Your booking is still held, but we won't be able to charge you automatically when it's confirmed.", "warning")}
    ${paragraph("Please log in and update your payment method to avoid your booking being cancelled.")}
    ${button("Update Payment Method", (process.env.NEXTAUTH_URL || "http://localhost:3000") + "/bookings")}
    ${supportContactSentence("If you need help, contact the club at ")}
  `);
}

export function adminRefundRequestTemplate(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  reason: string;
  requestedAmountCents: number | null;
  paidAmountCents: number;
  refundedAmountCents: number;
}): string {
  const remaining = data.paidAmountCents - data.refundedAmountCents;
  return layout(`
    ${heading("Refund Appeal Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has submitted a refund appeal.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Paid", value: "$" + (data.paidAmountCents / 100).toFixed(2) },
      { label: "Already Refunded", value: "$" + (data.refundedAmountCents / 100).toFixed(2) },
      { label: "Remaining", value: "$" + (remaining / 100).toFixed(2) },
      ...(data.requestedAmountCents ? [{ label: "Requested", value: "$" + (data.requestedAmountCents / 100).toFixed(2) }] : []),
    ])}
    ${alertBox(escapeHtml(data.reason), "info")}
    ${button("Review Appeal", BASE_URL + "/admin/refund-requests")}
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
      { label: "Current check-in", value: formatNZDate(data.checkIn) },
      { label: "Current check-out", value: formatNZDate(data.checkOut) },
      { label: "Requested change", value: escapeHtml(data.requestedSummary) },
    ])}
    ${data.reason ? alertBox(escapeHtml(data.reason), "info") : ""}
    ${button("Review Request", data.reviewUrl)}
  `);
}

export function adminIssueReportTemplate(data: {
  memberName: string;
  memberEmail: string;
  pageUrl: string;
  pageTitle?: string | null;
  description: string;
  issueReportUrl: string;
  hasScreenshot: boolean;
}): string {
  return layout(`
    ${heading("Issue Report Submitted")}
    ${paragraph(escapeHtml(data.memberName) + " has reported an issue from the bookings site.")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Email", value: escapeHtml(data.memberEmail) },
      { label: "Page", value: escapeHtml(data.pageTitle || data.pageUrl) },
      { label: "Screenshot", value: data.hasScreenshot ? "Available in admin" : "Not included" },
    ])}
    ${alertBox(escapeHtml(data.description), "info")}
    ${button("Review Issue Report", data.issueReportUrl, { sameOrigin: true })}
    ${button("Open Reported Page", data.pageUrl, { sameOrigin: true })}
  `);
}

/**
 * #2321 — the refund-appeal outcome emails, ONE FUNCTION PER OUTCOME.
 *
 * These were a single template switching on a `status` boolean, alongside a
 * single registered `refund-request-resolved` body whose default wording said
 * "approved". The HTML path always branched correctly, but the flat editable
 * body could not — so a club that had saved an override sent approval wording,
 * and a sentence with an empty amount, to members whose appeal was declined.
 * Splitting both the registered template and this function means no surface
 * exists on which one outcome's wording can reach the other's recipient.
 */
function refundRequestOutcomeLayout(data: {
  firstName: string;
  headingText: string;
  outcomeSentence: string;
  outcomeTone: "success" | "warning";
  adminNotes: string | null;
}): string {
  return layout(`
    ${heading(data.headingText)}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ",")}
    ${alertBox(data.outcomeSentence, data.outcomeTone)}
    ${data.adminNotes ? multilineBlock("<strong>Notes:</strong>\n" + escapeHtml(data.adminNotes)) : ""}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

export function refundRequestApprovedTemplate(data: {
  firstName: string;
  amountCents: number | null;
  adminNotes: string | null;
  checkIn: Date;
  checkOut: Date;
}): string {
  return refundRequestOutcomeLayout({
    firstName: data.firstName,
    headingText: "Refund Appeal Approved",
    outcomeSentence:
      "Your refund appeal for your booking (" + formatNZDate(data.checkIn) + " - " + formatNZDate(data.checkOut) + ") has been approved. A refund of " + formatCents(data.amountCents ?? 0) + " will be processed to your original payment method.",
    outcomeTone: "success",
    adminNotes: data.adminNotes,
  });
}

export function refundRequestDeclinedTemplate(data: {
  firstName: string;
  adminNotes: string | null;
  checkIn: Date;
  checkOut: Date;
}): string {
  // Deliberately takes no amount at all: there is no refund to state, and the
  // parameter's absence is what stops one being printed.
  return refundRequestOutcomeLayout({
    firstName: data.firstName,
    headingText: "Refund Appeal Update",
    outcomeSentence:
      "Your refund appeal for your booking (" + formatNZDate(data.checkIn) + " - " + formatNZDate(data.checkOut) + ") was not approved at this time.",
    outcomeTone: "warning",
    adminNotes: data.adminNotes,
  });
}

// ---- Public booking request flow (issue #707) ----

export function bookingRequestVerificationTemplate(data: {
  firstName: string;
  verifyUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Confirm Your Booking Request")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thanks for your booking request for " + escapeHtml(CLUB_NAME) + "'s lodge.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${paragraph("Please confirm your email address so the club can review your request. Your request will not be reviewed until you confirm.")}
    ${button("Confirm My Email", data.verifyUrl)}
    ${muted("This link expires on " + escapeHtml(formatNZDateTime(data.expiresAt)) + ". If you did not make this request, you can safely ignore this email and the request will be deleted.")}
  `);
}

export function groupSettlementReceiptTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
}): string {
  return layout(`
    ${heading("Your Group Booking Is Settled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thanks for settling your group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge. Everyone you are paying for is now confirmed.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Joiners settled", value: String(data.joinerCount) },
      { label: "Total paid", value: formatCents(data.totalCents) },
    ])}
    ${paragraph("Each joiner has been emailed to confirm their spot. There is nothing more for them to pay.")}
    ${supportContactSentence("If anything looks wrong, contact the club at ")}
  `);
}

export function groupJoinSettledTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
}): string {
  return layout(`
    ${heading("Your Spot Is Confirmed")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + escapeHtml(data.organiserName) + " has settled the cost of your stay at " + escapeHtml(CLUB_NAME) + "'s lodge as part of their group booking. Your spot is confirmed and there is nothing for you to pay.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${supportContactSentence("If you have any questions about your stay, contact the club at ")}
  `);
}

export function groupSettlementExpiredTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
}): string {
  return layout(`
    ${heading("Your Group Settlement Has Expired")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the combined payment you started for your group's stay at " + escapeHtml(CLUB_NAME) + "'s lodge was not completed in time, so the beds held for your joiners have been released.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Joiners affected", value: String(data.joinerCount) },
      { label: "Amount not charged", value: formatCents(data.totalCents) },
    ])}
    ${paragraph("No money has been taken. If your group still plans to come, restart the payment from your group booking page — the beds are subject to availability.")}
    ${supportContactSentence("If anything looks wrong, contact the club at ")}
  `);
}

export function groupJoinReleasedTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Your Held Spot Has Been Released")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + escapeHtml(data.organiserName) + " started a combined payment for your stay at " + escapeHtml(CLUB_NAME) + "'s lodge but it was not completed in time, so your held bed has been released.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
    ])}
    ${paragraph("Your booking is back to awaiting payment. If the group still plans to come, the organiser can restart the payment — or check with them about what happens next.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

/**
 * Final notice after a reaped organiser-pays place is cancelled (#1094): the
 * organiser never restarted the combined payment, so the joiner's pending
 * booking reached its terminal state.
 */
export function groupJoinCancelledTemplate(data: {
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Your Group Booking Has Been Cancelled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the combined group payment " + escapeHtml(data.organiserName) + " started for your stay at " + escapeHtml(CLUB_NAME) + "'s lodge was never completed, so your pending booking has now been cancelled. Nothing has been charged to you.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
    ])}
    ${paragraph("If you still want to come, you can make your own booking for these dates — or talk to the organiser about starting a fresh group trip.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

export function bookingRequestApprovedTemplate(data: {
  firstName: string;
  payUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  priceCents: number;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Your Booking Request Has Been Approved")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", good news — the club has approved your booking request.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Price", value: formatCents(data.priceCents) },
    ])}
    ${paragraph("Use the secure link below to pay and confirm your stay. You can pay by card, or by internet banking using the reference shown on the payment page.")}
    ${button("Pay for My Stay", data.payUrl)}
    ${alertBox("Until payment is received, club members keep priority for these dates and your booking may be bumped if the lodge fills.", "info")}
    ${muted("This payment link expires on " + escapeHtml(formatNZDateTime(data.expiresAt)) + ". If you have any questions, just reply to this email or contact the club.")}
  `);
}

/**
 * Split-booking guest-portion payment link (#1967). Sent to the member when the
 * provisional non-member child of a split booking reaches its hold deadline but
 * there is no card on file to auto-charge (the member paid their own place by
 * Internet Banking via the switch-at-pay path). Reuses the #707 tokenised
 * `/pay/<token>` PaymentLink so the member can settle their guests' portion.
 */
export function splitGuestPaymentLinkTemplate(data: {
  firstName: string;
  payUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  priceCents: number;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Pay for Your Guests to Confirm Their Place")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", your own place is taken care of separately, but your non-member guests still need to be paid for before we can hold beds for them. Because there is no card on file for this part of your booking, please use the secure link below to pay for your guests.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount due", value: formatCents(data.priceCents) },
    ])}
    ${paragraph("Use the secure link below to pay. You can pay by card, or by internet banking using the reference shown on the payment page.")}
    ${button("Pay for My Guests", data.payUrl)}
    ${alertBox("Until payment is received, no beds are held for your guests and their place may be bumped if the lodge fills for these dates.", "info")}
    ${muted("This payment link expires on " + escapeHtml(formatNZDateTime(data.expiresAt)) + ". If you have any questions, just reply to this email or contact the club.")}
  `);
}

export function bookingRequestQuoteTemplate(data: {
  firstName: string;
  respondUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  options: Array<{ label: string; totalCents: number }>;
  message?: string | null;
  expiresAt: Date;
  schoolName?: string | null;
  isReminder?: boolean;
}): string {
  const optionRows = data.options.map((option) => ({
    label: option.label,
    value: formatCents(option.totalCents),
  }));

  return layout(`
    ${heading(data.isReminder ? "Reminder: Your Booking Quote Is Expiring Soon" : "Your Booking Quote Is Ready")}
    ${paragraph(
      data.isReminder
        ? "Hi " +
            escapeHtml(data.firstName) +
            ", this is a reminder that your lodge quote is still waiting and will expire soon. We have included a fresh secure link below so you do not need to find the original email."
        : "Hi " + escapeHtml(data.firstName) + ", the club has prepared a quote for your lodge request.",
    )}
    ${infoTable([
      ...(data.schoolName ? [{ label: "School", value: data.schoolName }] : []),
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      ...optionRows,
    ])}
    ${data.message ? multilineBlock("<strong>Note from the club:</strong>\n" + escapeHtml(data.message)) : ""}
    ${paragraph("Use the secure link below to accept, cancel, request changes, or send a question about this quote.")}
    ${button("Respond to Quote", data.respondUrl)}
    ${muted("This quote link expires on " + escapeHtml(formatNZDateTime(data.expiresAt)) + ". If you have questions, just reply to this email or contact the club.")}
  `);
}

export function bookingRequestDeclinedTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  reason?: string | null;
}): string {
  return layout(`
    ${heading("Update on Your Booking Request")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thank you for your interest in staying at " + escapeHtml(CLUB_NAME) + "'s lodge.")}
    ${paragraph("Unfortunately the club is unable to accommodate your request for " + escapeHtml(formatNZDate(data.checkIn)) + " to " + escapeHtml(formatNZDate(data.checkOut)) + " at this time.")}
    ${data.reason ? multilineBlock("<strong>Note from the club:</strong>\n" + escapeHtml(data.reason)) : ""}
    ${paragraph("You are welcome to submit another request for different dates.")}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

/**
 * #2012 — member-facing terminal notice that the booking created from their
 * approved public booking request (#707) stayed unpaid up to the check-in day,
 * so the provisional booking was released. Distinct wording from
 * bookingRequestDeclinedTemplate ("unable to accommodate"): this request WAS
 * approved and priced — the payment window simply lapsed — so it must not
 * imply a refusal. Reassures that nothing was ever charged. No bearer token, so
 * this is not sensitive-log material.
 */
export function bookingRequestPaymentExpiredTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Your Booking Was Released — Payment Not Received")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the booking we approved from your request stayed unpaid up to the check-in day, so it has now been released. Nothing was ever charged.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
    ])}
    ${paragraph("If you still want to stay, you are welcome to submit a new booking request for these or other dates.")}
    ${supportContactSentence("If you have questions, contact the club at ")}
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Total", value: formatCents(data.totalCents) },
      { label: "Hold extended to", value: formatNZDateTime(data.holdUntil) },
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount due", value: formatCents(data.totalCents) },
      { label: "Hold extended to", value: formatNZDateTime(data.holdUntil) },
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
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount (unpaid)", value: formatCents(data.totalCents) },
    ])}
    ${paragraph("No further action is required for the guest portion. If these guests are in fact coming and the member intends to pay, create a new booking for them.")}
    ${muted("This is a one-off notice — it ends the capped hold-extension alert series for this guest portion.")}
    ${button("View Bookings", data.reviewUrl, { sameOrigin: true })}
  `);
}

/**
 * #1993 Part A — member-facing notice that the provisional non-member guest
 * portion of their stay was auto-cancelled because it stayed unpaid up to the
 * check-in day. Reassures that nothing was ever charged for the guest portion
 * and that the cancellation touches only that portion. `parentConfirmed`
 * selects the reassurance about their own booking: a settled/internet-banking
 * parent "remains confirmed"; otherwise the copy only states the parent was not
 * changed by this cancellation, never a false "confirmed". No bearer token, so
 * this is not sensitive-log material.
 */

export function splitGuestPortionCancelledTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  parentConfirmed: boolean;
  parentBookingReference?: string | null;
}): string {
  const ownBookingLine = splitGuestPortionOwnBookingLine(data.parentConfirmed);
  return layout(`
    ${heading("Your Guests' Provisional Place Was Cancelled")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the provisional place we were holding for your non-member guests stayed unpaid up to the check-in day, so it has now been automatically cancelled. Nothing was ever charged for it, and no beds were held.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      ...(data.parentBookingReference
        ? [
            {
              label: "Your booking reference",
              value: escapeHtml(data.parentBookingReference),
            },
          ]
        : []),
    ])}
    ${paragraph(ownBookingLine)}
    ${paragraph("If your guests are still coming, you can make a new booking for them at any time.")}
    ${button("Make a New Booking", BASE_URL + "/book")}
  `);
}

/**
 * School attendee confirmation prompt (#1101): tokenized link where the
 * school contact renames placeholder attendees and confirms the list.
 */
export function schoolAttendeeConfirmationTemplate(data: {
  firstName: string;
  schoolName: string | null;
  confirmUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  isReminder: boolean;
}): string {
  const stayLabel = data.schoolName
    ? escapeHtml(data.schoolName) + "'s stay"
    : "your school group's stay";
  return layout(`
    ${heading(data.isReminder ? "Reminder: Confirm Your Attendee List" : "Confirm Your Attendee List")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + stayLabel + " at " + escapeHtml(CLUB_NAME) + "'s lodge is coming up, and the booking currently lists placeholder attendee names. Please tell us who is coming so the lodge roster shows real names on arrival.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Attendees", value: String(data.guestCount) },
    ])}
    ${paragraph("Use the secure link below to update the names and confirm the list. You can come back and edit until you confirm; the link stays valid until check-in.")}
    ${button("Confirm Attendees", data.confirmUrl)}
    ${muted("Need to change how many people are coming, or their age groups? Contact the club instead — headcount changes go through a revised quote.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

/**
 * #2550 — member-facing reminder that a whole-lodge booking's party is still
 * "Guest 1..N".
 *
 * The member renames their own guests through the ordinary booking-guest edit
 * path, so this message carries NO token and no public page: the canonical
 * authenticated booking link is appended centrally for every booking-scoped
 * send (`finalizeBookingEmailHtml`).
 *
 * `urgencyNote` arrives ALREADY COMPOSED from
 * `wholeLodgeGuestNamesUrgencyNote`, and the sender hands the identical string
 * to the `{{namingUrgencyNote}}` token, so the HTML and the admin-editable flat
 * body cannot drift.
 */
export function wholeLodgeGuestNamesReminderTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  unnamedGuestCount: number;
  isFinal: boolean;
  urgencyNote: string;
}): string {
  return layout(`
    ${heading(data.isFinal ? "Last Chance: Who Is Coming With You?" : "Who Is Coming With You?")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", your whole-lodge booking at " + escapeHtml(CLUB_NAME) + "'s lodge is coming up and some of your party are still listed as placeholders rather than by name.")}
    ${infoTable([
      { label: "Check-in", value: formatNZDate(data.checkIn) },
      { label: "Check-out", value: formatNZDate(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Still unnamed", value: String(data.unnamedGuestCount) },
    ])}
    ${paragraph(escapeHtml(data.urgencyNote))}
    ${muted("You can update the names yourself from your booking. Changing a name does not change anybody's age group or what the stay costs — to change how many people are coming, or their age groups, contact the club.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
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
      { label: "Date recorded", value: formatNZDate(data.recordedAt) },
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

/** Shared stay facts every member-guest email states the same way. */
function memberGuestStayRows(data: {
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  guestNightsLabel: string;
  nightsLabel: string;
}): Array<{ label: string; value: string }> {
  return [
    // The nights label can be audience-derived, so it is escaped like a value.
    { label: "Lodge", value: escapeHtml(data.lodgeName) },
    {
      label: "Stay",
      value: `${escapeHtml(formatNZDate(data.checkIn))} - ${escapeHtml(formatNZDate(data.checkOut))}`,
    },
    ...(data.guestNightsLabel
      ? [
          {
            label: escapeHtml(data.nightsLabel),
            value: escapeHtml(data.guestNightsLabel),
          },
        ]
      : []),
  ];
}

/**
 * "Can X add you to this booking?" — to the member being added, or to the family
 * delegate answering for them (owner decision D-9).
 *
 * Carries the full party listing (MG2-D-a) and NO MONEY anywhere: not a price,
 * not a total, not a share. Nothing here tells the reader the switch that could
 * withhold this email exists, and nothing here is actionable without signing in.
 */
export function memberGuestConsentRequestTemplate(data: {
  firstName: string;
  bookerName: string;
  askHeading: string;
  askContextNote: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  guestNightsLabel: string;
  consentExpiresAt: Date;
  consentUrl: string;
  partyList: MemberGuestPartyList;
}): string {
  const answerBy = escapeHtml(formatNZDate(data.consentExpiresAt));
  const booker = escapeHtml(data.bookerName);

  return layout(`
    ${heading(escapeHtml(data.askHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.askContextNote)}`)}
    ${infoTable([
      ...memberGuestStayRows({
        lodgeName: data.lodgeName,
        checkIn: data.checkIn,
        checkOut: data.checkOut,
        guestNightsLabel: data.guestNightsLabel,
        // "Nights" rather than "Your nights": a family delegate reading this is
        // not the person the nights are held for (D-9).
        nightsLabel: "Nights",
      }),
      { label: "Booked by", value: booker },
      { label: "Please answer by", value: `<strong>${answerBy}</strong>` },
    ])}
    ${data.partyList.html}
    ${paragraph(
      `If you do not answer by <strong>${answerBy}</strong>, the request lapses on its own and ${booker} is told. You do not have to do anything to decline. In most cases the held bed is released at the same time; occasionally it cannot be - when there would be nobody left on the booking, for example - and the club sorts that out by hand.`,
    )}
    ${button("Answer this request", data.consentUrl, { sameOrigin: true })}
    ${muted("If you were not expecting this, you can safely ignore it - the place is only confirmed if somebody answers yes.")}
  `);
}

/**
 * "You have been added to a lodge booking" — to the member, when nobody asked, or
 * to the family adult who is told on behalf of a member with no login (D-9).
 *
 * ONE template for notify-only, an admin add and a booking-request row;
 * `addedContextNote` is the single composed sentence that tells them apart, and
 * MG4 reuses this template unchanged. The heading is composed for the same reason
 * the consent request's is: it names the guest rather than the reader when the two
 * are not the same person. `removalNote` comes from the shared self-removal
 * predicate, so this email never offers a "take yourself off" link the server
 * would refuse (owner decision D-14).
 */
export function memberGuestAddedTemplate(data: {
  firstName: string;
  addedHeading: string;
  addedContextNote: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  guestNightsLabel: string;
  /**
   * "Your nights" only when the reader IS the guest; a neutral "Nights" when a
   * delegate is reading, because they are not the person the bed is held for.
   */
  nightsLabel: string;
  partyList: MemberGuestPartyList;
  removalNote: string;
}): string {
  return layout(`
    ${heading(escapeHtml(data.addedHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.addedContextNote)}`)}
    ${infoTable(
      memberGuestStayRows({
        lodgeName: data.lodgeName,
        checkIn: data.checkIn,
        checkOut: data.checkOut,
        guestNightsLabel: data.guestNightsLabel,
        nightsLabel: data.nightsLabel,
      }),
    )}
    ${data.partyList.html}
    ${paragraph(escapeHtml(data.removalNote))}
    ${button("View this booking", `${BASE_URL}/bookings`)}
  `);
}

/**
 * "A family member added you to a booking" (#2284, S2).
 *
 * The general-family counterpart to `memberGuestAddedTemplate`: a courtesy FYI
 * sent when someone in the reader's OWN family group puts them (or a non-login
 * member they are the adult for) on a booking. It is NOT a member-guest feature
 * email — it carries no consent, no party list, and no held-bed language, only
 * the stay and how to come off it. The dispatcher applies the personal opt-out
 * and the #2258 per-booking switch withholds it like every member email.
 */
export function familyMemberBookingAddedTemplate(data: {
  firstName: string;
  addedHeading: string;
  addedContextNote: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  removalNote: string;
}): string {
  return layout(`
    ${heading(escapeHtml(data.addedHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.addedContextNote)}`)}
    ${infoTable([
      { label: "Lodge", value: escapeHtml(data.lodgeName) },
      {
        label: "Stay",
        value: `${escapeHtml(formatNZDate(data.checkIn))} - ${escapeHtml(formatNZDate(data.checkOut))}`,
      },
    ])}
    ${paragraph(escapeHtml(data.removalNote))}
    ${button("View this booking", `${BASE_URL}/bookings`)}
  `);
}

/**
 * What the member decided — to the person who made the booking.
 *
 * One template for five outcomes (approved, declined, declined-but-still-on-the-
 * booking, lapsed-and-removed, lapsed-but-still-on-the-booking) because the
 * heading, the sentence and the consequence are all composed server-side. The
 * consequence is the only place
 * money appears in this whole set, and it has to: owner decision D-15 settles an
 * expired or declined place as account credit to this recipient.
 */
export function memberGuestConsentOutcomeTemplate(data: {
  firstName: string;
  outcomeHeading: string;
  outcomeSentence: string;
  consequenceNote: string;
  bookingId: string;
}): string {
  return layout(`
    ${heading(escapeHtml(data.outcomeHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.outcomeSentence)}`)}
    ${paragraph(escapeHtml(data.consequenceNote))}
    ${button("View this booking", `${BASE_URL}/bookings/${data.bookingId}`)}
  `);
}

/**
 * "That request has lapsed" — to the member who was asked.
 *
 * Sent only where a request email actually went out, so nobody is told a request
 * lapsed that they never received. No action link, because there is no action:
 * the bed is already released.
 */
export function memberGuestConsentExpiredTemplate(data: {
  firstName: string;
  bookerName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  const booker = escapeHtml(data.bookerName);

  return layout(`
    ${heading("That request has lapsed")}
    ${paragraph(
      `Hi ${escapeHtml(data.firstName)}, the request from <strong>${booker}</strong> to add you to a booking at ${escapeHtml(data.lodgeName)} on ${escapeHtml(formatNZDate(data.checkIn))} - ${escapeHtml(formatNZDate(data.checkOut))} has lapsed, and the bed that was held for you has been released.`,
    )}
    ${paragraph(`You do not need to do anything. If you did want to come, ask ${booker} to add you again.`)}
  `);
}

/**
 * "You are no longer on that booking" — MG4 (#2309).
 *
 * The counterpart to `memberGuestAddedTemplate`, and it exists because MG2 told
 * a member they had a bed. Three things can take that back — the booker calls
 * off a request nobody has answered yet, the club takes a settled member guest
 * off, or the booking-request pipeline swaps them out at approval — and all
 * three leave a member holding an email that has stopped being true.
 *
 * NO BEARER/SELF-SERVICE ACTION AND NO PARTY LISTING, deliberately. The core
 * mail finalizer may add the canonical booking-detail action only when this
 * exact recipient independently retains route authority (for example, a
 * bookings-view admin). An ordinary removed member or family delegate gets no
 * booking link, because it would 403 or disclose a party they are no longer
 * part of. MG2-D-a's listing is the price of being asked to join; it is not owed
 * to somebody who has been removed.
 *
 * NO MONEY either, on the same rule as the request and added notices.
 *
 * THE LAST PARAGRAPH IS THE ONE DOING REAL WORK (mockup panel 8). The reader is
 * holding an earlier email with a button in it — "Answer this request", or
 * "View this booking" — and that button now leads nowhere. Saying so BEFORE they
 * press it is the difference between a closed loop and an error page, so it is
 * stated here and in the editable default body in the same words; the closing
 * contact line carries the support address in both for the same reason.
 */
export function memberGuestRequestWithdrawnTemplate(data: {
  firstName: string;
  withdrawnHeading: string;
  withdrawnContextNote: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading(escapeHtml(data.withdrawnHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.withdrawnContextNote)}`)}
    ${infoTable([
      { label: "Lodge", value: escapeHtml(data.lodgeName) },
      {
        label: "Stay",
        value: `${escapeHtml(formatNZDate(data.checkIn))} - ${escapeHtml(formatNZDate(data.checkOut))}`,
      },
    ])}
    ${supportContactSentence("You do not need to do anything. If you think this is a mistake, contact the club at ")}
    ${paragraph("The link in the earlier email no longer works. If plans change, you can be added to a booking again later.")}
  `);
}

/**
 * "Someone answered for you" — after a DELEGATE answered on a member's behalf.
 *
 * The one transition nobody downstream would otherwise hear about. The booking's
 * owner is told the outcome and the adult who clicked obviously knows, but the
 * member the answer was given FOR — and the other adults in the household who
 * were sent the same request — heard nothing, even though a decline releases
 * that member's bed and takes them off a booking. It goes to whoever we hold an
 * address for, including the member themselves when they have one, and states
 * plainly who answered and what they said.
 *
 * NO ACTION LINK, deliberately. The recipient may be a household adult who is
 * not on this booking at all, and owner decision D-11 gives booking-page access
 * to a guest ROW, never to a delegate — so a "view this booking" button here
 * would either leak the booking or 403 in their face.
 */
export function memberGuestConsentAnsweredTemplate(data: {
  firstName: string;
  answeredHeading: string;
  answeredSentence: string;
  answeredNote: string;
}): string {
  return layout(`
    ${heading(escapeHtml(data.answeredHeading))}
    ${paragraph(`Hi ${escapeHtml(data.firstName)}, ${escapeHtml(data.answeredSentence)}`)}
    ${paragraph(escapeHtml(data.answeredNote))}
  `);
}

/**
 * "Your booking needs adult member cover" — #2576 §7, §16.
 *
 * Sent when a CONFIRMED booking at an enforcing lodge loses the adult-member
 * cover the club requires — because an officer deliberately overrode the refusal,
 * or because an authoritative change (a membership lapsing, an administrative
 * cancellation, a lifecycle transition) removed it and could not be blocked.
 *
 * THE SECOND PARAGRAPH IS THE MOST IMPORTANT ONE, and it is there because of what
 * a member assumes when the club emails them about a problem with a confirmed
 * stay: that the stay is gone. It is not. §7 and §16 both forbid automatic
 * cancellation, the beds and payments are untouched, and saying so plainly is the
 * difference between a notice and a scare.
 *
 * NAMES NO PERSON, under any scope (§11). It says which nights need cover, never
 * who stopped providing it — even though under `SAME_BOOKING_OWNER` that person is
 * on the member's own account, because the covering member may be a family adult
 * whose membership has just lapsed and that is not this email's news to break.
 * The three ways out are the ones the owner listed.
 */
export function hostingCoverageLostTemplate(data: {
  firstName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  uncoveredNights: string;
}): string {
  return layout(`
    ${heading("Your booking needs adult member cover")}
    ${paragraph(
      `Hi ${escapeHtml(data.firstName)}, a change elsewhere means your booking at ${escapeHtml(data.lodgeName)} no longer has a qualifying adult member staying on every night your non-member guests are there.`,
    )}
    ${infoTable([
      { label: "Check-in", value: escapeHtml(formatNZDate(data.checkIn)) },
      { label: "Check-out", value: escapeHtml(formatNZDate(data.checkOut)) },
      { label: "Nights needing cover", value: escapeHtml(data.uncoveredNights) },
    ])}
    ${paragraph("Your booking has not been cancelled, and your beds and payments are unchanged. A Booking Officer has been notified and will be in touch.")}
    ${paragraph("You can also fix it yourself: add adult member cover for those nights, change the affected booking, or ask a Booking Officer to approve an exception.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}

/**
 * "Your exception request has lapsed" — #2553.
 *
 * A bed-holding policy-exception request the club never decided is closed by the
 * hold-reaper cron and its beds go back into the pool. Without this notice the
 * member's only signal is a bare `Expired` badge they would have to go looking
 * for, so their next act is a duplicate request raised in ignorance.
 *
 * THREE THINGS THIS SAYS AND ONE IT DOES NOT. It says the request lapsed, that
 * the beds it held were released, and that the booking itself is untouched — that
 * last one matters most, because "your request expired" reads to a member as
 * though the STAY had lapsed. It does NOT apologise or assign blame: nobody did
 * anything wrong, a deadline passed.
 *
 * NO MONEY, because none moved. A policy-exception request never charged
 * anything; the released beds were provisional. The booking link is the core
 * finalizer's optional canonical action, so it appears only where this recipient
 * independently retains route authority.
 */
export function policyExceptionRequestExpiredTemplate(data: {
  firstName: string;
  lodgeName: string;
  checkIn: Date;
  checkOut: Date;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Your exception request has lapsed")}
    ${paragraph(
      `Hi ${escapeHtml(data.firstName)}, the exception request you raised for your stay at ${escapeHtml(data.lodgeName)} was not decided by ${escapeHtml(formatNZDateTime(data.expiresAt))}, so it has lapsed and the beds it was holding have been released.`,
    )}
    ${infoTable([
      { label: "Check-in", value: escapeHtml(formatNZDate(data.checkIn)) },
      { label: "Check-out", value: escapeHtml(formatNZDate(data.checkOut)) },
    ])}
    ${paragraph("Your booking itself has not changed. Only the change you asked the club to allow has lapsed.")}
    ${paragraph("If you still want that change, you can raise a fresh request from your booking.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}
