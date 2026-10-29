/**
 * #3638: the admin alert for a booking a card payment settled and Xero then
 * reported paid as well, and #3979's for a bank transfer whose recorded amount
 * needs checking. Split from `admin-alerts-finance.ts` by size; the barrel
 * (`./admin-alerts`) re-exports them with the rest of the family.
 */
import { adminSecondInstrumentSettlementConflictTemplate } from "@/lib/email-templates/admin-finance";
import { adminBankTransferSettlementFigureTemplate } from "@/lib/email-templates/admin-bank-transfer-settlement";
import { adminDuplicateCaptureKeptTemplate } from "@/lib/email-templates/admin-duplicate-capture-kept";
import { adminSupersededCaptureRefusedTemplate } from "@/lib/email-templates/admin-superseded-capture-refused";
import { supersededCaptureRefusedAction, supersededCaptureRefusedParagraph } from "@/lib/superseded-capture-refused-note";
import {
  duplicateCaptureKeptAction,
  duplicateCaptureKeptParagraph,
  type CancellationRefundNote,
  type DuplicateCaptureKeptReason,
} from "@/lib/duplicate-capture-kept-note";
import { ibSettlementFigureParagraph, type IbSettlementKeptReason } from "@/lib/ib-settlement-figure-note";
import { secondInstrumentConflictOutcomeParagraph } from "../email-message-notes";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendUnmuteableAdminAlert } from "./admin-alerts-shared";
import { stampXeroOrganisation } from "./admin-alert-xero-links";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3638 (`INV-PAY-102`): a card payment settled the booking and Xero then
 * reported its Internet Banking invoice paid as well — the club may hold the
 * price twice. It first shipped as a generic "Payment Failed" mail through
 * `sendAdminPaymentFailureAlert`, which misdescribed the event (#2761's
 * finding) and let the `adminPaymentFailure` checkbox mute it.
 *
 * ITS OWN SUBJECT, naming the double payment. NOT GATED ON A NOTIFICATION
 * PREFERENCE, and delivery-locked in the registry, through
 * `sendUnmuteableAdminAlert` — the #2774 reasoning: this is the one thing that
 * pulls a person to reconcile money the club may hold twice, and the system
 * refunds nothing on its own. Same audience as its siblings: whoever can edit
 * finance.
 *
 * Repeat sends are throttled by the caller with a cross-instance AlertCooldown
 * claim keyed on (payment, invoice). #2262's sibling alert
 * (`sendAdminManualSettlementConflictAlert`) is unchanged: its registry entry
 * records a deliberate decision not to lock it.
 */
export async function sendAdminSecondInstrumentSettlementConflictAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  bookingId: string;
  bookingStatus: string;
  conflictKind: "settled" | "cancelledAfterCard" | "cancelledAfterRefund";
  invoiceAmountCents: number;
  cardHeldCents: number;
  cardPaymentIntentId: string | null;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
},
  format: ClubFormat,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const bookingUrl = `${baseUrl}/bookings/${data.bookingId}`;
  const xeroInvoiceUrl = await stampXeroOrganisation(data.xeroInvoiceUrl);

  await sendUnmuteableAdminAlert({
    subject: `Booking may have been paid twice — card and Xero: ${data.memberName}`,
    html: await renderEmailHtml(() =>
      adminSecondInstrumentSettlementConflictTemplate(
        { ...data, xeroInvoiceUrl, bookingUrl, reviewUrl },
        format,
      ),
    ),
    templateName: "admin-second-instrument-settlement-conflict",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingId: data.bookingId,
      status: data.bookingStatus,
      amount: formatMoneyCents(data.invoiceAmountCents, format),
      paidAmount: formatMoneyCents(data.cardHeldCents, format),
      paymentIntentId: data.cardPaymentIntentId ?? "",
      xeroInvoiceNumber: data.xeroInvoiceNumber ?? "",
      xeroObjectUrl: xeroInvoiceUrl ?? "",
      bookingUrl,
      reviewUrl,
      // The same sentence the hand-built HTML renders, so an admin's saved
      // default cannot describe the other case (#2268 convention).
      secondInstrumentConflictNote: secondInstrumentConflictOutcomeParagraph(
        data.conflictKind,
      ),
    },
    requirement: { area: "finance", level: "edit" },
  });
}

/**
 * #3979 (`INV-PAY-125`): the inbound settle recorded a bank transfer but kept
 * the stored figure instead of the invoice's cash, or the cash is not what the
 * booking owes. It first shipped through `sendAdminPaymentFailureAlert`
 * ("Payment Failed"), which misdescribed it and let the `adminPaymentFailure`
 * checkbox mute it. ITS OWN SUBJECT, NOT GATED ON A NOTIFICATION PREFERENCE and
 * delivery-locked in the registry, through `sendUnmuteableAdminAlert`, as #3638's
 * sibling above: a wrong recorded figure sizes every later refund and credit,
 * and this mail is what pulls a person to check it. Same audience: whoever can
 * edit finance. Sent once per marker by the caller
 * (`raiseCashSettlementAlert`).
 */
export async function sendAdminBankTransferSettlementFigureAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  bookingId: string;
  keptReason: IbSettlementKeptReason | null;
  owed: "overpaid" | "underpaid" | null;
  hasSupplementaryInvoice: boolean;
  recordedCents: number;
  cashCents: number;
  owedCents: number | null;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
},
  format: ClubFormat,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const bookingUrl = `${baseUrl}/bookings/${data.bookingId}`;
  const xeroInvoiceUrl = await stampXeroOrganisation(data.xeroInvoiceUrl);

  return sendUnmuteableAdminAlert({
    subject: `Bank transfer amount needs checking: ${data.memberName}`,
    html: await renderEmailHtml(() =>
      adminBankTransferSettlementFigureTemplate({ ...data, xeroInvoiceUrl, bookingUrl, reviewUrl }, format),
    ),
    templateName: "admin-bank-transfer-settlement-figure",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingId: data.bookingId,
      amount: formatMoneyCents(data.recordedCents, format),
      paidAmount: formatMoneyCents(data.cashCents, format),
      amountOwing: data.owedCents === null ? "as recorded" : formatMoneyCents(data.owedCents, format),
      xeroInvoiceNumber: data.xeroInvoiceNumber ?? "",
      xeroObjectUrl: xeroInvoiceUrl ?? "",
      bookingUrl,
      reviewUrl,
      settlementFigureNote: ibSettlementFigureParagraph({
        keptReason: data.keptReason,
        owed: data.owed,
        hasSupplementaryInvoice: data.hasSupplementaryInvoice,
      }),
    },
    requirement: { area: "finance", level: "edit" },
  });
}

/**
 * #4211 (`INV-PAY-043`): the duplicate-capture guard KEPT a card capture on a
 * paid booking - another payment on it still holds money and nothing records
 * which one settled it - so nothing was refunded and a person decides. It first
 * shipped through `sendAdminPaymentFailureAlert` ("Payment Failed"), which
 * misdescribed it and let the `adminPaymentFailure` checkbox and a digest-only
 * delivery mode silence it. ITS OWN SUBJECT, NOT GATED ON A NOTIFICATION
 * PREFERENCE and delivery-locked in the registry, through
 * `sendUnmuteableAdminAlert`, as #3638's sibling above: the system refunds
 * nothing on its own and this mail is the only thing that pulls a person to it.
 * Same audience: whoever can edit finance. Throttled by the caller
 * (`alertCaptureKeptWithoutRecordedSettler`).
 */
export async function sendAdminDuplicateCaptureKeptAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  bookingId: string;
  reason: DuplicateCaptureKeptReason;
  amountCents: number;
  paymentIntentId: string;
  otherPaymentIntentId: string | null;
  otherHoldsMoney?: boolean;
  cancellationRefund?: CancellationRefundNote | null;
},
  format: ClubFormat,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const bookingUrl = `${baseUrl}/bookings/${data.bookingId}`;

  await sendUnmuteableAdminAlert({
    subject: `Booking may have been paid twice — check by hand: ${data.memberName}`,
    html: await renderEmailHtml(() =>
      adminDuplicateCaptureKeptTemplate({ ...data, bookingUrl, reviewUrl }, format),
    ),
    templateName: "admin-duplicate-capture-kept",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingId: data.bookingId,
      amount: formatMoneyCents(data.amountCents, format),
      paymentIntentId: data.paymentIntentId,
      bookingUrl,
      reviewUrl,
      // The same sentence the hand-built HTML renders (#2268 convention).
      duplicateCaptureKeptNote: duplicateCaptureKeptParagraph({
        reason: data.reason,
        otherPaymentIntentId: data.otherPaymentIntentId,
        otherHoldsMoney: data.otherHoldsMoney,
        cancellationRefund: data.cancellationRefund,
      }),
      // What to do differs too: with nothing else holding money this payment
      // may be the one paying for the booking (#4211 review).
      duplicateCaptureKeptAction: duplicateCaptureKeptAction({ otherHoldsMoney: data.otherHoldsMoney, reason: data.reason }),
    },
    requirement: { area: "finance", level: "edit" },
  });
}

/**
 * #4300 (`INV-PAY-138`): the settle refused a card capture the superseded
 * machinery owns. It first shipped as the generic "Payment Failed" mail, which
 * misdescribed it and could be muted; now its own template, through
 * `sendUnmuteableAdminAlert` and delivery-locked, for whoever can edit finance.
 * Throttled by the caller (`reportSupersededCaptureRefused`).
 */
export async function sendAdminSupersededCaptureRefusedAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  bookingId: string;
  bookingCancelled: boolean;
  amountCents: number;
  paymentIntentId: string;
},
  format: ClubFormat,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const bookingUrl = `${baseUrl}/bookings/${data.bookingId}`;

  await sendUnmuteableAdminAlert({
    subject: `Card payment on a replaced payment — not applied: ${data.memberName}`,
    html: await renderEmailHtml(() =>
      adminSupersededCaptureRefusedTemplate({ ...data, bookingUrl, reviewUrl }, format),
    ),
    templateName: "admin-superseded-capture-refused",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingId: data.bookingId,
      amount: formatMoneyCents(data.amountCents, format),
      paymentIntentId: data.paymentIntentId,
      bookingUrl,
      reviewUrl,
      // The same sentences the hand-built HTML renders (#2268 convention).
      supersededCaptureNote: supersededCaptureRefusedParagraph({ bookingCancelled: data.bookingCancelled }),
      supersededCaptureAction: supersededCaptureRefusedAction({ bookingCancelled: data.bookingCancelled }),
    },
    requirement: { area: "finance", level: "edit" },
  });
}
