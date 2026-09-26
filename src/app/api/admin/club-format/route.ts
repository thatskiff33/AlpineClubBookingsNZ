import { NextResponse } from "next/server";
import { z } from "zod";

import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { clearAiSpendRateOnCurrencyChange } from "@/lib/ai-spend-currency-clear";
import {
  normaliseClubCurrencyCode,
  normaliseClubLocale,
} from "@/lib/club-format";
import { stateFromResolved, stateFromRow } from "@/lib/club-format-admin-state";
import {
  currencyHasTwoDecimalPlaces,
  twoDecimalPlacesRequiredMessage,
} from "@/lib/club-currency-minor-unit";
import {
  CLUB_FORMAT_SETTINGS_ID,
  CLUB_FORMAT_SETTINGS_SELECT,
  resolveClubFormatWithSource,
} from "@/lib/club-format-settings";
import logger from "@/lib/logger";
import { primeEmailClubTimeZone } from "@/lib/email-templates-club-time";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The club currency and locale maintenance API (stage 1 of programme #3205,
 * #3563). INV-CONFIG-006.
 *
 * ANY ADMIN READS; ONLY A FULL ADMIN CHANGES (owner decision on #3596). `GET`
 * is `requireAdmin({ permission: "any-admin" })` (`hasAdminPortalAccess`),
 * copied from `GET /api/admin/lodges`; its payload is safe whole for every
 * admin — the two values every rendered amount already shows, their provenance
 * and the last changer's display name, no email or id — so anything added to
 * `ClubFormatState` reaches every admin too. `PUT` stays `requireAdmin({
 * permission: false })`, Full Admin only. An OMITTED `permission` would be
 * wrong on both and looks right at a glance: it infers `support` from the path,
 * refusing the read to a finance-only admin and granting the write to a
 * support editor. The path is registered under `support` in
 * `ROUTE_AREA_PREFIXES` only so the drift guard resolves it; both divergences
 * are declared in `REVIEWED_PERMISSION_DIVERGENCES`. `/api/admin/club-time-zone`
 * and `/api/admin/environment-safety` are Full Admin on both verbs.
 *
 * THE CONFIRMATION IS ENFORCED HERE, not only in the panel. A checkbox in a
 * browser is a courtesy to the operator, and the panel is not the only caller.
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

/**
 * Retryable failures of the transaction below, answered 503 rather than 500.
 * P2028 (transaction API error, including an exhausted `maxWait`/`timeout`) and
 * P2034 (write conflict, deadlock, or the serialisation failure Serializable
 * deliberately provokes) are the shared shape `/api/admin/site-style` uses.
 * P2002 joins them here for the reason `/api/admin/club-time-zone` states: on a
 * one-row singleton whose id is a constant, a primary-key collision can only be
 * this upsert's create arm losing a race with another administrator recording
 * the setting for the first time. That rests on the other tables this writes
 * being `AuditLog` (a per-row `cuid`, no other unique constraint) and the AI rate
 * it only ever DELETES from — add a unique constraint or an insert, and a real
 * bug starts being answered "try again shortly", which retrying cannot fix.
 */
const TRANSACTION_CONTENTION_CODES = new Set(["P2002", "P2028", "P2034"]);

function isTransactionContentionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSACTION_CONTENTION_CODES.has(code);
}

export async function GET() {
  const guard = await requireAdmin({ permission: "any-admin" });
  if (!guard.ok) return guard.response;

  const resolved = await resolveClubFormatWithSource();
  return NextResponse.json({ state: await stateFromResolved(resolved) });
}

/**
 * `confirmed` is OPTIONAL in the schema and required by the check below, so an
 * absent flag and an explicit `false` get the same plain-English refusal rather
 * than one of them falling out as a generic "invalid body".
 *
 * `.strict()` is load-bearing: it is what makes an unknown key a 400 rather
 * than a silently ignored field a caller might believe had been honoured.
 */
const changeSchema = z
  .object({
    currencyCode: z.string().max(200),
    locale: z.string().max(200),
    confirmed: z.boolean().optional(),
  })
  .strict();

const INVALID_CURRENCY_MESSAGE =
  "Enter a three-letter currency code such as NZD, AUD or CHF. That is the " +
  "ISO 4217 code for the currency the club charges in — not a symbol ($) and " +
  "not a name (dollars).";

const INVALID_LOCALE_MESSAGE =
  "Enter a language tag such as en-NZ, en-AU or de-CH — a language, then the " +
  "country, separated by a hyphen. It decides how numbers and dates are " +
  "written, not what language the site is in.";

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: false });
  if (!guard.ok) return guard.response;
  const actingMemberId = guard.session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = changeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (parsed.data.confirmed !== true) {
    return NextResponse.json(
      {
        error:
          "Changing the club's currency or locale has to be confirmed before it is saved.",
      },
      { status: 400 },
    );
  }

  /*
    BOTH FIELDS ARE JUDGED BEFORE EITHER IS WRITTEN, and the refusal names which
    one failed. A save that stored a good currency and refused the locale would
    leave the operator looking at a half-applied form with no way to tell which
    half landed.
  */
  const currencyCode = normaliseClubCurrencyCode(parsed.data.currencyCode);
  if (!currencyCode) {
    return NextResponse.json(
      { error: INVALID_CURRENCY_MESSAGE },
      { status: 400 },
    );
  }
  // Card charges follow this currency (#3567 D1), so one that does not count
  // in hundredths would be charged 100x or a tenth of what is shown (D3).
  if (!currencyHasTwoDecimalPlaces(currencyCode)) {
    return NextResponse.json(
      { error: twoDecimalPlacesRequiredMessage(currencyCode) },
      { status: 400 },
    );
  }
  const locale = normaliseClubLocale(parsed.data.locale);
  if (!locale) {
    return NextResponse.json({ error: INVALID_LOCALE_MESSAGE }, { status: 400 });
  }

  try {
    const outcome = await prisma.$transaction(
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
    // Emails' cached locale re-reads NOW, after commit, not on its next TTL (#3566).
    if (outcome.changed) await primeEmailClubTimeZone();
    return NextResponse.json({
      changed: outcome.changed,
      state: await stateFromRow(outcome.row),
    });
  } catch (error) {
    /*
      The loser of a real race, told to try again rather than handed a 500 — it wrote
      nothing, so retrying is safe. Anything else rethrows: this route cannot tell what
      a broken database means, and a friendly "try again shortly" would hide it.
    */
    if (!isTransactionContentionError(error)) throw error;
    logger.warn({ err: error }, "Club format save hit write contention");
    return NextResponse.json(
      { error: "Another update is in progress — try again shortly." },
      { status: 503 },
    );
  }
}
