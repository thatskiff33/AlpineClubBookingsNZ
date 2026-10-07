/**
 * Reads the administrator-set NZD -> club-currency rate for AI spend (#3354).
 * The arithmetic and grammar live in the client-safe `ai-spend-currency.ts`;
 * this file is the one database reader, and `/api/admin/ai-spend-currency` is
 * the one writer of a rate (the club-format route is the one CLEARER of it —
 * see below).
 *
 * THE CLUB SIDE IS THE CLUB'S STORED CURRENCY (#3566, owner decision 3). It
 * used to be `APP_CURRENCY`, the server's environment, while the cap beside it
 * was labelled from the stored setting — so a club that switched from NZD to
 * CHF in the admin panel saw "Monthly cap (CHF)", a rate card saying there was
 * nothing to convert, and every NZ cent counted as a Swiss centime. The reader
 * now reads the stored currency itself, THROUGH THE SAME CLIENT as the rate —
 * inside the diagnostics reserve and settle that is their transaction, so the
 * currency, the rate and the budget come from one snapshot under one lock and
 * no second connection is opened under it (`INV-LOCK-004`). A failed read
 * PROPAGATES, like the rate's: pricing NZ cents as a currency we could not
 * confirm is not fail-closed. The REFERENCE side is unchanged and deliberately
 * independent of the club: the AI price table is written in NZD
 * (`AI_PRICE_TABLE_CURRENCY`), and following the club there would need live
 * exchange rates the product does not have.
 *
 * A stored rate does not record which currency it was set for, so a club that
 * changes currency has its rate CLEARED in the same transaction
 * (`/api/admin/club-format`, owner decision 4): a CHF rate would otherwise go on
 * pricing a later EUR or JPY club's spend.
 */

import { CLUB_FORMAT_SETTINGS_ID } from "@/lib/club-format";
import { resolveStoredClubFormat } from "@/lib/club-format-env";
import { prisma } from "@/lib/prisma";
import {
  AI_PRICE_TABLE_CURRENCY,
  IDENTITY_RATE_MICROS,
  isValidRateMicros,
  type AiSpendCurrency,
} from "@/lib/ai-spend-currency";

export const AI_SPEND_CURRENCY_SETTINGS_ID = "default";

/**
 * The delegate-guard view of a Prisma client (the same `(args: unknown) =>
 * unknown` shape `ai-assistant-usage.ts` uses), so the global client or an
 * interactive-transaction client can be passed and an old-colour client with
 * no delegate is a `undefined` rather than a throw.
 */
type AiSpendCurrencyReader = {
  aiSpendCurrencySettings?: {
    findUnique?: (args: unknown) => unknown;
  };
  clubFormatSettings?: {
    findUnique?: (args: unknown) => unknown;
  };
};

type AiSpendCurrencyRow = {
  clubUnitsPerNzdMicros: number;
  rateSetAt: Date;
  rateSetByMemberId: string | null;
};

/**
 * The identity answer for one club currency: 1 NZD = 1 club unit, nothing
 * stored. Built per call rather than frozen at module load, because the club's
 * currency is a setting that changes at runtime rather than a constant — a
 * module-level identity keyed on the currency seen first would be the
 * environment-constant defect over again. A fresh object per call also means a
 * caller that mutated it could not re-price anybody else's call.
 */
function identityAiSpendCurrency(clubCurrency: string): AiSpendCurrency {
  return {
    clubCurrency,
    isNzd: clubCurrency === AI_PRICE_TABLE_CURRENCY,
    clubUnitsPerNzdMicros: IDENTITY_RATE_MICROS,
    rateSetAt: null,
    rateSetByMemberId: null,
    isConfigured: false,
  };
}

/**
 * The rate in force, read ONCE per call or roundtrip alongside the settings
 * read — never per token.
 *
 *  - `clubCurrency === AI_PRICE_TABLE_CURRENCY`: the identity rate,
 *    `isNzd: true`, and the table is never read (a New Zealand club has nothing
 *    to convert).
 *  - Otherwise the singleton row; when none is stored, identity with
 *    `isConfigured: false` — which is how spend was priced before #3354, so no
 *    existing deployment changes behaviour until an administrator sets a rate.
 *  - A missing delegate (an old-colour client through a blue/green drain) or a
 *    stored value outside the parser's bounds falls back to identity the same
 *    way `loadDiagnosticsBudgetCents` falls back to its default. That fallback
 *    is NOT fail-closed — identity under-counts a non-NZD club's spend rather
 *    than denying it — and is safe only because no released code can reach
 *    either path: the delegate is generated with the table, and the one writer
 *    refuses a value the parser refuses. A DATABASE ERROR propagates: every
 *    caller sits behind a fail-closed catch that denies the spend, and a rate
 *    we could not read is not a rate to price at.
 *
 * The club's currency is read through `db` too (#3566) — see the module doc.
 * A missing `clubFormatSettings` delegate (an old-colour client) resolves to
 * the environment seed, the same answer `getClubFormat()` gives for an absent
 * row; a database ERROR propagates. Pass a transaction client as `db` to read
 * inside an existing transaction (the diagnostics reserve and settle do, so the
 * currency, the rate and the budget come from the same snapshot under the same
 * lock).
 */
export async function loadAiSpendCurrency(
  db: unknown = prisma,
): Promise<AiSpendCurrency> {
  const reader = db as AiSpendCurrencyReader;
  const findFormat = reader.clubFormatSettings?.findUnique;
  const storedFormat = findFormat
    ? ((await findFormat({
        where: { id: CLUB_FORMAT_SETTINGS_ID },
        select: { currencyCode: true, locale: true },
      })) as { currencyCode: string; locale: string } | null)
    : null;
  const clubCurrency = resolveStoredClubFormat(storedFormat).currencyCode;
  const identity = identityAiSpendCurrency(clubCurrency);
  if (identity.isNzd) return identity;
  const findUnique = reader.aiSpendCurrencySettings?.findUnique;
  if (!findUnique) return identity;
  const row = (await findUnique({
    where: { id: AI_SPEND_CURRENCY_SETTINGS_ID },
  })) as AiSpendCurrencyRow | null;
  if (!row || !isValidRateMicros(row.clubUnitsPerNzdMicros)) return identity;
  return {
    clubCurrency,
    isNzd: false,
    clubUnitsPerNzdMicros: row.clubUnitsPerNzdMicros,
    rateSetAt: row.rateSetAt,
    rateSetByMemberId: row.rateSetByMemberId,
    isConfigured: true,
  };
}
