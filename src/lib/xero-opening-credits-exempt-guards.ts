import { loadClubTaxSchedule } from "@/lib/club-tax-settings";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import {
  MAPPING_LABELS,
  isCodeExplicitlyConfigured,
  normalizeMappingCode,
} from "@/lib/xero-account-mapping-keys";
import { loadXeroTaxCategoryMappings, mappedTaxTypeFor } from "@/lib/xero-tax-category-mappings";
import {
  exemptPrerequisiteProblem,
  openingCreditsAccountConflicts,
  registeredNowOrLater,
} from "@/lib/xero-tax-category-prerequisites";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";
import { readXeroTaxRates } from "@/lib/xero-tax-rates";

/**
 * WHAT THE SETTINGS SCREENS REFUSE SO THE EXEMPT LINE CAN ALWAYS BE SENT
 * (#4988, on #5209's rules in `xero-tax-category-prerequisites.ts`;
 * `INV-PAY-162`, `INV-CONFIG-008`). A spent opening credit coded to the mapped
 * Opening Credits account is its own line in the Exempt tax category. Three
 * saves could leave that line unsendable or ambiguous, and each is refused with
 * a sentence saying what to do instead:
 *
 * 1. Opening Credits sharing its Xero account with another mapped role (owner
 *    decision, 21 Nov 2026, recorded on PR #5150: refuse the save).
 * 2. Mapping Opening Credits while the club is, or is scheduled to be,
 *    GST-registered and the Exempt category is not mapped to a rate Xero can
 *    carry (`exemptPrerequisiteProblem`).
 * 3. Clearing the Exempt mapping while Opening Credits is mapped and the club
 *    is, or is scheduled to be, GST-registered: the reverse of 2.
 *
 * The decisions are #5209's pure functions; this module only reads what they
 * need, outside any transaction (`INV-LOCK-004`). The sender's own refusal
 * (`XeroTaxCategoryUnavailableError`, held by the outbox) stays the backstop
 * for what a screen cannot see: a rate edited in Xero, a reconnect to another
 * organisation, a registration scheduled later, or two saves racing.
 */

const OPENING_CREDITS_KEY = "openingCredits";

type MappingCodeRow = { key: string; code: string | null };

/** "a", "a and b", "a, b and c". */
function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Why these mapping codes cannot stand together, or null: Opening Credits is
 * mapped and another role's effective account is the same one.
 *
 * The Opening Credits row is left out of the rows `openingCreditsAccountConflicts`
 * compares. That function walks every account-mapping key, Opening Credits
 * among them, so handed its own row it would report the key as conflicting
 * with itself and no club could ever map it.
 *
 * The message names roles, never the account code: the mapping screen reads a
 * bare "403" in a refusal as "not permitted", and an account can carry that code.
 */
function openingCreditsSharedAccountProblem(rows: readonly MappingCodeRow[]): string | null {
  const openingCreditsCode = rows.find((row) => row.key === OPENING_CREDITS_KEY)?.code;
  const conflicts = openingCreditsAccountConflicts({
    openingCreditsCode,
    mappings: rows.filter((row) => row.key !== OPENING_CREDITS_KEY),
  });
  if (conflicts.length === 0) return null;
  const roles = listInWords(conflicts.map((key) => MAPPING_LABELS[key] ?? key));
  return `Opening Credits cannot use the same Xero account as ${roles}. Choose an account for Opening Credits that no other mapping uses, or change the other mapping first. Nothing was saved.`;
}

/** The stored codes as they would read once `updates` is saved over them. */
function codesAfterSave(
  stored: readonly MappingCodeRow[],
  updates: Readonly<Record<string, { code?: string | null } | undefined>>,
): MappingCodeRow[] {
  const codes = new Map(stored.map((row) => [row.key, row.code]));
  for (const [key, update] of Object.entries(updates)) {
    if (update?.code !== undefined) codes.set(key, update.code);
  }
  return [...codes].map(([key, code]) => ({ key, code }));
}

/** `exemptPrerequisiteProblem` over what is stored now. Xero's rates are read fresh, and only when they are needed. */
async function readExemptPrerequisiteProblem(): Promise<string | null> {
  const [schedule, zone, mappings] = await Promise.all([
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
    loadXeroTaxCategoryMappings(),
  ]);
  const today = clubToday(zone);
  const exemptTaxType = mappedTaxTypeFor(mappings, "EXEMPT");
  let rates: XeroTaxRateOption[] | null = null;
  if (exemptTaxType !== null && registeredNowOrLater(schedule, today)) {
    try {
      rates = await readXeroTaxRates({ fresh: true });
    } catch {
      rates = null;
    }
  }
  return exemptPrerequisiteProblem({ schedule, today, exemptTaxType, rates });
}

/**
 * Why an account-mapping save is refused, or null when it may be written
 * (`PUT /api/admin/xero/account-mappings`). `stored` is every mapping row as it
 * is now; `updates` is the validated body.
 *
 * The shared-account rule judges the codes as they would read AFTER the save,
 * so it also catches another role being moved onto the Opening Credits account.
 * The Exempt prerequisite is asked only when the save sets or changes the
 * Opening Credits code: the screen sends every key on every save, and a club
 * that mapped the account earlier must still be able to save its other
 * mappings while Xero's rates cannot be read.
 */
export async function openingCreditsMappingSaveRefusal({
  stored,
  updates,
}: {
  stored: readonly MappingCodeRow[];
  updates: Readonly<Record<string, { code?: string | null } | undefined>>;
}): Promise<string | null> {
  const after = codesAfterSave(stored, updates);
  const shared = openingCreditsSharedAccountProblem(after);
  if (shared) return shared;

  const codeOf = (rows: readonly MappingCodeRow[]) =>
    normalizeMappingCode(rows.find((row) => row.key === OPENING_CREDITS_KEY)?.code);
  const next = codeOf(after);
  if (next === null || next === codeOf(stored)) return null;
  return readExemptPrerequisiteProblem();
}

/**
 * Why the Exempt mapping may not be cleared, or null when it may
 * (`clearXeroTaxCategory`). While the Opening Credits account is mapped and the
 * club is, or is scheduled to be, GST-registered, every spent opening credit
 * needs the Exempt rate; without it each one would wait in the Xero queue.
 */
export async function exemptClearRefusalWhileOpeningCreditsMapped(): Promise<string | null> {
  const [openingCredits, schedule, zone] = await Promise.all([
    prisma.xeroAccountMapping.findUnique({ where: { key: OPENING_CREDITS_KEY }, select: { code: true } }),
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
  ]);
  if (!isCodeExplicitlyConfigured(openingCredits)) return null;
  if (!registeredNowOrLater(schedule, clubToday(zone))) return null;
  return "The Exempt tax category is in use: the Opening Credits account is mapped, and the club is, or is scheduled to be, GST-registered, so each spent opening credit is sent to Xero with the Exempt rate. Unmap the Opening Credits account under Account Mappings first, then clear Exempt.";
}
