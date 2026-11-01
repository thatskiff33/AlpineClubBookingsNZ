import "server-only";

import {
  creditReleaseShareCents,
  isPureCreditReleaseChain,
  type AdditionalAskChainRow,
} from "@/lib/additional-ask-cause";
import { loadBankTransferOffer, type BankTransferOffer } from "@/lib/credit-release-bank-transfer";
import { signalCreditReleaseToOfficers, type CreditReleaseWithheldReason } from "@/lib/release-ask-officer-signal";
import logger from "@/lib/logger";
import {
  isXeroInvoiceNotFound,
  openBalanceCents,
  readXeroInvoiceBalance,
  type XeroInvoiceBalanceReader,
} from "@/lib/xero-invoice-balance";

/**
 * MAY THIS PAYMENT REQUEST BE EMAILED, AND MAY IT OFFER A BANK TRANSFER? (#4253 release 2,
 * `INV-ADDPAY-049`, `INV-ADDPAY-051`, owner decision D6: "anything the sweep cannot match fails
 * closed to the officers' queue").
 *
 * Asked BEFORE a reminder's stamp is claimed - by the reminder cron and by an officer's re-send -
 * so everything the email needs is in hand before anything is spent, and an unreadable answer
 * costs nothing (the reminder stays due). It reads the booking's invoice with the one reader the
 * request's sizing uses (`readXeroInvoiceBalance`), outside every transaction and lock, and only
 * for a request that includes released credit; a request that is only a change is never read.
 *
 * - Xero showing LESS open on the invoice than the request's released credit (a transfer that paid
 *   part of it), or the invoice not open at all (paid, voided, not yet approved), withholds the
 *   reminder for an officer: never a card chase for money that may already be paid, and never an
 *   automatic close or resize on a part payment.
 * - A request that cannot be matched to the invoice - none in Xero, Xero answering that it has no
 *   such invoice (a definite 404) or giving no amount due - is withheld for an officer too: those
 *   are answers, and retrying them would only skip the reminder silently for ever. Only a read that
 *   got no answer (Xero down, rate-limited, a 5xx) is "unreadable" and waits for the next pass.
 * - A bank transfer is offered only where it would pay exactly what is asked: a request made only
 *   of released credit (`isPureCreditReleaseChain`) whose amount EQUALS the invoice's open balance
 *   now. Then a transfer of the quoted invoice clears the invoice, which the closer turns into a
 *   closed request; any other amount would leave the invoice part-paid.
 */
export type CreditReleaseReminderGate =
  | { send: true; bankTransfer: BankTransferOffer | null }
  /** Withheld for an officer (`signalCreditReleaseToOfficers`). */
  | { send: false; reason: CreditReleaseWithheldReason; detail: Record<string, unknown> }
  /** Xero could not be read: nothing claimed, nothing told, the reminder stays due for the next pass. */
  | { send: false; reason: "invoice-unreadable"; detail: Record<string, unknown> };

export async function resolveCreditReleaseReminderGate(params: {
  /** The payment's ADDITIONAL rows, newest first, with their amounts. */
  rows: readonly AdditionalAskChainRow[];
  /** What the request asks for now (`Payment.additionalAmountCents`). */
  askCents: number;
  xeroInvoiceId: string | null;
  readInvoiceBalance?: XeroInvoiceBalanceReader;
}): Promise<CreditReleaseReminderGate> {
  const shareCents = creditReleaseShareCents(params.rows);
  if (shareCents === 0) return { send: true, bankTransfer: null };
  if (shareCents === null || !params.xeroInvoiceId) {
    return { send: false, reason: "request-unmatched", detail: { shareCents, hasInvoice: Boolean(params.xeroInvoiceId) } };
  }
  let open: number | null;
  let invoiceNumber: string | null;
  try {
    const balance = await (params.readInvoiceBalance ?? readXeroInvoiceBalance)(params.xeroInvoiceId);
    if (balance.amountDueCents === null) {
      // Xero answered and gave no amount due: an answer, not an outage.
      return { send: false, reason: "request-unmatched", detail: { invoiceStatus: balance.status, amountDueMissing: true } };
    }
    open = openBalanceCents(balance);
    if (open === null) {
      return { send: false, reason: "invoice-not-open", detail: { invoiceStatus: balance.status, shareCents, askCents: params.askCents } };
    }
    invoiceNumber = balance.invoiceNumber;
  } catch (err) {
    if (isXeroInvoiceNotFound(err)) {
      return { send: false, reason: "request-unmatched", detail: { invoiceNotFound: true } };
    }
    logger.warn({ err, xeroInvoiceId: params.xeroInvoiceId }, "Could not read the booking's Xero invoice before a payment request; leaving it for the next pass");
    return { send: false, reason: "invoice-unreadable", detail: {} };
  }
  if (open < shareCents) {
    return { send: false, reason: "invoice-part-paid", detail: { invoiceOpenCents: open, shareCents, askCents: params.askCents } };
  }
  const offerable = isPureCreditReleaseChain(params.rows) && open === params.askCents;
  return { send: true, bankTransfer: offerable ? await loadBankTransferOffer(invoiceNumber) : null };
}

/** What the reminder cron does with a request before it may claim the stamp. */
export type CreditReleaseReminderPreparation =
  | { outcome: "send"; bankTransfer: BankTransferOffer | null }
  /** Withheld for an officer, who has been told once. */
  | { outcome: "withheld" }
  /** Xero could not be read: skipped quietly, still due. */
  | { outcome: "unreadable" }
  /** Something the email needs could not be prepared: logged, nothing claimed. */
  | { outcome: "failed" };

/**
 * The cron's one call before a claim: the gate above, the officers' note on a withhold
 * (`signalCreditReleaseToOfficers`, keyed on the live request and its amount), and any failure
 * caught here so it can never reach the stamp.
 */
export async function prepareCreditReleaseReminder(params: {
  bookingId: string;
  paymentId: string;
  /** The live request's card payment, which the officers' note is keyed on. */
  liveIntentId: string | null;
  rows: readonly AdditionalAskChainRow[];
  askCents: number;
  xeroInvoiceId: string | null;
}): Promise<CreditReleaseReminderPreparation> {
  try {
    const gate = await resolveCreditReleaseReminderGate(params);
    if (gate.send) return { outcome: "send", bankTransfer: gate.bankTransfer };
    if (gate.reason === "invoice-unreadable") return { outcome: "unreadable" };
    await signalCreditReleaseToOfficers({
      bookingId: params.bookingId,
      reason: gate.reason,
      key: `${gate.reason}:${params.liveIntentId ?? params.paymentId}:${params.askCents}`,
      metadata: { paymentId: params.paymentId, ...gate.detail },
    });
    return { outcome: "withheld" };
  } catch (err) {
    logger.error(
      { err, bookingId: params.bookingId, job: "additionalPaymentReminders" },
      "Could not prepare a payment request before claiming its reminder; nothing was claimed",
    );
    return { outcome: "failed" };
  }
}
