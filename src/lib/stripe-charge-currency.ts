/**
 * The currency a card is charged in, and the two refusals every charge makes
 * before Stripe is called (#3567, owner decisions D1, D3 and D7).
 *
 * THE CHARGE CURRENCY IS THE CLUB'S STORED CURRENCY. `createPaymentIntent` and
 * `chargePaymentMethod` in `stripe.ts` work it out from the club format they
 * already require, through {@link stripeChargeCurrency}, so what a member is
 * shown and what their card is charged cannot come from two places. Every
 * entry point that can end in a charge also calls it straight after resolving
 * the format — before any claim, ledger row, customer lookup or status write —
 * so a currency this product cannot charge in is refused while nothing has
 * happened yet (#3567 review).
 *
 * A PURE MODULE, deliberately apart from `stripe.ts`: that file is
 * `server-only` and holds the SDK client, while this is the rule, which the
 * demo seed and the entry points share without pulling the SDK in.
 */
import type { ClubFormat } from "@/lib/club-format";
import {
  canonicalCurrencyCode,
  currencyHasTwoDecimalPlaces,
  twoDecimalPlacesRequiredMessage,
} from "@/lib/club-currency-minor-unit";
import { formatCents } from "@/lib/utils";

/** The club's currency does not count in hundredths, so no card is charged. */
export class UnsupportedChargeCurrencyError extends Error {
  constructor(readonly currencyCode: string) {
    super(twoDecimalPlacesRequiredMessage(currencyCode));
    this.name = "UnsupportedChargeCurrencyError";
  }
}

/** The amount is below the Stripe minimum this product checks for. */
export class BelowStripeMinimumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BelowStripeMinimumError";
  }
}

/**
 * The Stripe `currency` for a charge: the club's code, canonicalised the one
 * way (`canonicalCurrencyCode`) and lower-cased. Throws
 * {@link UnsupportedChargeCurrencyError} for a currency without two decimal
 * places (D3).
 */
export function stripeChargeCurrency(format: ClubFormat): string {
  // D3 as the owner decided: refused at PAYMENT time on the STORED value. The
  // resolver keeps displaying a fallback so pages still render, and says which
  // stored code it could not use; no card is charged until an admin fixes it.
  if (format.unusableStoredCurrency) {
    throw new UnsupportedChargeCurrencyError(format.unusableStoredCurrency);
  }
  const code = canonicalCurrencyCode(format.currencyCode);
  if (!currencyHasTwoDecimalPlaces(code)) {
    throw new UnsupportedChargeCurrencyError(code);
  }
  return code.toLowerCase();
}

/**
 * Stripe's minimum charge for the two-decimal currencies this product charges
 * in, as 50 of the currency's hundredths (owner decision D7). Stripe's real
 * minimum varies a little by currency (GBP's is 30p) and Stripe refuses a charge
 * below its own figure itself, so this only stops the obviously-too-small
 * amount early with a readable message.
 */
export const STRIPE_MINIMUM_AMOUNT_CENTS = 50;

export function refuseBelowStripeMinimum(amountCents: number, format: ClubFormat): void {
  if (amountCents > 0 && amountCents < STRIPE_MINIMUM_AMOUNT_CENTS) {
    throw new BelowStripeMinimumError(
      `Amount ${formatCents(amountCents, format)} is below the Stripe minimum (${formatCents(STRIPE_MINIMUM_AMOUNT_CENTS, format)})`,
    );
  }
}

/**
 * True for a refusal this product made BEFORE calling Stripe. Nothing was sent,
 * so no charge can be pending from it: a caller that tracks an attempt treats
 * it as a definite refusal, never as "Stripe may have charged".
 */
export function isLocalChargeRefusal(err: unknown): boolean {
  return err instanceof UnsupportedChargeCurrencyError || err instanceof BelowStripeMinimumError;
}

/**
 * Every refusal this product would make for a charge of `amountCents` before
 * calling Stripe — the currency (D3) or the minimum (D7) — or `null`. The cron
 * asks this BEFORE it claims a booking or mints an attempt row, so a charge that
 * would be refused locally never writes a row at all (#3567 review).
 */
export function localChargeRefusal(format: ClubFormat, amountCents: number): Error | null {
  try {
    stripeChargeCurrency(format);
    refuseBelowStripeMinimum(amountCents, format);
    return null;
  } catch (err) {
    if (isLocalChargeRefusal(err)) return err as Error;
    throw err;
  }
}

/**
 * The entry-point form of the refusal: the error when the club's currency
 * cannot be charged, or `null` when it can. An entry point calls this straight
 * after resolving the format and answers before it claims, writes or looks up
 * anything (#3567 review).
 */
export function chargeCurrencyRefusal(format: ClubFormat): UnsupportedChargeCurrencyError | null {
  try {
    stripeChargeCurrency(format);
    return null;
  } catch (err) {
    if (err instanceof UnsupportedChargeCurrencyError) return err;
    throw err;
  }
}

/** What an administrator is told when a card charge is refused for the currency. */
export const UNSUPPORTED_CHARGE_CURRENCY_ADMIN_MESSAGE =
  "No card was charged: the club's currency does not have two decimal places, and this site can only charge cards in a currency that does. Set a two-decimal currency at Admin → Setup & Configuration → Club Currency & Locale.";

/** What a member is told when the club's currency cannot be charged by card. */
export const UNSUPPORTED_CHARGE_CURRENCY_MEMBER_MESSAGE =
  "Card payments are not available for this club's currency at the moment. Nothing was charged. Please contact the club to arrange payment.";
