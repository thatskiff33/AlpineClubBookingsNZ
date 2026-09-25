import type { Prisma } from "@prisma/client";

import { AI_SPEND_CURRENCY_SETTINGS_ID } from "@/lib/ai-spend-currency-settings";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { resolveClubFormat, type ClubFormatCandidate } from "@/lib/club-format";
import { readEnvironmentClubFormatSeed } from "@/lib/club-format-env";

/**
 * A change of the club's CURRENCY clears the stored AI spend conversion rate
 * (#3566, owner decision 4), inside the caller's transaction.
 *
 * WHY A CLEAR AND NOT A CONVERSION. The rate is "how many of the club's
 * currency one NZ dollar buys", and `AiSpendCurrencySettings` does not record
 * which currency it was set for. After a currency change it would silently go
 * on pricing the new currency's spend at the old one's rate — a CHF rate
 * under-counts a JPY club about 170 times, in the direction that trips the cap
 * far too late. Deleting it puts the club in the existing state of a new
 * non-NZD club: both AI cards say the rate is not set, and spend is counted at
 * identity until an administrator enters one. A schema change stamping each
 * rate with its currency was the alternative, declined for this stage.
 *
 * WHAT COUNTS AS A CHANGE. "Before" is the currency the club was EFFECTIVELY
 * on, which is the environment seed while nothing is persisted — so the first
 * save of an unchanged seed currency does not clear a rate set against it. A
 * locale-only save never reaches the table.
 *
 * THE ONE CALLER is `/api/admin/club-format`'s Serializable transaction, whose
 * three-table contract this is the third table of; `/api/admin/ai-spend-currency`
 * re-reads the currency inside its own Serializable transaction, so a rate
 * saved across a currency change is refused rather than resurrected. Records
 * `AI_SPEND_CURRENCY_RATE_CLEARED` — only when a rate was actually stored.
 */
export async function clearAiSpendRateOnCurrencyChange(
  tx: Prisma.TransactionClient,
  input: {
    before: ClubFormatCandidate | null;
    currencyCode: string;
    actingMemberId: string;
    request: Request;
  },
): Promise<void> {
  const previousCurrency = resolveClubFormat(
    input.before,
    readEnvironmentClubFormatSeed(),
  ).currencyCode;
  if (previousCurrency === input.currencyCode) return;

  const cleared = await tx.aiSpendCurrencySettings.findUnique({
    where: { id: AI_SPEND_CURRENCY_SETTINGS_ID },
    select: { clubUnitsPerNzdMicros: true },
  });
  if (!cleared) return;

  await tx.aiSpendCurrencySettings.deleteMany({
    where: { id: AI_SPEND_CURRENCY_SETTINGS_ID },
  });
  await tx.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "AI_SPEND_CURRENCY_RATE_CLEARED",
      actor: { memberId: input.actingMemberId },
      entity: {
        type: "AiSpendCurrencySettings",
        id: AI_SPEND_CURRENCY_SETTINGS_ID,
      },
      // The sibling of AI_SPEND_CURRENCY_RATE_UPDATED, and `admin` for the
      // same reason: installation configuration.
      category: "admin",
      severity: "important",
      outcome: "success",
      summary:
        "AI spend conversion rate cleared because the club's currency changed",
      metadata: {
        previousCurrency,
        newCurrency: input.currencyCode,
        previousClubUnitsPerNzdMicros: cleared.clubUnitsPerNzdMicros,
      },
      request: getAuditRequestContext(input.request),
    }),
  );
}
