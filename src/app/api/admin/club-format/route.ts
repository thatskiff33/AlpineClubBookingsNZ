import { NextResponse } from "next/server";
import { z } from "zod";

import {
  normaliseClubCurrencyCode,
  normaliseClubLocale,
} from "@/lib/club-format";
import { stateFromResolved, stateFromRow } from "@/lib/club-format-admin-state";
import { countInFlightCardPayments } from "@/lib/club-format-in-flight";
import {
  currencyHasTwoDecimalPlaces,
  twoDecimalPlacesRequiredMessage,
} from "@/lib/club-currency-minor-unit";
import { resolveClubFormatWithSource } from "@/lib/club-format-settings";
import { writeClubFormat } from "@/lib/club-format-write";
import logger from "@/lib/logger";
import { primeEmailClubTimeZone } from "@/lib/email-templates-club-time";
import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";

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
 * THE WRITE ITSELF is `writeClubFormat` (`@/lib/club-format-write.ts`): the
 * three tables it touches, its Serializable isolation and why it takes no
 * advisory lock are stated there, beside the code they describe.
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

  const [resolved, inFlight] = await Promise.all([
    resolveClubFormatWithSource(),
    // What a currency change would catch mid-flight (#3567 D2). Advice for the
    // confirmation, read outside any transaction; null when it cannot be read.
    // FULL ADMIN ONLY (#3567 review): only a Full Admin can change the currency,
    // and payment counts are not part of the view-only payload other admins get.
    isFullAdmin(guard.session.user) ? countInFlightCardPayments() : Promise.resolve(null),
  ]);
  return NextResponse.json({ state: await stateFromResolved(resolved), inFlight });
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
    // The second acknowledgement a CURRENCY change needs (#3567 D2, D8): the
    // Stripe account and Xero base currency match, and cards follow at once.
    currencyChangeConfirmed: z.boolean().optional(),
  })
  .strict();

const UNCONFIRMED_CURRENCY_CHANGE_MESSAGE =
  "Changing the club's currency changes what cards are charged in, so it has " +
  "to be confirmed separately: tick that the Stripe account and the Xero base " +
  "currency match the new currency.";

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
    const outcome = await writeClubFormat({
      currencyCode,
      locale,
      currencyChangeConfirmed: parsed.data.currencyChangeConfirmed === true,
      actingMemberId,
      request,
    });
    if ("refused" in outcome) {
      return NextResponse.json(
        { error: UNCONFIRMED_CURRENCY_CHANGE_MESSAGE },
        { status: 400 },
      );
    }
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
