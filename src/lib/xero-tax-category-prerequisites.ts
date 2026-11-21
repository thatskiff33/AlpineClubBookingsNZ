import { clubTaxPeriodOn, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import { compareCalendarDates, type CalendarDate } from "@/lib/club-time";
import {
  ACCOUNT_MAPPING_DEFAULTS,
  ACCOUNT_MAPPING_KEYS,
  OPENING_CREDITS_MAPPING_KEY,
  normalizeMappingCode,
  type AccountMappingKey,
} from "@/lib/xero-account-mapping-keys";
import { xeroTaxCategoryRateProblem } from "@/lib/xero-tax-categories";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

/**
 * WHAT AN EXEMPT LINE NEEDS BEFORE IT CAN BE SET UP (#5209, for #4988's spent
 * opening-credit line). Pure: the caller reads the schedule, the Exempt mapping,
 * Xero's rates and the account mappings outside any transaction
 * (`INV-LOCK-004`) and passes them in. Kept apart from `xero-tax-categories.ts`
 * because it reads the tax schedule's rules, which the client-side card does not
 * need.
 */

/**
 * Whether a registered period is in force on `today` or scheduled after it:
 * while one is, a category other than income can carry tax on a document.
 */
export function registeredNowOrLater(schedule: ClubTaxSchedule, today: CalendarDate): boolean {
  return clubTaxPeriodOn(schedule, today).gstRegistered
    || schedule.some((period) => period.gstRegistered && compareCalendarDates(period.effectiveFrom, today) > 0);
}

/**
 * Whether the Exempt category must be mapped before an Exempt line can be set
 * up (the Opening Credits account, #4988): yes while today's period or any
 * scheduled later one is registered, so a scheduled registration cannot start
 * with an Exempt line and no rate for it. `exemptTaxType` is the mapping for
 * the connected organisation, null when unmapped there; `rates` is null when
 * Xero could not be read. Null means nothing is missing.
 */
export function exemptPrerequisiteProblem({
  schedule,
  today,
  exemptTaxType,
  rates,
}: {
  schedule: ClubTaxSchedule;
  today: CalendarDate;
  exemptTaxType: string | null;
  rates: readonly XeroTaxRateOption[] | null;
}): string | null {
  if (!registeredNowOrLater(schedule, today)) return null;
  if (exemptTaxType === null) {
    return "The club is, or is scheduled to be, GST-registered: map the Exempt tax category on the Xero setup screen first.";
  }
  if (rates === null) return "Xero's tax rates could not be read, so the Exempt tax category cannot be checked. Try again.";
  return xeroTaxCategoryRateProblem(rates, "EXEMPT", exemptTaxType);
}

/**
 * The OTHER account-mapping keys whose effective code is the Opening Credits
 * code (#4988): a row's own code, else the key's application default, compared
 * case- and whitespace-insensitively. Reports only; the caller decides.
 *
 * The Opening Credits key is never one of them (#5375 item 2). Its own row
 * always carries its own code, so once #4988 made it an account-mapping key it
 * would have reported itself on every save and no club could map it.
 */
export function openingCreditsAccountConflicts({
  openingCreditsCode,
  mappings,
}: {
  openingCreditsCode: string | null | undefined;
  mappings: ReadonlyArray<{ key: string; code: string | null }>;
}): AccountMappingKey[] {
  const target = normalizeMappingCode(openingCreditsCode)?.toUpperCase();
  if (!target) return [];
  return ACCOUNT_MAPPING_KEYS.filter((key) => {
    if (key === OPENING_CREDITS_MAPPING_KEY) return false;
    const explicit = normalizeMappingCode(mappings.find((row) => row.key === key)?.code);
    const effective = explicit ?? normalizeMappingCode(ACCOUNT_MAPPING_DEFAULTS[key]);
    return effective?.toUpperCase() === target;
  });
}
