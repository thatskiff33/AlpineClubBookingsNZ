/**
 * #4300 (`INV-PAY-138`): what a card success on the `/pay` link actually did,
 * asked of the server rather than assumed. Stripe's "succeeded" only says money
 * moved: the payment may have settled the booking, or (an intent an edit had
 * superseded) be going back while the booking still owes.
 *
 * First the link's own context: `paid` there is the answer. Otherwise the
 * payment-intent route again, told which intent was just paid: `alreadyPaid` is
 * paid; a fresh secret is the booking still owing, with the refreshed context
 * (so the amount shown is the one the new intent charges) and the going-back
 * notice exactly when the server says so; a known refusal is shown as such.
 * Anything else - a 410 because the webhook settled (or capacity-cancelled) the
 * booking in between, a 429, a network failure, the paid intent handed back as
 * if unpaid - reads the context once more (a webhook that has just settled it
 * shows the paid page), else ends in "Payment received - check booking status",
 * never back at the pay buttons.
 */
import {
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE,
} from "@/lib/payment-recovery-contract";
import { paymentRecoveryForRefusal, type PaymentLinkContext, type PaymentRecovery } from "./pay-link-presentation";

export type CardSuccessOutcome =
  | { kind: "paid"; context: PaymentLinkContext | null }
  | { kind: "fresh"; clientSecret: string; previousPaymentRefunding: boolean; context: PaymentLinkContext | null }
  | { kind: "recovery"; recovery: PaymentRecovery };

const STATUS_UNCONFIRMED: CardSuccessOutcome = {
  kind: "recovery",
  recovery: { heading: "Payment received - check booking status", message: PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE },
};

/** The link's context, or null when it cannot be read. */
async function readContext(path: string): Promise<PaymentLinkContext | null> {
  try {
    const response = await fetch(path);
    return response.ok ? ((await response.json().catch(() => null)) as PaymentLinkContext | null) : null;
  } catch {
    return null;
  }
}

export async function checkCardSuccess(token: string, paidIntentId: string): Promise<CardSuccessOutcome> {
  const path = `/api/pay/${encodeURIComponent(token)}`;
  const context = await readContext(path);
  if (context?.state === "paid") return { kind: "paid", context };
  const settledMeanwhile = async (): Promise<CardSuccessOutcome> => {
    const again = await readContext(path);
    return again?.state === "paid" ? { kind: "paid", context: again } : STATUS_UNCONFIRMED;
  };
  try {
    const response = await fetch(`${path}/payment-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paidPaymentIntentId: paidIntentId }),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const recovery = response.status === 409 ? paymentRecoveryForRefusal(data) : null;
      return recovery ? { kind: "recovery", recovery } : settledMeanwhile();
    }
    if (data.alreadyPaid === true) return { kind: "paid", context: null };
    // The intent just paid handed back as if unpaid is no fresh payment to make.
    if (typeof data.clientSecret !== "string" || data.paymentIntentId === paidIntentId) return settledMeanwhile();
    return {
      kind: "fresh",
      clientSecret: data.clientSecret,
      previousPaymentRefunding: data.previousPaymentRefunding === true,
      context,
    };
  } catch {
    return settledMeanwhile();
  }
}
