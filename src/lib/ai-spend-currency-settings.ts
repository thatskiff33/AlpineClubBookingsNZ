/**
 * Reads the administrator-set NZD -> club-currency rate for AI spend (#3354).
 * The arithmetic and grammar live in the client-safe `ai-spend-currency.ts`;
 * this file is the one database reader, and `/api/admin/ai-spend-currency` is
 * the one writer.
 */

import { APP_CURRENCY } from "@/config/operational";
import { prisma } from "@/lib/prisma";
import {
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
};

type AiSpendCurrencyRow = {
  clubUnitsPerNzdMicros: number;
  rateSetAt: Date;
  rateSetByMemberId: string | null;
};

const IDENTITY: AiSpendCurrency = {
  clubCurrency: APP_CURRENCY,
  isNzd: APP_CURRENCY === "NZD",
  clubUnitsPerNzdMicros: IDENTITY_RATE_MICROS,
  rateSetAt: null,
  rateSetByMemberId: null,
  isConfigured: false,
};

/**
 * The rate in force, read ONCE per call or roundtrip alongside the settings
 * read — never per token.
 *
 *  - `APP_CURRENCY === "NZD"`: the identity rate, `isNzd: true`, and the table
 *    is never read (a New Zealand club has nothing to convert).
 *  - Otherwise the singleton row; when none is stored, identity with
 *    `isConfigured: false` — which is how spend was priced before #3354, so no
 *    existing deployment changes behaviour until an administrator sets a rate.
 *  - A missing delegate (an old-colour client through a blue/green drain) or a
 *    stored value outside the parser's bounds falls back to identity the same
 *    way `loadDiagnosticsBudgetCents` falls back to its default. A DATABASE
 *    ERROR propagates: every caller sits behind a fail-closed catch that
 *    denies the spend, and a rate we could not read is not a rate to price at.
 *
 * Pass a transaction client as `db` to read inside an existing transaction
 * (the diagnostics reserve and settle do, so the rate and the budget come from
 * the same snapshot under the same lock).
 */
export async function loadAiSpendCurrency(
  db: unknown = prisma,
): Promise<AiSpendCurrency> {
  if (IDENTITY.isNzd) return IDENTITY;
  const findUnique = (db as AiSpendCurrencyReader).aiSpendCurrencySettings?.findUnique;
  if (!findUnique) return IDENTITY;
  const row = (await findUnique({
    where: { id: AI_SPEND_CURRENCY_SETTINGS_ID },
  })) as AiSpendCurrencyRow | null;
  if (!row || !isValidRateMicros(row.clubUnitsPerNzdMicros)) return IDENTITY;
  return {
    clubCurrency: APP_CURRENCY,
    isNzd: false,
    clubUnitsPerNzdMicros: row.clubUnitsPerNzdMicros,
    rateSetAt: row.rateSetAt,
    rateSetByMemberId: row.rateSetByMemberId,
    isConfigured: true,
  };
}
