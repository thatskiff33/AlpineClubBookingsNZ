import { loadClubTaxSchedule, type ClubTaxPeriod, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import { clubToday, type CalendarDate } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import {
  MAPPING_LABELS,
  isCodeExplicitlyConfigured,
  normalizeMappingCode,
} from "@/lib/xero-account-mapping-keys";
import {
  loadXeroTaxCategoryMappings,
  mappedTaxTypeFor,
  type XeroTaxCategoryMappings,
} from "@/lib/xero-tax-category-mappings";
import {
  OPENING_CREDITS_MAPPING_KEY,
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
 * Opening Credits account is its own line in the Exempt tax category. Four
 * saves could leave that line unsendable or ambiguous, and each is refused with
 * a sentence saying what to do instead:
 *
 * 1. Opening Credits sharing its Xero account with another mapped role (owner
 *    decision, 21 Nov 2026, recorded on PR #5150: refuse the save).
 * 2. Mapping Opening Credits while the club is, or is scheduled to be,
 *    GST-registered and the Exempt category is not mapped to a rate Xero can
 *    carry (`exemptPrerequisiteProblem`; owner decision, 22 Nov 2026, #5375
 *    item 6: required only while a registered period is in force or scheduled).
 * 3. Clearing the Exempt mapping while Opening Credits is mapped and the club
 *    is, or is scheduled to be, GST-registered: the reverse of 2.
 * 4. Scheduling a GST registration while Opening Credits is mapped and Exempt
 *    is not usable: the other way into the state 2 refuses (#5375 item 3).
 *
 * What no save causes is REPORTED: the Xero health check carries a problem
 * while Opening Credits is mapped, a registered period applies or is scheduled,
 * and Exempt has no usable rate (`openingCreditsExemptHealthProblem`).
 *
 * The decisions are #5209's pure functions; this module only reads what they
 * need, outside any transaction (`INV-LOCK-004`). The sender's own refusal
 * (`XeroTaxCategoryUnavailableError`, held by the outbox) stays the backstop
 * for what a screen cannot stop: a rate edited in Xero, a reconnect to another
 * organisation, or two saves racing.
 */

type MappingCodeRow = { key: string; code: string | null };

/** "a", "a and b", "a, b and c". */
function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Why these mapping codes cannot stand together, or null: Opening Credits is
 * mapped and another role's effective account is the same one
 * (`openingCreditsAccountConflicts`, which never counts the key itself).
 *
 * The message names roles, never the account code: the mapping screen reads a
 * bare "403" in a refusal as "not permitted", and an account can carry that code.
 */
function openingCreditsSharedAccountProblem(rows: readonly MappingCodeRow[]): string | null {
  const conflicts = openingCreditsAccountConflicts({
    openingCreditsCode: rows.find((row) => row.key === OPENING_CREDITS_MAPPING_KEY)?.code,
    mappings: rows,
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
    normalizeMappingCode(rows.find((row) => row.key === OPENING_CREDITS_MAPPING_KEY)?.code);
  const next = codeOf(after);
  if (next === null || next === codeOf(stored)) return null;
  return readExemptPrerequisiteProblem();
}

/** Whether the club chose an Opening Credits account: the one read the checks below share. */
async function openingCreditsAccountIsMapped(): Promise<boolean> {
  const row = await prisma.xeroAccountMapping.findUnique({
    where: { key: OPENING_CREDITS_MAPPING_KEY },
    select: { code: true },
  });
  return isCodeExplicitlyConfigured(row);
}

/**
 * Why the Exempt mapping may not be cleared, or null when it may
 * (`clearXeroTaxCategory`). While the Opening Credits account is mapped and the
 * club is, or is scheduled to be, GST-registered, every spent opening credit
 * needs the Exempt rate; without it each one would wait in the Xero queue.
 */
export async function exemptClearRefusalWhileOpeningCreditsMapped(): Promise<string | null> {
  const [mapped, schedule, zone] = await Promise.all([
    openingCreditsAccountIsMapped(),
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
  ]);
  if (!mapped) return null;
  if (!registeredNowOrLater(schedule, clubToday(zone))) return null;
  return "The Exempt tax category is in use: the Opening Credits account is mapped, and the club is, or is scheduled to be, GST-registered, so each spent opening credit is sent to Xero with the Exempt rate. Unmap the Opening Credits account under Account Mappings first, then clear Exempt.";
}

/**
 * Why a GST registration may not be scheduled, or null when it may
 * (`scheduleClubTaxChange`). A club that mapped Opening Credits while it was
 * not registered needed no Exempt mapping then; the day its registration
 * starts, every spent opening credit needs one. #5209's rule is asked of that
 * day: the period being scheduled, on the date it starts. `rates` is the list
 * the writer has just read fresh for the period's own code.
 */
export async function registrationRefusalWhileOpeningCreditsMapped({
  period,
  rates,
}: {
  period: ClubTaxPeriod;
  rates: readonly XeroTaxRateOption[];
}): Promise<string | null> {
  if (!period.gstRegistered) return null;
  if (!(await openingCreditsAccountIsMapped())) return null;
  const problem = exemptPrerequisiteProblem({
    schedule: [period],
    today: period.effectiveFrom,
    exemptTaxType: mappedTaxTypeFor(await loadXeroTaxCategoryMappings(), "EXEMPT"),
    rates,
  });
  if (problem === null) return null;
  return `The Opening Credits account is mapped, so once the club is GST-registered each spent opening credit is sent to Xero with the Exempt rate. ${problem} Nothing was saved.`;
}

/**
 * The Xero health check's line for a state no screen refusal can rule out
 * (`readXeroTaxHealth`; #5375 item 3), or null: Opening Credits is mapped, a
 * registered period applies today or is scheduled, and Exempt has no usable
 * rate in the connected organisation. Judged by #5209's rule. Rates that could
 * not be read are "not checked", which the health check already says, so only
 * a known fault is reported.
 */
export async function openingCreditsExemptHealthProblem({
  schedule,
  today,
  mappings,
  rates,
}: {
  schedule: ClubTaxSchedule;
  today: CalendarDate;
  mappings: XeroTaxCategoryMappings;
  rates: readonly XeroTaxRateOption[] | null;
}): Promise<string | null> {
  // Not connected: there is no organisation to judge against, and nothing sends.
  if (mappings.tenantId === null || !registeredNowOrLater(schedule, today)) return null;
  if (!(await openingCreditsAccountIsMapped())) return null;
  const exemptTaxType = mappedTaxTypeFor(mappings, "EXEMPT");
  if (exemptTaxType !== null && rates === null) return null;
  if (exemptPrerequisiteProblem({ schedule, today, exemptTaxType, rates }) === null) return null;
  return "Opening Credits is mapped and the club is, or is scheduled to be, GST-registered, but the Exempt tax category has no usable Xero tax rate. Spent opening credits wait in the Xero queue until a Full Admin maps Exempt on the Xero setup screen.";
}
