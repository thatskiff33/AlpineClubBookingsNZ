import "server-only";

import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { clearAiSpendRateOnCurrencyChange } from "@/lib/ai-spend-currency-clear";
import { resolveStoredClubFormat } from "@/lib/club-format-env";
import {
  CLUB_FORMAT_SETTINGS_ID,
  CLUB_FORMAT_SETTINGS_SELECT,
  type PersistedClubFormatSettings,
} from "@/lib/club-format-settings";
import { prisma } from "@/lib/prisma";

/**
 * The club currency and locale WRITE behind `PUT /api/admin/club-format`
 * (stage 1 of programme #3205, #3563; INV-CONFIG-006). The route validates,
 * authorises and answers; this is the transaction, moved here so the route
 * stays a boundary (`docs/ARCHITECTURE.md` -> "Where code lives").
 *
 * THE TRANSACTION TOUCHES EXACTLY THREE TABLES — `ClubFormatSettings`, `AuditLog`
 * and, on a CURRENCY change only, `AiSpendCurrencySettings`, whose rate it clears
 * (#3566; `ai-spend-currency-clear.ts` says why) — a contract, not a detail. No
 * stored amount is rewritten: every `Int` column of cents holds what it held,
 * and no payment, invoice or credit is re-denominated. A write here reaching a
 * booking, a payment or a member would be that promise broken, so the route's
 * test enumerates the delegates and fails if any other one is called.
 *
 * SERIALIZABLE, AND NO ADVISORY LOCK. A single-row configuration upsert
 * composes no capacity claim, no settlement money and no lifecycle transition,
 * which is what `docs/CONCURRENCY_AND_LOCKING.md` reserves the lock tiers for —
 * but it does need its recorded BEFORE value to be true. At Prisma's default
 * READ COMMITTED a `findUnique` takes no row lock, so two administrators saving
 * at once could each read NZD, both write, and leave a trail claiming two
 * changes FROM NZD: the intermediate value the trail exists to show is simply
 * lost, and the dirty gate can miss a re-save that had already happened.
 * Serializable aborts the loser instead, which writes nothing at all and is
 * answered a retryable 503. The same shape `/api/admin/club-time-zone` carries.
 */
export type ClubFormatWriteOutcome =
  | { changed: false; row: PersistedClubFormatSettings }
  | { changed: false; refused: true }
  | { changed: true; row: PersistedClubFormatSettings };

export async function writeClubFormat({
  currencyCode,
  locale,
  currencyChangeConfirmed,
  actingMemberId,
  request,
}: {
  currencyCode: string;
  locale: string;
  /** The second tick a CURRENCY change needs (#3567 D2); see below. */
  currencyChangeConfirmed: boolean;
  actingMemberId: string;
  request: Request;
}): Promise<ClubFormatWriteOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const before = await tx.clubFormatSettings.findUnique({
        where: { id: CLUB_FORMAT_SETTINGS_ID },
        select: CLUB_FORMAT_SETTINGS_SELECT,
      });

      /*
        DIRTY GATING (docs/ARCHITECTURE.md -> "Admin/member layer"). Re-saving the
        pair already stored writes nothing: no row, no `updatedAt` bump and no
        audit row. A trail recording changes that never happened is worse than
        no trail, because the next reader cannot tell the difference. The
        isolation level above — not this read sitting inside the transaction —
        keeps `before` true at commit time, so a concurrent save can neither slip
        past this gate nor make the audit row name a currency already left.
      */
      if (
        before &&
        before.currencyCode === currencyCode &&
        before.locale === locale
      ) {
        return { changed: false as const, row: before };
      }

      /*
        A CURRENCY CHANGE MOVES CARD CHARGES (#3567 D1), so it carries its own
        acknowledgement, judged against the currency the club is EFFECTIVELY
        on — the environment seed while nothing is persisted, the same
        judgement the AI-rate clear below makes. Refused here, inside the
        transaction, so the "before" it is judged against is the one the
        write would replace. Nothing has been written yet.
      */
      if (
        resolveStoredClubFormat(before).currencyCode !== currencyCode &&
        !currencyChangeConfirmed
      ) {
        return { changed: false as const, refused: true as const };
      }

      const row = await tx.clubFormatSettings.upsert({
        where: { id: CLUB_FORMAT_SETTINGS_ID },
        update: { currencyCode, locale, updatedByMemberId: actingMemberId },
        create: {
          id: CLUB_FORMAT_SETTINGS_ID,
          currencyCode,
          locale,
          updatedByMemberId: actingMemberId,
        },
        select: CLUB_FORMAT_SETTINGS_SELECT,
      });
      await clearAiSpendRateOnCurrencyChange(tx, { before, currencyCode, actingMemberId, request });

      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "CLUB_FORMAT_UPDATED",
          actor: { memberId: actingMemberId },
          entity: { type: "ClubFormatSettings", id: CLUB_FORMAT_SETTINGS_ID },
          // Installation configuration, like CLUB_TIME_ZONE_UPDATED and
          // CLUB_IDENTITY_SETTINGS_UPDATED.
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: "Club currency and locale updated",
          /*
            THE BEFORE AND AFTER PAIR, AND NOTHING ELSE. A `before` of null
            means nothing was persisted yet. No request echo, no settings
            blob, and nothing about the actor beyond the id the row already
            carries.
          */
          metadata: {
            before: before
              ? { currencyCode: before.currencyCode, locale: before.locale }
              : null,
            after: { currencyCode, locale },
          },
          request: getAuditRequestContext(request),
        }),
      );

      return { changed: true as const, row };
    },
    { isolationLevel: "Serializable" },
  );
}
